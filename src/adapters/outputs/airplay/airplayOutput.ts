import { createLogger } from '@/shared/logging/logger';
import type { PassThrough } from 'node:stream';
import type { PlaybackSession } from '@/ports/types/playback';
import { zoneSessionKey } from '@/ports/types/SessionKey';
import type { PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { computeGroupAnchorNtp } from '@/adapters/outputs/airplay/ap2Sender';
import { AirplayLaneSender } from '@/adapters/outputs/airplay/laneSender';
import type { AirplaySender } from '@/adapters/outputs/airplay/airplaySender';
import { AirplayStreamSession } from '@/adapters/outputs/airplay/airplayStreamSession';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { waitForReadableStream } from '@/shared/audio/streamReadiness';

export interface AirPlayOutputConfig {
  host: string;
  port?: number;
  name?: string;
  password?: string;
  debug?: boolean;
  /** Device encryption types (mDNS TXT `et`), resolved by the AdminUI picker. */
  et?: string;
  /** Device metadata capabilities (mDNS TXT `md`), resolved by the AdminUI picker. */
  md?: string;
  /**
   * What the device advertises about itself (mDNS TXT `features`/`ft`, `flags`/
   * `sf`, `model`/`am`), resolved by the AdminUI picker. This is what says
   * whether the device speaks AirPlay 2 at all, and so which lane to open; a
   * config saved before these were recorded simply has the AirPlay 2 handshake
   * tried first.
   */
  features?: string;
  flags?: string;
  model?: string;
  /** Multiroom sync offset (ms) for this output; positive = plays later. NOT the buffer. */
  latencyMs?: number;
  /**
   * Per-output device read-ahead buffer (ms). Default 750; raise for stutter-prone
   * devices (more resilience to jitter/underrun) at the cost of start/skip snappiness.
   */
  bufferMs?: number;
}

export const AIRPLAY_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'airplay',
  label: 'AirPlay',
  description: 'AirPlay output. Streams the session to a configured AirPlay (RAOP) device.',
  fields: [
    {
      id: 'host',
      label: 'AirPlay host',
      type: 'text',
      placeholder: '192.168.1.120',
      required: true,
      description: 'IP or hostname of the AirPlay/RAOP renderer.',
    },
    {
      id: 'port',
      label: 'AirPlay port',
      type: 'number',
      placeholder: '5000',
      advanced: true,
      description: 'Optional RTSP port override; when omitted, discovery picks it (RAOP is typically 5000).',
    },
    {
      id: 'name',
      label: 'Display name',
      type: 'text',
      placeholder: 'Living Room',
      advanced: true,
      description: 'Optional name shown in logs.',
    },
    {
      id: 'password',
      label: 'Password',
      type: 'text',
      placeholder: 'Optional password',
      advanced: true,
      description: 'Only needed for protected AirPlay devices.',
    },
    {
      id: 'bufferMs',
      label: 'Buffer (ms)',
      type: 'number',
      placeholder: '750',
      advanced: true,
      description:
        'Device read-ahead buffer in ms (default 750). Raise (e.g. 1500) for devices that stutter or underrun; higher = more resilient but slower start/skip. Range 250–5000.',
    },
    {
      id: 'debug',
      label: 'Debug logging',
      type: 'boolean',
      advanced: true,
      description: 'Writes every step of the AirPlay conversation to the log. For diagnosing a device that will not play.',
    },
  ],
};

/**
 * AirPlay output, driven by node-airplay. The sender owns the realtime side —
 * pairing, timing, ALAC and the encrypted RTP stream — and picks its own lane
 * per device: AirPlay 2 with PTP for receivers that serve it, the NTP lane for
 * those that advertise PTP without answering, and the sender's own read-ahead
 * for the rest. We feed it a continuous PCM stream and let its backpressure
 * pace us. The stream is kept alive across track switches so a track change is
 * metadata-only (no zap).
 */
export class AirPlayOutput implements ZoneOutput {
  public readonly type = 'airplay';

  /** Grouped zones stay in step here: every device is its own sender, started against one shared anchor. */
  public supportsNativeGrouping(): boolean {
    return true;
  }

  private readonly log = createLogger('Output', 'AirPlay');
  private readonly sender: AirplaySender;
  private readonly streamSession: AirplayStreamSession;
  private currentVolume = 0;
  private running = false;
  private starting = false;
  private paused = false;
  private lastSession: PlaybackSession | null = null;
  private attachedLeaderId: number | null = null;
  private groupSource: PassThrough | null = null;

  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private readonly retryIntervalMs = 1000;
  private readonly retryMaxAttempts = 20;
  private progressTimer: NodeJS.Timeout | null = null;
  private readonly progressIntervalMs = 2000;
  private volumeAssertTimer: NodeJS.Timeout | null = null;
  // Second volume assert, once audio is definitely flowing (see assertDeviceVolume).
  private readonly volumeAssertDelayMs = 1500;
  private readonly pcmStartTimeoutMs = 8000;
  private readonly pcmPipeTimeoutMs = 20000;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: AirPlayOutputConfig,
    private readonly ports: OutputPorts,
    initialVolume?: number,
  ) {
    this.sender = new AirplayLaneSender(
      {
        host: config.host.trim(),
        ...(typeof config.port === 'number' ? { port: config.port } : {}),
        ...(config.password?.trim() ? { password: config.password.trim() } : {}),
        ...(config.et ? { et: config.et } : {}),
        ...(config.features ? { features: config.features } : {}),
        ...(config.flags ? { flags: config.flags } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(Number.isFinite(config.bufferMs) ? { bufferMs: config.bufferMs } : {}),
        name: zoneName,
        onUnavailable: (reason: string) => this.handleSenderUnavailable(reason),
      },
      { zoneId, zoneName },
    );
    this.streamSession = new AirplayStreamSession(zoneId, this.ports.engine);
    // On a track-change source swap, flush the device buffer + ring and re-bind to
    // the fresh stream so the old track's buffered tail is dropped at the seam.
    this.streamSession.setOnResubscribe((stream) => this.sender.rebind(stream));
    if (Number.isFinite(initialVolume)) {
      this.currentVolume = Math.min(100, Math.max(0, Math.round(initialVolume as number)));
    }
    this.log.info('AirPlay output config', {
      zoneId,
      zoneName,
      host: config.host.trim(),
      port: config.port,
      et: config.et,
    });
    this.ports.airplayGroup.register(this.zoneId, this);
  }

  public async play(session: PlaybackSession): Promise<void> {
    this.paused = false;
    const isNewTrack = Boolean(this.lastSession && this.lastSession.stream?.id !== session.stream?.id);
    this.lastSession = session;

    if (!session.playbackSource) {
      this.log.warn('AirPlay output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay no source');
      return;
    }

    const effectiveOutput = this.ports.zoneAudioPrefs.getEffectiveOutputSettings(this.zoneId);
    this.streamSession.setPlaybackSource(session.playbackSource, effectiveOutput);

    // Track switch: keep the sender connected (no RTSP zap), but proactively swap
    // to the new engine session now — drop the old source + buffered tail and flush
    // the device buffer — instead of waiting for the old subscriber to drain. This
    // mirrors the sendspin output (re-subscribe + client-buffer reset per track).
    if (isNewTrack && this.sender.isRunning()) {
      this.running = true;
      this.clearRetry();
      // Grouped leader: re-batch identical fresh subscribers for the new track so
      // members stay frame-locked (senders stay connected, just re-attach). Falls
      // through to the solo switchTrack when not a leader-with-members.
      if (await this.ports.airplayGroup.startSyncedGroup(this.zoneId, false)) {
        void this.updateMetadata(session);
        return;
      }
      if (this.groupSource) {
        // We were a group leader but the group is gone (ungrouped). Leave group
        // mode: drop the group subscriber and re-feed the sender from a fresh solo
        // streamSession (which was disposed on group entry). Without this the
        // disposed streamSession's switchTrack() is a no-op and the next track is
        // silent.
        this.destroyGroupSource();
        const stream = this.streamSession.getStream();
        if (stream) {
          this.sender.rebind(stream);
        }
      } else {
        this.streamSession.switchTrack();
      }
      void this.updateMetadata(session);
      return;
    }

    // Non-leader of an active group: feed our own sender from the leader's stream.
    const joined = await this.ports.airplayGroup.tryJoinLeader(this);
    if (joined) {
      this.log.info('joined leader AirPlay session (multiroom)', { zoneId: this.zoneId });
      return;
    }

    if (this.running || this.starting) {
      // Already active; just make sure the source is bound and volume is current.
      const stream = this.streamSession.getStream();
      if (stream) {
        await this.sender.start(stream, this.currentVolume);
        this.assertDeviceVolume('play (already active)');
      }
      this.clearRetry();
      return;
    }

    const engineReady = await this.waitForEngine();
    if (!engineReady) {
      this.log.warn('AirPlay output skipped; no active audio engine session', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay engine not ready');
      return;
    }

    // If we lead a group with members, start every member sample-accurately from a
    // shared NTP anchor instead of a solo start. Falls through to solo when we are
    // not a leader-with-members (or the synced start could not be set up).
    if (await this.ports.airplayGroup.startSyncedGroup(this.zoneId, true)) {
      this.running = true;
      this.clearRetry();
      void this.updateMetadata(session);
      return;
    }

    const stream = this.streamSession.getStream();
    if (!stream) {
      this.log.warn('AirPlay output skipped; pcm stream unavailable', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'airplay pcm stream unavailable');
      return;
    }

    this.starting = true;
    try {
      const pcmTimeoutMs =
        session.playbackSource.kind === 'pipe' ? this.pcmPipeTimeoutMs : this.pcmStartTimeoutMs;
      const ready = await this.waitForPcmStream(stream, pcmTimeoutMs);
      if (!ready) {
        this.log.warn('AirPlay output skipped; PCM stream not ready', {
          zoneId: this.zoneId,
          timeoutMs: pcmTimeoutMs,
        });
        this.starting = false;
        this.scheduleRetry();
        return;
      }
      const started = await this.sender.start(stream, this.currentVolume);
      if (!started) {
        this.starting = false;
        this.scheduleRetry();
        return;
      }
      this.running = true;
      this.clearRetry();
      this.assertDeviceVolume('play');
    } finally {
      this.starting = false;
    }

    void this.updateMetadata(session);
    this.startProgressTimer();
    await this.ports.airplayGroup.syncGroupMembers(this);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    if (this.paused) {
      return;
    }
    this.log.info('AirPlay pause', { zoneId: this.zoneId, zoneName: this.zoneName });
    this.paused = true;
    this.stopProgressTimer();
    this.clearVolumeAssert();
    this.sender.pause();
    this.running = false;
    this.starting = false;
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay resume', { zoneId: this.zoneId, zoneName: this.zoneName });
    if (this.running || this.starting) {
      return;
    }
    this.paused = false;
    // The sender connection is kept across pause; re-anchor the RTP clock and
    // re-bind the source explicitly (sender.resume → senderControl('play'))
    // instead of relying on libraop's implicit accept-frames unpause.
    if (this.sender.isRunning() && !this.attachedLeaderId) {
      // Resume sendspin/snapcast-style: REUSE the existing subscriber + shared
      // stream (held at the pause position via backpressure during pause) instead
      // of re-subscribing fresh. getStream() returns that same paused subscriber;
      // sender.resume() re-anchors the device with `play` and un-gates the feed, so
      // playback continues from the exact sample — no fresh-subscriber skip.
      const stream = this.streamSession.getStream();
      if (stream) {
        this.sender.resume(stream);
        this.running = true;
        this.clearRetry();
        this.startProgressTimer();
        this.assertDeviceVolume('resume');
        void this.updateMetadata(session);
        return;
      }
    }
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('AirPlay stop', { zoneId: this.zoneId, zoneName: this.zoneName });
    this.clearRetry();
    this.stopProgressTimer();
    this.clearVolumeAssert();

    if (this.attachedLeaderId) {
      // We were a grouped member; just tear down our sender and detach.
      this.running = false;
      this.starting = false;
      await this.ports.airplayGroup.detachMember(this);
      return;
    }

    this.sender.stop();
    this.destroyGroupSource();
    this.running = false;
    this.starting = false;
    this.paused = false;
    this.lastSession = null;
    this.streamSession.dispose();
    this.ports.airplayGroup.onLeaderStopped(this.zoneId);
  }

  public getPreferredOutput(): PreferredOutput {
    // AirPlay/RAOP expects 44.1kHz PCM16 stereo.
    return {
      profile: 'pcm',
      sampleRate: 44100,
      channels: 2,
      bitDepth: 16,
      prebufferBytes: 256 * 1024,
    };
  }

  public getLatencyMs(): number {
    return this.sender.getLatencyMs();
  }

  public async dispose(): Promise<void> {
    await this.stop(null);
    this.ports.airplayGroup.unregister(this.zoneId);
  }

  public async setVolume(level: number): Promise<void> {
    if (!Number.isFinite(level)) return;
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    if (clamped === this.currentVolume) {
      return;
    }
    this.currentVolume = clamped;
    await this.sender.setVolume(this.currentVolume);
  }

  /**
   * Push the zone volume to the device again now that the RTP session is live.
   *
   * libraop asserts the volume exactly once, inside connect: a SET_PARAMETER right
   * after RECORD, before a single audio packet has gone out. Some devices — Sonos
   * in particular — drop that one and keep playing at whatever internal AirPlay
   * volume they retained, which is heard as "play works, the visualizer runs, but
   * it stays silent until you touch volume +/-" (#330). The volume dispatch that
   * follows every playback start can't fix it either: it normally carries the level
   * we already hold, and {@link setVolume} short-circuits an unchanged level. So
   * assert it explicitly here — once on start, and once more a moment later when
   * audio is definitely flowing, for devices that only honour volume mid-stream.
   */
  private assertDeviceVolume(reason: string): void {
    this.clearVolumeAssert();
    this.pushVolume(reason);
    const timer = setTimeout(() => {
      this.volumeAssertTimer = null;
      if (this.running && !this.paused) {
        this.pushVolume(`${reason} (mid-stream)`);
      }
    }, this.volumeAssertDelayMs);
    timer.unref?.();
    this.volumeAssertTimer = timer;
  }

  private pushVolume(reason: string): void {
    if (!this.sender.isRunning()) {
      return;
    }
    this.log.debug('AirPlay volume assert', {
      zoneId: this.zoneId,
      volume: this.currentVolume,
      reason,
    });
    void this.sender.setVolume(this.currentVolume);
  }

  private clearVolumeAssert(): void {
    if (!this.volumeAssertTimer) {
      return;
    }
    clearTimeout(this.volumeAssertTimer);
    this.volumeAssertTimer = null;
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? this.ports.audioManager.getSession(this.zoneId);
    if (!current) return;
    const meta = current.metadata;
    if (!meta) return;
    this.sender.updateMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      cover: current.cover ? { data: current.cover.data, mime: current.cover.mime } : undefined,
      // session elapsed/duration are in SECONDS; libraop wants milliseconds.
      elapsedMs: Number.isFinite(current.elapsed) ? current.elapsed * 1000 : undefined,
      durationMs: Number.isFinite(current.duration) ? current.duration * 1000 : undefined,
    });
  }

  // --- multiroom group participant ----------------------------------------

  public getZoneId(): number {
    return this.zoneId;
  }

  public getCurrentVolume(): number {
    return this.currentVolume;
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** PCM stream that grouped members feed their own senders from. */
  public getSharedStream(): PassThrough | null {
    return this.streamSession.getStream();
  }

  /**
   * Synced multiroom: open this output's own engine subscriber to the LEADER's
   * zone session (primeWithBuffer so it starts from the same rolling-buffer
   * snapshot as the other members). Must be called for every member in one
   * synchronous batch by the group controller so the snapshots are identical
   * (= same frame 0). Returns false if the engine stream is unavailable.
   */
  /** Shared NTP playback anchor for synced multiroom (delegated to the RAOP layer). */
  public computeGroupAnchor(prebufferMs: number): bigint {
    return computeGroupAnchorNtp(prebufferMs);
  }

  public createGroupSubscriber(leaderZoneId: number): boolean {
    this.destroyGroupSource();
    // We feed the sender from the group subscriber now, not the solo streamSession.
    // Dispose the latter so its (now unread) engine subscriber doesn't fill up and
    // backpressure-stall the whole engine session — which would silence every
    // member a couple seconds after the group starts. Recreated on solo return.
    this.streamSession.dispose();
    const stream = this.ports.engine.createStream(zoneSessionKey(leaderZoneId), 'pcm', {
      label: `airplay-group-${this.zoneId}`,
      primeWithBuffer: true,
    });
    this.groupSource = stream;
    return Boolean(stream);
  }

  /**
   * Start this output's sender from the batched group subscriber, anchored to the
   * shared NTP start so it plays frame-locked with the other members.
   */
  public async startGroupedSender(anchorNtp: bigint, reAnchor: boolean): Promise<boolean> {
    if (!this.groupSource) {
      return false;
    }
    const started = await this.sender.startForGroup(
      this.groupSource,
      this.currentVolume,
      anchorNtp,
      reAnchor,
    );
    this.running = started;
    this.starting = false;
    if (started) {
      this.startProgressTimer();
      this.assertDeviceVolume('grouped start');
    }
    return started;
  }

  private destroyGroupSource(): void {
    if (this.groupSource && !this.groupSource.destroyed) {
      try {
        this.groupSource.destroy();
      } catch {
        /* ignore */
      }
    }
    this.groupSource = null;
  }

  /** Start this output's sender from a leader's shared PCM stream (grouped member). */
  public async startFromLeaderStream(stream: NodeJS.ReadableStream, volume: number): Promise<void> {
    this.currentVolume = Math.min(100, Math.max(0, Math.round(volume)));
    const started = await this.sender.start(stream, this.currentVolume);
    this.running = started;
    if (started) {
      this.startProgressTimer();
      this.assertDeviceVolume('leader stream start');
    }
  }

  public async stopLocal(): Promise<void> {
    this.stopProgressTimer();
    this.clearVolumeAssert();
    this.sender.stop();
    this.destroyGroupSource();
    this.running = false;
    this.starting = false;
  }

  public markAttachedToLeader(leaderId: number): void {
    this.attachedLeaderId = leaderId;
  }

  public clearLeaderAttachment(): void {
    this.attachedLeaderId = null;
  }

  public isAttachedToLeader(leaderId: number): boolean {
    return this.attachedLeaderId === leaderId;
  }

  public getAttachedLeaderId(): number | null {
    return this.attachedLeaderId;
  }

  // --- internals -----------------------------------------------------------

  private async waitForPcmStream(stream: PassThrough, timeoutMs: number): Promise<boolean> {
    return waitForReadableStream(stream, { timeoutMs });
  }

  /**
   * Persist `et/md/port` discovered via runtime mDNS back into this zone's output
   * config, so a legacy config (saved before the device picker stored `et`) is
   * upgraded on first successful connect. After this the server uses the stored
   * values directly and no longer depends on runtime discovery (which matters for
   * MFi devices whose `et` is required for auth-setup).
   */

  private async waitForEngine(retries = 5, delayMs = 150): Promise<boolean> {
    let attempts = 0;
    while (attempts <= retries) {
      if (this.ports.engine.hasSession(zoneSessionKey(this.zoneId))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      attempts++;
    }
    return this.ports.engine.hasSession(zoneSessionKey(this.zoneId));
  }

  /** Push playback progress to the device periodically so its UI stays in sync. */
  private startProgressTimer(): void {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => {
      const session = this.ports.audioManager.getSession(this.zoneId);
      if (!session || !Number.isFinite(session.duration) || session.duration <= 0) {
        return;
      }
      // session timings are in seconds; the sender expects milliseconds.
      this.sender.setProgress((session.elapsed || 0) * 1000, session.duration * 1000);
    }, this.progressIntervalMs);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private handleSenderUnavailable(reason: string): void {
    if (!this.running && !this.starting) {
      return;
    }
    this.log.info('AirPlay device unavailable; stopping zone', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      reason,
    });
    this.running = false;
    this.starting = false;
    this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
  }

  private scheduleRetry(): void {
    if (this.retryAttempt >= this.retryMaxAttempts || this.retryTimer) {
      return;
    }
    const session = this.lastSession;
    if (!session) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryAttempt += 1;
      if (this.running || this.starting) {
        this.clearRetry();
        return;
      }
      void this.play(session);
    }, this.retryIntervalMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryAttempt = 0;
  }
}
