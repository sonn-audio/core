import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { clampVolumeForZone, getZoneDefaultVolume } from '@/application/zones/helpers/stateHelpers';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  buildMetadataPatch,
  buildPositionPatch,
  buildResumedPatch,
  buildStartedPatch,
  buildStoppedPatch,
  buildVolumePatch,
} from '@/application/zones/playback/patchBuilder';
import { resolveZoneStateControllerId } from '@/application/zones/state/authorityPolicies';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Zones', 'PlayerListeners');

type PlayerListenerCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  dispatchVolume: (ctx: ZoneContext, outputs: ZoneOutput[], volume: number) => void;
  /** Say what the room is at, for an input whose own client draws a slider for it. */
  spotifyVolume?: (zoneId: number, volume: number) => void;
  buildAbsoluteCoverUrl: (pathname: string) => string;
  audioHelpers: ZoneAudioHelpers;
  stopAlert: (zoneId: number) => Promise<void>;
  handleEndOfTrack: (ctx: ZoneContext) => Promise<void>;
  handlePlaybackError: (
    zoneId: number,
    reason: string | undefined,
    source: 'player',
    extra: { zone: string; sourceMac: string },
  ) => void;
  onCrossfadePosition?: (zoneId: number, time: number, duration: number) => void;
};

export function attachPlayerListeners(args: {
  coordinator: PlayerListenerCoordinator;
  player: ZoneContext['player'];
  outputs: ZoneOutput[];
  zoneId: number;
  zoneName: string;
  sourceMac: string;
}): void {
  const { coordinator, player, outputs, zoneId, zoneName, sourceMac } = args;
  player.on('paused', (session) => onPlayerPaused(coordinator, zoneId, outputs, session));
  player.on('started', (session) => onPlayerStarted(coordinator, zoneId, outputs, session));
  player.on('resumed', (session) => onPlayerResumed(coordinator, zoneId, outputs, session));
  player.on('stopped', (session) => onPlayerStopped(coordinator, zoneId, outputs, session));
  player.on('position', (time, duration) => onPlayerPosition(coordinator, zoneId, time, duration));
  player.on('metadata', (metadata) => onPlayerMetadata(coordinator, zoneId, metadata));
  player.on('cover', (relative) => onPlayerCover(coordinator, zoneId, relative));
  player.on('volume', (level) => onPlayerVolume(coordinator, zoneId, outputs, level));
  player.on('ended', () => onPlayerEnded(coordinator, zoneId));
  player.on('error', (reason) => onPlayerError(coordinator, zoneId, reason, zoneName, sourceMac));
}

const RESET_VOLUME_ON_PAUSE_DELAY_MS = 20000;

function clearResetVolumeTimer(ctx: ZoneContext | undefined): void {
  if (ctx?.resetVolumeTimer) {
    clearTimeout(ctx.resetVolumeTimer);
    ctx.resetVolumeTimer = undefined;
  }
}

function scheduleResetVolumeOnPause(
  coordinator: PlayerListenerCoordinator,
  ctx: ZoneContext,
): void {
  clearResetVolumeTimer(ctx);
  const timer = setTimeout(() => {
    ctx.resetVolumeTimer = undefined;
    const current = coordinator.getZone(ctx.id);
    // Only fire if the zone is still paused on the same context and not in an alert.
    if (!current || current !== ctx || current.alert || current.state.mode !== 'pause') {
      return;
    }
    const defaultVolume = getZoneDefaultVolume(current.config);
    // Routing the change through the player makes onPlayerVolume update state
    // and dispatch to outputs through the existing path.
    current.player.setVolume(defaultVolume);
  }, RESET_VOLUME_ON_PAUSE_DELAY_MS);
  timer.unref?.();
  ctx.resetVolumeTimer = timer;
}

function onPlayerPaused(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'pause', session);
  }
  coordinator.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
  const ctx = coordinator.getZone(zoneId);
  // A zone without a configured default volume resolves to 0, and "reset to the default"
  // must not mean "reset to silence": the reset parked the zone at 0, so the next play
  // started muted and fought the renderer's own level (issue #358, second report).
  if (
    ctx &&
    !ctx.alert &&
    ctx.config.playback?.resetVolumeOnPause === true &&
    getZoneDefaultVolume(ctx.config) > 0
  ) {
    scheduleResetVolumeOnPause(coordinator, ctx);
  }
}

function onPlayerStarted(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  // Capture pending reset *before* clearing — a still-pending timer means
  // "pause happened, reset hasn't been applied or overridden yet". In that
  // case the play should start at the default (reference Loxone: pause =
  // volume back to default for the next play).
  const hadPendingReset = ctxReset?.resetVolumeTimer !== undefined;
  // Does the player agree that this zone is off? `state.mode` alone does not settle it: an output
  // that runs dry between two queue tracks echoes STOPPED back into the zone state, so a plain
  // `state.mode === 'stop'` read every track change as a cold start and put the zone default back
  // on the outputs — the volume moved on its own after every song (#322). This flag is the veto on
  // that false positive and nothing more: `ZonePlayer.stop()` is the only thing that clears it, and
  // a queue advance never calls it. `state.mode` stays the signal, so a paused or playing zone is
  // still not a fresh start whatever the flag says.
  const wasPlayerActive = ctxReset?.playerActive === true;
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
    ctxReset.playerActive = true;
    clearResetVolumeTimer(ctxReset);
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'play', session);
  }
  const ctx = coordinator.getZone(zoneId);
  if (ctx) {
    // During an alert, the alert flow has already set state.volume to the
    // per-event volume (e.g. the TTS slider value). Don't replace it.
    // A volume step that started the zone carries the listener's own choice of level. Honouring the
    // default there would throw away the very press that started the music.
    const startAtCurrentVolume = ctx.startAtCurrentVolume === true;
    ctx.startAtCurrentVolume = undefined;
    const isFreshStart =
      !ctx.alert &&
      !startAtCurrentVolume &&
      ((ctx.state.mode === 'stop' && !wasPlayerActive) || hadPendingReset);
    const volume = isFreshStart
      ? getZoneDefaultVolume(ctx.config)
      : clampVolumeForZone(ctx.config, ctx.state.volume);
    /*
     * No `player.setVolume` here.
     *
     * The real player's `setVolume` only emits, and `onPlayerVolume` answers that by
     * patching the volume and dispatching to outputs — which is exactly what the two
     * calls below already do, and they carry the started patch besides. On a fresh
     * start it therefore only bought a second dispatch to every output and a second
     * state patch. The pause-reset timer is already cleared unconditionally above,
     * so the listener's other side effect is not missed either.
     */
    // [#287] Trace the start-volume decision so we can see, on Spotify Connect
    // activation, whether the zone default is applied and dispatched to outputs.
    log.debug('player started: start-volume decision', {
      zoneId,
      activeInput: ctx.activeInput,
      isFreshStart,
      hadPendingReset,
      wasPlayerActive,
      mode: ctx.state.mode,
      stateVolume: ctx.state.volume,
      defaultVolume: getZoneDefaultVolume(ctx.config),
      dispatchedVolume: volume,
      outputs: outputs.map((o) => o.type),
    });
    coordinator.dispatchVolume(ctx, outputs, volume);
    // And to the Spotify app, when Spotify is what started. A Connect device carries a level of its
    // own, remembered from whenever it last played; saying what the room is at replaces it, so the
    // slider stands where the zone does instead of where some other room left it.
    coordinator.spotifyVolume?.(zoneId, volume);
    const patch = {
      ...buildStartedPatch({ ctx, session, audioHelpers: coordinator.audioHelpers }),
      volume,
    };
    coordinator.applyPatch(zoneId, patch);
  }
}

function onPlayerResumed(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  // See onPlayerStarted: a pending reset at resume time means the user hasn't
  // overridden the volume during the pause window, so apply the default now.
  const hadPendingReset = ctxReset?.resetVolumeTimer !== undefined;
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
    ctxReset.playerActive = true;
    clearResetVolumeTimer(ctxReset);
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'resume', session);
  }
  const ctx = coordinator.getZone(zoneId);
  if (ctx) {
    const patch = buildResumedPatch({ ctx, audioHelpers: coordinator.audioHelpers });
    if (!ctx.alert && hadPendingReset) {
      const defaultVolume = getZoneDefaultVolume(ctx.config);
      /*
       * `setVolume` dispatches on its own (synchronous emit -> onPlayerVolume), so
       * the follow-up dispatch that used to sit here was a duplicate. It also sent
       * the raw configured default rather than the clamped value, so a zone whose
       * default sits above its own `maxVolume` had the out-of-policy level land on
       * its outputs as the last word.
       */
      ctx.player.setVolume(defaultVolume);
      coordinator.applyPatch(zoneId, { ...patch, volume: defaultVolume });
    } else {
      coordinator.applyPatch(zoneId, patch);
    }
  }
}

function onPlayerStopped(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  session: PlaybackSession | null | undefined,
): void {
  const ctxReset = coordinator.getZone(zoneId);
  if (ctxReset) {
    ctxReset.outputTimingActive = false;
    ctxReset.lastOutputTimingAt = 0;
    // The zone is off until something starts it again, and the next start is a cold one.
    ctxReset.playerActive = false;
    clearResetVolumeTimer(ctxReset);
  }
  const ctxLocal = coordinator.getZone(zoneId);
  if (ctxLocal) {
    coordinator.dispatchOutputs(ctxLocal, outputs, 'stop', session);
  }
  coordinator.applyPatch(zoneId, buildStoppedPatch());
}

function onPlayerPosition(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  time: number,
  duration: number,
): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  const controllerId = resolveZoneStateControllerId(ctx.config);
  const stateAudiopath = typeof ctx.state.audiopath === 'string' ? ctx.state.audiopath.trim() : '';
  if (controllerId !== 'internal' && !stateAudiopath) {
    // External state controller owns progress when no local audiopath is active.
    return;
  }
  if (coordinator.audioHelpers.isRadioAudiopath(ctx.state.audiopath, ctx.state.audiotype)) {
    if (ctx.state.time !== 0 || ctx.state.duration !== 0) {
      coordinator.applyPatch(
        zoneId,
        buildPositionPatch({ time: 0, duration: 0, forceDurationZero: true }),
      );
    }
    return;
  }
  // For controllable radio (e.g. Radio Paradise), duration is owned by metadata updates.
  // Timing updates may carry block/stream durations and should not override the current track duration.
  const suppressDuration = ctx.metadata.radioControllable === true;
  const alertDurationOverride =
    ctx.alert && typeof ctx.alert.reportedDurationSec === 'number' && ctx.alert.reportedDurationSec > 0
      ? Math.round(ctx.alert.reportedDurationSec)
      : null;
  const now = Date.now();
  const safeDuration = suppressDuration
    ? 0
    : Math.max(0, alertDurationOverride ?? duration);
  const safeTime = Math.max(0, Math.min(time, safeDuration || Number.MAX_SAFE_INTEGER));
  const durationChanged =
    safeDuration > 0 &&
    (typeof ctx.state.duration !== 'number' || Math.round(ctx.state.duration) !== safeDuration);
  const withinThrottle =
    now - ctx.lastPositionUpdateAt < 1000 && safeTime === ctx.lastPositionValue && !durationChanged;
  if (withinThrottle) {
    return;
  }
  ctx.lastPositionUpdateAt = now;
  ctx.lastPositionValue = safeTime;
  if (suppressDuration) {
    coordinator.applyPatch(zoneId, { time: safeTime });
  } else {
    coordinator.applyPatch(zoneId, buildPositionPatch({ time: safeTime, duration: safeDuration }));
  }
  coordinator.onCrossfadePosition?.(zoneId, safeTime, safeDuration);

  if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt < 8000) {
    return;
  }
  if (ctx.outputTimingActive && now - ctx.lastOutputTimingAt >= 8000) {
    ctx.outputTimingActive = false;
  }
}

function onPlayerMetadata(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  metadata: PlaybackMetadata,
): void {
  const patch = buildMetadataPatch(metadata);
  applyPatchIfNonEmpty(coordinator.applyPatch, zoneId, patch);
}

function onPlayerCover(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  relative: string | null | undefined,
): void {
  const coverurl = relative ? `${coordinator.buildAbsoluteCoverUrl(relative)}?t=${Date.now()}` : '';
  if (coverurl) {
    coordinator.applyPatch(zoneId, { coverurl });
  }
}

function onPlayerVolume(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  outputs: ZoneOutput[],
  level: number,
): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  // A volume change during a pending pause-time reset is treated as the user
  // intentionally setting the next-play volume — cancel the reset so it
  // doesn't clobber their choice when the window expires.
  clearResetVolumeTimer(ctx);
  const clamped = clampVolumeForZone(ctx.config, level);
  coordinator.applyPatch(zoneId, buildVolumePatch(clamped));
  coordinator.dispatchVolume(ctx, outputs, clamped);
  // Every volume the zone settles on passes here — a command, a mute, a group, or the Spotify app
  // itself. Told unconditionally: only the input service can say whether Spotify is what this room
  // is playing, and a level it has just reported is one it already knows, so nothing echoes.
  coordinator.spotifyVolume?.(zoneId, clamped);
}

function onPlayerEnded(coordinator: PlayerListenerCoordinator, zoneId: number): void {
  const ctx = coordinator.getZone(zoneId);
  if (!ctx) {
    return;
  }
  if (ctx.alert) {
    void coordinator.stopAlert(zoneId);
    return;
  }
  void coordinator.handleEndOfTrack(ctx);
}

function onPlayerError(
  coordinator: PlayerListenerCoordinator,
  zoneId: number,
  reason: string | undefined,
  zoneName: string,
  sourceMac: string,
): void {
  coordinator.handlePlaybackError(zoneId, reason, 'player', { zone: zoneName, sourceMac });
}

function applyPatchIfNonEmpty(
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void,
  zoneId: number,
  patch: Partial<ZoneState>,
): void {
  if (Object.keys(patch).length > 0) {
    applyPatch(zoneId, patch);
  }
}
