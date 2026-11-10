import { networkInterfaces } from 'node:os';
import { createLogger } from '@/shared/logging/logger';
import { bestEffort } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/ports/types/playback';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { isHttpUrl } from '@/shared/coverArt';
import { buildBaseUrl, resolveStreamUrl } from '@/shared/streamUrl';
import {
  chooseStreamProfile,
  parseStreamFormatPreference,
  streamProfileContentType,
  type StreamFormatPreference,
  type StreamProfileChoice,
} from '@/domain/outputs/streamProfilePolicy';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { CastDevice, DiscoveredDevice, MediaStatusModel } from '@sonn-audio/node-googlecast';
import { loadGoogleCastModule } from '@/adapters/outputs/googleCast/googlecastLoader';

const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';
export interface GoogleCastOutputConfig {
  host: string;
  name?: string;
  /** `auto` (lossless, with fallback), `lossless`, or `lossy`. See GoogleCastOutput.streamProfile. */
  streamFormat?: string;
  useSendspin?: boolean;
  sendspinNamespace?: string;
  sendspinPlayerId?: string;
  sendspinSyncDelayMs?: number;
}

export const GOOGLE_CAST_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'googleCast',
  label: 'Google Cast',
  description: 'Stream to a Google Cast device using the default media receiver.',
  fields: [
    {
      id: 'streamFormat',
      label: 'Sound quality',
      type: 'text',
      placeholder: 'auto',
      description:
        "Chromecast plays FLAC, so this sends the music unchanged by default. Set it to 'mp3' if the network cannot keep up — the server also falls back on its own if the device refuses the stream.",
    },
  ],
};

export class GoogleCastOutput implements ZoneOutput {
  public readonly type = 'googleCast';
  private readonly log = createLogger('Output', 'GoogleCast');
  private castDevice: CastDevice | null = null;
  private connected = false;
  private connectPromise?: Promise<void>;
  private receiverPromise?: Promise<void>;
  private lastLoadAt = 0;
  private lastLoadSignature: string | null = null;
  private loadPromise?: Promise<void>;
  private loadInFlightSignature: string | null = null;
  private loadToken = 0;
  private lastLoadTimeoutAt = 0;
  private readonly streamFormat: StreamFormatPreference;
  /** Set once this receiver has actually refused a lossless stream. */
  private losslessFailed = false;
  private lastLoadReconnectAt = 0;
  private lastMediaSessionId: number | null = null;
  private lastMetadataSignature: string | null = null;
  private lastMetadataUpdateAt = 0;
  private lastMetadataLoadAttemptAt = 0;
  private metadataLoadCooldownUntil = 0;
  private lastKnownVolume = 50;
  private lastKnownMuted: boolean | null = null;
  private lastOutboundVolumeAt: number | null = null;
  private lastOutboundVolume: number | null = null;
  private lastOutboundStateAt: number | null = null;
  private lastOutboundState: 'playing' | 'paused' | 'stopped' | null = null;
  private lastForwardedState: 'playing' | 'paused' | 'stopped' | null = null;
  private suppressRemoteStateUntil = 0;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    private readonly config: GoogleCastOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.streamFormat = parseStreamFormatPreference(config.streamFormat);
  }

  public isReady(): boolean {
    return this.connected;
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Google Cast output skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    this.markOutboundState('playing');
    await this.connect();
    await this.loadStream(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    if (this.castDevice) {
      // Best-effort pause; cast may reject during transitions.
      this.markOutboundState('paused');
      await bestEffort(() => this.castDevice!.media.pauseCurrent(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast pause failed',
        context: { zoneId: this.zoneId },
      });
      return;
    }
    await this.stopStream();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (!session) return;
    if (this.castDevice) {
      // Best-effort resume; cast may reject during transitions.
      this.markOutboundState('playing');
      await bestEffort(() => this.castDevice!.media.playCurrent(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast resume failed',
        context: { zoneId: this.zoneId },
      });
      return;
    }
    await this.play(session);
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.markOutboundState('stopped');
    await this.stopStream();
  }

  public async setPosition(positionMs: number): Promise<void> {
    if (!this.castDevice || !this.lastMediaSessionId) {
      this.log.debug('Google Cast seek skipped; no receiver or session', { zoneId: this.zoneId });
      return;
    }
    const seconds = Math.max(0, positionMs / 1000);
    this.log.debug('Google Cast seek', { zoneId: this.zoneId, seconds });
    await this.castDevice.media.seekCurrent(seconds).catch((err: unknown) => {
      this.log.debug('Google Cast seek failed', { zoneId: this.zoneId, message: (err as { message?: string } | null)?.message });
    });
  }

  public async dispose(): Promise<void> {
    await this.stopStream();
    this.disconnect();
  }

  public async setVolume(level: number): Promise<void> {
    if (!this.castDevice) return;
    const volume = Math.max(0, Math.min(1, level / 100));
    this.markOutboundVolume(level);
    await this.castDevice.volume.setVolume(volume).catch((err: unknown) => {
      this.log.debug('Google Cast setVolume failed', {
        zoneId: this.zoneId,
        message: (err as { message?: string } | null)?.message,
      });
    });
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) return;

    const signature = this.buildMediaSignature(session);
    if (signature === this.lastMetadataSignature) {
      return;
    }
    // Metadata often arrives while a load is still pending (Apple Music DRM/key extraction etc).
    // Do not start a second cast LOAD in parallel; it tends to time out and/or disconnect.
    if (this.loadPromise) {
      this.lastMetadataUpdateAt = Date.now();
      return;
    }
    if (signature === this.loadInFlightSignature) {
      // Avoid concurrent loads while a play/load is already running.
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = Date.now();
      return;
    }
    const now = Date.now();
    // Metadata is often populated/adjusted shortly after playback start (e.g. title/artist),
    // but re-loading the receiver can interrupt playback and slow start. Keep metadata updates
    // local for a short period after a successful load.
    if (this.lastLoadAt && now - this.lastLoadAt < 5000) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (signature === this.lastLoadSignature && now - this.lastLoadAt < 3000) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now < this.metadataLoadCooldownUntil) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now - this.lastMetadataUpdateAt < 1500) {
      return;
    }
    const meta = (session.metadata ?? {}) as { duration?: number };
    const durationSec = session.duration || meta.duration || 0;
    const isLiveStream = !durationSec || durationSec <= 0;
    if (isLiveStream) {
      // Avoid reloads for live streams; metadata updates require a session update API.
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (!this.castDevice) {
      this.lastMetadataSignature = signature;
      this.lastMetadataUpdateAt = now;
      return;
    }
    if (now - this.lastMetadataLoadAttemptAt < 1000) {
      return;
    }
    this.lastMetadataLoadAttemptAt = now;
    await bestEffort(() => this.loadStream(session), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label: 'cast metadata reload failed',
      context: { zoneId: this.zoneId },
    });
    this.lastMetadataSignature = signature;
    this.lastMetadataUpdateAt = now;
  }

  public getPreferredOutput(): PreferredOutput {
    return {
      profile: this.streamProfile(),
      sampleRate: 44100,
      channels: 2,
      prebufferBytes: 1024 * 256,
    };
  }

  /**
   * Lossless by default: every Cast audio device since the original Chromecast Audio decodes FLAC, and
   * the receiver *tells us* when a load fails, so unlike a DLNA renderer this endpoint can be trusted to
   * report its own limits. A failed lossless load flips {@link losslessFailed} and the next session falls
   * back to MP3, so a device that turns out not to manage it costs one failed start, once.
   */
  private streamProfile(): StreamProfileChoice {
    return chooseStreamProfile({
      preference: this.streamFormat,
      losslessSupported: true,
      losslessFailed: this.losslessFailed,
    });
  }

  public getHttpPreferences(): HttpPreferences {
    // Use chunked transfer (no Content-Length) and disable ICY metadata.
    //
    // A forced Content-Length is computed from the track duration, but for our live
    // transcode that duration is unreliable: it can be stale across an Apple Music
    // track handoff (the previous track's length lingers) or unknown (12h fallback).
    // When the real encoded byte count then ends short of the advertised length, Node
    // aborts the socket and Cast drops its buffered-ahead audio — clipping the tail of
    // every track. Chunked lets Cast play to the real end-of-stream and drain its buffer,
    // independent of any duration estimate.
    //
    // Cast buffers ~the engine's read-ahead (~8s) plus the prime burst, so the stream
    // closes several seconds before Cast finishes playing. Hold the connection open after
    // the source ends so Cast can drain its buffer without glitching/clipping the tail.
    return { httpProfile: 'chunked', icyEnabled: false, drainMsAfterEnd: 12000 };
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) {
      return this.connectPromise;
    }
    const { connect } = await loadGoogleCastModule();
    const device = this.buildDeviceDescriptor();

    const pending = (async (): Promise<void> => {
      const startedAt = Date.now();
      const castDevice = await connect(device);
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.castDevice = castDevice;
      this.connected = true;
      this.log.info('Google Cast connected', {
        zoneId: this.zoneId,
        host: this.config.host,
        durationMs,
      });
      castDevice.on('disconnected', (err?: Error) => {
        this.log.warn('Google Cast disconnected', {
          zoneId: this.zoneId,
          host: this.config.host,
          message: err?.message,
        });
        this.disconnect();
      });
      castDevice.on('error', (err: Error) => {
        this.log.warn('Google Cast client error', { zoneId: this.zoneId, message: err?.message });
        this.disconnect();
      });
      castDevice.on('mediaStatusModel', (status: MediaStatusModel) => this.handleStatus(status));
      castDevice.on('volumeChanged', (volume) => this.handleVolume(volume));
    })();

    // Compare against the wrapper actually stored: a settled attempt, failed or not, must never be
    // handed out again, or one EHOSTUNREACH while the speaker was off fails every later play (#424).
    const tracked: Promise<void> = pending.finally(() => {
      if (this.connectPromise === tracked) {
        this.connectPromise = undefined;
      }
    });
    this.connectPromise = tracked;

    return tracked;
  }

  private disconnect(): void {
    this.connected = false;
    if (this.castDevice) {
      // Best-effort close; cast clients may already be gone.
      void bestEffort(() => this.castDevice!.disconnect(), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'cast client close failed',
        context: { zoneId: this.zoneId },
      });
    }
    this.castDevice = null;
    this.lastLoadSignature = null;
    this.lastMetadataSignature = null;
    this.lastMediaSessionId = null;
    this.lastLoadAt = 0;
  }

  private async loadStream(session: PlaybackSession): Promise<void> {
    if (!this.castDevice) return;
    const media = this.buildMedia(session);
    const signature = this.buildMediaSignature(session);
    if (this.lastLoadSignature === signature && Date.now() - this.lastLoadAt < 1000) {
      return;
    }
    if (this.loadPromise && this.loadInFlightSignature === signature) {
      return this.loadPromise;
    }

    const token = (this.loadToken += 1);
    // A newer load replaces this one on the receiver, which cancels ours. Retrying it, or recording
    // it as the loaded media, would put the stale stream back over the new one (#431).
    const superseded = (): boolean => this.loadToken !== token;
    this.loadInFlightSignature = signature;
    const pending = (async (): Promise<void> => {
      const startedAt = Date.now();
      this.log.debug('Google Cast load start', {
        zoneId: this.zoneId,
        host: this.config.host,
        token,
        elapsed: session.elapsed ?? 0,
        contentId: media?.contentId,
      });
      await this.ensureReceiver();
      const now = Date.now();
      this.suppressRemoteStateUntil = Math.max(this.suppressRemoteStateUntil, now + 3000);
      let loaded = await this.loadMedia(media, {
        autoplay: true,
        currentTime: 0,
      });
      if (!loaded && !superseded()) {
        // If the load times out, the cast stack may be in a bad state; reconnect once and retry.
        const shouldReconnect = Date.now() - this.lastLoadTimeoutAt < 3000;
        const canReconnect = Date.now() - this.lastLoadReconnectAt > 10000;
        if (shouldReconnect && canReconnect) {
          this.lastLoadReconnectAt = Date.now();
          this.log.warn('Google Cast load timed out; reconnecting', {
            zoneId: this.zoneId,
            host: this.config.host,
          });
          this.disconnect();
          await this.connect();
        }

        await this.ensureReceiver();
        if (!superseded()) {
          loaded = await this.loadMedia(media, {
            autoplay: true,
            currentTime: 0,
          });
        }
      }
      if (!loaded || superseded()) {
        if (superseded()) {
          this.log.debug('Google Cast load superseded by a newer one', { zoneId: this.zoneId, token });
        }
        return;
      }
      this.lastLoadSignature = signature;
      this.lastMetadataSignature = signature;
      this.lastLoadAt = Date.now();
      this.metadataLoadCooldownUntil = Date.now() + 5000;
      // Autoplay should start playback; only attempt an explicit play when we see PAUSED later.
      void this.ensurePlayback();
      this.log.debug('Google Cast load finished', {
        zoneId: this.zoneId,
        host: this.config.host,
        token,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    })();

    this.loadPromise = pending.finally(() => {
      if (this.loadToken === token) {
        this.loadPromise = undefined;
        this.loadInFlightSignature = null;
      }
    });

    return this.loadPromise;
  }

  private async stopStream(): Promise<void> {
    if (!this.castDevice) return;
    // Best-effort stop; receiver may already be idle.
    await bestEffort(() => this.castDevice!.media.stopCurrent(), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label: 'cast stop failed',
      context: { zoneId: this.zoneId },
    });
  }

  private async ensureReceiver(): Promise<void> {
    if (!this.castDevice) return;
    const sessionAppId = this.castDevice.getSession?.()?.appId;
    if (sessionAppId === DEFAULT_MEDIA_RECEIVER_APP_ID) return;

    // IMPORTANT: receiver.getStatus() does not update CastDevice.session (it doesn't emit),
    // so "cached active appId" is not sufficient; we must (re)launch to get a transportId.

    if (this.receiverPromise) {
      return this.receiverPromise;
    }
    try {
      const startedAt = Date.now();
      const pending = this.castDevice.launchApp(DEFAULT_MEDIA_RECEIVER_APP_ID).then(() => undefined);
      const tracked: Promise<void> = pending.finally(() => {
        if (this.receiverPromise === tracked) {
          this.receiverPromise = undefined;
        }
      });
      this.receiverPromise = tracked;
      await tracked;
      const durationMs = Math.max(0, Date.now() - startedAt);
      this.log.debug('Google Cast receiver ready', { zoneId: this.zoneId, durationMs });
    } catch (err: unknown) {
      this.log.warn('Google Cast launch error', { zoneId: this.zoneId, message: (err as { message?: string } | null)?.message });
      throw err;
    }
  }

  private handleStatus(status: MediaStatusModel): void {
    if (!status) return;
    if (typeof status.mediaSessionId === 'number') {
      this.lastMediaSessionId = status.mediaSessionId;
    }
    this.log.debug('Google Cast status', {
      zoneId: this.zoneId,
      state: status.playerState,
      idleReason: status.idleReason,
      currentTime: status.currentTime,
      duration: status.duration,
    });
    const mappedStatus =
      status.playerIsPlaying ? 'playing' : status.playerIsPaused ? 'paused' : status.playerIsIdle ? 'stopped' : undefined;
    if (!mappedStatus) {
      return;
    }
    const duration = typeof status.duration === 'number' ? status.duration : undefined;
    const position = typeof status.currentTime === 'number' ? status.currentTime : undefined;
    const customData = status.mediaCustomData as Record<string, unknown>;
    const uriCandidate =
      customData?.uri ??
      customData?.queue_item_id ??
      status.contentId ??
      undefined;
    const uri = typeof uriCandidate === 'string' ? uriCandidate : undefined;
    this.ports.outputHandlers.onOutputState(this.zoneId, {
      status: mappedStatus,
      position,
      duration,
      uri,
    });
    const ignoreStop =
      mappedStatus === 'stopped' && status.playerIsIdle && status.idleReason === 'FINISHED';
    this.maybeForwardRemoteState(mappedStatus, { ignoreStop });
  }

  private handleVolume(volume?: {
    level?: number;
    muted?: boolean;
    controlType?: 'fixed' | 'attenuation' | 'master';
  }): void {
    if (!volume) return;
    if (typeof volume.level === 'number' && Number.isFinite(volume.level)) {
      const vol = Math.min(100, Math.max(0, Math.round(volume.level * 100)));
      const now = Date.now();
      const recentlySent =
        this.lastOutboundVolumeAt != null && now - this.lastOutboundVolumeAt < 1000;
      const outboundMatches =
        this.lastOutboundVolume != null && Math.abs(vol - this.lastOutboundVolume) <= 1;
      if (recentlySent && outboundMatches) {
        return;
      }
      if (vol !== this.lastKnownVolume) {
        this.lastKnownVolume = vol;
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
      }
    }
    if (typeof volume.muted === 'boolean' && volume.muted !== this.lastKnownMuted) {
      this.lastKnownMuted = volume.muted;
      if (volume.muted) {
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
      } else {
        this.ports.zoneManager.handleCommand(
          this.zoneId,
          'volume_set',
          String(this.lastKnownVolume),
        );
      }
    }
  }

  private maybeForwardRemoteState(
    state: 'playing' | 'paused' | 'stopped',
    options?: { ignoreStop?: boolean },
  ): void {
    const now = Date.now();
    if (now < this.suppressRemoteStateUntil) {
      return;
    }
    if (this.lastForwardedState === state) {
      return;
    }
    if (
      this.lastOutboundState === state &&
      this.lastOutboundStateAt != null &&
      now - this.lastOutboundStateAt < 1500
    ) {
      return;
    }
    this.lastForwardedState = state;
    switch (state) {
      case 'playing':
        this.ports.zoneManager.handleCommand(this.zoneId, 'play');
        break;
      case 'paused':
        this.ports.zoneManager.handleCommand(this.zoneId, 'pause');
        break;
      case 'stopped':
        if (options?.ignoreStop) {
          break;
        }
        this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
        break;
      default:
        break;
    }
  }

  private markOutboundVolume(level: number): void {
    this.lastOutboundVolumeAt = Date.now();
    this.lastOutboundVolume = Math.min(100, Math.max(0, Math.round(level)));
  }

  private markOutboundState(state: 'playing' | 'paused' | 'stopped'): void {
    this.lastOutboundStateAt = Date.now();
    this.lastOutboundState = state;
  }

  private buildMedia(session: PlaybackSession): any {
    const { baseUrl, streamUrl } = this.resolveStreamUrls(session);
    const coverUrl = this.resolveCoverUrl(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
      station?: string;
      duration?: number;
    };
    const durationSec = session.duration || meta.duration || 0;
    const normalizedDuration = durationSec > 0 ? durationSec : undefined;
    // Our `/streams/...` endpoints are live transcoded streams even when duration is known.
    // Declaring them as LIVE avoids cast trying to treat them like random-access VOD.
    const streamType = 'LIVE';
    return {
      contentId: streamUrl,
      contentType: streamProfileContentType(this.streamProfile()),
      streamType,
      duration: normalizedDuration,
      metadata: {
        metadataType: 3, // MUSIC_TRACK
        title: meta.title ?? this.zoneName,
        artist: meta.artist ?? meta.subtitle ?? '',
        albumName: meta.album ?? '',
        images: coverUrl ? [{ url: coverUrl }] : [],
        customData: {
          zoneId: this.zoneId,
          source: session.source,
          duration: normalizedDuration || null,
          station: meta.station ?? null,
        },
      },
      customData: {
        baseUrl,
      },
    };
  }

  private buildMediaSignature(session: PlaybackSession): string {
    const baseUrl = this.resolveBaseUrl();
    // Signature must be stable across time; do not include `prime` decisions.
    const streamUrl = resolveStreamUrl({
      baseUrl,
      zoneId: this.zoneId,
      streamPath: session.stream?.url,
      defaultExt: this.streamProfile() === 'flac' ? 'flac' : 'mp3',
    });
    const coverUrl = this.resolveCoverUrl(session);
    const meta = (session.metadata ?? {}) as {
      title?: string;
      artist?: string;
      subtitle?: string;
      album?: string;
      duration?: number;
    };
    const durationSec = session.duration || meta.duration || 0;
    return JSON.stringify({
      streamUrl,
      title: meta?.title,
      artist: meta?.artist ?? meta?.subtitle,
      album: meta?.album,
      coverUrl,
      durationSec,
    });
  }

  private shouldPrimeStream(session: PlaybackSession): boolean {
    const startedAt = session.playbackStartedAt ?? session.startedAt ?? 0;
    if (!startedAt) {
      return true;
    }
    // Prime only near the beginning so reconnects later in the track don't rewind audio.
    return Date.now() - startedAt < 2500;
  }

  private resolveStreamUrls(session: PlaybackSession): { baseUrl: string; streamUrl: string; coverUrl?: string } {
    const baseUrl = this.resolveBaseUrl();
    const prime = this.shouldPrimeStream(session) ? undefined : '0';
    const streamUrl = resolveStreamUrl({
      baseUrl,
      zoneId: this.zoneId,
      streamPath: session.stream?.url,
      defaultExt: this.streamProfile() === 'flac' ? 'flac' : 'mp3',
      // Prime sends buffered audio immediately, which typically shortens cast "BUFFERING" time.
      prime,
      primeMode: 'upsert',
    });
    return { baseUrl, streamUrl };
  }

  private async loadMedia(
    media: any,
    options: { autoplay?: boolean; currentTime?: number } = {},
  ): Promise<boolean> {
    if (!this.castDevice) return false;
    try {
      const startedAt = Date.now();
      const response: any = await this.castDevice.media.load(media.contentId, media.contentType, {
        metadata: media.metadata,
        streamType: media.streamType,
        customData: media.customData,
        autoplay: options.autoplay ?? true,
        startTime: options.currentTime ?? 0,
      });
      const sessionId = response?.status?.[0]?.mediaSessionId;
      if (typeof sessionId === 'number') {
        this.lastMediaSessionId = sessionId;
      }
      this.log.info('Google Cast stream loaded', {
        zoneId: this.zoneId,
        host: this.config.host,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
      return true;
    } catch (loadErr: unknown) {
      const message = (loadErr as { message?: string } | null)?.message ?? '';
      if (typeof message === 'string' && message.toLowerCase().includes('request timed out')) {
        this.lastLoadTimeoutAt = Date.now();
      }
      // A receiver that cannot take the lossless stream says so here. Remember it, so the next session
      // is MP3 rather than another silent start; the device's own evidence outranks our assumption.
      if (!this.losslessFailed && this.streamProfile() === 'flac') {
        this.losslessFailed = true;
        this.log.warn('Google Cast rejected the lossless stream; falling back to mp3 for this device', {
          zoneId: this.zoneId,
          host: this.config.host,
          message,
        });
      }
      this.log.warn('Google Cast load error', {
        zoneId: this.zoneId,
        host: this.config.host,
        appId: this.castDevice?.getSession?.()?.appId,
        message,
        contentId: media?.contentId,
      });
      if (typeof message === 'string' && message.toLowerCase().includes('load cancelled')) {
        this.metadataLoadCooldownUntil = Date.now() + 3000;
      }
      return false;
    }
  }

  private async ensurePlayback(): Promise<void> {
    try {
      if (!this.castDevice) return;
      const status = await this.castDevice.media.getStatusModel();
      if (typeof status.mediaSessionId === 'number') {
        this.lastMediaSessionId = status.mediaSessionId;
      }
      // Avoid spamming play() during transitions (BUFFERING/IDLE can reject with "Invalid request").
      if (status.playerState === 'PAUSED') {
        await this.castDevice.media.playCurrent();
      }
    } catch (err: unknown) {
      this.log.debug('Google Cast play after load failed', {
        zoneId: this.zoneId,
        message: (err as { message?: string } | null)?.message,
      });
    }
  }

  private resolveBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys?.audioserver?.ip?.trim(),
      fallbackHost: this.pickLocalAddress(),
    });
  }

  private buildDeviceDescriptor(): DiscoveredDevice {
    const name = this.config.name?.trim() || this.zoneName;
    return {
      id: `googlecast-${this.zoneId}-${this.config.host}`,
      name,
      host: this.config.host,
      port: 8009,
      lastSeen: Date.now(),
    };
  }

  private resolveCoverUrl(session: PlaybackSession): string | undefined {
    const cover = session.metadata?.coverurl;
    if (!cover) {
      return undefined;
    }
    const trimmed = cover.trim();
    if (!trimmed) {
      return undefined;
    }
    return isHttpUrl(trimmed) ? trimmed : undefined;
  }

  private pickLocalAddress(): string {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address) {
          return net.address;
        }
      }
    }
    return '127.0.0.1';
  }
}
