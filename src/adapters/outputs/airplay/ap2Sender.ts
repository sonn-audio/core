import { randomBytes } from 'node:crypto';
import {
  AirPlayConnection,
  NtpTimingResponder,
  PtpEngine,
  RealtimeSender,
  createIdentity,
  setVolume as sendVolume,
  setMetadata as sendMetadata,
  setArtwork as sendArtwork,
  setupRealtimeStream,
  FRAMES_PER_PACKET,
  type SenderIdentity,
} from '@sonn-audio/node-airplay';
import { ntpNow } from '@sonn-audio/node-airplay';
import { createLogger } from '@/shared/logging/logger';
import type { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';
import { PcmRing } from '@/adapters/outputs/airplay/pcmRing';

const SAMPLE_RATE = 44_100;
const BYTES_PER_FRAME = 4; // s16le stereo
const BYTES_PER_PACKET = FRAMES_PER_PACKET * BYTES_PER_FRAME;
/**
 * How far ahead of the render point audio is handed over. The receiver plays a
 * sample this long after we send it, so this single number is the output's
 * latency, the delay before the first sound, AND how much of the previous track
 * a skip still plays out (the realtime path has no device-side flush yet).
 *
 * The reference sender defaults to 2000 ms for resilience; that costs about six
 * seconds before a start is audible, which is not what this server's AirPlay
 * zones are tuned for — the RAOP path deliberately sits near 750 ms. The
 * receiver's own window bottoms out at latencyMin (11025 frames = 250 ms), so
 * 500 ms leaves headroom above the floor while keeping start and skip snappy.
 */
const LEAD_MS = 500;
/**
 * PCM buffered before the stream is set up. The receiver drops the control
 * channel when a stream SETUP is not followed promptly by audio, so the buffer
 * has to be filled BEFORE the session is built, never after (measured: four
 * seconds of silence between SETUP and the first packet ends the session, and
 * the sender keeps streaming into the void with nothing to show for it).
 */
const PRIME_MS = 400;
const SEND_TICK_MS = 4;

/**
 * One PTP grandmaster for the whole process.
 *
 * UDP 319/320 can only be bound once, and a single grandmaster can serve every
 * receiver, so sessions register themselves as peers instead of each running an
 * engine. This is also what a synchronised group will need later: members that
 * share one clock share a timeline by construction.
 */
class SharedPtp {
  private engine: PtpEngine | null = null;
  private starting: Promise<PtpEngine | null> | null = null;
  private readonly identity: SenderIdentity = createIdentity(randomBytes(8));
  private readonly log = createLogger('Output', 'AirPlay2/PTP');

  public get senderIdentity(): SenderIdentity {
    return this.identity;
  }

  /** Start the engine if it is not up yet, and serve `peer` from it. */
  public async acquire(peer: string): Promise<PtpEngine | null> {
    if (this.engine) {
      this.engine.addPeer(peer);
      return this.engine;
    }
    if (!this.starting) {
      this.starting = this.startEngine();
    }
    const engine = await this.starting;
    engine?.addPeer(peer);
    return engine;
  }

  public release(peer: string): void {
    this.engine?.removePeer(peer);
  }

  private async startEngine(): Promise<PtpEngine | null> {
    const engine = new PtpEngine({
      clockId: this.identity.clockId,
      peers: [],
      onLog: (message) => this.log.debug('ptp', { message }),
    });
    try {
      await engine.start();
      this.engine = engine;
      this.log.info('PTP grandmaster started', { clockId: this.identity.clockId.toString(16) });
      return engine;
    } catch (err) {
      // Almost always the privileged ports. An AirPlay 2 session without PTP
      // connects, reports healthy and renders silence on an Apple receiver, so
      // this has to fail loudly rather than fall back.
      this.log.error('PTP grandmaster could not start; AirPlay 2 output is unavailable', {
        message: err instanceof Error ? err.message : String(err),
        hint: 'UDP 319/320 need root or CAP_NET_BIND_SERVICE',
      });
      this.starting = null;
      return null;
    }
  }
}

const sharedPtp = new SharedPtp();

/**
 * A shared playback instant `prebufferMs` from now, as unix-epoch NTP.
 *
 * Every member of a sync group is handed the same value, so they map the same
 * frame to the same moment however far ahead each one runs.
 */
export function computeGroupAnchorNtp(prebufferMs: number): bigint {
  return ntpNow() + (BigInt(Math.max(0, Math.round(prebufferMs))) * (1n << 32n)) / 1000n;
}

export interface Ap2SenderConfig {
  host: string;
  port?: number;
  password?: string;
  /** Name the receiver shows for the session. */
  name?: string;
  onUnavailable?: (reason: string) => void;
}

/**
 * Drives a single AirPlay 2 receiver over node-airplay: HAP pairing, an
 * encrypted control channel, PTP timing and an encrypted realtime RTP stream.
 *
 * The shape mirrors {@link RaopSender} so an output can hold either without
 * knowing which — see {@link AirplaySender}.
 */
export class Ap2Sender implements AirplaySender {
  private readonly log = createLogger('Output', 'Ap2Sender');
  private connection: AirPlayConnection | null = null;
  private sender: RealtimeSender | null = null;
  private ptp: PtpEngine | null = null;

  private readonly ring = new PcmRing();

  private sendTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private packetsDue = 0;
  private currentVolume = 30;
  private starting = false;
  private paused = false;
  /** Wall-clock instant the first sample must be audible, for a synced group. */
  private groupStartUnixMs: number | null = null;
  private ntpResponder: NtpTimingResponder | null = null;
  private timing: 'ptp' | 'ntp' = 'ptp';

  constructor(
    private readonly config: Ap2SenderConfig,
    private readonly context: { zoneId: number; zoneName: string },
  ) {}

  public isRunning(): boolean {
    return this.sender !== null;
  }

  public getLatencyMs(): number {
    return LEAD_MS;
  }

  public async start(source: NodeJS.ReadableStream, volume: number): Promise<boolean> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    this.paused = false;

    if (this.sender) {
      this.ring.attach(source);
      return true;
    }
    if (this.starting) {
      return false;
    }
    this.starting = true;
    try {
      // Fill the ring FIRST: the session must not sit idle after its stream
      // SETUP (see PRIME_MS).
      this.ring.attach(source);
      const primed = await this.ring.waitForPrime(PRIME_MS);
      if (!primed) {
        this.log.warn('no PCM arrived; not opening an AirPlay 2 session', this.context);
        this.ring.detach();
        return false;
      }
      return await this.openSession();
    } finally {
      this.starting = false;
    }
  }

  /**
   * Start as a member of a sync group.
   *
   * `basePlayNtp` is the shared instant every member is handed, in the
   * unix-epoch NTP fixed point the RAOP path uses (seconds << 32 | fraction).
   * Our PTP timeline is the host's realtime clock, the same base, so the two
   * protocols can express one instant — which is what lets a mixed group of
   * AirPlay 1 and AirPlay 2 zones line up.
   *
   * A track change inside a running group arrives with `reAnchor` false: the
   * session and its timeline stay, only the source is swapped, or every track
   * boundary would cost a re-anchor.
   */
  public async startForGroup(
    source: NodeJS.ReadableStream,
    volume: number,
    basePlayNtp: bigint,
    reAnchor: boolean,
  ): Promise<boolean> {
    if (this.sender && !reAnchor) {
      this.rebind(source);
      return true;
    }
    if (this.sender && reAnchor) {
      this.stop();
    }
    this.groupStartUnixMs = ntpToUnixMs(basePlayNtp);
    try {
      return await this.start(source, volume);
    } finally {
      this.groupStartUnixMs = null;
    }
  }

  public pause(): void {
    this.paused = true;
    this.stopSendLoop();
  }

  public resume(source: NodeJS.ReadableStream): void {
    this.paused = false;
    this.ring.attach(source);
    if (this.sender) {
      this.startSendLoop();
    }
  }

  public rebind(source: NodeJS.ReadableStream): void {
    // Drop what is still queued from the old track: keeping it would play the
    // previous track's tail over the new one. What the receiver already holds
    // (up to LEAD_MS) still plays out — the realtime path has no flush yet, so
    // the lead is what bounds that.
    this.ring.clear();
    this.ring.attach(source);
  }

  public async setVolume(volume: number): Promise<void> {
    this.currentVolume = clampVolume(volume, this.currentVolume);
    const connection = this.connection;
    if (!connection) {
      return;
    }
    try {
      await sendVolume(connection.rtsp, connection.sessionUrl, this.currentVolume);
    } catch (err) {
      this.log.debug('volume not applied', {
        ...this.context,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Track metadata, pushed as a DMAP blob over the control channel.
   *
   * Apple's own now-playing screen rides the MediaRemote channel, which needs
   * credentials from a PIN pairing and so is out of reach of a transiently
   * paired session; this is the path that is open, and some receivers withhold
   * audio until they have had it.
   */
  public updateMetadata(payload: {
    title?: string;
    artist?: string;
    album?: string;
    cover?: { data: Buffer; mime?: string };
    elapsedMs?: number;
    durationMs?: number;
  }): void {
    const connection = this.connection;
    const sender = this.sender;
    if (!connection || !sender) {
      return;
    }
    const position = sender.rtpPosition;
    void sendMetadata(
      connection.rtsp,
      connection.sessionUrl,
      { title: payload.title, artist: payload.artist, album: payload.album },
      position,
    ).catch((err: unknown) => this.logMetadataFailure('metadata', err));

    if (payload.cover?.data?.length) {
      void sendArtwork(
        connection.rtsp,
        connection.sessionUrl,
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
    this.sender?.stop();
    this.sender = null;
    this.connection?.close();
    this.connection = null;
    if (this.ptp) {
      sharedPtp.release(this.config.host);
      this.ptp = null;
    }
    this.ntpResponder?.stop();
    this.ntpResponder = null;
    this.timing = 'ptp';
    this.log.info('AirPlay 2 sender stopped', this.context);
  }

  // -- session ---------------------------------------------------------------

  private async openSession(): Promise<boolean> {
    const identity = sharedPtp.senderIdentity;
    this.ptp = await sharedPtp.acquire(this.config.host);
    if (!this.ptp) {
      this.config.onUnavailable?.('PTP timing unavailable (needs UDP 319/320)');
      return false;
    }

    try {
      let connection = await AirPlayConnection.open({
        host: this.config.host,
        ...(this.config.port !== undefined ? { port: this.config.port } : {}),
        ...(this.config.password !== undefined ? { password: this.config.password } : {}),
        identity: identity.bytes,
        onEvent: (event) => this.handleSessionEvent(event),
      });
      this.connection = connection;
      let session = await connection.setupSession(this.config.name ?? 'sonn');

      // A receiver can advertise SupportsPTP, accept the PTP SETUP with a 200,
      // and then never probe our clock — after which it renders silence while
      // everything here looks healthy (measured on a BeoLab 50). It gives
      // itself away by answering with a timing port of its own, so take it at
      // its word rather than its advertisement and redo the session on the NTP
      // lane. Apple receivers never do this, and must not: NTP timing is what
      // makes THEM silent.
      if (session.wantsNtpTiming) {
        this.log.info('receiver asked for NTP timing; re-running the session on that lane', {
          ...this.context,
          host: this.config.host,
        });
        connection.close();
        this.ntpResponder = new NtpTimingResponder();
        const timingPort = await this.ntpResponder.start();
        const ntpConnection = await AirPlayConnection.open({
          host: this.config.host,
          ...(this.config.port !== undefined ? { port: this.config.port } : {}),
          ...(this.config.password !== undefined ? { password: this.config.password } : {}),
          identity: identity.bytes,
          onEvent: (event) => this.handleSessionEvent(event),
        });
        this.connection = ntpConnection;
        // Everything past here talks to the receiver, and the connection it was
        // reached on just changed. Keeping the old one in hand leaves the rest
        // of the setup addressing a socket that was closed two lines ago.
        connection = ntpConnection;
        session = await ntpConnection.setupSession(this.config.name ?? 'sonn', {
          timing: 'ntp',
          timingPort,
        });
        this.timing = 'ntp';
      }

      // Bound before the stream is set up, so they have to be released by hand
      // when anything after this throws: only a sender that got as far as being
      // constructed will ever close them itself, and a retry loop that leaks two
      // sockets a go eats the process.
      const sockets = await RealtimeSender.bindSockets();
      let stream;
      try {
        stream = await setupRealtimeStream(connection.rtsp, connection.sessionUrl, {
          audioKey: connection.hap.sharedSecret,
          localDataPort: sockets.dataPort,
          localControlPort: sockets.controlPort,
          streamConnectionId: Math.floor(Math.random() * 0x7fff_ffff),
        });
        await sendVolume(connection.rtsp, connection.sessionUrl, this.currentVolume);
      } catch (err) {
        sockets.data.close();
        sockets.control.close();
        throw err;
      }

      this.sender = new RealtimeSender(
        {
          host: this.config.host,
          dataPort: stream.dataPort,
          controlPort: stream.controlPort,
          audioKey: connection.hap.sharedSecret,
          ptp: this.ptp,
          timing: this.timing,
          leadMs: LEAD_MS,
          onLog: (message) => this.log.debug('rtp', { ...this.context, message }),
        },
        sockets.data,
        sockets.control,
      );
      this.sender.start(this.groupStartUnixMs ?? undefined);
      this.startSendLoop();
      this.startStats();
      this.log.info('AirPlay 2 sender started', {
        ...this.context,
        host: this.config.host,
        timing: this.timing,
        leadMs: LEAD_MS,
      });
      return true;
    } catch (err) {
      this.log.warn('AirPlay 2 session failed', {
        ...this.context,
        host: this.config.host,
        message: err instanceof Error ? err.message : String(err),
      });
      this.connection?.close();
      this.connection = null;
      sharedPtp.release(this.config.host);
      this.ptp = null;
      this.ntpResponder?.stop();
      this.ntpResponder = null;
      return false;
    }
  }

  /**
   * The receiver dropping the control channel is the one failure this path has
   * that leaves everything else looking healthy — packets keep flowing into a
   * session that no longer exists.
   */
  private handleSessionEvent(event: string): void {
    this.log.warn('AirPlay 2 session event', { ...this.context, event });
    if (event.includes('closed the control channel')) {
      this.stop();
      this.config.onUnavailable?.(event);
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

  /** Once a second: what the sender is actually doing, rather than inferred. */
  private startStats(): void {
    this.statsTimer = setInterval(() => {
      const sender = this.sender;
      if (!sender) {
        return;
      }
      this.log.debug('ap2 sender state', {
        ...this.context,
        ringMs: this.ring.bufferedMs,
        sourcePaused: this.ring.isSourcePaused,
        packetsSent: sender.packetsSent,
        rtxAnswered: sender.rtxAnswered,
        timing: this.timing,
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
   * Send what the source has given us, never more than a lead ahead of realtime.
   *
   * The wall clock is a CEILING here, not a metronome. An earlier version
   * treated it as the latter — it filled every gap with silence and counted the
   * packet anyway — which is right for a file the engine reads at its own pace,
   * and wrong for a live source. On a live input the sender at the other end is
   * the clock: every inserted packet of silence pushes us permanently ahead of
   * it, the backlog grows by exactly that much, and the ring ends up against
   * its gate for good. So on an empty ring we simply wait.
   */
  private pump(): void {
    const sender = this.sender;
    if (!sender || this.paused) {
      return;
    }
    const elapsedFrames = ((Date.now() - this.startedAt) / 1000) * SAMPLE_RATE;
    const dueFrames = elapsedFrames + (LEAD_MS / 1000) * SAMPLE_RATE;
    while (this.packetsDue * FRAMES_PER_PACKET < dueFrames) {
      const pcm = this.ring.take(BYTES_PER_PACKET);
      if (!pcm) {
        return; // nothing to send yet; the clock will catch us up
      }
      sender.sendPacket(pcm);
      this.packetsDue++;
    }
  }
}

/**
 * Unix-epoch NTP fixed point (seconds << 32 | fraction) to milliseconds — the
 * form the group controller hands out, shared with the RAOP path.
 */
function ntpToUnixMs(ntp: bigint): number {
  const seconds = ntp >> 32n;
  const fraction = ntp & 0xffff_ffffn;
  return Number(seconds) * 1000 + Number((fraction * 1000n) >> 32n);
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}
