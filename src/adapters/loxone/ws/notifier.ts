import { createLogger } from '@/shared/logging/logger';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import type { ZoneState } from '@/domain/zones/zoneState';
import {
  toLoxoneZoneState,
  type LoxoneZoneState,
} from '@/adapters/loxone/ws/zoneStateProjection';
import type { AudioSyncGroupPayload } from '@/application/groups/types/AudioSyncGroupPayload';
import type { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import type { GroupTrackerPort } from '@/ports/GroupTrackerPort';

type ZoneStateLookup = (zoneId: number) => ZoneState | undefined;
type OutputProtocolLookup = (zoneId: number) => string | null;

export class LoxoneWsNotifier {
  private readonly log = createLogger('LoxoneHttp', 'Notifier');
  private zoneStateLookup: ZoneStateLookup | null = null;
  private outputProtocolLookup: OutputProtocolLookup | null = null;
  private mixedGroupLookup: (() => boolean) | null = null;
  private audiopathToLoxone: ((audiopath: string) => string) | null = null;

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly groupTracker: GroupTrackerPort,
  ) {}

  /**
   * Provides the notifier with read access to current zone states so that
   * `audio_event` payloads can be enriched with sync-group context
   * (`syncedzones`, `mastervolume`) the v17 client expects.
   */
  public setZoneStateLookup(lookup: ZoneStateLookup | null): void {
    this.zoneStateLookup = lookup;
  }

  /** Read access to each zone's output protocol, surfaced in audio_event as a
   *  grouping hint for our own player (the native client ignores the field). */
  public setOutputProtocolLookup(lookup: OutputProtocolLookup | null): void {
    this.outputProtocolLookup = lookup;
  }

  /** Whether this server allows mixed-protocol grouping — surfaced so the player
   *  can relax its protocol-match grouping hint. */
  public setMixedGroupLookup(lookup: (() => boolean) | null): void {
    this.mixedGroupLookup = lookup;
  }

  /**
   * Translates the core's service-native `state.audiopath` back to the Loxone
   * disguise (`spotify@bridge-...`) the native client expects in `audio_event`.
   * When unset, the audiopath is emitted verbatim (unchanged behaviour).
   */
  public setAudiopathToLoxone(translate: ((audiopath: string) => string) | null): void {
    this.audiopathToLoxone = translate;
  }

  /**
   * Builds the Loxone-shaped payload for a zone. All the shaping lives in
   * `toLoxoneZoneState`; this only gathers the context that shaping needs, which
   * is the part that depends on the notifier's runtime lookups.
   *
   * Public because the connect snapshot has to send the same shape: a client that
   * saw a different payload on connect than on the next change would render a
   * zone twice, differently.
   */
  public projectForLoxone(state: ZoneState): LoxoneZoneState {
    const group = this.groupTracker.getGroupByZone(state.id);
    const isLeader = group?.leader === state.id;
    return toLoxoneZoneState(state, {
      group: group ? { leader: group.leader, members: group.members } : null,
      leaderVolume:
        !group || isLeader
          ? state.volume
          : (this.zoneStateLookup?.(group.leader)?.volume ?? state.volume),
      outputProtocol: this.outputProtocolLookup?.(state.id) ?? state.outputProtocol,
      mixedGroupEnabled: this.mixedGroupLookup?.() ?? state.mixedGroupEnabled,
      // No-op when the translator is unset or the path isn't a bridged
      // service-native id.
      audiopathToLoxone: (audiopath) => this.audiopathToLoxone?.(audiopath) ?? audiopath,
    });
  }

  private emit(payload: unknown, event: string, context?: Record<string, unknown>): void {
    try {
      this.registry.broadcastMessage(JSON.stringify(payload));
      this.log.spam(`${event} broadcast`, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn(`${event} broadcast failed`, { ...context, message });
    }
  }

  /**
   * Pushes the current zone state to all Loxone clients.
   */
  public notifyZoneStateChanged(state: ZoneState): void {
    // The full state is broadcast frequently (often once per second for progress updates).
    // Logging the entire payload makes spam logging unusable, so keep this as a summary.
    this.log.spam('audio_event payload', {
      zoneId: state.id,
      zoneName: state.name,
      mode: state.mode,
      time: state.time,
      duration: state.duration,
      title: state.title,
      artist: state.artist,
      sourceName: state.sourceName,
    });
    this.emit({ audio_event: [this.projectForLoxone(state)] }, 'audio_event', {
      zoneId: state.id,
    });
  }

  /**
   * Signals that a zone queue changed.
   */
  public notifyQueueUpdated(zoneId: number, queueSize: number): void {
    this.emit(
      {
        audio_queue_event: [
          {
            playerid: Number(zoneId),
            queuesize: Number(queueSize),
            restrictions: 1,
          },
        ],
      },
      'audio_queue_event',
      { zoneId, queueSize },
    );
  }

  /**
   * Signals that the favorites collection of a zone changed.
   */
  public notifyRoomFavoritesChanged(zoneId: number, count: number): void {
    this.emit(
      {
        roomfavchanged_event: [
          {
            playerid: Number(zoneId),
            count: Number(count),
          },
        ],
      },
      'roomfavchanged_event',
      { zoneId, count },
    );
  }

  /**
   * Signals that the "recently played" history changed.
   */
  public notifyRecentlyPlayedChanged(zoneId: number, timestamp: number): void {
    this.emit(
      {
        recentlyplayedchanged_event: [
          {
            playerid: Number(zoneId),
            ts: Number(timestamp),
          },
        ],
      },
      'recentlyplayedchanged_event',
      { zoneId, timestamp },
    );
  }

  /**
   * Signals that the line-in inputs list changed.
   */
  public notifyLineInChanged(): void {
    this.emit({ lineinchanged_event: [] }, 'lineinchanged_event');
  }

  /**
   * Signals that the streaming-services configuration changed.
   * Client refetches services when `action === 'serviceschanged'`.
   */
  public notifyServiceChanged(action: string = 'serviceschanged'): void {
    this.emit({ service_changed_event: [{ action }] }, 'service_changed_event', { action });
  }

  /**
   * Signals an upcoming process restart (server stays reachable).
   * v17 client distinguishes this from a hard reboot.
   */
  public notifyRestart(): void {
    this.emit({ restart_event: [] }, 'restart_event');
  }

  /**
   * Signals an upcoming hard reboot (sockets will drop).
   * Client transitions to the `rebooting` health state.
   */
  public notifyReboot(): void {
    this.emit({ reboot_event: [] }, 'reboot_event');
  }

  /**
   * Signals that USB / external storage state changed.
   */
  public notifyUsbChanged(): void {
    this.emit({ usbchanged_event: [] }, 'usbchanged_event');
  }

  /**
   * Signals that local playlists were created, edited, or removed. The optional
   * `command` field at the top level matches the reference music-server payload
   * shape and lets the client correlate the broadcast with the original request.
   */
  public notifyPlaylistChanged(
    detail?: {
      action: string;
      playlistid: number | string;
      audiopath?: string;
      cmd?: string;
      user?: string;
      name?: string;
    },
    command?: string,
  ): void {
    const payload = detail ? [detail] : [];
    const message: Record<string, unknown> = { playlistchanged_event: payload };
    if (command) {
      message.command = command;
    }
    this.emit(message, 'playlistchanged_event');
  }

  /**
   * Signals that custom URL inputs were added, renamed, or removed.
   */
  public notifyCustomUrlChanged(): void {
    this.emit({ customurl_changed_event: [] }, 'customurl_changed_event');
  }

  /**
   * Emits a Loxone-compatible `rescan_event` for local library progress.
   */
  public notifyRescan(status: 0 | 1 | 2, folders?: number, files?: number): void {
    const event: Record<string, number> = { status };
    if (typeof folders === 'number') {
      event.folders = folders;
    }
    if (typeof files === 'number') {
      event.files = files;
    }
    this.emit({ rescan_event: [event] }, 'rescan_event', { status, folders, files });
  }

  /**
   * Broadcasts the full storage inventory to every connected client.
   */
  public notifyStorageListUpdated(storages: StorageConfig[]): void {
    this.emit({ storage: storages }, 'storage_list', { storages: storages.length });
  }

  /**
   * Notifies clients that a storage entry was created.
   */
  public notifyStorageAdded(storage: StorageConfig): void {
    this.emit({ storage_added: [storage] }, 'storage_added', { id: storage.id });
  }

  /**
   * Notifies clients that a storage entry was removed.
   */
  public notifyStorageRemoved(id: string): void {
    this.emit({ storage_removed: [{ id }] }, 'storage_removed', { id });
  }

  /**
   * Notify Loxone music apps to reload service/account state.
   */
  public notifyReloadMusicApp(action: 'useradd' | 'userdel', provider: string, userId: string): void {
    this.emit(
      {
        reloadmusicapp_event: [
          {
            action,
            cause: provider,
            reload: 1,
            user: userId,
          },
        ],
      },
      'reloadmusicapp_event',
      { action, provider, userId },
    );
  }

  public notifyGlobalSearchResult(result: Record<string, any>, providerId: string, unique: string): void {
    // TuneIn special-case payload
    if (providerId.toLowerCase() === 'tunein' && result.station) {
      const payload = {
        globalsearch_result: {
          station: {
            caption: 'Zender',
            items: result.station,
            link: `audio/cfg/search/radio/nouser/station/arr/0/${result.station.length}`,
            totalitems: result.station.length,
          },
          custom: {
            caption: 'Eigen radiostations',
            items: result.custom ?? [],
            link: 'audio/cfg/search/radio/nouser/custom/arr/0/0',
            totalitems: result.custom?.length ?? 0,
          },
        },
        type: providerId,
        unique,
      };
      this.emit(payload, 'globalsearch_result', { providerId, unique });
      return;
    }

    const userId = result.user ?? 'nouser';
    const query = result.query ?? '';
    const totals = (result as { _totals?: Record<string, number> })?._totals;

    // Local library: client expects categories directly in globalsearch_result, no error/result wrapper.
    if (providerId.toLowerCase() === 'local' || providerId.toLowerCase() === 'library') {
      const localPayload = {
        globalsearch_result: {
          tracks: buildCategory('Titels', result.tracks, providerId, userId, 'track', query, totals),
          albums: buildCategory('Albums', result.albums, providerId, userId, 'album', query, totals),
          artists: buildCategory('Artiesten', result.artists, providerId, userId, 'artist', query, totals),
          playlists: buildCategory('Playlists', result.playlists, providerId, userId, 'playlist', query, totals),
          folders: buildCategory('Mappen', result.folders, providerId, userId, 'folder', query, totals),
        },
        type: providerId,
        unique,
      };
      this.emit(localPayload, 'globalsearch_result', { providerId, unique });
      return;
    }

    const payload = {
      globalsearch_result: {
        error: 0,
        result: {
          tracks: buildCategory('Titoli', result.tracks, providerId, userId, 'track', query, totals),
          albums: buildCategory('Albums', result.albums, providerId, userId, 'album', query, totals),
          artists: buildCategory('Artiesten', result.artists, providerId, userId, 'artist', query, totals),
          playlists: buildCategory(
            'Playlists',
            result.playlists,
            providerId,
            userId,
            'playlist',
            query,
            totals,
          ),
          shows: buildCategory('Podcasts', result.shows, providerId, userId, 'show', query, totals),
          episodes: buildCategory(
            'Volgen',
            result.episodes,
            providerId,
            userId,
            'episode',
            query,
            totals,
          ),
          topresults: buildTopResults(result),
          user: userId,
        },
      },
      type: providerId,
      unique,
    };

    this.emit(payload, 'globalsearch_result', { providerId, unique });
  }

  public notifyGlobalSearchError(providerId: string, unique: string): void {
    const payload = {
      globalsearch_result: {
        error: 1,
        type: providerId,
        unique,
      },
    };
    this.emit(payload, 'globalsearch_error', { providerId, unique });
  }

  public notifyAudioSyncEvent(payload: AudioSyncGroupPayload[]): void {
    this.registry.broadcastMessage(this.serializeAudioSyncEvent(payload));
  }

  /** The `audio_sync_event` frame, shared by the broadcast and the connect snapshot. */
  public serializeAudioSyncEvent(payload: AudioSyncGroupPayload[]): string {
    return JSON.stringify({ audio_sync_event: payload });
  }
}

function buildCategory(
  caption: string,
  items: any[] | undefined,
  providerId: string,
  userId: string,
  type: string,
  query: string,
  totals?: Record<string, number>,
) {
  const list = Array.isArray(items) ? items : [];
  const totalsKey = `${type}s`;
  return {
    caption,
    count: list.length,
    items: list,
    link: `audio/cfg/search/${providerId}/${userId}/${type}/${encodeURIComponent(query)}/0/50`,
    totalitems: totals?.[totalsKey] ?? list.length,
  };
}

function buildTopResults(result: Record<string, any>) {
  const top = {
    caption: 'Top resultaten',
    count: 0,
    tracks: result.tracks?.slice(0, 1) ?? [],
    albums: result.albums?.slice(0, 1) ?? [],
    artists: result.artists?.slice(0, 1) ?? [],
    playlists: result.playlists?.slice(0, 1) ?? [],
  };

  top.count =
    top.tracks.length + top.albums.length + top.artists.length + top.playlists.length;

  return top;
}
