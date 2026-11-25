import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { applyPreferredPlaybackSettings } from '@/application/playback/PlaybackSettingsApplier';
import type { PlaybackPlan } from '@/application/playback/types/PlaybackPlan';
import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import { normalizeSpotifyAudiopath, resolveSpotifyAccountId } from '@/application/zones/helpers/queueHelpers';
import {
  captureOwnershipEpoch,
  ownershipMoved,
} from '@/application/zones/playback/playbackOwnership';
import type { ContentPort } from '@/ports/ContentPort';
import type { InputsPort } from '@/ports/InputsPort';
import type { ComponentLogger } from '@/shared/logging/logger';

export type ExecutePlaybackPlanArgs = {
  ctx: ZoneContext;
  plan: PlaybackPlan;
  content: ContentPort;
  inputs: InputsPort;
  log: ComponentLogger;
  zoneAudioPrefs: ZoneAudioPreferences;
  startAtSec?: number;
};

export async function executePlaybackPlan(args: ExecutePlaybackPlanArgs): Promise<PlaybackSession | null> {
  const { ctx, plan, content, inputs, log, zoneAudioPrefs, startAtSec } = args;
  // Resolving a source can take seconds (a Spotify run has to start and become ready). If the
  // zone is handed to somebody else in that window, what comes back belongs to the previous
  // owner and must not be handed to the speaker: measured, a queue advance claimed a Sonos
  // speaker two minutes after the zone had yielded to a session started elsewhere.
  const ownershipEpoch = captureOwnershipEpoch(ctx);
  const abandonIfOwnershipMoved = (label: string | null, resolved: boolean): boolean => {
    if (!resolved || !ownershipMoved(ctx, ownershipEpoch)) {
      return false;
    }
    log.info('playback start abandoned; the zone changed hands while it was starting', {
      zoneId: ctx.id,
      source: label,
      audiopath: plan.audiopath,
    });
    if (label === 'spotify') {
      // The run holds the account and has to be let go of; nothing was dispatched to the output.
      inputs.stopSpotifySession(ctx.id, 'ownership_changed');
    }
    return true;
  };
  applyPreferredPlaybackSettings(zoneAudioPrefs, ctx.id, plan.preferredSettings);
  const normalizedStartAt =
    typeof startAtSec === 'number' && Number.isFinite(startAtSec) && startAtSec > 0 ? startAtSec : undefined;
  const resolveStartAt = (source?: PlaybackSource | null): number | undefined => {
    if (!normalizedStartAt) {
      return undefined;
    }
    if (!source) {
      return undefined;
    }
    // For pipe sources (e.g. a Spotify run), the ffmpeg seek is embedded in the stream via
    // startPositionMs and audioManager ignores startAtSec for pipes. However, startAt is still
    // needed so that zonePlayer initialises the ticker at the correct seek position instead of 0.
    return normalizedStartAt;
  };

  if (plan.playExternalLabel === 'musicassistant') {
    const result = await inputs.startStreamForAudiopath(
      ctx.id,
      ctx.name,
      plan.audiopath,
      {
        flow: true,
        parentAudiopath: plan.metadata.station,
        startItem: plan.audiopath,
        startIndex: typeof plan.metadata.stationIndex === 'number' ? plan.metadata.stationIndex : undefined,
        zoneConfig: ctx.config,
      },
    );
    if (result.playbackSource) {
      return ctx.player.playExternal(
        'musicassistant',
        result.playbackSource,
        plan.metadata,
        resolveStartAt(result.playbackSource),
      );
    }
    if (result.outputOnly) {
      return ctx.player.playExternal('musicassistant', null, plan.metadata);
    }
    return null;
  }

  if (plan.kind === 'provider-stream' && plan.playExternalLabel) {
    const result = await content.resolvePlaybackSource({
      audiopath: plan.audiopath,
      requester: { kind: 'zone', zoneId: plan.zoneId },
    });
    if (result.playbackSource) {
      if (abandonIfOwnershipMoved(plan.playExternalLabel, true)) {
        return null;
      }
      return ctx.player.playExternal(
        plan.playExternalLabel,
        result.playbackSource,
        plan.metadata,
        resolveStartAt(result.playbackSource),
      );
    }
    if (result.outputOnly) {
      return ctx.player.playExternal(plan.playExternalLabel, null, plan.metadata);
    }
    return null;
  }

  if (plan.playExternalLabel === 'spotify') {
    // The queue normalizes `spotify@AccountB:track:…` to `spotify:track:…`, so by the time a track
    // is played the audiopath no longer names the account — the queue row does, in `user`. Asking
    // the row first is what starts the second account in its own Soloist store instead of falling
    // through to the default account's (#377).
    const accountId = resolveSpotifyAccountId(plan.audiopath, findQueueUser(ctx, plan.audiopath));
    const seekPositionMs = normalizedStartAt ? Math.max(0, Math.round(normalizedStartAt * 1000)) : 0;
    const playbackSource = await inputs.getPlaybackSourceForUri(
      ctx.id,
      normalizeSpotifyAudiopath(plan.audiopath),
      seekPositionMs,
      accountId,
    );
    log.debug('startQueuePlayback spotify', {
      zoneId: ctx.id,
      audiopath: plan.audiopath,
      hasPlaybackSource: Boolean(playbackSource),
      playbackKind: playbackSource?.kind,
      queueSize: ctx.queue.items.length,
    });
    if (!playbackSource) {
      log.warn('spotify input not ready; blocking playback to avoid skips', { zoneId: ctx.id });
      return null;
    }
    if (abandonIfOwnershipMoved('spotify', true)) {
      return null;
    }
    const queueUris = ctx.queue.items.map((q) => q.audiopath);
    const queueIndex = ctx.queueController.currentIndex();
    const meta = {
      ...plan.metadata,
      queue: queueUris,
      queueIndex,
    } as PlaybackMetadata;
    const startAt = resolveStartAt(playbackSource);
    return ctx.player.playExternal('spotify', playbackSource, meta, startAt);
  }

  return ctx.player.playUri(plan.audiopath, plan.metadata, normalizedStartAt);
}

/**
 * The account the queue recorded for this track, if it is still the track the queue is on.
 *
 * Matched on the audiopath rather than taken from the current index: a fast-start plays before the
 * queue has been rebuilt, and answering with whatever the previous queue was on would name the
 * wrong account.
 */
function findQueueUser(ctx: ZoneContext, audiopath: string): string | undefined {
  const normalized = normalizeSpotifyAudiopath(audiopath);
  const current = ctx.queueController.current();
  if (current && normalizeSpotifyAudiopath(current.audiopath ?? '') === normalized) {
    return current.user;
  }
  const match = ctx.queue.items.find(
    (item) => normalizeSpotifyAudiopath(item.audiopath ?? '') === normalized,
  );
  return match?.user;
}
