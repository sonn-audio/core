/**
 * Fans zone-state changes out to the per-zone DLNA renderers.
 *
 * Every zone with the DLNA input enabled advertises itself as a UPnP
 * MediaRenderer, and a control point that subscribes to one (Home Assistant's
 * `dlna_dmr`, BubbleUPnP, a TV) expects to be told what that zone is doing.
 * The renderer only ever hears about the casts it received itself, so without
 * this decorator it reports whatever it was last *asked* to do — `STOPPED` for
 * the whole life of a zone nobody ever cast to, while the zone happily plays.
 *
 * Same shape and same reason as `withApiEvents`: sitting in front of the one
 * internal zone-change signal means no future emit path can forget to reflect.
 * Every method is forwarded explicitly rather than spread, so a new port method
 * is a compile error here instead of a silently dropped notification.
 */
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneState } from '@/domain/zones/zoneState';

/** The slice of `DlnaInputService` this tap needs. */
export interface DlnaZoneStateReflector {
  reflectZoneState: (state: ZoneState) => void;
}

export function withDlnaReflection(
  inner: NotifierPort,
  /**
   * Resolved per call, not held: the renderer service is constructed after the
   * notifier that this decorates, because it needs the config port that the
   * notifier's own runtime ports hand out.
   */
  reflector: () => DlnaZoneStateReflector | null,
): NotifierPort {
  return {
    notifyZoneStateChanged: (state) => {
      inner.notifyZoneStateChanged(state);
      try {
        reflector()?.reflectZoneState(state);
      } catch {
        // A renderer that fails to notify its subscribers must not take the zone's
        // own state delivery down with it — same containment as the API tap.
      }
    },
    notifyQueueUpdated: (zoneId, queueSize) => inner.notifyQueueUpdated(zoneId, queueSize),
    notifyRoomFavoritesChanged: (zoneId, count) => inner.notifyRoomFavoritesChanged(zoneId, count),
    notifyRecentlyPlayedChanged: (zoneId, timestamp) =>
      inner.notifyRecentlyPlayedChanged(zoneId, timestamp),
    notifyRescan: (status, folders, files) => inner.notifyRescan(status, folders, files),
    notifyReloadMusicApp: (action, provider, userId) =>
      inner.notifyReloadMusicApp(action, provider, userId),
    notifyAudioSyncEvent: (payload) => inner.notifyAudioSyncEvent(payload),
    notifyPlaybackFailed: (zoneId, failure) => inner.notifyPlaybackFailed?.(zoneId, failure),
  };
}
