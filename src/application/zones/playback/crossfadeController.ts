import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { ZoneContext, QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { InputsPort } from '@/ports/InputsPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';
import { followsLeaderStream } from '@/application/zones/helpers/groupFollower';

interface CrossfadeEntry {
  resolving: boolean;
  resolvedSource: PlaybackSource | null;
  resolvedMetadata: PlaybackMetadata | null;
  nextAudiopath: string;
  nextQueueIndex: number;
  triggered: boolean;
  triggeredAt: number;
  /** True when the fade-in source is a Spotify stream (started at trigger time via inputsPort). */
}

export interface CrossfadeControllerDeps {
  zoneRepo: ZoneRepository;
  audioManager: AudioManager;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  configPort: ConfigPort;
  inputsPort: InputsPort;
  recentsManager: RecentsManager;
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
}

/**
 * Coordinates the per-zone crossfade lifecycle: position-based pre-resolve of
 * the next track, the actual blend (server-side inline or output-native), and
 * the post-blend URL handover to HTTP-based outputs.
 */
export class CrossfadeController {
  private readonly state = new Map<number, CrossfadeEntry>();
  private static readonly PRE_RESOLVE_EXTRA_SEC = 10;

  constructor(private readonly deps: CrossfadeControllerDeps) {}

  /** Clears any pending pre-resolve/trigger entry for a zone. */
  public clear(zoneId: number): void {
    this.state.delete(zoneId);
  }

  /**
   * If a crossfade triggered within the suppression window, consume the entry
   * and return true so the caller can suppress its end-of-track handling. The
   * entry is always cleared (whether consumed or stale) since end-of-track
   * marks the end of any prior crossfade lifecycle.
   */
  public consumeRecentTrigger(zoneId: number, suppressMs: number): boolean {
    const entry = this.state.get(zoneId);
    if (entry?.triggered && entry.triggeredAt > 0) {
      const elapsed = Date.now() - entry.triggeredAt;
      this.state.delete(zoneId);
      return elapsed < suppressMs;
    }
    this.state.delete(zoneId);
    return false;
  }

  public onPosition(zoneId: number, time: number, duration: number): void {
    if (!duration || duration <= 0) return;
    const ctx = this.deps.zoneRepo.get(zoneId);
    if (!ctx || ctx.alert || ctx.inputMode === 'alert') return;
    const crossfadeSec = this.deps.configPort.getSystemConfig()?.audioserver?.crossfadeSec;
    if (!crossfadeSec || crossfadeSec <= 0) return;
    if (!this.deps.isLocalQueueAuthority(ctx.queue.authority)) return;
    const session = this.deps.audioManager.getSession(zoneId);
    const srcKind = session?.playbackSource?.kind;
    if (!srcKind) return;
    if (session.metadata?.isRadio) return;

    const remaining = duration - time;
    if (remaining <= 0) return;

    // After an inline crossfade Squeezelite's elapsed and the zone timer are both anchored
    // to the OLD song's timeline (Squeezelite never reconnected).  session.crossfadedAt is
    // set by audioManager right after the blend completes; use it as the only reliable
    // clock for the NEW song's position so we don't fire the next crossfade immediately.
    let accurateElapsed: number;
    if (session?.crossfadedAt) {
      accurateElapsed = (Date.now() - session.crossfadedAt) / 1000;
    } else {
      // Normal (non-crossfaded) session: use the best available elapsed estimate.
      // - session.startedAt gives a wall-clock anchor with no lag.
      // - session.elapsed from Squeezelite is accurate on state changes.
      // - `time` from zone timer lags VLC by ~5-13 s (VLC buffering).
      const wallClockElapsedSec = session?.startedAt
        ? (Date.now() - session.startedAt) / 1000
        : time;
      const squeezeliteElapsed =
        typeof session?.elapsed === 'number' && session.elapsed > 0 ? session.elapsed : 0;
      // When squeezeliteElapsed is 0 the zone timer may carry a stale position — clamp.
      const sanitizedTime = squeezeliteElapsed > 0 ? time : Math.min(time, wallClockElapsedSec);
      accurateElapsed = Math.max(wallClockElapsedSec, squeezeliteElapsed, sanitizedTime);
    }
    const accurateDuration = session?.metadata?.duration ?? duration;
    const accurateRemaining = accurateDuration - accurateElapsed;

    const state = this.state.get(zoneId);

    if (
      accurateRemaining <= crossfadeSec + CrossfadeController.PRE_RESOLVE_EXTRA_SEC &&
      !state?.resolving &&
      !state?.triggered
    ) {
      void this.preResolve(ctx, crossfadeSec);
    }

    if (accurateRemaining <= crossfadeSec && state?.resolvedSource && !state.triggered) {
      void this.trigger(ctx, crossfadeSec);
    }
  }

  private async preResolve(ctx: ZoneContext, crossfadeSec: number): Promise<void> {
    const zoneId = ctx.id;
    const nextIndex = ctx.queueController.nextIndex();
    if (nextIndex < 0) return;
    const nextItem = ctx.queue.items[nextIndex];
    if (!nextItem) return;
    if (this.deps.audioHelpers.isRadioAudiopath(nextItem.audiopath, nextItem.audiotype)) return;
    if (this.deps.audioHelpers.isMusicAssistantAudiopath(nextItem.audiopath)) return;
    // Spotify cannot be crossfaded, and it is not a limitation of ours: a blend needs both tracks
    // sounding at once, and an account plays in exactly one place at a time. The engine that used
    // to manage it did so by opening a second session, which Spotify no longer allows anybody.
    if (this.deps.audioHelpers.isSpotifyAudiopath(nextItem.audiopath)) return;

    this.state.set(zoneId, {
      resolving: true,
      resolvedSource: null,
      resolvedMetadata: null,
      nextAudiopath: nextItem.audiopath,
      nextQueueIndex: nextIndex,
      triggered: false,
      triggeredAt: 0,
    });

    try {
      const resolvedMetadata: PlaybackMetadata = {
        title: nextItem.title || '',
        artist: nextItem.artist || '',
        album: nextItem.album || '',
        coverurl: nextItem.coverurl,
        duration: nextItem.duration,
        audiopath: nextItem.audiopath,
        station: nextItem.station,
        isRadio: false,
      };

      let resolvedSource: PlaybackSource | null = null;

      // YouTube is absent here as it was before; see ParentContextPolicy on these sets.
      const owner = this.deps.audioHelpers.providerForAudiopath(nextItem.audiopath);

      if (owner && owner !== 'youtube') {
        const resolution = await this.deps.contentPort
          .resolvePlaybackSource({ audiopath: nextItem.audiopath, requester: { kind: 'zone', zoneId } })
          .catch(() => null);
        resolvedSource = resolution?.playbackSource ?? null;
      } else {
        resolvedSource = resolvePlaybackSource(nextItem.audiopath);
      }

      const current = this.state.get(zoneId);
      if (!current || current.nextAudiopath !== nextItem.audiopath) return;

      if (!resolvedSource || resolvedSource.kind === 'pipe') {
        this.state.delete(zoneId);
        return;
      }

      current.resolving = false;
      current.resolvedSource = resolvedSource;
      current.resolvedMetadata = resolvedMetadata;

      // Eager trigger: if accurate elapsed already crossed the crossfade window while
      // we were resolving (async services), fire immediately rather than waiting for
      // the next zone-timer tick.
      if (!current.triggered) {
        const session = this.deps.audioManager.getSession(zoneId);
        const accurateElapsed =
          typeof session?.elapsed === 'number' && session.elapsed > 0
            ? session.elapsed
            : ctx.player.getState().time;
        const accurateDuration = session?.metadata?.duration ?? ctx.player.getState().duration ?? 0;
        const remaining = accurateDuration - accurateElapsed;
        if (remaining > 0 && remaining <= crossfadeSec) {
          void this.trigger(ctx, crossfadeSec);
        }
      }
    } catch {
      this.state.delete(zoneId);
    }
  }

  private async trigger(ctx: ZoneContext, crossfadeSec: number): Promise<void> {
    const zoneId = ctx.id;
    const state = this.state.get(zoneId);
    if (!state?.resolvedSource || state.triggered) return;
    state.triggered = true;
    state.triggeredAt = Date.now();

    // Use squeezelite-native client-side crossfade when ALL outputs support it.
    const allNativeCrossfade =
      ctx.outputs.length > 0 &&
      ctx.outputs.every((o) => typeof o.supportsCrossfade === 'function' && o.supportsCrossfade());

    if (allNativeCrossfade) {
      await this.triggerNative(ctx, crossfadeSec, state);
      return;
    }

    const newSource = state.resolvedSource;

    type FadeIn =
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number };

    let fadeIn: FadeIn;
    const nextPlaybackSource: PlaybackSource = newSource;

    if (newSource.kind === 'file') {
      fadeIn = { kind: 'file', path: newSource.path };
    } else if (newSource.kind === 'url') {
      fadeIn = {
        kind: 'url',
        url: newSource.url,
        headers: (newSource as Extract<PlaybackSource, { kind: 'url' }>).headers,
        decryptionKey: (newSource as Extract<PlaybackSource, { kind: 'url' }>).decryptionKey,
      };
    } else {
      this.state.delete(zoneId);
      return;
    }

    // Kick off the blend WITHOUT awaiting yet. The synchronous prologue inside
    // inlineCrossfadePlayback updates session.metadata/duration/crossfadedAt and
    // returns a promise that resolves when the actual PCM blend completes
    // ~`crossfadeSec` seconds from now.
    const blendPromise = this.deps.audioManager.inlineCrossfadePlayback(
      zoneId,
      fadeIn,
      crossfadeSec,
      nextPlaybackSource,
      state.resolvedMetadata ?? undefined,
    );

    // The session has already been mutated synchronously above. Read it now so we
    // can flip the visible player state to the NEW track at fade-in start (instead
    // of after the 10 s blend completes). Without this the audio_event keeps the
    // OLD title/artist/cover until the blend is finished.
    const earlySession = this.deps.audioManager.getSession(zoneId);
    if (earlySession) {
      ctx.queueController.setCurrentIndex(state.nextQueueIndex);
      // Player state: title, duration, time=0 — same call we used to make AFTER
      // the blend, just moved earlier. The HTTP stream URL does not change so
      // squeezelite is unaffected.
      ctx.player.updateStateForCrossfade(earlySession);
      const nextItem = ctx.queue.items[state.nextQueueIndex];
      if (nextItem) {
        const patch = buildQueueItemPlaybackPatch(
          ctx,
          nextItem,
          state.nextQueueIndex,
          this.deps.audioHelpers,
        );
        this.deps.applyPatch(zoneId, {
          ...patch,
          mode: 'play',
          clientState: 'on',
          power: 'on',
          time: 0,
          duration:
            typeof nextItem.duration === 'number'
              ? Math.max(0, Math.round(nextItem.duration))
              : undefined,
        });
        void this.deps.recentsManager.record(zoneId, nextItem);
      }
    }

    const crossfadeSession = await blendPromise;
    if (!crossfadeSession) {
      state.triggered = false;
      this.state.delete(zoneId);
      return;
    }

    // Clear crossfade state once the blend has actually completed. handleEndOfTrack
    // must not suppress a future queue advance when song B eventually finishes,
    // since no separate "song A ended" event fires (the session continues inline).
    this.state.delete(zoneId);

    // Gapless URL handover for HTTP-URL outputs (currently squeezelite only).
    // The audio session keeps its PCM pipeline + encoder unchanged across the blend,
    // but we rotate the stream id so the output reconnects to a fresh URL with fresh
    // metadata. Squeezelite's elapsed-vs-duration tracking would otherwise drift on a
    // single long URL and eventually misbehave (stuck buffering after upstream stalls).
    void this.runUrlHandover(ctx, crossfadeSession);

    this.deps.log.info('crossfade triggered', {
      zoneId,
      crossfadeSec,
      next: state.nextAudiopath,
    });
  }

  /**
   * Native crossfade for outputs like squeezelite that have built-in client-side
   * crossfade support. Instead of a server-side PCM blend we:
   *  1. Set a crossfade hint on each output so the upcoming play() call uses enqueue
   *     + TransitionType.CROSSFADE instead of replacing the current stream.
   *  2. Advance the queue and start the new audio session normally. The old engine
   *     stops, sending EOF to the sync stream. Players drain their local audio buffer
   *     (typically 5–15 s) then fade in the new URL — simultaneously for sync groups
   *     because all players share the same byte stream.
   */
  private async triggerNative(
    ctx: ZoneContext,
    crossfadeSec: number,
    state: CrossfadeEntry,
  ): Promise<void> {
    const zoneId = ctx.id;

    // Signal all outputs to use native crossfade on the next play() call.
    for (const output of ctx.outputs) {
      output.setCrossfadeHint?.(crossfadeSec);
    }

    // Update early metadata so the UI shows the new track title immediately.
    const earlySession = this.deps.audioManager.getSession(zoneId);
    if (earlySession && state.resolvedMetadata) {
      earlySession.metadata = state.resolvedMetadata;
      earlySession.source = state.nextAudiopath ?? state.resolvedMetadata.title ?? 'crossfade';
      earlySession.duration = state.resolvedMetadata.duration ?? 0;
      earlySession.playbackSource = state.resolvedSource!;
      earlySession.updatedAt = Date.now();
    }

    ctx.queueController.setCurrentIndex(state.nextQueueIndex);
    if (earlySession) {
      ctx.player.updateStateForCrossfade(earlySession);
    }
    const nextItem = ctx.queue.items[state.nextQueueIndex];
    if (nextItem) {
      const patch = buildQueueItemPlaybackPatch(
        ctx,
        nextItem,
        state.nextQueueIndex,
        this.deps.audioHelpers,
      );
      this.deps.applyPatch(zoneId, {
        ...patch,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        time: 0,
        duration:
          typeof nextItem.duration === 'number'
            ? Math.max(0, Math.round(nextItem.duration))
            : undefined,
      });
      void this.deps.recentsManager.record(zoneId, nextItem);
    }

    // Gracefully stop the old engine so squeezelite clients receive a clean HTTP
    // EOF (stream `end()`) rather than an abrupt destroy(). With a clean EOF,
    // squeezelite's decoder drains its remaining audio buffer and then fires
    // `STMd` (decoder ready). The node-slimproto client processes `STMd` by
    // calling the actual `strm`-enqueue command for whatever is stored in
    // `_nextMedia` — which is set by `orchestrateGroupEnqueue()` (called inside
    // `play()` below). Without the clean EOF, squeezelite fires `STMu` (stream
    // underrun) instead, which clears `_nextMedia` and the enqueue is lost.
    this.deps.audioManager.softStopPlayback(zoneId);

    // Start the new audio session. The old engine was already stopped above; the
    // playbackService.stop() inside startWithResolvedSource is a no-op. play()
    // is dispatched on all outputs — with the crossfade hint set above, squeezelite
    // calls orchestrateGroupEnqueue() so `_nextMedia` is set. Players receive the
    // actual `strm` command when squeezelite's `STMd` event fires after the old
    // stream ends cleanly.
    const nativeSession = await this.deps.startQueuePlayback(
      ctx,
      state.nextAudiopath,
      state.resolvedMetadata ?? undefined,
      { skipExternalStop: true },
    );

    this.state.delete(zoneId);

    if (!nativeSession) {
      // Hints were already consumed by play(); nothing more to do.
      return;
    }

    this.deps.log.info('crossfade triggered (native)', {
      zoneId,
      crossfadeSec,
      next: state.nextAudiopath,
    });
  }

  /**
   * Phase-1 URL handover: rotates the audio session's stream id, asks each capable
   * output to enqueue the new URL as the next track, then closes the OLD URL's HTTP
   * response after a short pre-buffer window so the output transitions naturally.
   *
   * Outputs that don't implement `enqueueRotation` are skipped — they either don't
   * use HTTP URLs (Sendspin/Snapcast/AirPlay) or haven't been wired up for the
   * gapless handover yet (DLNA/Sonos/Cast — Phase 2).
   */
  private async runUrlHandover(ctx: ZoneContext, _session: PlaybackSession): Promise<void> {
    // Never the speaker of a member that plays its leader's stream: like every other piece of
    // the zone's own playback, a handover of its own must not reach it (see
    // `OutputRouter.outputsDrivenByZone`, #409).
    const candidates = ctx.outputs.filter(
      (o) => typeof o.enqueueRotation === 'function' && !followsLeaderStream([o]),
    );
    if (candidates.length === 0) return;
    const rotation = this.deps.audioManager.rotateStreamId(ctx.id);
    if (!rotation) return;
    // Re-fetch the session AFTER rotation so it carries the new stream.url.
    const rotatedSession = this.deps.audioManager.getSession(ctx.id);
    if (!rotatedSession) return;
    let enqueuedAtLeastOne = false;
    for (const output of candidates) {
      try {
        const ok = await output.enqueueRotation!(rotatedSession);
        if (ok) enqueuedAtLeastOne = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn('output enqueueRotation failed', {
          zoneId: ctx.id,
          type: output.type,
          message,
        });
      }
    }
    if (!enqueuedAtLeastOne) {
      // No output accepted the handover. This can happen in two cases:
      // 1. Grouped playback (enqueueRotation returns false for sync groups) AND players
      //    are still connected — old URL continues serving them, nothing to do.
      // 2. All players disconnected before the crossfade completed (e.g. squeezelite
      //    closed the connection when elapsed >= duration) — in this case we must
      //    dispatch a fresh play to restart the group on the new rotated stream URL.
      const currentSession = this.deps.audioManager.getSession(ctx.id);
      if (currentSession && currentSession.state === 'playing') {
        const streamStats = this.deps.audioManager.getStreamStats(ctx.id);
        const hasSubscribers = streamStats.some((s) => s.subscribers > 0);
        if (!hasSubscribers) {
          this.deps.log.debug(
            'url handover skipped — no subscribers; dispatching play to restart group',
            { zoneId: ctx.id },
          );
          this.deps.dispatchOutputs(ctx, ctx.outputs, 'play', currentSession);
          return;
        }
      }
      this.deps.log.debug('url handover skipped — no output accepted enqueue', { zoneId: ctx.id });
      return;
    }
    // Give the output a moment to receive the slimproto frame, open a TCP connection
    // to the new URL, and pre-buffer enough FLAC frames that an EOF on the old URL
    // doesn't cause an audible underrun. The squeezelite `expect=1` param sets the
    // network buffer threshold to ~32 KB (~200 ms of audio); 700 ms gives squeezelite
    // ~3.5× that threshold to pre-buffer the new URL while still keeping the OLD URL
    // alive briefly enough to minimise the perceptible stutter at handover. Earlier
    // 1500 ms was safe but produced an audible 1–3 s buffering window when the OLD
    // the producer stalled at the same time as the rotation.
    setTimeout(() => {
      try {
        this.deps.audioManager.closeSubscribersForStreamId(ctx.id, rotation.oldId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log.warn('closeSubscribersForStreamId failed', {
          zoneId: ctx.id,
          oldId: rotation.oldId,
          message,
        });
      }
    }, 700);
  }
}
