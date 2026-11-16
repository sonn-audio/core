import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata } from '@/ports/types/playback';
import type { ZoneContext, QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { ContentPort } from '@/ports/ContentPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { resolvePlaybackSource } from '@/application/playback/sourceResolver';
import { buildQueueItemPlaybackPatch } from '@/application/zones/playback/patchBuilder';
import { followsLeaderStream } from '@/application/zones/helpers/groupFollower';

/** How long before the end of a track the next one is lined up. */
const ARM_AHEAD_SEC = 20;
/**
 * How much earlier still for a local file, as a share of its length.
 *
 * A file bound for a FLAC output is decoded at up to 1.1 times real time, so its decoder can be
 * done a tenth of the track before the room is — and a decoder that has finished has nothing left
 * to join onto. A stream is decoded in real time and needs no such margin; holding its successor's
 * connection open for minutes would be asking for a timeout.
 */
const FILE_ARM_AHEAD_SHARE = 0.11;
/** How long the end of a track waits for a join that is under way but not yet reported. */
const JOIN_WAIT_MS = 3000;

interface GaplessEntry {
  nextAudiopath: string;
  nextQueueIndex: number;
  metadata: PlaybackMetadata;
  /** Set once the engine has joined the next track on; null while it is only lined up. */
  joined: { source: PlaybackSource; engineSession: number | null } | null;
  /** Settles when the engine reports: true for joined, false for not going to happen. */
  outcome: Promise<boolean>;
}

export interface GaplessControllerDeps {
  zoneRepo: ZoneRepository;
  audioManager: AudioManager;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  configPort: ConfigPort;
  recentsManager: RecentsManager;
  log: ComponentLogger;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean;
}

/**
 * Lets one track run into the next with nothing in between.
 *
 * The end of a track used to stop its session and start another, and every output was told to play
 * a new stream. On a live album, a symphony or a mix, that is a silence where the recording has
 * none. Here the next track is handed to the engine shortly before the current one ends; the
 * engine joins it onto the same stream at the last sample (see `GaplessAppender`), and when the
 * room has finished hearing the outgoing track this controller moves the queue, the clock and
 * what the clients show over to the next one. No output is told anything, because for the outputs
 * nothing happened.
 *
 * Whatever goes wrong on the way leaves the old behaviour: no entry, no join, and the end of the
 * track starts the next one as a session of its own.
 */
export class GaplessController {
  private readonly state = new Map<number, GaplessEntry>();

  constructor(private readonly deps: GaplessControllerDeps) {}

  private enabled(): boolean {
    const audio = this.deps.configPort.getSystemConfig()?.audioserver;
    // Crossfade is the other way of getting from one track to the next, and has the floor when on.
    return audio?.gapless !== false && !((audio?.crossfadeSec ?? 0) > 0);
  }

  /** Drop whatever is lined up for a zone: something else is about to decide what plays next. */
  public clear(zoneId: number): void {
    if (this.state.delete(zoneId)) {
      this.deps.audioManager.disarmGapless(zoneId);
    }
  }

  public onPosition(zoneId: number, time: number, duration: number): void {
    const lined = this.state.get(zoneId);
    if (lined) {
      // A join belongs to the engine session it was made in. A stop, a seek or a restart since then
      // replaced that session, and what was joined onto it went with it.
      if (!lined.joined || this.deps.audioManager.isOnEngineSession(zoneId, lined.joined.engineSession)) {
        return;
      }
      this.state.delete(zoneId);
    }
    if (!duration || duration <= 0 || !this.enabled()) return;
    const remaining = duration - time;
    if (remaining <= 0) return;
    const session = this.deps.audioManager.getSession(zoneId);
    const kind = session?.playbackSource?.kind;
    if (!session || session.state !== 'playing' || session.metadata?.isRadio) return;
    if (kind !== 'file' && kind !== 'url') return;
    const armAhead = ARM_AHEAD_SEC + (kind === 'file' ? duration * FILE_ARM_AHEAD_SHARE : 0);
    if (remaining > armAhead) return;
    const ctx = this.deps.zoneRepo.get(zoneId);
    if (!ctx || ctx.alert || ctx.inputMode === 'alert') return;
    if (!this.deps.isLocalQueueAuthority(ctx.queue.authority)) return;
    // A Squeezelite player is told how long its track is and closes the stream when it gets there,
    // so a stream that runs on would be cut off. A member playing its leader's stream has no
    // transitions of its own.
    if (ctx.outputs.some((output) => output.type === 'squeezelite') || followsLeaderStream(ctx.outputs)) return;

    const nextIndex = ctx.queueController.nextIndex();
    if (nextIndex < 0 || nextIndex === ctx.queueController.currentIndex()) return;
    const next = ctx.queue.items[nextIndex];
    if (!next) return;
    const { audioHelpers } = this.deps;
    if (
      audioHelpers.isRadioAudiopath(next.audiopath, next.audiotype) ||
      audioHelpers.isMusicAssistantAudiopath(next.audiopath) ||
      audioHelpers.isSpotifyAudiopath(next.audiopath)
    ) {
      return;
    }

    const metadata: PlaybackMetadata = {
      title: next.title || '',
      artist: next.artist || '',
      album: next.album || '',
      coverurl: next.coverurl,
      duration: next.duration,
      audiopath: next.audiopath,
      station: next.station,
      isRadio: false,
    };
    const entry: GaplessEntry = {
      nextAudiopath: next.audiopath,
      nextQueueIndex: nextIndex,
      metadata,
      joined: null,
      outcome: Promise.resolve(false),
    };
    // Registered first: `lineUp` checks that its entry is still the zone's before it goes on.
    this.state.set(zoneId, entry);
    entry.outcome = this.lineUp(ctx, entry).catch(() => false);
    void entry.outcome.then((joined) => {
      // Nothing lined up after all: forget it, so the end of the track is an ordinary one.
      if (!joined && this.state.get(zoneId) === entry) {
        this.state.delete(zoneId);
      }
    });
  }

  private async lineUp(ctx: ZoneContext, entry: GaplessEntry): Promise<boolean> {
    const zoneId = ctx.id;
    const owner = this.deps.audioHelpers.providerForAudiopath(entry.nextAudiopath);
    const source: PlaybackSource | null = owner
      ? (
          await this.deps.contentPort
            .resolvePlaybackSource({ audiopath: entry.nextAudiopath, requester: { kind: 'zone', zoneId } })
            .catch(() => null)
        )?.playbackSource ?? null
      : resolvePlaybackSource(entry.nextAudiopath);
    if (!source || this.state.get(zoneId) !== entry) {
      return false;
    }
    const splice = await this.deps.audioManager.armGapless(zoneId, source, entry.metadata);
    if (!splice || this.state.get(zoneId) !== entry) {
      return false;
    }
    entry.joined = { source: splice.source, engineSession: splice.engineSession };
    this.deps.log.debug('next track joined in the engine; waiting for the room to reach it', {
      zoneId,
      next: entry.nextAudiopath,
      outgoingSec: Math.round((splice.frames / splice.sampleRate) * 10) / 10,
    });
    return true;
  }

  /**
   * The zone clock says the current track is over. True when the next one is already playing on
   * the same stream and everything has been moved over to it; false to let the caller start the
   * next track the ordinary way.
   */
  public async takeOver(ctx: ZoneContext): Promise<boolean> {
    const zoneId = ctx.id;
    const entry = this.state.get(zoneId);
    if (!entry) {
      return false;
    }
    // The queue may have been edited since the track was lined up; only the track that would have
    // been next anyway may take over.
    const stillNext = (): boolean => {
      const index = ctx.queueController.nextIndex();
      return index === entry.nextQueueIndex && ctx.queue.items[index]?.audiopath === entry.nextAudiopath;
    };
    if (!stillNext()) {
      this.clear(zoneId);
      return false;
    }
    if (!entry.joined) {
      // The clock got here before the decoder did — a track a little longer than its metadata says.
      const joined = await Promise.race([
        entry.outcome,
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), JOIN_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (!joined || this.state.get(zoneId) !== entry || !entry.joined || !stillNext()) {
        this.clear(zoneId);
        return false;
      }
    }
    this.state.delete(zoneId);
    const session = this.deps.audioManager.adoptGaplessNext(
      zoneId,
      entry.joined.source,
      entry.metadata,
      entry.joined.engineSession,
    );
    if (!session) {
      return false;
    }
    ctx.queueController.setCurrentIndex(entry.nextQueueIndex);
    ctx.player.updateStateForCrossfade(session);
    const item = ctx.queue.items[entry.nextQueueIndex];
    if (item) {
      this.deps.applyPatch(zoneId, {
        ...buildQueueItemPlaybackPatch(ctx, item, entry.nextQueueIndex, this.deps.audioHelpers),
        mode: 'play',
        clientState: 'on',
        power: 'on',
        time: 0,
        duration: typeof item.duration === 'number' ? Math.max(0, Math.round(item.duration)) : undefined,
      });
      void this.deps.recentsManager.record(zoneId, item);
    }
    this.deps.log.info('track changed without a gap', { zoneId, next: entry.nextAudiopath });
    return true;
  }
}
