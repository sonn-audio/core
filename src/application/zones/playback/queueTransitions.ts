import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { QueueItem } from '@/ports/types/queueTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';

type QueueTransitionCoordinator = {
  getZone: (zoneId: number) => ZoneContext | undefined;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
  startQueuePlayback: (
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ) => Promise<PlaybackSession | null>;
  prefetchPlaybackSource?: (ctx: ZoneContext, audiopath: string) => void;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>) => void;
  dispatchOutputs: (
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ) => void;
  recentsRecord: (zoneId: number, item: QueueItem) => Promise<void>;
  audioHelpers: ZoneAudioHelpers;
};

export async function stepQueueAsync(args: {
  coordinator: QueueTransitionCoordinator;
  zoneId: number;
  delta: number;
}): Promise<void> {
  const { coordinator, zoneId, delta } = args;
  const ctx = coordinator.getZone(zoneId);
  if (!ctx || ctx.queue.items.length === 0) {
    return;
  }
  if (!coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
    return;
  }
  ctx.queueHeld = false;

  const nextIndex = ctx.queueController.step(delta);
  if (nextIndex < 0) {
    return;
  }

  const item = ctx.queueController.current();
  if (!item) {
    return;
  }
  coordinator.prefetchPlaybackSource?.(ctx, item.audiopath);
  const session = await coordinator.startQueuePlayback(ctx, item.audiopath, {
    title: item.title,
    artist: item.artist,
    album: item.album,
    coverurl: item.coverurl,
    audiopath: item.audiopath,
    duration: item.duration,
    station: item.station,
    isRadio: coordinator.audioHelpers.isRadioAudiopath(item.audiopath, item.audiotype),
  });
  if (session) {
    const basePatch = buildQueueItemPlaybackPatch(ctx, item, nextIndex, coordinator.audioHelpers);
    coordinator.applyPatch(zoneId, {
      ...basePatch,
      mode: 'play',
      clientState: 'on',
      power: 'on',
      duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : undefined,
      queueAuthority: ctx.queue.authority,
      time: 0,
    });
  }
}

export async function handleEndOfTrack(args: {
  coordinator: QueueTransitionCoordinator;
  ctx: ZoneContext;
}): Promise<void> {
  const { coordinator, ctx } = args;

  // Stop at a real end-of-track (nothing more to play), keeping the just-ended
  // track's duration in the stopped state. buildStoppedPatch zeroes duration,
  // and the Loxone app renders a stopped zone with duration 0 as a "LIVE" bar.
  // Capture the duration before stop() (which resets it via buildStoppedPatch).
  const stopAtEnd = (reason: string): void => {
    const endedDuration = Math.max(0, Math.round(ctx.state.duration ?? 0));
    const stopped = ctx.player.stop(reason);
    coordinator.dispatchOutputs(ctx, ctx.outputs, 'stop', stopped);
    if (endedDuration > 0) {
      coordinator.applyPatch(ctx.id, { duration: endedDuration });
    }
  };

  const queueSize = ctx.queue.items.length;
  if (queueSize === 0) {
    stopAtEnd('queue_empty');
    return;
  }

  if (!coordinator.isLocalQueueAuthority(ctx.queue.authority)) {
    return;
  }

  let nextIndex = ctx.queueController.nextIndex();
  if (nextIndex < 0) {
    stopAtEnd('queue_end');
    return;
  }

  // Walk forward until a track actually starts, skipping past unplayable ones (e.g. a track Apple
  // pulled from the storefront) instead of stopping the zone dead. `visited` bounds the walk so
  // repeat-one/repeat-all can't loop forever, and we dispatch a single stop only once exhausted.
  const visited = new Set<number>();
  let attemptedStart = false;
  while (nextIndex >= 0 && !visited.has(nextIndex)) {
    visited.add(nextIndex);
    ctx.queueController.setCurrentIndex(nextIndex);
    const next = ctx.queueController.current();
    if (!next) {
      stopAtEnd('queue_invalid_next');
      return;
    }
    const session = await coordinator.startQueuePlayback(ctx, next.audiopath, {
      title: next.title,
      artist: next.artist,
      album: next.album,
      coverurl: next.coverurl,
      audiopath: next.audiopath,
      duration: next.duration,
      station: next.station,
    });
    attemptedStart = true;
    if (session) {
      const basePatch = buildQueueItemPlaybackPatch(
        ctx,
        next,
        ctx.queueController.currentIndex(),
        coordinator.audioHelpers,
      );
      coordinator.applyPatch(ctx.id, {
        ...basePatch,
        mode: 'play',
        clientState: 'on',
        power: 'on',
        time: 0,
      });
      void coordinator.recentsRecord(ctx.id, next);
      return;
    }
    nextIndex = ctx.queueController.nextIndex();
  }

  // No track in the queue could be started. Preserve the distinct stop reason: a genuine start
  // attempt that failed is queue_next_failed, otherwise we simply ran off the end.
  stopAtEnd(attemptedStart ? 'queue_next_failed' : 'queue_end');
}
