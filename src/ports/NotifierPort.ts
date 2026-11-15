import type { AudioSyncGroupPayload } from '@/ports/types/groups';
import type { ZoneState } from '@/domain/zones/zoneState';

export interface NotifierPort {
  notifyZoneStateChanged: (state: ZoneState) => void;
  notifyQueueUpdated: (zoneId: number, queueSize: number) => void;
  notifyRoomFavoritesChanged: (zoneId: number, count: number) => void;
  notifyRecentlyPlayedChanged: (zoneId: number, timestamp: number) => void;
  notifyRescan: (status: 0 | 1 | 2, folders?: number, files?: number) => void;
  notifyReloadMusicApp: (action: 'useradd' | 'userdel', provider: string, userId: string) => void;
  notifyAudioSyncEvent: (payload: AudioSyncGroupPayload[]) => void;
  /**
   * A zone was asked to play and nothing in its queue would start.
   *
   * Optional, unlike the rest: the others keep a client's picture of the server in step, and
   * a notifier that drops one leaves that picture wrong. This one is a message for whoever is
   * listening, and a notifier with no way to say it to anyone simply does not.
   */
  notifyPlaybackFailed?: (zoneId: number, failure: PlaybackFailure) => void;
}

export type PlaybackFailure = {
  zoneName: string;
  /** What the zone was trying to play, when it has a title. */
  title?: string;
  audiopath: string;
  /**
   * What the service said, in its own words, when it said anything: "tidal stream is DRM
   * protected", "deezer stream url unavailable". Free text from the provider that failed.
   */
  reason?: string;
  /**
   * Set when the service turned the account away rather than the track: its sign-in has
   * expired (`auth`) or it does not allow the request (`denied`). The listener's remedy is
   * then the account, not another track.
   */
  refusal?: 'auth' | 'denied';
};
