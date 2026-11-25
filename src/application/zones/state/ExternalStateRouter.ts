import type { ComponentLogger } from '@/shared/logging/logger';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSession } from '@/ports/types/playback';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { QueueItem } from '@/application/zones/internal/zoneTypes';
import { resolveZoneStateControllerId } from '@/application/zones/state/authorityPolicies';
import type { ExternalTakeover } from '@/application/zones/state/StateController';

export type ExternalStateRouterDeps = {
  zones: ZoneRepository;
  audioManager: Pick<AudioManager, 'hasActiveLocalSession' | 'getSession' | 'stopPlayback'>;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  notifyQueueUpdated: (zoneId: number, queueSize: number) => void;
  /**
   * Give the zone up to whoever has the speaker now: its queue stops advancing and whatever fed
   * it is let go of, without touching the speaker, which is playing something else. True when the
   * zone had playback of its own to let go of - the handing over happens either way, because a
   * session that ended on its own still leaves a queue armed and a Spotify run alive.
   */
  yieldToExternalSource: (zoneId: number) => boolean;
  log: ComponentLogger;
};

/**
 * Routes state-controller updates (BeoLink, MA, Sonos, etc.) into the zone.
 *
 * The state controller is the source of truth for what the speaker is actually
 * playing — even when we have a local audio session feeding it. Patches are
 * therefore applied unconditionally, with one narrow exception: while a local
 * session is active we suppress `time` and `duration` because some controllers
 * (notably MA, which treats our HTTP stream as a radio source) report jittery
 * or bogus position for our own content. The local ticker remains authoritative
 * for those two fields; everything else (mode/title/artist/album/cover/audiopath/
 * volume) propagates so external takeovers and source changes surface in Loxone
 * the moment the controller observes them.
 */
export class ExternalStateRouter {
  private readonly deps: ExternalStateRouterDeps;

  constructor(deps: ExternalStateRouterDeps) {
    this.deps = deps;
  }

  public onStatePatch(zoneId: number, patch: Partial<ZoneState>): void {
    const ctx = this.deps.zones.get(zoneId);
    if (!ctx) {
      return;
    }
    const controllerId = resolveZoneStateControllerId(ctx.config);
    if (controllerId === 'internal') {
      this.deps.applyPatch(zoneId, patch);
      return;
    }
    const hasActiveLocalSession = this.deps.audioManager.hasActiveLocalSession(zoneId);
    if (hasActiveLocalSession) {
      const propagated: Partial<ZoneState> = { ...patch };
      delete propagated.time;
      delete propagated.duration;
      // A controller that cannot name what it plays (Sonos always reports '') says nothing
      // about our content. Taking its empty audiopath blanked the path of the stream we were
      // playing, so a favourite saved from the app came out empty and would not play (#439).
      // A speaker that really went elsewhere ends the session first (onExternalTakeover).
      if (propagated.audiopath === '') {
        delete propagated.audiopath;
      }
      if (Object.keys(propagated).length === 0) return;
      this.deps.applyPatch(zoneId, propagated);
      return;
    }
    const session = this.deps.audioManager.getSession(zoneId);
    if (session) {
      if (isOwnPauseEcho(session, patch)) {
        // Not a stale session: it is the pause we just performed, coming back at us. Sonos does
        // not pause a length-less HTTP stream — it drops the connection and reports STOPPED —
        // so tearing the session down here is what left the zone with nothing to resume and the
        // follow-up play deflected to the controller (issue #345). Keep the session (its source
        // and elapsed position are the resume point) and keep reporting 'pause': the local state
        // is authoritative for our own content, exactly as time/duration are above.
        const propagated: Partial<ZoneState> = { ...patch };
        delete propagated.mode;
        delete propagated.time;
        delete propagated.duration;
        if (Object.keys(propagated).length === 0) return;
        this.deps.applyPatch(zoneId, propagated);
        return;
      }
      // Session object can outlive real output playback; drop it before accepting external authority.
      // The zone is given up first: the speaker is playing somebody else's source, so its queue
      // must stop advancing and the run that fed this session must be let go of - a stale session
      // dropped on its own left both behind and the queue could take the speaker back later.
      this.deps.yieldToExternalSource(zoneId);
      this.deps.audioManager.stopPlayback(zoneId);
      this.deps.log.info('cleared stale local session before external state patch', {
        zoneId,
        controller: controllerId,
      });
    }
    this.deps.applyPatch(zoneId, patch);
  }

  /**
   * The speaker switched itself to a source of its own while it was playing ours (#430: a Sonos
   * soundbar going to TV audio when the TV comes on). The zone gives the speaker up, the way a
   * stop would, so that the next track of its session is not pushed to the speaker and does not
   * take it back. It stays that way until somebody picks something for the zone again.
   */
  public onExternalTakeover(zoneId: number, takeover: ExternalTakeover): void {
    const ctx = this.deps.zones.get(zoneId);
    if (!ctx) return;
    const controllerId = resolveZoneStateControllerId(ctx.config);
    if (controllerId === 'internal') return;
    // Logged whether or not the zone still had playback of its own: the handing over happens
    // either way, and a takeover that arrives after our session ended on its own is exactly the
    // case that has to stay diagnosable.
    const hadOwnPlayback = this.deps.yieldToExternalSource(zoneId);
    this.deps.log.info('zone yielded its speaker to an external source', {
      zoneId,
      controller: controllerId,
      source: takeover.sourceName,
      mediaUrl: takeover.mediaUrl,
      hadOwnPlayback,
    });
  }

  public onQueueMirror(zoneId: number, items: QueueItem[], currentIndex: number): void {
    const ctx = this.deps.zones.get(zoneId);
    if (!ctx) return;
    // Only mirror MA's queue when there's no local audio session — when we're
    // streaming our own content into MA, the local queue is authoritative.
    if (this.deps.audioManager.hasActiveLocalSession(zoneId)) {
      return;
    }
    const safeIndex = Math.max(0, Math.min(items.length - 1, Math.floor(currentIndex)));
    ctx.queueController.setItems(items, safeIndex);
    // Mark the zone as queue-driven so the Loxone app renders the queue UI:
    //   - audiotype = 2 (Playlist) tells the app "we're playing from a queue"
    //   - qid is the unique_id of the current item
    //   - queueAuthority = local mirrors the existing playContent flow
    const current = items[safeIndex];
    if (current) {
      const patch: Partial<ZoneState> = {
        audiopath: current.audiopath,
        audiotype: 2,
        qindex: safeIndex,
        qid: current.unique_id,
        queueAuthority: 'local',
      };
      this.deps.applyPatch(zoneId, patch);
    }
    this.deps.notifyQueueUpdated(zoneId, items.length);
  }
}

/**
 * True when the patch is the speaker echoing back a pause we performed ourselves.
 *
 * A paused session that still owns a playback source is ours by definition — a zone only reaches
 * that state through our own pause path. What ends it is the device reporting that it is playing
 * again: that is either our resume (which flips the session back to 'playing' first, so it never
 * gets here) or something else taking the speaker over, and then the session really is stale.
 */
function isOwnPauseEcho(session: PlaybackSession, patch: Partial<ZoneState>): boolean {
  return session.state === 'paused' && Boolean(session.playbackSource) && patch.mode !== 'play';
}
