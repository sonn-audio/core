import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { AudioSession, type PlaybackSource, type OutputProfile } from '@/engine/audioSession';
import {
  audioOutputSettings,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import type { EnginePort, EngineSessionStats } from '@/ports/EnginePort';
import type { SessionKey } from '@/ports/types/SessionKey';
import type { GaplessSplice } from '@/engine/gaplessAppender';

export class AudioStreamEngine {
  private readonly log = createLogger('Audio', 'Engine');
  // Keyed by SessionKey. For zone playback the key IS the zoneId; a non-zone
  // consumer (e.g. DLNA media server) uses an ephemeral key from a disjoint
  // range. The engine treats it purely as an opaque map key — no zone logic.
  private readonly sessions = new Map<SessionKey, Map<OutputProfile, AudioSession>>();
  // Keyed by profileMap (not session key) so a handoff/replace can put a reason
  // on the *outgoing* map without overwriting state for the incoming map under
  // the same key. Each session's onTerminated callback reads + deletes its
  // own entry, so the Map stays bounded.
  private readonly stopReasonByProfileMap = new Map<Map<OutputProfile, AudioSession>, string>();
  private readonly outputSettings = audioOutputSettings;
  private readonly handoffTokens = new Map<SessionKey, string>();

  /**
   * Snapshot the crossfade-enabled flag each session-start. When the system-wide
   * config flips, in-flight sessions keep their original pipeline shape and the
   * next start() picks up the new value.
   */
  constructor(
    private readonly isCrossfadeEnabled: () => boolean = () => true,
    private readonly onPcmFrame?: (zoneId: SessionKey, pcm: Buffer, timestampUs: number) => void,
    /** Whether tracks may be joined onto one another; see `GaplessAppender`. */
    private readonly isGaplessEnabled: () => boolean = () => false,
  ) {}

  /**
   * Whether a session for `source` should be built so that a next track can follow it.
   *
   * Only for a track, which is to say a file or stream somebody knows the length of. A radio
   * station has no next, and an alert is a one-off: both keep the single process they always ran.
   */
  private gaplessCapable(source: PlaybackSource): boolean {
    if (!this.isGaplessEnabled() || (source.kind !== 'file' && source.kind !== 'url')) {
      return false;
    }
    if (source.kind === 'file' && (source.loop || source.path.includes('/alerts/'))) {
      return false;
    }
    return typeof source.knownDurationSec === 'number' && source.knownDurationSec > 0;
  }

  /**
   * Line `source` up behind what a session is playing, to follow it without a gap. Resolves when it
   * has taken over, or with null when it could not — the current track then ends as tracks do.
   */
  public async armNext(zoneId: SessionKey, source: PlaybackSource): Promise<GaplessSplice | null> {
    const profileMap = this.sessions.get(zoneId);
    // One stream per zone only: with several profiles each is a session decoding the source for
    // itself, and they would have to change over as one.
    if (!profileMap || profileMap.size !== 1) return null;
    const session = [...profileMap.values()][0];
    return session ? session.armNext(source) : null;
  }

  public disarmNext(zoneId: SessionKey): void {
    this.sessions.get(zoneId)?.forEach((session) => session.disarmNext());
  }

  private onSessionTerminated?: (
    zoneId: SessionKey,
    stats: EngineSessionStats | null,
    reason?: string,
  ) => void;

  public setSessionTerminationHandler(
    handler: (
      zoneId: SessionKey,
      stats: EngineSessionStats | null,
      reason?: string,
    ) => void,
  ): void {
    this.onSessionTerminated = handler;
  }

  public start(
    zoneId: SessionKey,
    source: PlaybackSource,
    profiles: OutputProfile[] = ['mp3'],
    outputSettings?: AudioOutputSettings,
    equalizerBands: ReadonlyArray<number> | null = null,
  ): void {
    this.stop(zoneId, 'replace', { discardSubscribers: true });
    const profileMap = new Map<OutputProfile, AudioSession>();
    const effectiveOutput = outputSettings ?? this.outputSettings;
    const crossfadeEnabled = this.isCrossfadeEnabled();
    profiles.forEach((profile) => {
      const session = new AudioSession(zoneId, source, profile, () => {
        profileMap.delete(profile);
        const currentMap = this.sessions.get(zoneId);
        if (currentMap !== profileMap) {
          return;
        }
        if (profileMap.size === 0) {
          const stats = session.getStats();
          const stopReason = this.stopReasonByProfileMap.get(profileMap);
          this.stopReasonByProfileMap.delete(profileMap);
          this.sessions.delete(zoneId);
          this.onSessionTerminated?.(zoneId, stats, stopReason);
        }
      }, effectiveOutput, equalizerBands, crossfadeEnabled, this.onPcmFrame, this.gaplessCapable(source));
      profileMap.set(profile, session);
      session.start();
      this.log.info('audio session started', { zoneId, source: source.kind, profile, crossfadeEnabled });
    });
    if (profileMap.size > 0) {
      this.sessions.set(zoneId, profileMap);
    }
  }

  public startWithHandoff(
    zoneId: SessionKey,
    source: PlaybackSource,
    profiles: OutputProfile[] = ['mp3'],
    outputSettings?: AudioOutputSettings,
    options: { waitProfile?: OutputProfile; timeoutMs?: number } = {},
    equalizerBands: ReadonlyArray<number> | null = null,
  ): void {
    const existing = this.sessions.get(zoneId) ?? null;
    const handoffToken = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.handoffTokens.set(zoneId, handoffToken);
    const profileMap = new Map<OutputProfile, AudioSession>();
    const effectiveOutput = outputSettings ?? this.outputSettings;
    const crossfadeEnabled = this.isCrossfadeEnabled();
    profiles.forEach((profile) => {
      const session = new AudioSession(zoneId, source, profile, () => {
        profileMap.delete(profile);
        const currentMap = this.sessions.get(zoneId);
        if (currentMap !== profileMap) {
          return;
        }
        if (profileMap.size === 0) {
          const stats = session.getStats();
          const stopReason = this.stopReasonByProfileMap.get(profileMap);
          this.stopReasonByProfileMap.delete(profileMap);
          this.sessions.delete(zoneId);
          this.onSessionTerminated?.(zoneId, stats, stopReason);
        }
      }, effectiveOutput, equalizerBands, crossfadeEnabled, this.onPcmFrame, this.gaplessCapable(source));
      profileMap.set(profile, session);
      session.start();
      this.log.info('audio session started (handoff)', { zoneId, source: source.kind, profile, crossfadeEnabled });
    });

    // Make the new sessions available immediately so subscribers bind to the new stream.
    if (profileMap.size > 0) {
      this.sessions.set(zoneId, profileMap);
    }

    const waitProfile = options.waitProfile ?? profiles[0];
    const waitSession =
      (waitProfile ? profileMap.get(waitProfile) : null) ??
      profileMap.values().next().value ??
      null;
    if (!waitSession) {
      profileMap.forEach((session) => session.stop());
      return;
    }
    const existingWaitSession =
      (waitProfile ? existing?.get(waitProfile) : null) ??
      existing?.values().next().value ??
      null;
    const existingReady = existingWaitSession?.hasFirstChunk() ?? false;
    const skipHandoff = Boolean(existing && !existingReady);
    if (skipHandoff && existing) {
      this.stopReasonByProfileMap.set(existing, 'switch');
      existing.forEach((session) => session.stop(true));
      this.log.info('audio handoff skipped; existing not ready', { zoneId });
    }
    const timeoutMs = options.timeoutMs ?? 8000;
    void (async () => {
      const ready = await waitSession.waitForFirstChunk(timeoutMs);
      if (this.handoffTokens.get(zoneId) !== handoffToken) {
        // Superseded by a newer handoff before our session became ready. The
        // newer handoff captured a *different* `existing`, so it will never stop
        // the session we were going to replace — stop it here so its ffmpeg does
        // not leak. (Rapid track skips otherwise pile up orphaned ffmpeg
        // processes, exhausting the upstream segment proxy until playback stalls.)
        // Our own profileMap is the next handoff's `existing`, so that handoff
        // cleans it up. Guard against stopping whatever is active now.
        if (!skipHandoff && existing && this.sessions.get(zoneId) !== existing) {
          this.stopReasonByProfileMap.set(existing, 'switch');
          existing.forEach((session) => session.stop(true));
        }
        return;
      }
      if (!ready) {
        this.log.warn(
          skipHandoff
            ? 'audio start failed; stopping session'
            : 'audio handoff failed; keeping existing session',
          { zoneId, timeoutMs },
        );
        profileMap.forEach((session) => session.stop());
        if (!skipHandoff && existing && this.sessions.get(zoneId) === profileMap) {
          this.sessions.set(zoneId, existing);
        }
        if (this.handoffTokens.get(zoneId) === handoffToken) {
          this.handoffTokens.delete(zoneId);
        }
        return;
      }
      if (!skipHandoff && existing) {
        this.stopReasonByProfileMap.set(existing, 'switch');
        existing.forEach((session) => session.stop(true));
      }
      if (this.handoffTokens.get(zoneId) === handoffToken) {
        this.handoffTokens.delete(zoneId);
      }
      this.log.info('audio handoff complete', { zoneId });
    })();
  }

  public stop(
    zoneId: SessionKey,
    reason = 'stop',
    options: { discardSubscribers?: boolean } = {},
  ): void {
    const existing = this.sessions.get(zoneId);
    if (!existing) {
      return;
    }
    this.stopReasonByProfileMap.set(existing, reason);
    const discardSubscribers = options.discardSubscribers === true;
    existing.forEach((session) => session.stop(discardSubscribers));
    this.sessions.delete(zoneId);
    this.log.info('audio session stopped', { zoneId });
  }

  /**
   * Swap EQ bands and respawn ffmpeg without dropping output subscribers.
   * Returns true if at least one running session was restarted.
   *
   * @param resumeAtSec Current playback position, so the respawn continues there instead of replaying
   *   the source from its original offset. Ignored for sources that cannot be positioned.
   */
  public restartZoneForEqualizer(
    zoneId: SessionKey,
    bands: ReadonlyArray<number> | null,
    resumeAtSec?: number,
  ): boolean {
    const existing = this.sessions.get(zoneId);
    if (!existing || existing.size === 0) {
      return false;
    }
    existing.forEach((session) => session.restartForEqualizer(bands, resumeAtSec));
    this.log.info('audio session restarting for equalizer change', {
      zoneId,
      profiles: Array.from(existing.keys()),
    });
    return true;
  }

  public createStream(
    zoneId: SessionKey,
    profile: OutputProfile = 'mp3',
    options: { primeWithBuffer?: boolean; label?: string } = {},
  ): PassThrough | null {
    return this.sessions.get(zoneId)?.get(profile)?.createSubscriber(options) ?? null;
  }

  public async waitForFirstChunk(
    zoneId: SessionKey,
    profile: OutputProfile = 'mp3',
    timeoutMs = 2000,
  ): Promise<boolean> {
    const session = this.sessions.get(zoneId)?.get(profile);
    if (!session) {
      return false;
    }
    return session.waitForFirstChunk(timeoutMs);
  }

  public async inlineCrossfade(
    zoneId: SessionKey,
    fadeIn: Parameters<EnginePort['inlineCrossfade']>[1],
    durationSec: number,
  ): Promise<boolean> {
    const profileMap = this.sessions.get(zoneId);
    if (!profileMap) return false;
    const session = [...profileMap.values()][0];
    if (!session) return false;
    return session.inlineCrossfade(fadeIn, durationSec);
  }

  public hasSession(zoneId: SessionKey): boolean {
    return this.sessions.has(zoneId);
  }

  public getSessionStats(zoneId: SessionKey): EngineSessionStats[] {
    const map = this.sessions.get(zoneId);
    if (!map) return [];
    const stats: EngineSessionStats[] = [];
    for (const session of map.values()) {
      stats.push(session.getStats());
    }
    return stats;
  }
}
