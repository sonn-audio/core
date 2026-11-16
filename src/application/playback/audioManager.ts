import { randomUUID } from 'node:crypto';
import type { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type {
  EngineOutputSpec,
  EngineStartOptions,
  PlaybackSource,
  OutputProfile,
} from '@/ports/EngineTypes';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';
import { declaredSourceRate } from '@/application/playback/policies/sourceRatePolicy';
import { resolveSourcePreDelayMs } from '@/application/playback/playbackPreDelay';
import { decodeAudiopath } from '@/domain/zones/audiopath';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import { zoneSessionKey, type SessionKey } from '@/ports/types/SessionKey';
import type { EngineSessionStats } from '@/ports/EnginePort';
import type { PlaybackService } from '@/application/playback/PlaybackService';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { EqualizerRestartScheduler } from '@/application/playback/EqualizerRestartScheduler';

/** What a caller may declare about a local file. Mirrors the engine source's `nativeFormat`. */
export type DeclaredFileFormat = {
  sampleRate: number;
  channels: number;
  bitDepth?: 16 | 24 | 32;
  lossless: boolean;
  codecName?: string;
};

import { toEngineInputSpec } from '@/ports/playbackSourceMapping';
import type {
  PlaybackMetadata,
  AudioStreamHandle,
  CoverArtPayload,
  PlaybackSession,
} from '@/ports/types/playback';

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputNotifier = {
  notifyOutputError: (zoneId: number, reason?: string) => void;
  notifyOutputState: (zoneId: number, state: OutputState) => void;
  /**
   * The length of what is playing, learned after the fact.
   *
   * Only ever fires for a track that started without one. The zone clock is what ends a track, and it
   * was handed a 0 at start, so telling the session alone would change nothing — this reaches the
   * player itself. See `AudioManager.watchSourceDuration`.
   */
  notifySourceDuration: (zoneId: number, durationSec: number) => void;
};

/**
 * Central coordinator for playback commands. Every play/pause/stop request
 * funnels through the audio manager so the same stream can be re-used by
 * future outputs (DLNA, AirPlay, Sendspin, ...).
 */
export class AudioManager {
  private readonly log = createLogger('Audio', 'Manager');
  private readonly sessions = new Map<number, PlaybackSession>();
  private readonly playRequestTimes = new Map<number, { requestedAt: number; uri?: string; type?: string }>();
  private readonly playRequestMaxAgeMs = 60_000;
  /**
   * Zones whose track started without a length, waiting for ffmpeg to state one.
   *
   * Cleared the moment a duration is adopted, the session stops, or the window below runs out — a
   * genuinely live source never answers and must not be polled for the rest of its life.
   */
  private readonly durationWatchers = new Map<number, NodeJS.Timeout>();
  private readonly durationPollMs = 500;
  /**
   * How long to keep asking. Generous, because a stream whose index sits at the end only states its
   * length once ffmpeg has read it all — but bounded, because that case is also caught for free when
   * the engine exits (see `handleEngineTermination`), and a live source would otherwise be polled forever.
   */
  private readonly durationWatchMs = 30_000;
  private readonly playbackService: PlaybackService;
  private readonly outputNotifier: OutputNotifier;
  private readonly prefs: ZoneAudioPreferences;
  public readonly equalizerScheduler: EqualizerRestartScheduler;
  /**
   * HTTP responses currently serving a given streamId. Each entry registers a
   * dispose() callback; calling closeSubscribersForStreamId() ends them all so
   * the squeezelite client gets a clean EOF on the OLD URL after a URL rotation.
   * Keyed by `${zoneId}:${streamId}`.
   */
  private readonly subscriberHandles = new Map<string, Set<() => void>>();

  /**
   * Where a local file's native format comes from, when something knows it.
   *
   * Set during bootstrap rather than passed in, because the library that answers it is built after
   * this manager. Unset, every file stays undeclared and the engine resamples as it always did.
   */
  private declaredFileFormat: ((filePath: string) => DeclaredFileFormat | null) | null = null;

  public setDeclaredFileFormatSource(
    lookup: ((filePath: string) => DeclaredFileFormat | null) | null,
  ): void {
    this.declaredFileFormat = lookup;
  }

  /**
   * Attach the file's own format to a source that does not carry one.
   *
   * `isBitPerfect` needs the source format to clear its first guard, and it is consulted when the
   * ffmpeg args are built — synchronously, at session construction. So the answer has to be present
   * *before* the engine starts, which is why it is looked up here rather than probed there. For a
   * scanned library track it is a single indexed read plus one stat.
   */
  private declareFileFormat(source: PlaybackSource | null): PlaybackSource | null {
    if (!source || source.kind !== 'file' || source.nativeFormat || !this.declaredFileFormat) {
      return source;
    }
    const declared = this.declaredFileFormat(source.path);
    return declared ? { ...source, nativeFormat: declared } : source;
  }

  constructor(
    playbackService: PlaybackService,
    outputNotifier: OutputNotifier,
    prefs: ZoneAudioPreferences,
  ) {
    this.playbackService = playbackService;
    this.outputNotifier = outputNotifier;
    this.prefs = prefs;
    this.equalizerScheduler = new EqualizerRestartScheduler({
      getSession: (zoneId) => this.sessions.get(zoneId),
      playbackService: this.playbackService,
      getEqualizerBands: (zoneId) => this.prefs.getEqualizerResolver()?.(zoneId) ?? null,
      log: this.log,
    });
    this.playbackService.setSessionTerminationHandler((key, stats, reason) =>
      this.handleEngineTermination(key, stats, reason),
    );
  }

  public markPlayRequest(zoneId: number, details?: { uri?: string; type?: string }): void {
    this.playRequestTimes.set(zoneId, {
      requestedAt: Date.now(),
      uri: details?.uri,
      type: details?.type,
    });
  }

  public clearPlayRequest(zoneId: number): void {
    this.playRequestTimes.delete(zoneId);
  }

  private peekPlayRequest(zoneId: number): { requestedAt: number; uri?: string; type?: string } | null {
    const entry = this.playRequestTimes.get(zoneId);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.requestedAt > this.playRequestMaxAgeMs) {
      return null;
    }
    return entry;
  }

  private claimPlayRequest(zoneId: number): { requestedAt: number; uri?: string; type?: string } | null {
    const entry = this.playRequestTimes.get(zoneId);
    if (!entry) {
      return null;
    }
    this.playRequestTimes.delete(zoneId);
    if (Date.now() - entry.requestedAt > this.playRequestMaxAgeMs) {
      return null;
    }
    return entry;
  }

  private decorateRadioSource(
    zoneId: number,
    source: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    rawSource?: string,
  ): PlaybackSource | null {
    if (!source || source.kind !== 'url' || !metadata?.isRadio) {
      return source;
    }
    const headers: Record<string, string> = { ...(source.headers ?? {}) };
    headers['Icy-MetaData'] = '1';
    if (this.isProxyUrl(source.url)) {
      headers['X-Loxone-Zone'] = String(zoneId);
    }
    const realTime = this.shouldUseRealTime(rawSource ?? source.url);
    return { ...source, headers, ...(realTime ? { realTime: true } : {}) };
  }

  private normalizeStartAtSec(startAtSec?: number): number | null {
    if (!Number.isFinite(startAtSec)) {
      return null;
    }
    const safe = Math.max(0, startAtSec ?? 0);
    return safe > 0 ? safe : null;
  }


  private applyStartAt(
    source: PlaybackSource | null,
    startAtSec?: number | null,
    metadata?: PlaybackMetadata,
  ): PlaybackSource | null {
    if (!source || !startAtSec || startAtSec <= 0) {
      return source;
    }
    if (metadata?.isRadio) {
      return source;
    }
    if (source.kind === 'pipe') {
      return source;
    }
    return { ...source, startAtSec };
  }

  private applyZonePlaybackPreDelay(zoneId: number, source: PlaybackSource | null): PlaybackSource | null {
    if (!source) {
      return source;
    }
    const rawZoneDelay = this.prefs.getPlaybackPreDelayMs(zoneId);
    const zoneDelay =
      Number.isFinite(rawZoneDelay) && (rawZoneDelay ?? 0) > 0 ? Math.max(0, Math.round(rawZoneDelay ?? 0)) : 0;
    // The zone's own wake-up delay is skipped when its amp is already on, but a
    // forced floor (set for a multi-zone alert) always applies so every target
    // zone starts together even when some amps were already warm.
    let powerOn = false;
    try {
      powerOn = this.prefs.getPowerStateResolver()?.(zoneId) === true;
    } catch {
      // Ignore resolver failures and keep safe fallback behavior.
    }
    const rawFloor = this.prefs.getAlertPreDelayFloorMs(zoneId);
    const floor = Number.isFinite(rawFloor) && (rawFloor ?? 0) > 0 ? Math.max(0, Math.round(rawFloor ?? 0)) : 0;
    const sourceDelay = resolveSourcePreDelayMs(source);
    const effectiveDelay = Math.max(sourceDelay, floor, powerOn ? 0 : zoneDelay);
    if (effectiveDelay <= 0 || sourceDelay === effectiveDelay) {
      return source;
    }
    return { ...source, preDelayMs: effectiveDelay };
  }

  private getStartAtSec(source: PlaybackSource | null): number {
    if (!source || source.kind === 'pipe') {
      return 0;
    }
    const startAtSec = (source as { startAtSec?: number }).startAtSec;
    if (!Number.isFinite(startAtSec)) {
      return 0;
    }
    return Math.max(0, startAtSec ?? 0);
  }

  private isProxyUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.pathname === '/streams/proxy';
    } catch {
      return false;
    }
  }

  private shouldUseRealTime(rawSource?: string): boolean {
    if (!rawSource) {
      return false;
    }
    const rawLower = rawSource.toLowerCase();
    if (
      rawLower.startsWith('tunein:') ||
      rawLower.startsWith('radio:') ||
      rawLower.includes('tunein') ||
      rawLower.includes('radioparadise')
    ) {
      return true;
    }
    const decoded = decodeAudiopath(rawSource);
    const decodedLower = (decoded || '').toLowerCase();
    return (
      decodedLower.startsWith('tunein:') ||
      decodedLower.startsWith('radio:') ||
      decodedLower.includes('tunein') ||
      decodedLower.includes('radioparadise')
    );
  }

  public startPlayback(
    zoneId: number,
    source: string,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
    options?: { startAtSec?: number },
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const playbackSource = this.declareFileFormat(
      this.decorateRadioSource(zoneId, resolvePlaybackSource(source), metadata, source),
    );
    const effectiveSource = this.applyStartAt(playbackSource, startAtSec, metadata);
    return this.startWithResolvedSource(
      zoneId,
      source,
      this.applyZonePlaybackPreDelay(zoneId, effectiveSource),
      metadata,
      requiresPcm,
    );
  }

  public startExternalPlayback(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
    options?: { startAtSec?: number },
  ): PlaybackSession | null {
    if (typeof requiresPcm === 'boolean') {
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const startAtSec = this.normalizeStartAtSec(options?.startAtSec);
    const rawSource = playbackSource?.kind === 'url' ? playbackSource.url : undefined;
    // Declared here too, not only in `startPlayback`: a caller that resolved the source itself can
    // still hand us a local file, and a file whose format nobody states is a file that gets
    // resampled. `declareFileFormat` only ever fills a gap, so a source that already carries one
    // passes through untouched.
    const decorated = this.declareFileFormat(
      this.decorateRadioSource(zoneId, playbackSource, metadata, rawSource),
    );
    const effectiveSource = this.applyStartAt(decorated, startAtSec, metadata);
    return this.startWithResolvedSource(
      zoneId,
      label,
      this.applyZonePlaybackPreDelay(zoneId, effectiveSource),
      metadata,
      requiresPcm,
    );
  }

  public pausePlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session || session.state !== 'playing') {
      return null;
    }
    // Keep the engine alive on pause so outputs can resume instantly.
    // Backpressure from zero subscribers will stall ffmpeg output safely.
    if (session.startedAt) {
      session.elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
    }
    session.state = 'paused';
    session.updatedAt = Date.now();
    this.log.debug('playback paused', { zoneId, source: session.source });
    return session;
  }

  public resumePlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    if (session.state === 'playing') {
      this.log.debug('resume ignored; already playing', { zoneId });
      return session;
    }
    if (!session.playbackSource) {
      session.state = 'playing';
      session.updatedAt = Date.now();
      session.startedAt = Date.now();
      this.log.debug('playback resumed (output-only)', { zoneId, source: session.source });
      return session;
    }
    // If we never tore down the engine, just flip state.
    if (this.playbackService.hasSession(zoneSessionKey(zoneId))) {
      const now = Date.now();
      session.state = 'playing';
      session.updatedAt = now;
      session.startedAt = now - (session.elapsed ?? 0) * 1000;
      // Restart the "is this session actively driving?" grace window, exactly as a restart on an
      // existing session does. An output that dropped its HTTP connection during the pause (Sonos
      // always does) needs a moment to come back, and until it has, subscriber count is 0 —
      // without this the stale timestamps make hasActiveLocalSession say no and the first state
      // patch from the speaker tears the session down mid-resume.
      session.playbackStartedAt = now;
      session.firstAudioReadyAt = undefined;
      this.log.debug('playback resumed (reusing engine session)', { zoneId, source: session.source });
      return session;
    }
    const rawElapsed = Number.isFinite(session.elapsed) ? Math.max(0, session.elapsed) : 0;
    const duration = session.duration ?? session.metadata?.duration ?? 0;
    const boundedElapsed =
      duration > 0 ? Math.min(rawElapsed, Math.max(0, duration - 1)) : rawElapsed;
    const resumeAtSec = this.normalizeStartAtSec(boundedElapsed);
    const effectiveSource =
      this.applyStartAt(session.playbackSource, resumeAtSec, session.metadata) ??
      session.playbackSource;
    const profiles = this.computeProfiles(
      effectiveSource,
      this.prefs.getPcmPreference(zoneId) ?? true,
      session.profiles,
    );
    const streamProfile = profiles.includes('flac') ? 'flac' : profiles.includes('aac') ? 'aac' : profiles.includes('mp3') ? 'mp3' : 'pcm';
    const handles = this.createStreamHandles(zoneId, streamProfile);
    session.stream = handles.stream;
    session.pcmStream = handles.pcmStream;
    const effectiveOutput = this.prefs.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
    this.playbackService.start(startOptions);
    session.playbackSource = effectiveSource;
    session.profiles = profiles;
    session.outputSettings = outputSignature;
    session.state = 'playing';
    session.updatedAt = Date.now();
    session.startedAt =
      resumeAtSec && resumeAtSec > 0 ? Date.now() - resumeAtSec * 1000 : Date.now();
    session.elapsed = boundedElapsed;
    session.firstAudioReadyAt = undefined;
    // A resume respawns ffmpeg, so the banner comes round again for a track that still has no length.
    this.watchSourceDuration(zoneId);
    this.log.debug('playback resumed', { zoneId, source: session.source });
    return session;
  }

  public stopPlayback(zoneId: number): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    this.playbackService.stop(zoneSessionKey(zoneId), 'stop', { discardSubscribers: true });
    this.clearDurationWatch(zoneId);
    this.sessions.delete(zoneId);
    this.log.debug('playback stopped', { zoneId, source: session.source });
    return session;
  }

  /**
   * Gracefully stop the current audio session for a zone without forcibly
   * destroying its HTTP subscriber connections. The ffmpeg process receives
   * SIGTERM and flushes remaining encoded audio; each HTTP subscriber
   * receives a clean stream `end()` so that squeezelite clients see a proper
   * EOF and fire their `STMd` (decoder-ready) event. This is required for
   * native-crossfade transitions where squeezelite's `STMd` event triggers the
   * enqueued next-track `strm` command.
   */
  public softStopPlayback(zoneId: number): void {
    this.playbackService.stop(zoneSessionKey(zoneId), 'crossfade-native', { discardSubscribers: false });
    // Note: sessions.delete() is intentionally NOT called here — the session
    // object is retained so that startWithResolvedSource can inspect it and
    // start the new engine cleanly. The subsequent startPlayback call will
    // call playbackService.stop() again which is a no-op (sessions map already
    // cleaned by the engine), and then create a fresh session entry.
  }

  public getStreamHandle(zoneId: number): AudioStreamHandle | null {
    return this.sessions.get(zoneId)?.stream ?? null;
  }

  public getSession(zoneId: number): PlaybackSession | null {
    return this.sessions.get(zoneId) ?? null;
  }

  /**
   * Returns true iff `streamId` is currently the active stream id for the zone, or it
   * is a recently-rotated id whose grace window has not yet expired. Used by the HTTP
   * stream handler to keep old URL connections valid during a URL handover.
   */
  public isStreamIdActive(zoneId: number, streamId: string): boolean {
    const session = this.sessions.get(zoneId);
    if (!session) return false;
    if (session.stream.id === streamId) return true;
    if (session.pcmStream?.id === streamId) return true;
    const recent = session.recentStreamIds;
    if (!recent || recent.length === 0) return false;
    const now = Date.now();
    return recent.some((entry) => entry.id === streamId && entry.expiresAt > now);
  }

  /**
   * Allocate a fresh stream id for the zone's audio session and move the previous
   * id into `recentStreamIds` (with `graceMs` TTL). The PCM pipeline is untouched —
   * only the URL identity changes. Returns the previous id and the new URL, or null
   * if there is no active session.
   */
  public rotateStreamId(
    zoneId: number,
    graceMs = 30_000,
  ): { oldId: string; newId: string; newUrl: string } | null {
    const session = this.sessions.get(zoneId);
    if (!session) return null;
    const oldStream = session.stream;
    const newComposite = `${zoneId}-${randomUUID()}`;
    const newUrl = oldStream.url.replace(oldStream.id, newComposite);
    const newCoverUrl = oldStream.coverUrl.replace(oldStream.id, newComposite);
    session.stream = {
      ...oldStream,
      id: newComposite,
      url: newUrl,
      coverUrl: newCoverUrl,
      createdAt: Date.now(),
    };
    const now = Date.now();
    const recent = (session.recentStreamIds ?? []).filter((entry) => entry.expiresAt > now);
    recent.push({ id: oldStream.id, expiresAt: now + graceMs });
    session.recentStreamIds = recent;
    this.log.debug('stream id rotated', {
      zoneId,
      oldId: oldStream.id,
      newId: newComposite,
      newUrl,
    });
    return { oldId: oldStream.id, newId: newComposite, newUrl };
  }

  /**
   * Register an HTTP response that is serving `streamId` for `zoneId`. The returned
   * function deregisters the entry; callers must invoke it when the response closes.
   * `closeSubscribersForStreamId` invokes every registered `dispose` for the streamId,
   * which is how the URL handover signals EOF to the OLD squeezelite connection.
   */
  public registerSubscriberHandle(
    zoneId: number,
    streamId: string,
    dispose: () => void,
  ): () => void {
    const key = `${zoneId}:${streamId}`;
    let bucket = this.subscriberHandles.get(key);
    if (!bucket) {
      bucket = new Set();
      this.subscriberHandles.set(key, bucket);
    }
    bucket.add(dispose);
    return () => {
      const current = this.subscriberHandles.get(key);
      if (!current) return;
      current.delete(dispose);
      if (current.size === 0) this.subscriberHandles.delete(key);
    };
  }

  /**
   * Forcibly end every HTTP response currently serving `streamId`. Used by the URL
   * handover after the new subscriber has had time to pre-buffer, so that
   * squeezelite gets a clean EOF on the OLD URL and transitions to the enqueued one.
   */
  public closeSubscribersForStreamId(zoneId: number, streamId: string): number {
    const key = `${zoneId}:${streamId}`;
    const bucket = this.subscriberHandles.get(key);
    if (!bucket || bucket.size === 0) return 0;
    const count = bucket.size;
    for (const dispose of Array.from(bucket)) {
      try { dispose(); } catch { /* ignore */ }
    }
    this.subscriberHandles.delete(key);
    this.log.debug('closed subscribers for stream id', { zoneId, streamId, count });
    return count;
  }

  /**
   * Returns true when this zone still has an actively-driving local playback session.
   * Used by external state controllers to avoid being blocked by stale session objects.
   */
  public hasActiveLocalSession(zoneId: number): boolean {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return false;
    }
    if (session.state !== 'playing') {
      return false;
    }
    if (!session.playbackSource) {
      // Output-only sessions do not own engine playback and should not block external state.
      return false;
    }
    if (!this.playbackService.hasSession(zoneSessionKey(zoneId))) {
      return false;
    }
    const stats = this.playbackService.getSessionStats(zoneSessionKey(zoneId));
    if (!stats.length) {
      return true;
    }
    let maxSubscribers = 0;
    for (const stat of stats) {
      const subscribers = Number.isFinite(stat.subscribers) ? Math.max(0, Math.floor(stat.subscribers)) : 0;
      if (subscribers > maxSubscribers) {
        maxSubscribers = subscribers;
      }
    }
    if (maxSubscribers > 0) {
      return true;
    }
    // Grace window: immediately after start there can be a short no-subscriber period.
    const activeSince =
      session.firstAudioReadyAt ??
      session.playbackStartedAt ??
      session.startedAt ??
      session.updatedAt;
    const ageMs = Number.isFinite(activeSince) ? Math.max(0, Date.now() - Number(activeSince)) : 0;
    return ageMs < 5000;
  }

  /**
   * Returns true when this zone has a live engine session (playing or paused).
   * Used for command routing: a paused session keeps the ffmpeg engine alive so
   * resume can reuse it — those commands must stay with the playback coordinator
   * rather than being deflected to an external state controller.
   */
  public hasLocalEngineSession(zoneId: number): boolean {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return false;
    }
    if (!session.playbackSource) {
      return false;
    }
    return this.playbackService.hasSession(zoneSessionKey(zoneId));
  }

  public updateSessionCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return undefined;
    }
    session.cover = cover;
    session.updatedAt = Date.now();
    return cover ? session.stream.coverUrl : undefined;
  }

  /**
   * Wait for ffmpeg to say how long a track is, when nothing else could.
   *
   * A track that starts with no length cannot be ended by anything downstream: `ZonePlayer`'s clock and
   * the engine-exit path both need one to fire `ended`, so the queue would sit on it forever. The old
   * answer was to invent 2:00 and cut the track off there (#350); this asks the one party that actually
   * finds out — the ffmpeg already decoding it, which prints the length in its input banner.
   *
   * A poll rather than an event because the engine port exposes its sessions by `getSessionStats` and
   * nothing else; it is a map lookup twice a second, only for a zone that is missing a length, and it
   * stops the moment one arrives.
   */
  private watchSourceDuration(zoneId: number): void {
    this.clearDurationWatch(zoneId);
    const session = this.sessions.get(zoneId);
    if (!session || (session.duration ?? 0) > 0) {
      return;
    }
    // Radio has no length by definition, and a pipe's producer (a Spotify run, line-in, Bluetooth) reports
    // position and length itself — neither has anything to learn here.
    const kind = session.playbackSource?.kind;
    if (session.metadata?.isRadio || (kind !== 'file' && kind !== 'url')) {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const current = this.sessions.get(zoneId);
      if (!current || current.state !== 'playing' || (current.duration ?? 0) > 0) {
        this.clearDurationWatch(zoneId);
        return;
      }
      const learned = this.readEngineSourceDuration(zoneId);
      if (learned) {
        this.adoptSourceDuration(zoneId, learned, 'ffmpeg banner');
        return;
      }
      if (Date.now() - startedAt >= this.durationWatchMs) {
        this.clearDurationWatch(zoneId);
      }
    }, this.durationPollMs);
    timer.unref?.();
    this.durationWatchers.set(zoneId, timer);
  }

  private clearDurationWatch(zoneId: number): void {
    const timer = this.durationWatchers.get(zoneId);
    if (timer) {
      clearInterval(timer);
      this.durationWatchers.delete(zoneId);
    }
  }

  /** The length ffmpeg read off this zone's source, or null while it has not said. */
  private readEngineSourceDuration(zoneId: number): number | null {
    if (!this.playbackService.hasSession(zoneSessionKey(zoneId))) {
      return null;
    }
    for (const stat of this.playbackService.getSessionStats(zoneSessionKey(zoneId))) {
      const value = stat.sourceDurationSec;
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.round(value);
      }
    }
    return null;
  }

  /**
   * Adopt a length that arrived after the track started, and tell the clock that has to act on it.
   *
   * The session is not enough: `ZonePlayer` was handed the length at start and owns it from then on, so
   * without the notification the progress bar would fill in while the track still never ended.
   */
  private adoptSourceDuration(zoneId: number, durationSec: number, via: string): void {
    this.clearDurationWatch(zoneId);
    const session = this.sessions.get(zoneId);
    if (!session || (session.duration ?? 0) > 0) {
      return;
    }
    session.duration = durationSec;
    if (session.metadata) {
      session.metadata.duration = durationSec;
    }
    session.updatedAt = Date.now();
    this.log.info('source duration learned', { zoneId, durationSec, via });
    this.outputNotifier.notifySourceDuration(zoneId, durationSec);
  }

  public updateSessionTiming(zoneId: number, elapsed: number, duration: number): void {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return;
    }
    const safeElapsed = Math.max(0, elapsed);
    const safeDuration = Math.max(0, duration);
    if (session.elapsed === safeElapsed && session.duration === safeDuration) {
      return;
    }
    session.elapsed = safeElapsed;
    session.duration = safeDuration;
    if (session.metadata) {
      session.metadata.duration = safeDuration;
    }
    session.updatedAt = Date.now();
  }

  public getOutputSettings(zoneId: number): Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'> | null {
    return this.sessions.get(zoneId)?.outputSettings ?? null;
  }

  public updateSessionMetadata(zoneId: number, metadata: PlaybackMetadata): PlaybackSession | null {
    const session = this.sessions.get(zoneId);
    if (!session) {
      return null;
    }
    session.metadata = metadata;
    if (metadata.duration && metadata.duration > 0) {
      session.duration = metadata.duration;
    }
    session.updatedAt = Date.now();
    return session;
  }

  public waitForFirstChunk(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    timeoutMs = 2000,
  ): Promise<boolean> {
    return this.playbackService.waitForFirstChunk(zoneSessionKey(zoneId), profile, timeoutMs);
  }

  public createStream(
    zoneId: number,
    profile: OutputProfile = 'mp3',
    options?: { primeWithBuffer?: boolean; label?: string },
  ): PassThrough | null {
    return this.playbackService.createStream(zoneSessionKey(zoneId), profile, options);
  }

  public createLocalPcmTap(
    zoneId: number,
    source: PlaybackSource,
    options?: {
      outputSettings?: Pick<AudioOutputSettings, 'sampleRate' | 'channels' | 'pcmBitDepth'>;
      startAtSec?: number;
      label?: string;
    },
  ): { stream: PassThrough; stop: () => void } | null {
    const base = this.prefs.getEffectiveOutputSettings(zoneId);
    const outputSettings: AudioOutputSettings = {
      ...base,
      sampleRate: options?.outputSettings?.sampleRate ?? base.sampleRate,
      channels: options?.outputSettings?.channels ?? base.channels,
      pcmBitDepth: options?.outputSettings?.pcmBitDepth ?? base.pcmBitDepth,
    };
    const playbackSource =
      Number.isFinite(options?.startAtSec) && (options?.startAtSec ?? 0) > 0
        ? { ...source, startAtSec: options?.startAtSec }
        : source;
    const local = this.playbackService.createLocalSession(
      zoneSessionKey(zoneId),
      playbackSource,
      'pcm',
      outputSettings,
      () => {
        /* no-op */
      },
    );
    local.start();
    const stream = local.createSubscriber({
      primeWithBuffer: false,
      label: options?.label ?? `local-${zoneId}`,
    });
    if (!stream) {
      local.stop();
      return null;
    }
    const stop = (): void => {
      local.stop();
      stream.destroy();
    };
    return { stream, stop };
  }

  private createStreamHandles(
    zoneId: number,
    streamProfile: OutputProfile = 'mp3',
  ): { stream: AudioStreamHandle; pcmStream: AudioStreamHandle } {
    const id = `${zoneId}-${randomUUID()}`;
    const basePath = `/streams/${zoneId}/${id}`;
    const createdAt = Date.now();
    const streamExt =
      streamProfile === 'aac'
        ? 'aac'
        : streamProfile === 'flac'
          ? 'flac'
          : streamProfile === 'pcm'
            ? 'wav'
          : streamProfile === 'opus'
            ? 'opus'
            : 'mp3';
    const stream: AudioStreamHandle = {
      id,
      url: `${basePath}.${streamExt}`,
      coverUrl: `${basePath}/cover`,
      createdAt,
    };
    const pcmStream: AudioStreamHandle = {
      ...stream,
      url: `${basePath}.wav`,
    };
    return { stream, pcmStream };
  }

  private buildOutputSignature(settings: AudioOutputSettings): Pick<
    AudioOutputSettings,
    'sampleRate' | 'channels' | 'pcmBitDepth'
  > {
    return {
      sampleRate: settings.sampleRate,
      channels: settings.channels,
      pcmBitDepth: settings.pcmBitDepth,
    };
  }


  private buildEngineOutputSpecs(
    profiles: OutputProfile[],
    outputSettings: AudioOutputSettings,
  ): EngineOutputSpec[] {
    return profiles.map((profile) => ({
      profile,
      sampleRate: outputSettings.sampleRate,
      channels: outputSettings.channels,
      pcmBitDepth: outputSettings.pcmBitDepth,
      prebufferBytes: outputSettings.prebufferBytes,
      ...(Number.isFinite(outputSettings.fixedGainDb) && outputSettings.fixedGainDb !== 0
        ? { fixedGainDb: outputSettings.fixedGainDb }
        : {}),
    }));
  }

  private buildEngineStartOptions(
    zoneId: number,
    playbackSource: PlaybackSource,
    profiles: OutputProfile[],
    outputSettings: AudioOutputSettings,
    handoff?: EngineStartOptions['handoff'],
  ): EngineStartOptions {
    const options: EngineStartOptions = {
      zoneId: zoneSessionKey(zoneId),
      input: toEngineInputSpec(playbackSource),
      outputs: this.buildEngineOutputSpecs(profiles, outputSettings),
    };
    if (typeof handoff !== 'undefined') {
      options.handoff = handoff;
    }
    const eqBands = this.prefs.getEqualizerResolver()?.(zoneId) ?? null;
    if (eqBands && eqBands.length > 0) {
      options.equalizer = { bands: eqBands };
    }
    return options;
  }

  private startWithResolvedSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
    requiresPcm?: boolean,
  ): PlaybackSession | null {
    let effectiveSource =
      playbackSource?.kind === 'url' && metadata?.isRadio
        ? { ...playbackSource, restartOnFailure: true }
        : playbackSource;
    if (
      (effectiveSource?.kind === 'file' || effectiveSource?.kind === 'pipe') &&
      effectiveSource.realTime === true
    ) {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    if (
      effectiveSource?.kind === 'url' &&
      effectiveSource.realTime !== true &&
      !metadata?.isRadio
    ) {
      // Default URL inputs to unpaced mode for faster startup; output pacing (and/or true live
      // sources) will keep playback aligned without relying on ffmpeg's `-re`.
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    const inputPrefs = this.prefs.getInputPreferences(zoneId);
    if (inputPrefs?.fileRealTime === false && effectiveSource?.kind === 'file') {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    if (inputPrefs?.urlRealTime === false && effectiveSource?.kind === 'url') {
      effectiveSource = { ...effectiveSource, realTime: false };
    }
    // Say so when the length is already settled. The engine decodes nothing differently for it; it only
    // stops asking ffmpeg for its input banner, which is how a source nobody could describe gets its
    // real length read off stderr instead of guessed (see `FfmpegArgBuilder.getLogLevel`).
    if (
      (effectiveSource?.kind === 'url' || effectiveSource?.kind === 'file') &&
      typeof metadata?.duration === 'number' &&
      metadata.duration > 0
    ) {
      effectiveSource = { ...effectiveSource, knownDurationSec: Math.round(metadata.duration) };
    }
    this.log.info('startWithResolvedSource', {
      zoneId,
      label,
      sourceKind: effectiveSource?.kind ?? null,
      hasStream: effectiveSource ? 'stream' in effectiveSource && !!(effectiveSource as { stream?: unknown }).stream : false,
    });
    const existing = this.sessions.get(zoneId);
    const startAtSec = this.getStartAtSec(effectiveSource);
    const effectivePcmPreference =
      typeof requiresPcm === 'boolean'
        ? requiresPcm
        : this.prefs.getPcmPreference(zoneId) ?? true;
    if (typeof requiresPcm === 'boolean') {
      this.prefs.setPcmPreference(zoneId, requiresPcm);
    }
    const preferredProfile = this.prefs.getProfileOverride(zoneId);
    const profiles = this.computeProfiles(
      effectiveSource,
      effectivePcmPreference,
      preferredProfile ? [preferredProfile] : undefined,
    );
    // Before the settings are read: the rate they carry depends on what is about to play.
    this.prefs.matchSourceRate(zoneId, declaredSourceRate(effectiveSource));
    const effectiveOutput = this.prefs.getEffectiveOutputSettings(zoneId);
    const outputSignature = this.buildOutputSignature(effectiveOutput);
    const outputOnly =
      !effectiveSource && (label.toLowerCase() === 'spotify' || label.toLowerCase() === 'musicassistant');

    const sameSource = Boolean(existing && this.isSamePlaybackSource(existing.playbackSource, effectiveSource));
    const isSpotifyPipe = sameSource && effectiveSource?.kind === 'pipe' && label.toLowerCase() === 'spotify';
    const pendingPlayRequest = this.peekPlayRequest(zoneId);
    const spotifyExplicitServicePlay = isSpotifyPipe && pendingPlayRequest?.type === 'serviceplay';
    const spotifyExplicitTargetChanged =
      spotifyExplicitServicePlay &&
      typeof pendingPlayRequest.uri === 'string' &&
      pendingPlayRequest.uri.length > 0 &&
      pendingPlayRequest.uri !== existing?.playRequestUri;
    const forcePipeRestartOnTrackChange =
      sameSource &&
      effectiveSource?.kind === 'pipe' &&
      (
        this.didTrackChange(existing?.metadata, metadata) ||
        // An explicit Spotify serviceplay is a direct user track selection. Treat it as a
        // hard track switch so we never keep streaming the old pipe under new metadata.
        spotifyExplicitServicePlay ||
        // A paused Spotify pipe must restart on an explicit new play request, otherwise
        // the old pipe session can be resumed with only metadata updated.
        (isSpotifyPipe && existing?.state !== 'playing') ||
        // Zone state patches can update the session metadata before the actual start decision.
        // Fall back to the pending request URI so an explicit serviceplay to a different track
        // still restarts the engine even if metadata already looks "current".
        spotifyExplicitTargetChanged
      );

    // If we are already on the same source (e.g. track change on the same pipe),
    // keep the existing stream URLs and engine session running.
    if (sameSource && !forcePipeRestartOnTrackChange && existing) {
      const now = Date.now();
      const playRequest = this.claimPlayRequest(zoneId);
      existing.source = label;
      if (effectiveSource) {
        existing.playbackSource = effectiveSource;
      }
      if (metadata) {
        existing.metadata = metadata;
        if (metadata.duration && metadata.duration > 0) {
          existing.duration = metadata.duration;
        }
      }
      existing.elapsed = startAtSec;
      existing.state = 'playing';
      existing.startedAt = now - startAtSec * 1000;
      existing.updatedAt = now;
      existing.playbackStartedAt = now;
      existing.firstAudioReadyAt = undefined;
      if (playRequest) {
        existing.playRequestAt = playRequest.requestedAt;
        existing.playRequestUri = playRequest.uri;
        existing.playRequestType = playRequest.type;
      }
      const profilesChanged = !this.sameProfiles(existing.profiles, profiles);
      existing.profiles = profiles;
      const outputChanged =
        !existing.outputSettings ||
        existing.outputSettings.sampleRate !== outputSignature.sampleRate ||
        existing.outputSettings.channels !== outputSignature.channels ||
        existing.outputSettings.pcmBitDepth !== outputSignature.pcmBitDepth;
      // Ensure engine session exists (resume after a pause).
      if (effectiveSource && (outputChanged || profilesChanged || !this.playbackService.hasSession(zoneSessionKey(zoneId)))) {
        if ((outputChanged || profilesChanged) && this.playbackService.hasSession(zoneSessionKey(zoneId))) {
          this.log.info('restarting audio engine to apply output format', {
            zoneId,
            sampleRate: outputSignature.sampleRate,
            channels: outputSignature.channels,
            pcmBitDepth: outputSignature.pcmBitDepth,
            profiles,
          });
          this.playbackService.stop(zoneSessionKey(zoneId), 'reconfigure', { discardSubscribers: true });
        }
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
        this.playbackService.start(startOptions);
      }
      existing.outputSettings = outputSignature;
      this.log.debug('playback continued on same source', { zoneId, source: label });
      return existing;
    }
    if (forcePipeRestartOnTrackChange) {
      this.log.info('restarting audio engine for pipe track change', { zoneId, source: label });
    }

    const isAppleMusic = label.toLowerCase() === 'applemusic';
    const wantsHandoff =
      isAppleMusic &&
      effectiveSource?.kind === 'url' &&
      Boolean(existing);
    if (!wantsHandoff) {
      this.playbackService.stop(zoneSessionKey(zoneId), 'switch', { discardSubscribers: true });
    }
    if (!effectiveSource && !outputOnly) {
      this.log.warn('unable to resolve playback source; skipping session', {
        zoneId,
        source: label,
      });
      return null;
    }
    if (effectiveSource) {
      this.log.info('starting audio engine', { zoneId, kind: effectiveSource.kind, profiles, handoff: wantsHandoff });
      if (wantsHandoff) {
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput, {
          waitProfile: 'pcm',
          timeoutMs: isAppleMusic ? 15000 : 8000,
        });
        this.playbackService.startWithHandoff(startOptions);
      } else {
        const startOptions = this.buildEngineStartOptions(zoneId, effectiveSource, profiles, effectiveOutput);
        this.playbackService.start(startOptions);
      }
    }
    const streamProfile = profiles.includes('flac') ? 'flac' : profiles.includes('aac') ? 'aac' : 'mp3';
    const { stream, pcmStream } = this.createStreamHandles(zoneId, streamProfile);
    const playRequest = this.claimPlayRequest(zoneId);
    const now = Date.now();
    const session: PlaybackSession = {
      zoneId,
      source: label,
      metadata,
      stream,
      pcmStream,
      state: 'playing',
      elapsed: startAtSec,
      duration: metadata?.duration ?? 0,
      startedAt: now - startAtSec * 1000,
      updatedAt: now,
      playbackSource: effectiveSource,
      cover: undefined,
      profiles,
      outputSettings: outputSignature,
      playRequestAt: playRequest?.requestedAt,
      playRequestUri: playRequest?.uri,
      playRequestType: playRequest?.type,
      playbackStartedAt: now,
      firstAudioReadyAt: undefined,
    };
    this.sessions.set(zoneId, session);
    this.watchSourceDuration(zoneId);
    this.log.info(outputOnly ? 'playback started (output-only)' : 'playback started', {
      zoneId,
      source: label,
      stream: stream.id,
      title: metadata?.title,
      sincePlayContentMs: playRequest?.requestedAt ? Math.max(0, now - playRequest.requestedAt) : null,
    });
    return session;
  }

  private isSamePlaybackSource(
    prev?: PlaybackSource | null,
    next?: PlaybackSource | null,
  ): boolean {
    if (!prev || !next) return false;
    if (prev.kind !== next.kind) return false;
    switch (prev.kind) {
      case 'pipe':
        {
          const prevPipe = prev as typeof prev & { stream?: NodeJS.ReadableStream };
          const nextPipe = next as typeof prev & { stream?: NodeJS.ReadableStream };
          if (prevPipe.stream || nextPipe.stream) {
            if (prevPipe.stream !== nextPipe.stream) {
              return false;
            }
          }
          return (
            prev.path === nextPipe.path &&
            prev.format === nextPipe.format &&
            prev.sampleRate === nextPipe.sampleRate &&
            prev.channels === nextPipe.channels
          );
        }
      case 'url':
        {
          const nextUrl = next as {
            kind: 'url';
            url: string;
            headers?: Record<string, string>;
            decryptionKey?: string;
            inputFormat?: string;
            tlsVerifyHost?: string;
            startAtSec?: number;
          };
          const prevUrl = prev as typeof nextUrl;
          return (
            prevUrl.url === nextUrl.url &&
            this.headersEqual(prevUrl.headers, nextUrl.headers) &&
            prevUrl.decryptionKey === nextUrl.decryptionKey &&
            prevUrl.inputFormat === nextUrl.inputFormat &&
            prevUrl.tlsVerifyHost === nextUrl.tlsVerifyHost &&
            this.getStartAtSec(prev) === this.getStartAtSec(next)
          );
        }
      case 'file':
        {
          const nextFile = next as { kind: 'file'; path: string; realTime?: boolean; startAtSec?: number };
          const prevPace = (prev as { realTime?: boolean }).realTime !== false;
          const nextPace = nextFile.realTime !== false;
          return (
            prev.path === nextFile.path &&
            prevPace === nextPace &&
            this.getStartAtSec(prev) === this.getStartAtSec(next)
          );
        }
      default:
        return false;
    }
  }

  private headersEqual(
    left?: Record<string, string>,
    right?: Record<string, string>,
  ): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    leftKeys.sort();
    rightKeys.sort();
    for (let i = 0; i < leftKeys.length; i += 1) {
      const lk = leftKeys[i];
      const rk = rightKeys[i];
      if (lk !== rk) return false;
      if (lk === undefined || rk === undefined) return false;
      if (left[lk] !== right[rk]) return false;
    }
    return true;
  }

  private didTrackChange(
    prev?: PlaybackMetadata | null,
    next?: PlaybackMetadata | null,
  ): boolean {
    // For same-source pipe playback we must restart if we cannot confidently prove
    // we are on the same track, otherwise buffered old PCM can leak into the new start.
    if (!prev || !next) {
      return true;
    }
    if (prev.trackId || next.trackId) {
      return (prev.trackId ?? '') !== (next.trackId ?? '');
    }
    if (prev.audiopath || next.audiopath) {
      return (prev.audiopath ?? '') !== (next.audiopath ?? '');
    }
    const prevTitle = (prev.title ?? '').trim().toLowerCase();
    const nextTitle = (next.title ?? '').trim().toLowerCase();
    const prevArtist = (prev.artist ?? '').trim().toLowerCase();
    const nextArtist = (next.artist ?? '').trim().toLowerCase();
    const prevAlbum = (prev.album ?? '').trim().toLowerCase();
    const nextAlbum = (next.album ?? '').trim().toLowerCase();
    if (prevTitle || nextTitle || prevArtist || nextArtist || prevAlbum || nextAlbum) {
      return prevTitle !== nextTitle || prevArtist !== nextArtist || prevAlbum !== nextAlbum;
    }
    return true;
  }

  private sameProfiles(a?: OutputProfile[] | null, b?: OutputProfile[] | null): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((p, idx) => p === sortedB[idx]);
  }

  /**
   * `EngineSessionStats` rather than a hand-written copy of its shape. The copy that stood here had
   * already drifted — it was missing `sourceFormat` and `processing` — so a fact the engine reports
   * was simply invisible at this end until someone noticed and retyped it.
   */
  private handleEngineTermination(
    key: SessionKey,
    stats: EngineSessionStats | null,
    reason?: string,
  ): void {
    // For zone playback the session key IS the zoneId; a non-zone (ephemeral)
    // key never lands in the zone sessions map, so it falls out here as a no-op.
    const zoneId = key as number;
    const session = this.sessions.get(zoneId);
    if (!session) return;
    const exitCode = stats?.lastExitCode;
    const exitSignal = stats?.lastExitSignal;
    const stderr = stats?.lastStderr?.trim();
    // Last chance to learn the length, and for one shape of source it is the *only* chance: a
    // non-seekable stream whose index sits at the end states its duration when ffmpeg has read the
    // whole thing — which is here. Adopting it now still ends the track correctly, because the zone
    // clock (not this exit) is what times the end for the unpaced sources every pull output uses.
    if ((session.duration ?? 0) <= 0 && !session.metadata?.isRadio) {
      const learned = stats?.sourceDurationSec;
      if (typeof learned === 'number' && Number.isFinite(learned) && learned > 0) {
        this.adoptSourceDuration(zoneId, Math.round(learned), 'ffmpeg banner at end of source');
      }
    }
    this.clearDurationWatch(zoneId);
    const duration = session.duration ?? session.metadata?.duration ?? 0;
    const elapsedFromClock = session.startedAt
      ? Math.round(Math.max(0, Date.now() - session.startedAt) / 1000)
      : session.elapsed;
    const observedElapsed = Math.max(session.elapsed ?? 0, elapsedFromClock);
    const shouldEmitEnded =
      !reason &&
      session.state === 'playing' &&
      duration > 0 &&
      !session.metadata?.isRadio &&
      observedElapsed >= Math.max(0, duration - 1);
    if (reason === 'pause') {
      this.log.debug('engine stopped for pause; keeping session', {
        zoneId,
        source: session.source,
      });
      return;
    }
    this.sessions.delete(zoneId);
    // Whether ffmpeg succeeded is its exit status, never what it printed. At `-loglevel info`
    // — which every source without a probed native format gets, see `FfmpegArgBuilder.getLogLevel`
    // — a flawless run still writes the input banner and, for FLAC into a pipe, "unable to rewrite
    // FLAC header". Reading that as failure turned every alert and TTS on a non-Sendspin output
    // into "Playback unavailable" (#331). stderr stays the *text* of an error, not the verdict.
    const cleanExit = (exitCode === 0 || exitCode === null) && !exitSignal;
    const isFiniteFile = session.playbackSource?.kind === 'file' && !session.metadata?.isRadio;
    if (!reason && cleanExit && (shouldEmitEnded || isFiniteFile)) {
      this.log.info('playback ended', {
        zoneId,
        source: session.source,
        duration,
        elapsed: observedElapsed,
      });
    } else {
      this.log.warn('playback session terminated by engine', {
        zoneId,
        source: session.source,
        reason,
        exitCode,
        exitSignal,
        stderr,
      });
    }
    if (shouldEmitEnded) {
      this.outputNotifier.notifyOutputState(zoneId, {
        status: 'stopped',
        position: duration,
        duration,
        uri: session.metadata?.audiopath,
      });
    }
    if (reason) {
      this.log.debug('suppressing output error; engine stopped intentionally', {
        zoneId,
        source: session.source,
        reason,
      });
      return;
    }
    if (session.state === 'playing') {
      if (!cleanExit) {
        const detail =
          stderr ||
          (typeof exitCode === 'number' ? `ffmpeg exited (${exitCode})` : exitSignal ? `ffmpeg exited (${exitSignal})` : 'ffmpeg exited');
        this.outputNotifier.notifyOutputError(zoneId, `${session.source} stream failed: ${detail}`);
      }
    }
    // Attempt to restart once for pipe sources to recover from transient ffmpeg exits.
    if (session.playbackSource?.kind === 'pipe') {
      const pipeStream = (session.playbackSource as { stream?: NodeJS.ReadableStream }).stream;
      const streamEnded = Boolean(
        pipeStream &&
          ((pipeStream as { readableEnded?: boolean }).readableEnded ||
            (pipeStream as { destroyed?: boolean }).destroyed),
      );
      if (streamEnded) {
        this.log.info('pipe source ended; skipping restart', { zoneId, source: session.source });
        return;
      }
      setTimeout(() => {
        this.startWithResolvedSource(
          zoneId,
          session.source,
          session.playbackSource,
          session.metadata,
          this.prefs.getPcmPreference(zoneId),
        );
      }, 250);
    }
  }

  private computeProfiles(
    playbackSource: PlaybackSource | null,
    requiresPcm: boolean,
    preferred?: OutputProfile[],
  ): OutputProfile[] {
    if (preferred?.length) {
      const deduped = Array.from(new Set(preferred));
      return deduped;
    }
    if (!playbackSource || playbackSource.kind !== 'pipe') {
      if (requiresPcm) {
        return ['pcm'];
      }
      return ['mp3'];
    }
    return requiresPcm ? (['pcm'] as Array<'pcm'>) : (['mp3'] as Array<'mp3'>);
  }

  public async inlineCrossfadePlayback(
    zoneId: number,
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
    nextPlaybackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): Promise<PlaybackSession | null> {
    // Update title/artist/album/cover/duration AT FADE-IN START so the UI immediately
    // shows the new track. We deliberately do NOT reset the wall-clock anchors here:
    // the new track's audio doesn't actually start being audible until the blend
    // completes, so anchoring `crossfadedAt` to the blend start would make
    // `onCrossfadePosition` think the new track is `crossfadeSec` seconds further
    // along than it really is — the next crossfade would fire `crossfadeSec` early
    // and the user sees the metadata jump *crossfadeSec* before the song actually ends.
    const session = this.sessions.get(zoneId);
    if (session) {
      session.metadata = metadata ?? session.metadata;
      session.source = metadata?.audiopath ?? metadata?.title ?? 'crossfade';
      session.duration = metadata?.duration ?? 0;
      session.playbackSource = nextPlaybackSource;
      session.updatedAt = Date.now();
    }
    this.log.info('inline crossfade started', {
      zoneId,
      durationSec,
      title: metadata?.title,
    });

    const success = await this.playbackService.inlineCrossfade(zoneSessionKey(zoneId), fadeIn, durationSec);
    if (!success) return null;

    // Reset wall-clock anchors AFTER the blend completes — at this moment the new
    // track's audio is fully audible, so `crossfadedAt = now` correctly represents
    // "elapsed=0 of the new track" for `onCrossfadePosition`'s next-trigger math.
    const nowAfterBlend = Date.now();
    if (session) {
      session.elapsed = 0;
      session.startedAt = nowAfterBlend;
      session.crossfadedAt = nowAfterBlend;
      session.updatedAt = nowAfterBlend;
    }

    return session ?? null;
  }

  /**
   * Engine stats for a zone's session, one entry per encoded profile.
   *
   * Returns `EngineSessionStats` rather than a hand-written copy of it. The copy had drifted:
   * it omitted `sampleRate`, `channels` and `pcmBitDepth`, so the format the engine reports
   * was reaching callers at runtime but invisible to the type checker.
   */
  public getStreamStats(zoneId: number): EngineSessionStats[] {
    return this.playbackService.getSessionStats(zoneSessionKey(zoneId));
  }
}
