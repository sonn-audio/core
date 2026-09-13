import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ZoneContext, QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import type { RadioParadiseBlockService } from '@/application/zones/radioparadise/radioParadiseBlockService';
import type { CrossfadeController } from '@/application/zones/playback/crossfadeController';
import { handleEndOfTrack as handleEndOfTrackTransition } from '@/application/zones/playback/queueTransitions';

export interface QueueAdvanceControllerDeps {
  zoneRepo: ZoneRepository;
  audioManager: AudioManager;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  configPort: ConfigPort;
  recentsManager: RecentsManager;
  radioParadise: RadioParadiseBlockService;
  crossfade: CrossfadeController;
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
  /** Warm the next track's input-resolved source ahead of time (e.g. Spotify direct-proxy). */
  prefetchInputSource?: (zoneId: number, audiopath: string, queueUser?: string) => void;
  /** Updates radio-style metadata after a Radio Paradise block resolution. */
  updateRadioMetadata: (
    zoneId: number,
    metadata: {
      title: string;
      artist: string;
      coverurl?: string;
      duration?: number;
      controllable?: boolean;
    },
  ) => void;
}

/**
 * Coordinates queue progression: end-of-track handling (with crossfade
 * suppression and Radio Paradise auto-skip), explicit Radio Paradise skip,
 * and proactive next-track prefetch for on-demand bridges.
 */
export class QueueAdvanceController {
  constructor(private readonly deps: QueueAdvanceControllerDeps) {}

  public async advanceTrack(ctx: ZoneContext): Promise<void> {
    const suppressMs =
      ((this.deps.configPort.getSystemConfig()?.audioserver?.crossfadeSec ?? 5) + 5) * 1000;
    if (this.deps.crossfade.consumeRecentTrigger(ctx.id, suppressMs)) {
      this.deps.log.debug('end_of_track suppressed; crossfade already advanced queue', {
        zoneId: ctx.id,
      });
      return;
    }

    const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
    if (
      this.deps.radioParadise.isRadioParadiseAudiopath(currentAudiopath) &&
      this.deps.radioParadise.canSkip(ctx.id)
    ) {
      const resolved = await this.deps.radioParadise.resolveNextBlock(ctx.id);
      if (resolved) {
        const metadata = this.buildRadioParadiseMetadata(ctx, resolved);
        const session = await this.deps.startQueuePlayback(ctx, resolved.url, metadata, {
          startAtSec: resolved.startAtSec,
          skipExternalStop: true,
        });
        if (session && resolved.track) {
          this.deps.updateRadioMetadata(ctx.id, {
            title: resolved.track.title,
            artist: resolved.track.artist,
            coverurl: resolved.track.coverurl,
            duration: resolved.track.durationSec,
            controllable: true,
          });
        }
        return;
      }
    }
    await handleEndOfTrackTransition({
      coordinator: {
        getZone: (id) => this.deps.zoneRepo.get(id),
        isLocalQueueAuthority: this.deps.isLocalQueueAuthority,
        startQueuePlayback: this.deps.startQueuePlayback,
        applyPatch: this.deps.applyPatch,
        dispatchOutputs: this.deps.dispatchOutputs,
        recentsRecord: this.deps.recentsManager.record.bind(this.deps.recentsManager),
        audioHelpers: this.deps.audioHelpers,
      },
      ctx,
    });
  }

  public async radioParadiseSkip(ctx: ZoneContext, delta: 1 | -1): Promise<void> {
    const timeSec = Number(ctx.player.getState().time) || 0;
    const resolved = await this.deps.radioParadise.resolveSkip(ctx.id, timeSec, delta);
    if (!resolved) {
      return;
    }
    const metadata = this.buildRadioParadiseMetadata(ctx, resolved);
    const session = await this.deps.startQueuePlayback(ctx, resolved.url, metadata, {
      startAtSec: resolved.startAtSec,
      skipExternalStop: true,
    });
    if (session && resolved.track) {
      this.deps.updateRadioMetadata(ctx.id, {
        title: resolved.track.title,
        artist: resolved.track.artist,
        coverurl: resolved.track.coverurl,
        duration: resolved.track.durationSec,
        controllable: true,
      });
    }
  }

  public prefetchNext(ctx: ZoneContext): void {
    if (!this.deps.isLocalQueueAuthority(ctx.queue.authority)) {
      return;
    }
    if (ctx.queue.items.length === 0) {
      return;
    }
    const schedulePrefetch = (index: number): void => {
      if (index < 0 || index >= ctx.queue.items.length) {
        return;
      }
      const item = ctx.queue.items[index];
      if (!item) {
        return;
      }
      if (this.deps.audioHelpers.isRadioAudiopath(item.audiopath, item.audiotype)) {
        return;
      }
      // Spotify direct-proxy is resolved by the input service, not the content
      // port, so it has its own warm-ahead path.
      if (this.deps.audioHelpers.isSpotifyAudiopath(item.audiopath)) {
        if (isTrackAudiopath(item.audiopath)) {
          // The row's account travels with it: the queue audiopath has none, and warming the
          // wrong account's store would be warming a source the track will not be played from.
          this.deps.prefetchInputSource?.(ctx.id, item.audiopath, item.user);
        }
        return;
      }
      // YouTube is absent as it was before; see ParentContextPolicy on these differing sets.
      const owner = this.deps.audioHelpers.providerForAudiopath(item.audiopath);
      if (!owner || owner === 'youtube') {
        return;
      }
      if (!isTrackAudiopath(item.audiopath)) {
        return;
      }
      void this.deps.contentPort
        .resolvePlaybackSource({
          audiopath: item.audiopath,
          prefetch: true,
          requester: { kind: 'zone', zoneId: ctx.id },
        })
        .catch((error) => {
          this.deps.log.debug('next track prefetch failed', {
            zoneId: ctx.id,
            audiopath: item.audiopath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const nextIndex = ctx.queueController.nextIndex();
    if (nextIndex < 0) {
      return;
    }
    schedulePrefetch(nextIndex);
    schedulePrefetch(nextIndex + 1);
  }

  private buildRadioParadiseMetadata(
    ctx: ZoneContext,
    resolved: {
      track?: { title: string; artist: string; album: string; coverurl?: string; durationSec?: number };
      blockDurationSec: number;
      stationLabel: string;
      isRadio: boolean;
    },
  ): PlaybackMetadata {
    const base: PlaybackMetadata = { title: '', artist: '', album: '' };
    const current = ctx.queueController.current();
    const audiopath = current?.audiopath ?? ctx.state.audiopath ?? '';
    const track = resolved.track;
    return {
      ...base,
      isRadio: resolved.isRadio,
      title: track?.title ?? base.title,
      artist: track?.artist ?? base.artist,
      album: track?.album ?? base.album,
      coverurl: track?.coverurl,
      duration: track?.durationSec ?? base.duration,
      station: resolved.stationLabel,
      audiopath,
    };
  }
}

function isTrackAudiopath(audiopath: string): boolean {
  return /:track:|:library-track:/i.test(audiopath);
}
