import {
  connectRaop,
  ntpNow,
  RaopStreamer,
  RAOP_FRAMES_PER_PACKET,
  setVolume as sendVolume,
  setMetadata as sendMetadata,
  setArtwork as sendArtwork,
  type RaopSession,
} from '@sonn-audio/node-airplay';
import { createLogger } from '@/shared/logging/logger';
import type { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';
import { PcmRing } from '@/adapters/outputs/airplay/pcmRing';

const SAMPLE_RATE = 44_100;
const BYTES_PER_FRAME = 4; // s16le stereo
const BYTES_PER_PACKET = RAOP_FRAMES_PER_PACKET * BYTES_PER_FRAME;
/** See {@link PcmRing.waitForPrime}: audio has to exist before RECORD, not after. */
const PRIME_MS = 400;
const SEND_TICK_MS = 4;

/**
 * Total read-ahead the device holds by default, in ms. The old native sender
 * settled here and the zone clocks are tuned for it, so it stays.
 */
const DEFAULT_BUFFER_MS = 750;
const MIN_BUFFER_MS = 250;
const MAX_BUFFER_MS = 5000;
/**
 * The receiver adds this on top of whatever the sender asks for — libraop's
 * comment on it is "why do AirPlay devices use required latency + 11025 ???",
 * and the answer is still unknown. `bufferMs` is the TOTAL the device ends up
 * holding, so it is what we subtract before asking.
 */
const RAOP_LATENCY_MIN_FRAMES = 11_025;
/** Seconds between the NTP and Unix epochs. */
const NTP_EPOCH_DELTA = 2_208_988_800n;

export interface RaopSenderConfig {
  host: string;
  port?: number;
  /** Device encryption types (mDNS TXT `et`); a `4` asks for the MFi exchange. */
  et?: string;
  /** Total device read-ahead in ms; default {@link DEFAULT_BUFFER_MS}. */
  bufferMs?: number;
}

/**
 * Drives a single AirPlay 1 (RAOP) receiver over node-airplay: an SDP-bodied
 * ANNOUNCE, an unencrypted ALAC stream, and a frame counter for a clock.
 *
 * This is the lane for gear that never learned AirPlay 2 — AirPort Express,
 * older AVRs, third-party speakers whose firmware stopped in the AirPlay 1 era.
 * It is not a fallback for a modern Apple receiver: those accept the whole
 * session and then render silence, which is why {@link Ap2Sender} exists and why
 * the two are chosen between rather than tried in turn wherever we can tell.
 *
 * The shape mirrors {@link Ap2Sender} so an output can hold either without
 * knowing which — see {@link AirplaySender}.
 */
export class RaopSender implements AirplaySender {
  private readonly log = createLogger('Output', 'RaopSender');
  private session: RaopSession | null = null;
  private streamer: RaopStreamer | null = null;
  private readonly ring = new PcmRing();

  private sendTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private packetsDue = 0;
  private currentVolume = 30;
  private starting = false;
  private paused = false;
  /** Shared anchor for a synced group; absolute unix-epoch NTP. */
  private groupStartNtp: bigint | null = null;
  /** Frame position the session was anchored at — metadata is timed against it. */
  private anchorFrames = 0n;
  private readonly latencyFrames: number;

  constructor(
    private readonly config: RaopSenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {
    const bufferMs = Number.isFinite(config.bufferMs)
      ? Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, config.bufferMs as number))
      : DEFAULT_BUFFER_MS;
    this.latencyFrames = Math.max(
      0,
      Math.round((bufferMs / 1000) * SAMPLE_RATE) - RAOP_LATENCY_MIN_FRAMES,
    );
  }

  public isRunning(): boolean {
    return this.streamer !== null;
  }

  /**
   * What the device actually holds, once it has told us — it may raise what we
   * asked for, and the zone clock has to account for the number it chose.
   */
  public getLatencyMs(): number {
    return (
      this.streamer?.latencyMs ??
      Math.round(((this.latencyFrames + RAOP_LATENCY_MIN_FRAMES) / SAMPLE_RATE) * 1000)
    );
  }

  public async start(source: NodeJS.ReadableStream, volume: number): Promise<boolean> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    this.paused = false;

    if (this.streamer) {
      this.ring.attach(source);
      return true;
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      this.ring.attach(source);
      const primed = await this.ring.waitForPrime(PRIME_MS);
      if (!primed) {
        this.log.warn('no PCM arrived; not opening a RAOP session', this.context);
        this.ring.detach();
        return false;
      }
      return await this.openSession();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Start as a member of a sync group, anchored to the instant every member was
   * handed. RAOP expresses a moment as a frame position derived from that same
   * NTP value, which is what lines an AirPlay 1 zone up with an AirPlay 2 one.
   */
  public async startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    basePlayNtp: bigint,
    reAnchor: boolean,
  ): Promise<boolean> {
    if (this.streamer && !reAnchor) {
      this.rebind(source);
      return true;
    }
    if (this.streamer && reAnchor) {
      this.stop();
    }
    this.groupStartNtp = basePlayNtp;
    try {
      return await this.start(source, volume);
    } finally {
      this.groupStartNtp = null;
    }
  }

  /**
   * Pause by ending the session, not by going quiet.
   *
   * RAOP's timeline IS the frame counter, and this lane has no way to move it:
   * the streamer anchors once and every sync packet reports where that anchor has
   * carried it. Simply stopping the feed freezes that position while the device's
   * own clock keeps running, so the frames sent on resume describe a moment that
   * has already passed and the device has nothing to render them at -- it accepts
   * them and stays silent (#386, reported as a hang on resume; libraop re-anchored
   * with an explicit `play` here, which node-airplay's RAOP lane does not offer).
   *
   * Tearing down instead also stops the speaker at once rather than letting it
   * play out its read-ahead, and resume is then the ordinary fresh start that the
   * output already falls back to when the sender is not running.
   */
  public pause(): void {
    this.paused = true;
    this.stopSendLoop();
    this.closeSession('pause');
  }

  public resume(source: NodeJS.ReadableStream): void {
    this.paused = false;
    this.ring.attach(source);
    if (this.streamer) {
      this.startSendLoop();
      return;
    }
    // Nothing to resume: pause ended the session. The output sees isRunning()
    // false and starts a fresh one, which is the only way back onto a live
    // timeline here.
    this.log.debug('resume with no session; the output will start a fresh one', this.context);
  }

  public rebind(source: NodeJS.ReadableStream): void {
    // Drop the old track's tail that is still queued here. What the device
    // already holds still plays out; its read-ahead is what bounds that.
    this.ring.clear();
    this.ring.attach(source);
  }

  public async setVolume(volume: number): Promise<void> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    const session = this.session;
    if (!session) {
      return;
    }
    try {
      await sendVolume(session.rtsp, session.sessionUrl, this.currentVolume);
    } catch (err) {
      this.log.debug('volume not applied', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  public updateMetadata(payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    elapsedMs?: number;
    durationMs?: number;
  }): void {
    const session = this.session;
    const streamer = this.streamer;
    if (!session || !streamer) {
      return;
    }
    // The DMAP blob is anchored to where the timeline is; a receiver may reject
    // one that arrives without a position it recognises.
    const position = Number(
      (this.anchorFrames + BigInt(streamer.packetsSent * RAOP_FRAMES_PER_PACKET)) & 0xffff_ffffn,
    );
    void sendMetadata(
      session.rtsp,
      session.sessionUrl,
      { title: payload.title, artist: payload.artist, album: payload.album },
      position,
    ).catch((err: unknown) => this.logMetadataFailure('metadata', err));

    if (payload.cover?.data?.length) {
      void sendArtwork(
        session.rtsp,
        session.sessionUrl,
        payload.cover.mime ?? 'image/jpeg',
        payload.cover.data,
        position,
      ).catch((err: unknown) => this.logMetadataFailure('artwork', err));
    }
  }

  /** Carried inside the metadata blob; there is no separate progress verb here. */
  public setProgress(_elapsedMs: number, _durationMs: number): void {
    /* no-op */
  }

  private logMetadataFailure(what: string, err: unknown): void {
    this.log.debug(`${what} not accepted`, {
      ...this.context,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  public stop(): void {
    this.stopSendLoop();
    this.ring.detach();
    this.ring.clear();
    this.closeSession('stop');
  }

  /**
   * Let go of the session and everything it bound.
   *
   * The streamer owns the UDP sockets and the timing responder; the RTSP
   * connection is the session's, so both have to be released or a restart binds
   * a second set on top of the first.
   */
  private closeSession(reason: 'pause' | 'stop'): void {
    if (!this.streamer && !this.session) {
      return;
    }
    this.streamer?.stop();
    this.streamer = null;
    if (this.session) {
      try {
        this.session.rtsp.close();
      } catch {
        /* the socket is going away either way */
      }
      this.session = null;
    }
    this.log.info('RAOP session closed', { ...this.context, reason });
  }

  // -- session ---------------------------------------------------------------

  private async openSession(): Promise<boolean> {
    try {
      const session = await connectRaop({
        host: this.config.host,
        ...(this.config.port !== undefined ? { port: this.config.port } : {}),
        ...(this.config.et !== undefined ? { et: this.config.et } : {}),
        latencyFrames: this.latencyFrames,
        onLog: (message) => this.log.debug('raop', { ...this.context, message }),
      });
      this.session = session;
      this.streamer = new RaopStreamer({
        host: this.config.host,
        session,
        onLog: (message) => this.log.debug('rtp', { ...this.context, message }),
      });
      const startNtp = this.groupStartNtp ?? ntpNow();
      this.anchorFrames = ntpToFrames(startNtp);
      this.streamer.start(startNtp);
      await this.setVolume(this.currentVolume);
      this.startSendLoop();
      this.startStats();
      this.log.info('RAOP sender started', {
        ...this.context,
        host: this.config.host,
        latencyMs: this.getLatencyMs(),
      });
      return true;
    } catch (err) {
      this.log.warn('RAOP session failed', {
        ...this.context,
        host: this.config.host,
        message: err instanceof Error ? err.message : String(err),
      });
      this.streamer?.stop();
      this.streamer = null;
      this.session?.rtsp.close();
      this.session = null;
      return false;
    }
  }

  // -- audio -----------------------------------------------------------------

  private startSendLoop(): void {
    if (this.sendTimer) {
      return;
    }
    this.startedAt = Date.now();
    this.packetsDue = 0;
    this.sendTimer = setInterval(() => this.pump(), SEND_TICK_MS);
  }

  private startStats(): void {
    this.statsTimer = setInterval(() => {
      const streamer = this.streamer;
      if (!streamer) {
        return;
      }
      this.log.debug('raop sender state', {
        ...this.context,
        ringMs: this.ring.bufferedMs,
        sourcePaused: this.ring.isSourcePaused,
        packetsSent: streamer.packetsSent,
        rtxAnswered: streamer.rtxAnswered,
      });
    }, 1000);
  }

  private stopSendLoop(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
  }

  /**
   * Send what the source has given us, never more than the device's read-ahead
   * beyond realtime. The wall clock is a CEILING here, not a metronome: on an
   * empty ring we wait rather than insert silence, or a live source would push
   * us permanently ahead of the sender feeding it (see {@link Ap2Sender.pump}).
   */
  private pump(): void {
    const streamer = this.streamer;
    if (!streamer || this.paused) {
      return;
    }
    const elapsedFrames = ((Date.now() - this.startedAt) / 1000) * SAMPLE_RATE;
    const dueFrames = elapsedFrames + (this.getLatencyMs() / 1000) * SAMPLE_RATE;
    while (this.packetsDue * RAOP_FRAMES_PER_PACKET < dueFrames) {
      const pcm = this.ring.take(BYTES_PER_PACKET);
      if (!pcm) {
        return; // nothing to send yet; the clock will catch us up
      }
      streamer.sendPacket(pcm);
      this.packetsDue++;
    }
  }
}

/**
 * Absolute NTP time to a frame count — the same conversion the streamer anchors
 * with, repeated here because the position it derives is private to it.
 */
function ntpToFrames(ntp: bigint): bigint {
  const seconds = (ntp >> 32n) - NTP_EPOCH_DELTA;
  const fraction = ntp & 0xffff_ffffn;
  return seconds * BigInt(SAMPLE_RATE) + ((fraction * BigInt(SAMPLE_RATE)) >> 32n);
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}
