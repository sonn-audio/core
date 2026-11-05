import { createLogger, type ComponentLogger } from '@/shared/logging/logger';
import type { ZoneAirplayConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { CoverArtPayload, PlaybackMetadata } from '@/ports/types/playback';
import type { PlayerRegistryPort } from '@/ports/PlayerRegistryPort';
import type { MdnsBrowser, MdnsPort, MdnsRegistration } from '@/ports/MdnsPort';
import { advertisableIpv4Addresses } from '@/shared/utils/net';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { PassThrough } from 'stream';
import {
  AirPlayReceiver,
  sendRemoteCommand,
  type ReceiverAdvertisement,
  type ReceiverEvent,
} from '@sonn-audio/node-airplay';

/** How long a sender may go quiet before we call it a pause. */
const AUDIO_IDLE_PAUSE_MS = 1500;

/**
 * How long a sender may send nothing but silence before we call it a pause.
 *
 * A paused iPhone does not go quiet: it keeps the stream running on silent
 * packets, so the idle watchdog never fires. Long enough that no track's own
 * gap or hush is mistaken for one.
 */
const SILENCE_PAUSE_MS = 4000;

/**
 * The loudest sample (of 32767) that still counts as silence: about -78 dBFS,
 * so only digital silence and the last bit of dither below it qualify. The
 * quietest passage of real music is well above this.
 */
const SILENCE_SAMPLE_LIMIT = 4;

/** How long to wait for the sender's remote-control service to answer. */
const DACP_LOOKUP_TIMEOUT_MS = 2000;

export interface AirplayInstanceController {
  startPlayback(
    zoneId: number,
    label: string,
    source: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void;
  updateMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void;
  updateCover(zoneId: number, cover?: CoverArtPayload): string | void;
  updateVolume(zoneId: number, volume: number): void;
  updateTiming(zoneId: number, elapsed: number, duration: number): void;
  pausePlayback(zoneId: number): void;
  resumePlayback(zoneId: number): void;
  stopPlayback(zoneId: number): void;
}

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_CHANNELS = 2;

export class AirplayInstance {
  private readonly log: ComponentLogger;
  private readonly label: string;
  private readonly hardwareAddress: string;
  private zoneName: string;
  private stopping = false;
  private isPlaying = false;
  private currentMetadata: Partial<PlaybackMetadata> = {};
  private coverArt?: CoverArtPayload;
  private coverUrl?: string;
  private lastPublishedMetadata?: string;
  private currentVolume = 0;
  private sessionActive = false;
  private currentElapsedSec = 0;
  private currentDurationSec = 0;
  private receiver: AirPlayReceiver | null = null;
  private advertisement: MdnsRegistration | null = null;
  /** The streaming device's remote-control identity, for play/pause/skip back at it. */
  private dacpId: string | null = null;
  private activeRemote: string | null = null;
  private httpRequest: http.ClientRequest | null = null;
  private httpResponse: http.IncomingMessage | null = null;
  private httpPort?: number;
  private httpHost?: string;
  private pcmStream: PassThrough | null = null;
  private pcmSampleRate = DEFAULT_SAMPLE_RATE;
  private pcmChannels = DEFAULT_CHANNELS;
  private pcmLogged = false;
  private pcmBackpressured = false;
  private pcmBytesIn = 0;
  private pcmStatsTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Bytes of unbroken silence received, to tell a paused sender from a playing one. */
  private silentBytes = 0;
  private pcmBytesTotal = 0;
  /**
   * Bumped on every track change so the audiopath we publish changes with it.
   *
   * An AirPlay zone has no real queue: the sender pushes one continuous stream
   * and only the metadata changes. A queue-driven client (the Loxone app) reads
   * that as one long track and keeps running its own progress clock across a
   * track change, however faithfully we broadcast `time=0`. Giving each track
   * its own audiopath is what tells such a client this is a different track.
   */
  private trackToken = 0;
  /** Identifies the artwork we last published, so a repeat push changes nothing. */
  private coverFingerprint = '';
  private lastTimingPushMs = 0;

  constructor(
    private readonly zoneId: number,
    zoneName: string,
    private readonly sourceMac: string,
    private config: ZoneAirplayConfig,
    private readonly controller: AirplayInstanceController,
    private readonly playerRegistry: PlayerRegistryPort,
    private readonly mdns: MdnsPort,
  ) {
    this.zoneName = zoneName;
    this.log = createLogger('Input', `AirPlay][${zoneName}`);
    this.label = 'airplay';
    this.hardwareAddress = deriveHardwareAddress(sourceMac, zoneId);
  }

  public async start(): Promise<void> {
    if (this.receiver !== null) {
      return;
    }
    await this.startServer();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    await this.stopServer();
    this.sessionActive = false;
    this.isPlaying = false;
    this.currentElapsedSec = 0;
    this.currentDurationSec = 0;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
    this.stopping = false;
  }

  public async updateConfig(config: ZoneAirplayConfig): Promise<void> {
    if (this.config.port === config.port && this.config.enabled === config.enabled) {
      this.config = config;
      return;
    }
    this.config = config;
    await this.restart();
  }

  public async updateZoneName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.zoneName) {
      this.zoneName = trimmed || this.zoneName;
      return;
    }
    this.zoneName = trimmed;
    await this.restart();
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start().catch((error) => {
      this.log.error('failed to restart airplay instance', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async startServer(): Promise<void> {
    const { portBase, portRange } = this.resolvePorts();
    const host = this.resolveHostAddress();
    this.httpHost = host;
    this.log.info('starting AirPlay receiver', {
      zoneId: this.zoneId,
      portBase,
      portRange,
      host,
    });
    try {
      const { receiver, advertisement } = await this.listenOnFreePort(portBase, portRange);
      this.receiver = receiver;

      // The receiver deliberately publishes nothing itself, so the service that
      // makes it findable is ours to announce.
      //
      // The hostname matters as much as the service does (#363). Left to itself
      // the responder uses this machine's own name for the SRV target -- a bare
      // label, outside `.local`, so a sender drops the address records that came
      // with it and asks unicast DNS instead. In a container that name is
      // `sonn-core` and resolves nowhere: the zone is listed and unreachable,
      // which reads as "it used to work". Publish the same per-zone `<MAC>.local`
      // the native receiver did, pinned to the one address we are reachable on.
      const hostname = `${advertisement.instanceName.split('@')[0]}.local`;
      const addresses = this.advertisableAddress(host);
      this.advertisement = this.mdns.publish({
        name: advertisement.instanceName,
        type: 'raop',
        protocol: 'tcp',
        port: advertisement.port,
        host: hostname,
        ...(addresses ? { addresses } : {}),
        txt: advertisement.txt,
      });

      this.log.info('airplay receiver ready', {
        zoneId: this.zoneId,
        port: advertisement.port,
        name: advertisement.instanceName,
        hostname,
        address: addresses?.[0] ?? host,
      });
    } catch (error) {
      this.receiver = null;
      this.log.error('failed to start airplay receiver', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The address to pin the advertisement to, when it is one a LAN client can actually reach.
   *
   * {@link resolveHostAddress} falls back to the first non-internal interface, and on a host
   * running containers that can be a bridge. Pinning it would advertise an address nothing off
   * this machine can route; handing back nothing lets the responder narrow the set itself.
   */
  private advertisableAddress(host: string | undefined): string[] | undefined {
    return host && advertisableIpv4Addresses().includes(host) ? [host] : undefined;
  }

  /**
   * Claim the first free port in the zone's range.
   *
   * Zones derive their base port from their id, so two servers -- or a stale
   * process on the way out -- can want the same one, and a receiver that cannot
   * bind is a room that never appears at all. The native receiver walked the
   * range for that reason; binding the base port alone brought that back.
   */
  private async listenOnFreePort(
    portBase: number,
    portRange: number,
  ): Promise<{ receiver: AirPlayReceiver; advertisement: ReceiverAdvertisement }> {
    const attempts = Math.max(1, portRange);
    for (let offset = 0; offset < attempts; offset++) {
      const receiver = new AirPlayReceiver(
        {
          name: this.zoneName,
          model: this.config.model || 'SonnCoreAirplay',
          ...(this.hardwareAddress ? { mac: Buffer.from(this.hardwareAddress.replace(/[^0-9a-f]/gi, ''), 'hex') } : {}),
          port: portBase + offset,
          onRequest: (info) =>
            this.log.info('airplay rtsp request', {
              zoneId: this.zoneId,
              method: info.method,
              appleChallenge: info.appleChallenge,
              encryptedKey: info.encryptedKey,
              headers: info.headers.join(','),
            }),
        },
        (event) => this.handleRaopEvent(event),
      );
      try {
        return { receiver, advertisement: await receiver.start() };
      } catch (error) {
        if (!isAddressInUse(error) || offset === attempts - 1) {
          throw error;
        }
        this.log.debug('airplay port taken; trying the next one', {
          zoneId: this.zoneId,
          port: portBase + offset,
        });
      }
    }
    // Unreachable: the loop either returns or throws on its last attempt.
    throw new Error('no free port in range');
  }

  private async stopServer(): Promise<void> {
    if (this.receiver !== null) {
      try {
        this.receiver?.stop();
      } catch (error) {
        this.log.warn('failed to stop airplay receiver', {
          zoneId: this.zoneId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.receiver = null;
    try {
      this.advertisement?.stop();
    } catch {
      /* the service goes away with the process anyway */
    }
    this.advertisement = null;
    this.dacpId = null;
    this.activeRemote = null;
    this.stopHttpStream();
    this.httpPort = undefined;
    this.httpHost = undefined;
    this.endPcmStream();
  }

  private resolvePorts(): { portBase: number; portRange: number } {
    const base = typeof this.config.port === 'number' && this.config.port > 0 ? this.config.port : 6000 + (this.zoneId % 500);
    const portBase = base;
    const portRange = 100;
    return { portBase, portRange };
  }

  private resolveHostAddress(): string | undefined {
    const interfaces = os.networkInterfaces();
    const normalizedMac = this.sourceMac.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
    let fallbackHost: string | undefined;
    for (const addresses of Object.values(interfaces)) {
      if (!addresses) {
        continue;
      }
      for (const addr of addresses) {
        if (addr.family !== 'IPv4' || addr.internal) {
          continue;
        }
        const addrMac = (addr.mac || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
        if (!fallbackHost) {
          fallbackHost = addr.address;
        }
        if (normalizedMac && addrMac === normalizedMac) {
          return addr.address;
        }
      }
    }
    return fallbackHost;
  }

  private handleRaopEvent(event: ReceiverEvent): void {
    // Everything except the audio itself: a line per packet is ~86 a second,
    // each one formatted, written out, buffered and pushed to any open log
    // view. That is enough to hold up the event loop the audio runs on, and
    // turns into audible stutter -- at spam level as much as at any other, so
    // the audio path is logged only by the once-a-second input state.
    if (event.type !== 'pcm') {
      this.log.debug('airplay raop event', { zoneId: this.zoneId, type: event.type });
    }
    switch (event.type) {
      case 'stream':
        // The PCM arrives as events on this path, so there is no stream to go
        // and fetch — the port is only worth noting.
        this.log.info('airplay stream announced', { zoneId: this.zoneId, port: event.port });
        break;
      case 'remote':
        this.dacpId = event.dacpId;
        this.activeRemote = event.activeRemote;
        this.log.debug('airplay remote identity', { zoneId: this.zoneId, dacpId: event.dacpId });
        break;
      case 'play':
        this.handlePlaybackStart();
        break;
      case 'pause':
        this.handlePlaybackPause();
        break;
      case 'flush':
        // A RAOP FLUSH means "drop what you have buffered, a new position is
        // coming" -- not "pause". Every sender issues one right after RECORD,
        // and treating that as a transport pause lands it in the middle of the
        // output negotiating its stream, which leaves the zone paused for good.
        // A real pause shows up as the audio simply stopping; the idle watchdog
        // below is what notices that.
        this.log.debug('airplay flush', { zoneId: this.zoneId });
        break;
      case 'stop':
        this.handlePlaybackStop();
        break;
      case 'volume':
        this.handleVolumeChange(event.value);
        break;
      case 'metadata':
        this.applyMetadataFromObject({
          title: event.title,
          artist: event.artist,
          album: event.album,
          // DMAP carries the track length with every metadata push, where the
          // sender's progress updates are sparse -- so this is the length that
          // can be relied on to arrive for each new track.
          durationMs: event.durationMs,
        });
        break;
      case 'progress':
        // Position and length only ever come from the sender -- the audio
        // itself carries no notion of where in the track it is.
        this.applyMetadataFromObject({
          durationMs: event.durationMs,
          elapsedMs: event.elapsedMs,
        });
        break;
      case 'artwork':
        // Cover art arrives on its own; the track fields came with the metadata
        // event before it and must not be blanked here.
        this.applyMetadataFromObject({ artwork: event.data });
        break;
      case 'pcm':
        this.handlePcmFrame(event.data, event.sampleRate, event.channels);
        break;
      default:
        break;
    }
  }

  public markStopping(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
  }

  /** Force-stop only the active AirPlay session/stream while keeping the receiver running. */
  public stopActiveSession(reason?: string): void {
    if (!this.sessionActive && !this.httpResponse) {
      return;
    }
    this.log.info('forcing airplay session stop', { zoneId: this.zoneId, reason });
    this.sessionActive = false;
    this.isPlaying = false;
    this.stopHttpStream();
    this.endPcmStream();
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.stop('airplay_forced_stop');
    } else {
      this.controller.stopPlayback(this.zoneId);
    }
    this.resetMetadata(true);
    if (reason?.startsWith('switch_to_')) {
      this.log.info('restarting airplay receiver to drop client', { zoneId: this.zoneId, reason });
      void this.restart();
    }
  }

  /**
   * Send a transport command back to the device streaming into this zone.
   *
   * The sender publishes an `_dacp._tcp` service named `iTunes_Ctrl_<DACP-ID>`,
   * and hands us both that id and an `Active-Remote` token in its RTSP headers.
   * Resolving the service is a live mDNS lookup each time: the sender may have
   * moved, and the answer is only useful for as long as the session lasts.
   */
  public sendRemoteCommand(
    command: 'Play' | 'Pause' | 'PlayPause' | 'Stop' | 'Next' | 'Previous' | 'ToggleMute',
  ): void {
    const remoteCommand = this.resolveRemoteCommand(command);
    if (!remoteCommand || !this.dacpId || !this.activeRemote) {
      this.log.debug('remote command unavailable (airplay server)', {
        zoneId: this.zoneId,
        command,
        hasIdentity: Boolean(this.dacpId && this.activeRemote),
      });
      return;
    }
    void this.resolveDacpEndpoint(this.dacpId)
      .then(async (endpoint) => {
        if (!endpoint) {
          this.log.debug('airplay remote control service not found', {
            zoneId: this.zoneId,
            dacpId: this.dacpId,
          });
          return;
        }
        const sent = await sendRemoteCommand(
          endpoint.host,
          endpoint.port,
          this.activeRemote as string,
          remoteCommand,
        );
        if (!sent) {
          this.log.warn('airplay remote command not sent', { zoneId: this.zoneId, command });
        }
      })
      .catch((error: unknown) => {
        this.log.debug('airplay remote command failed', {
          zoneId: this.zoneId,
          command,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /** Find the sender's `_dacp._tcp` service, or null when it does not answer in time. */
  private async resolveDacpEndpoint(
    dacpId: string,
  ): Promise<{ host: string; port: number } | null> {
    const wanted = `iTunes_Ctrl_${dacpId}`.toLowerCase();
    return await new Promise<{ host: string; port: number } | null>((resolve) => {
      let browser: MdnsBrowser | null = null;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (endpoint: { host: string; port: number } | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        browser?.stop();
        resolve(endpoint);
      };
      browser = this.mdns.browse({ type: 'dacp', protocol: 'tcp' }, (service) => {
        if ((service.name ?? '').toLowerCase() !== wanted) {
          return;
        }
        const address =
          (service.addresses ?? []).find((value) => value.includes('.')) ?? service.host;
        if (address && service.port) {
          finish({ host: address, port: service.port });
        }
      });
      if (settled) {
        // Answered from cache before browse() returned: stop what finish() could not see yet.
        browser.stop();
        return;
      }
      timer = setTimeout(() => finish(null), DACP_LOOKUP_TIMEOUT_MS);
    });
  }

  /**
   * Not available on this path. RAOP has no verb for a receiver to set the
   * SENDER's volume — the old native server exposed one, but it only ever
   * mirrored what the sender had already told us.
   */
  public setRemoteVolume(percent: number): void {
    this.log.debug('remote volume unavailable (airplay server)', {
      zoneId: this.zoneId,
      percent,
    });
  }

  private startHttpStream(port: number | undefined): void {
    if (!port || port <= 0) {
      return;
    }
    const host = this.httpHost || '127.0.0.1';
    if (this.httpPort === port && this.httpHost === host && this.httpResponse && !this.httpResponse.complete) {
      return;
    }
    this.stopHttpStream();
    this.httpPort = port;
    this.httpHost = host;
    this.log.info('connecting to airplay http stream', { zoneId: this.zoneId, host, port });
    const req = http.get(
      {
        host,
        port,
        path: '/',
        headers: {
          'Icy-MetaData': '0',
        },
      },
      (res) => {
        this.httpResponse = res;
        if (res.statusCode && res.statusCode >= 300) {
          this.log.warn('airplay http stream returned non-OK status', {
            zoneId: this.zoneId,
            status: res.statusCode,
          });
          this.stopHttpStream();
          return;
        }
        res.on('data', (chunk: Buffer) => this.handlePcmFrame(chunk));
        res.on('end', () => {
          this.log.info('airplay http stream ended', { zoneId: this.zoneId });
          this.stopHttpStream();
          if (!this.stopping) {
            this.handlePlaybackStop();
          }
        });
        res.on('error', (error) => {
          this.log.warn('airplay http stream error', {
            zoneId: this.zoneId,
            message: error instanceof Error ? error.message : String(error),
          });
          this.stopHttpStream();
          if (!this.stopping) {
            this.handlePlaybackStop();
          }
        });
      },
    );
    req.on('error', (error) => {
      this.log.warn('airplay http request error', {
        zoneId: this.zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopHttpStream();
      if (!this.stopping) {
        this.handlePlaybackStop();
      }
    });
    req.on('close', () => {
      this.httpRequest = null;
    });
    this.httpRequest = req;
  }

  private stopHttpStream(): void {
    if (this.httpResponse) {
      this.httpResponse.removeAllListeners();
      // Re-attach a no-op error handler BEFORE destroy(): destroying the socket
      // emits a final 'error' ("socket hang up"). Without a listener Node treats
      // an 'error' event as fatal — an unhandled exception that crashes the whole
      // server. This happens on resume when the sender re-opens the HTTP audio
      // stream (a brief double-connect) and we tear the old one down.
      this.httpResponse.on('error', () => {});
      this.httpResponse.destroy();
    }
    if (this.httpRequest) {
      this.httpRequest.removeAllListeners();
      this.httpRequest.on('error', () => {});
      this.httpRequest.destroy();
    }
    this.httpResponse = null;
    this.httpRequest = null;
  }

  private handlePcmFrame(payload: Buffer, sampleRate?: number, channels?: number): void {
    if (!payload?.length) {
      return;
    }
    if (typeof sampleRate === 'number' && sampleRate > 0) {
      this.pcmSampleRate = sampleRate;
    }
    if (typeof channels === 'number' && channels > 0) {
      this.pcmChannels = channels;
    }
    const silent = isNearSilence(payload);
    this.silentBytes = silent ? this.silentBytes + payload.length : 0;
    if (!this.sessionActive || !this.isPlaying) {
      if (silent) {
        // What a paused sender keeps sending to hold the session open. It is
        // not playback, so it neither starts nor resumes the zone, and it is
        // not buffered either: queued up, it would sit as a delay in front of
        // the music when that comes back.
        return;
      }
      if (!this.sessionActive) {
        this.handlePlaybackStart();
      } else {
        this.handlePlaybackResume();
      }
    }
    if (!this.pcmStream) {
      this.pcmStream = new PassThrough({ highWaterMark: 512 * 1024 });
    }
    // A live stream sits at its buffer limit whenever the consumer reads in
    // larger blocks than the sender writes, which is the normal steady state
    // here rather than a fault. Log the transitions, not every packet: nothing
    // is dropped either way, so per-chunk logging is pure noise.
    const ok = this.pcmStream.write(payload);
    if (ok !== !this.pcmBackpressured) {
      this.pcmBackpressured = !ok;
      this.log.debug(ok ? 'pcm stream draining again' : 'pcm stream at buffer limit', {
        zoneId: this.zoneId,
      });
    }
    if (!this.pcmStatsTimer) {
      // Once a second: how much audio is queued between the sender and whatever
      // consumes it. A depth that keeps climbing means the consumer is behind;
      // a flat one that is simply large is only latency.
      this.pcmStatsTimer = setInterval(() => {
        const stream = this.pcmStream;
        if (!stream) {
          return;
        }
        this.log.debug('airplay input state', {
          zoneId: this.zoneId,
          bufferedMs: Math.round((stream.writableLength / (44100 * 4)) * 1000),
          bytesInPerSec: this.pcmBytesIn,
          paused: stream.isPaused(),
          ...(this.receiver?.stats ?? {}),
        });
        this.pcmBytesIn = 0;
      }, 1000);
      this.pcmStatsTimer.unref?.();
    }
    this.pcmBytesIn += payload.length;
    this.noteAudioActivity();
    if (!this.pcmLogged) {
      this.pcmLogged = true;
      this.log.info('airplay pcm stream started', {
        zoneId: this.zoneId,
        sampleRate: this.pcmSampleRate,
        channels: this.pcmChannels,
        bytes: payload.length,
      });
    }
    this.handlePcmTimingUpdate(payload.length);
    const bytesPerSecond = this.pcmSampleRate * this.pcmChannels * 2;
    if (silent && this.silentBytes >= (bytesPerSecond * SILENCE_PAUSE_MS) / 1000) {
      this.log.debug('airplay audio is only silence; pausing', { zoneId: this.zoneId });
      this.handlePlaybackPause();
    }
  }

  private handleVolumeChange(raw: number): void {
    if (!Number.isFinite(raw)) {
      return;
    }
    const interpreted =
      raw <= 1 && raw >= 0 ? Math.round(raw * 100) : raw <= 0 && raw >= -144 ? mapDbToPercent(raw) : Math.round(raw);
    const volume = Math.max(0, Math.min(100, interpreted));
    if (volume === this.currentVolume) {
      return;
    }
    this.currentVolume = volume;
    this.log.info('airplay volume changed', {
      zoneId: this.zoneId,
      raw,
      volume,
    });
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.setVolume(volume);
    } else {
      this.controller.updateVolume(this.zoneId, volume);
    }
  }

  /** Map a zone command onto the DACP verb the sender's remote service expects. */
  private resolveRemoteCommand(
    command: 'Play' | 'Pause' | 'PlayPause' | 'Stop' | 'Next' | 'Previous' | 'ToggleMute',
  ): 'play' | 'pause' | 'playpause' | 'stop' | 'nextitem' | 'previtem' | 'mutetoggle' | null {
    switch (command) {
      case 'Play':
        return 'play';
      case 'Pause':
        return 'pause';
      case 'PlayPause':
        return this.isPlaying ? 'pause' : 'play';
      case 'Stop':
        return 'stop';
      case 'Next':
        return 'nextitem';
      case 'Previous':
        return 'previtem';
      case 'ToggleMute':
        return 'mutetoggle';
      default:
        return null;
    }
  }

  private applyMetadataFromObject(metadata: Record<string, unknown>): void {
    const readString = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
      return undefined;
    };
    const readNumber = (keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = metadata[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
        if (typeof value === 'string') {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      return undefined;
    };

    const prevTitle = this.currentMetadata.title ?? '';
    const prevArtist = this.currentMetadata.artist ?? '';
    const prevAlbum = this.currentMetadata.album ?? '';
    const title = readString(['title', 'name', 'songName', 'Song Name']);
    const artist = readString(['artist', 'Artist']);
    const album = readString(['album', 'albumName', 'Album']);
    if (title) {
      this.currentMetadata.title = title;
    }
    if (artist) {
      this.currentMetadata.artist = artist;
    }
    if (album) {
      this.currentMetadata.album = album;
    }

    const meta = metadata as Record<string, unknown> & { artwork?: { data?: unknown } | unknown };
    const artwork =
      meta.artworkData ??
      (meta.artwork as { data?: unknown } | undefined)?.data ??
      meta['artwork-data'] ??
      meta.artwork;
    const artworkMime =
      readString(['artworkMIMETYPE', 'artworkMime', 'artworkType']) ?? (this.coverArt?.mime ?? undefined);
    if (artwork) {
      try {
        const buf = Buffer.isBuffer(artwork)
          ? artwork
          : typeof artwork === 'string'
            ? Buffer.from(artwork, 'base64')
            : null;
        // The sender pushes the same artwork more than once per track. Minting a
        // fresh cover url each time makes a client abandon the download it had
        // started and begin again, so the picture mostly never arrives at all.
        const fingerprint = buf?.length ? createHash('sha1').update(buf).digest('hex') : '';
        if (buf?.length && fingerprint !== this.coverFingerprint) {
          this.coverFingerprint = fingerprint;
          this.coverArt = { data: buf, mime: artworkMime ?? detectMimeType(buf) };
          const coverUrl = this.controller.updateCover(this.zoneId, this.coverArt);
          this.coverUrl = typeof coverUrl === 'string' ? coverUrl : undefined;
          this.log.info('airplay cover art updated', {
            zoneId: this.zoneId,
            bytes: buf.length,
            mime: this.coverArt.mime,
          });
        }
      } catch {
        // ignore artwork parse failures
      }
    }

    const durationMs = readNumber(['durationMs', 'totalTimeMs', 'lengthMs']);
    const durationSeconds = readNumber(['duration', 'totalTime', 'length']);
    const durationProvided = (durationMs !== undefined && durationMs > 0) || (durationSeconds !== undefined && durationSeconds > 0);
    if (durationMs && durationMs > 0) {
      this.currentDurationSec = Math.max(0, Math.round(durationMs / 1000));
      this.currentMetadata.duration = this.currentDurationSec;
    } else if (durationSeconds && durationSeconds > 0) {
      this.currentDurationSec = Math.max(0, Math.round(durationSeconds));
      this.currentMetadata.duration = this.currentDurationSec;
    }
    const elapsedMs = readNumber(['positionMs', 'elapsedMs', 'progressMs', 'playbackPositionMs']);
    const elapsedSeconds = readNumber(['position', 'elapsedTime', 'progress', 'playbackPosition']);
    const elapsedProvided = elapsedMs !== undefined || elapsedSeconds !== undefined;
    if (elapsedProvided) {
      const elapsedSec = Math.max(0, Math.round(elapsedMs !== undefined ? elapsedMs / 1000 : elapsedSeconds!));
      this.currentElapsedSec = elapsedSec;
      const player = this.playerRegistry.getPlayer(this.zoneId);
      if (player) {
        player.updateTiming(elapsedSec, this.currentDurationSec);
      } else {
        this.controller.updateTiming(this.zoneId, elapsedSec, this.currentDurationSec);
      }
    }

    const resolvedTitle = this.currentMetadata.title ?? '';
    const resolvedArtist = this.currentMetadata.artist ?? '';
    const resolvedAlbum = this.currentMetadata.album ?? '';
    const trackChanged =
      (title && resolvedTitle !== prevTitle) ||
      (artist && resolvedArtist !== prevArtist) ||
      (album && resolvedAlbum !== prevAlbum);
    if (trackChanged) {
      this.trackToken += 1;
      this.pcmBytesTotal = 0;
      this.currentElapsedSec = 0;
      this.lastTimingPushMs = 0;
      if (!durationProvided) {
        this.currentDurationSec = 0;
        this.currentMetadata.duration = undefined;
      }
      const player = this.playerRegistry.getPlayer(this.zoneId);
      if (player) {
        player.updateTiming(0, this.currentDurationSec);
      } else {
        this.controller.updateTiming(this.zoneId, 0, this.currentDurationSec);
      }
    }

    this.publishMetadata();
  }

  private handlePlaybackStart(): void {
    if (!this.sessionActive) {
      if (this.httpPort) {
        this.startHttpStream(this.httpPort);
      }
      if (!this.pcmStream) {
        this.pcmStream = new PassThrough({ highWaterMark: 512 * 1024 });
      }
      this.sessionActive = true;
      this.isPlaying = true;
      const playbackSource: PlaybackSource = {
        kind: 'pipe',
        path: `airplay-${this.zoneId}`,
        format: 's16le',
        sampleRate: this.pcmSampleRate,
        channels: this.pcmChannels,
        stream: this.pcmStream,
      };
      // Always go through the controller so the zone manager can mark the active input
      // and keep Spotify outputs quiet while AirPlay owns the zone.
      this.controller.startPlayback(
        this.zoneId,
        this.label,
        playbackSource,
        this.buildPlaybackMetadata(),
      );
      this.pcmBytesTotal = 0;
      this.lastTimingPushMs = Date.now();
      this.currentElapsedSec = 0;
      this.currentDurationSec = this.currentMetadata.duration || 0;
      this.publishMetadata();
      return;
    }
    if (!this.isPlaying) {
      this.handlePlaybackResume();
    }
  }

  private handlePlaybackResume(): void {
    if (!this.sessionActive || this.isPlaying) {
      return;
    }
    this.isPlaying = true;
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.resume();
    } else {
      this.controller.resumePlayback(this.zoneId);
    }
  }

  /**
   * A sender does not announce a pause: it just stops sending audio (and its
   * RTSP session stays open, so nothing else tells us either). Treat a gap as
   * the pause it is, and let the next packet resume. A sender that pauses by
   * sending silence instead is caught in {@link handlePcmFrame}.
   */
  private noteAudioActivity(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.isPlaying) {
        this.log.debug('airplay audio went quiet; pausing', { zoneId: this.zoneId });
        this.handlePlaybackPause();
      }
    }, AUDIO_IDLE_PAUSE_MS);
    this.idleTimer.unref?.();
  }

  private handlePlaybackPause(): void {
    if (!this.sessionActive || !this.isPlaying) {
      return;
    }
    this.isPlaying = false;
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.pause();
    } else {
      this.controller.pausePlayback(this.zoneId);
    }
  }

  private handlePlaybackStop(): void {
    if (!this.sessionActive) {
      return;
    }
    this.sessionActive = false;
    this.isPlaying = false;
    this.stopHttpStream();
    this.endPcmStream();
    // Through the zone, never straight to its player. The sender ending its session is AirPlay
    // giving the room back, and only the zone can record that: stopping the player alone left the
    // zone believing AirPlay still owned it, so a Spotify Connect takeover long after the phone had
    // gone was refused as though it were stealing a live session (#420).
    this.controller.stopPlayback(this.zoneId);
    this.resetMetadata(true);
  }

  private buildPlaybackMetadata(): PlaybackMetadata {
    const fallbackTitle = `${this.zoneName} (AirPlay)`;
    return {
      title: this.currentMetadata.title || fallbackTitle,
      artist: this.currentMetadata.artist ?? '',
      album: this.currentMetadata.album ?? '',
      coverurl: this.coverUrl,
      duration: this.currentMetadata.duration,
      audiopath: `airplay://${this.sourceMac}/${this.trackToken}`,
    };
  }

  private publishMetadata(): void {
    const metadata = this.buildPlaybackMetadata();
    const serialized = JSON.stringify(metadata);
    const changed = serialized !== this.lastPublishedMetadata;
    if (changed) {
      this.lastPublishedMetadata = serialized;
    }
    if (changed) {
      this.log.info('airplay metadata updated', {
        zoneId: this.zoneId,
        title: metadata.title,
        artist: metadata.artist,
        album: metadata.album,
        cover: Boolean(metadata.coverurl),
        changed,
      });
    }
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.updateMetadata(metadata);
    } else {
      this.controller.updateMetadata(this.zoneId, metadata);
    }
  }

  private resetMetadata(clearCoverArt = false): void {
    this.currentMetadata = {};
    this.currentElapsedSec = 0;
    this.currentDurationSec = 0;
    this.pcmLogged = false;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
    // Do not push timing resets while an AirPlay session is bouncing; only reset when fully stopped.
    if (!this.sessionActive) {
      this.controller.updateTiming(this.zoneId, 0, 0);
    }
    if (clearCoverArt) {
      this.coverFingerprint = '';
      this.coverArt = undefined;
      const player = this.playerRegistry.getPlayer(this.zoneId);
      if (player) {
        player.updateCover(undefined);
      } else {
        const coverUrl = this.controller.updateCover(this.zoneId, undefined);
        this.coverUrl = typeof coverUrl === 'string' ? coverUrl : undefined;
      }
    }
    this.lastPublishedMetadata = undefined;
  }

  private endPcmStream(): void {
    if (this.pcmStatsTimer) {
      clearInterval(this.pcmStatsTimer);
      this.pcmStatsTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.pcmStream) {
      return;
    }
    try {
      this.pcmStream.end();
      this.pcmStream.destroy();
    } catch {
      // ignore
    }
    this.pcmStream = null;
    this.pcmLogged = false;
    this.pcmBytesTotal = 0;
    this.lastTimingPushMs = 0;
  }

  private handlePcmTimingUpdate(bytes: number): void {
    if (!bytes || bytes <= 0) {
      return;
    }
    const sampleRate = this.pcmSampleRate || DEFAULT_SAMPLE_RATE;
    const channels = this.pcmChannels || DEFAULT_CHANNELS;
    const bytesPerFrame = channels * 2; // 16-bit samples
    if (bytesPerFrame <= 0 || sampleRate <= 0) {
      return;
    }
    this.pcmBytesTotal += bytes;
    const elapsedSeconds = Math.floor(this.pcmBytesTotal / (bytesPerFrame * sampleRate));
    const elapsedSec = elapsedSeconds;
    const durationSec = this.currentDurationSec || this.currentMetadata.duration || 0;
    const now = Date.now();
    const shouldPublish =
      elapsedSec !== this.currentElapsedSec || now - this.lastTimingPushMs >= 1000;
    if (!shouldPublish) {
      return;
    }
    this.currentElapsedSec = elapsedSec;
    this.lastTimingPushMs = now;
    const player = this.playerRegistry.getPlayer(this.zoneId);
    if (player) {
      player.updateTiming(elapsedSec, durationSec);
    } else {
      this.controller.updateTiming(this.zoneId, elapsedSec, durationSec);
    }
  }

}

/**
 * Whether a block of s16le audio is silence: every sample within
 * {@link SILENCE_SAMPLE_LIMIT} of zero. Music bails out on its first sample.
 */
export function isNearSilence(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    if (sample > SILENCE_SAMPLE_LIMIT || sample < -SILENCE_SAMPLE_LIMIT) {
      return false;
    }
  }
  return true;
}

/** A port someone else already holds -- worth moving along for, unlike any other bind failure. */
function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

function detectMimeType(buffer: Buffer): string {
  if (!buffer?.length) {
    return 'image/jpeg';
  }
  if (buffer.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png';
  }
  if (buffer.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  return 'image/jpeg';
}

export function deriveHardwareAddress(sourceMac: string, zoneId: number): string {
  // sourceMac is the serial of whichever Loxone device carries the zone's outputs:
  // zones on one extension share it, and sibling devices differ only in the last
  // bytes, so no arithmetic on it yields a unique RAOP identifier (#356). Hash
  // serial+zone instead, and mark the address locally administered so it can never
  // collide with a real device's MAC.
  const serial = (sourceMac || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  const digest = createHash('sha256').update(`airplay:${serial}:${zoneId}`).digest();
  const bytes = Array.from(digest.subarray(0, 6));
  bytes[0] = ((bytes[0] ?? 0) | 0x02) & 0xfe; // unicast, locally administered
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(':');
}

function mapDbToPercent(db: number): number {
  if (db <= -144) {
    return 0;
  }
  const pct = Math.round(((db + 30) / 30) * 100);
  return Math.max(0, Math.min(100, pct));
}
