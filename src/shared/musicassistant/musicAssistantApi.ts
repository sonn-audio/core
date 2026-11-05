import { createLogger } from '@/shared/logging/logger';
import { MusicAssistantClient } from '@/shared/musicassistant/musicAssistantClient';

type Track = Record<string, any>;
type Album = Record<string, any>;
type Artist = Record<string, any>;
type Playlist = Record<string, any>;
type Radio = Record<string, any>;

interface LibraryResult {
  items: any[];
  total: number;
}

export class MusicAssistantApi {
  private static readonly instances = new Map<string, { api: MusicAssistantApi; ref: number }>();

  private readonly log = createLogger('Content', 'MusicAssistantApi');
  private readonly client: MusicAssistantClient;
  private connected = false;
  private eventCallbacks: Array<{ filter: string; objectId: string; cb: (evt: Record<string, any>) => void }> = [];
  private eventUnsub?: () => void;

  private constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token?: string,
  ) {
    this.client = new MusicAssistantClient(host, port, token);
  }

  public static acquire(host: string, port: number, token?: string): MusicAssistantApi {
    const key = `${host}:${port}:${token ?? ''}`;
    const existing = this.instances.get(key);
    if (existing) {
      existing.ref += 1;
      return existing.api;
    }
    const api = new MusicAssistantApi(host, port, token);
    this.instances.set(key, { api, ref: 1 });
    return api;
  }

  public release(): void {
    const key = `${this.host}:${this.port}:${this.token ?? ''}`;
    const entry = MusicAssistantApi.instances.get(key);
    if (!entry) return;
    entry.ref -= 1;
    if (entry.ref <= 0) {
      this.client.cleanup();
      this.eventCallbacks = [];
      this.eventUnsub?.();
      this.eventUnsub = undefined;
      MusicAssistantApi.instances.delete(key);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  public async connect(): Promise<void> {
    await this.ensureConnected();
  }

  private ensureEventSubscription(): void {
    if (this.eventUnsub) return;
    this.eventUnsub = this.client.onEvent((evt) => this.dispatchEvent(evt));
  }

  private dispatchEvent(evt: Record<string, any>): void {
    if (!evt) return;
    const eventName = String(evt.event ?? '').toUpperCase();
    const objectId = String(evt.object_id ?? '').toLowerCase();

    for (const entry of this.eventCallbacks) {
      const matchEvent = entry.filter === 'ALL' || entry.filter === eventName;
      const matchObject = entry.objectId === '*' || entry.objectId === objectId;
      if (!matchEvent || !matchObject) continue;
      try {
        entry.cb(evt);
      } catch (err) {
        this.log.warn('music assistant event handler failed', {
          event: eventName,
          objectId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  public subscribe(
    eventFilter: string,
    callback: (evt: Record<string, any>) => void,
    objectId = '*',
  ): () => void {
    this.ensureEventSubscription();
    const entry = { filter: eventFilter.toUpperCase(), objectId: objectId.toLowerCase(), cb: callback };
    this.eventCallbacks.push(entry);
    return () => {
      const idx = this.eventCallbacks.indexOf(entry);
      if (idx >= 0) this.eventCallbacks.splice(idx, 1);
      if (this.eventCallbacks.length === 0 && this.eventUnsub) {
        this.eventUnsub();
        this.eventUnsub = undefined;
      }
    };
  }

  private async safeRpc<T = any>(endpoint: string, params?: Record<string, unknown>, fallback?: T): Promise<T> {
    try {
      await this.ensureConnected();
      const result = await this.client.rpc(endpoint, params);
      return result as T;
    } catch (err) {
      this.log.warn('music assistant rpc failed', {
        endpoint,
        message: err instanceof Error ? err.message : String(err),
      });
      return fallback as T;
    }
  }

  public async search(query: string, limit = 10): Promise<{ tracks?: Track[]; albums?: Album[]; artists?: Artist[]; playlists?: Playlist[] }> {
    return this.safeRpc('music/search', { search_query: query, limit }, {});
  }

  public async searchRadios(query: string, limit = 10): Promise<Radio[]> {
    const res = await this.safeRpc<any>('music/search', { search_query: query, media_types: ['radio'], limit }, []);
    if (Array.isArray(res?.radio)) return res.radio;
    if (Array.isArray(res)) return res;
    return [];
  }

  public async getLibraryPlaylists(limit = 50, offset = 0): Promise<LibraryResult> {
    const items = await this.safeRpc<any[]>('music/playlists/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/playlists/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getLibraryAlbums(limit = 50, offset = 0): Promise<LibraryResult> {
    const items = await this.safeRpc<any[]>('music/albums/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/albums/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getLibraryArtists(limit = 50, offset = 0): Promise<LibraryResult> {
    const items = await this.safeRpc<any[]>('music/artists/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/artists/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getLibraryRadios(limit = 200, offset = 0): Promise<LibraryResult> {
    const items = await this.safeRpc<any[]>('music/radios/library_items', { limit, offset }, []);
    const total = await this.safeRpc<number | null>('music/radios/count', undefined, null);
    return { items, total: typeof total === 'number' ? total : items.length };
  }

  public async getRecommendations(): Promise<any[]> {
    const res = await this.safeRpc<any[]>('music/recommendations', undefined, []);
    return Array.isArray(res) ? res : [];
  }

  public async getPlaylist(itemId: string, provider = 'library'): Promise<any | null> {
    return this.safeRpc('music/playlists/get_playlist', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getPlaylistTracks(itemId: string, provider = 'library'): Promise<any[]> {
    const raw = await this.safeRpc<any[]>('music/playlists/playlist_tracks', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
      in_library_only: false,
    }, []);
    return Array.isArray(raw) ? raw : [];
  }

  public async getAlbum(itemId: string, provider = 'library'): Promise<any | null> {
    return this.safeRpc('music/albums/get_album', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getAlbumTracks(itemId: string, provider = 'library', offset = 0, limit = 50): Promise<any[]> {
    return this.safeRpc('music/albums/album_tracks', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
      offset,
      limit,
      in_library_only: false,
    }, []);
  }

  public async getArtist(itemId: string, provider = 'library'): Promise<any | null> {
    return this.safeRpc('music/artists/get_artist', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getArtistTracks(itemId: string, provider = 'library', offset = 0, limit = 50): Promise<any[]> {
    return this.safeRpc('music/artists/artist_tracks', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
      offset,
      limit,
      in_library_only: false,
    }, []);
  }

  public async getTrack(itemId: string, provider = 'library'): Promise<any | null> {
    return this.safeRpc('music/tracks/get_track', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getRadio(itemId: string, provider = 'library'): Promise<any | null> {
    return this.safeRpc('music/radios/get_radio', {
      item_id: itemId,
      provider_instance_id_or_domain: provider,
    }, null);
  }

  public async getAllPlayers(): Promise<any[]> {
    return this.safeRpc('players/all', undefined, []);
  }

  public async registerBuiltinPlayer(playerId: string, name: string): Promise<boolean> {
    const result = await this.safeRpc<boolean>(
      'builtin_player/register',
      {
        player_id: playerId,
        player_name: name,
        name,
      },
      false,
    );
    return Boolean(result);
  }

  public async updateBuiltinPlayerState(
    playerId: string,
    state: { powered?: boolean; playing?: boolean; paused?: boolean; position?: number; volume?: number; muted?: boolean },
  ): Promise<void> {
    if (!playerId) return;
    const payload: Record<string, unknown> = { player_id: playerId };
    if (typeof state.powered === 'boolean') payload.powered = state.powered;
    if (typeof state.playing === 'boolean') payload.playing = state.playing;
    if (typeof state.paused === 'boolean') payload.paused = state.paused;
    if (typeof state.position === 'number') payload.position = state.position;
    if (typeof state.volume === 'number') payload.volume = state.volume;
    if (typeof state.muted === 'boolean') payload.muted = state.muted;
    await this.safeRpc('builtin_player/update_state', payload);
  }

  public async playMedia(
    queueId: string,
    media: string | string[] | Record<string, unknown> | Record<string, unknown>[],
    options?: { option?: string; radio_mode?: boolean; start_item?: string; shuffle?: boolean },
  ): Promise<boolean> {
    if (!queueId || !media) return false;
    const mediaList = (Array.isArray(media) ? media : [media]).filter(Boolean);
    if (!mediaList.length) return false;
    const payload: Record<string, unknown> = {
      queue_id: queueId,
      media: mediaList, // web UI always sends an array
      option: options?.option || 'replace',
    };
    if (options?.radio_mode != null) payload.radio_mode = options.radio_mode;
    if (options?.start_item) payload.start_item = options.start_item;
    try {
      await this.ensureConnected();
      await this.client.rpc('player_queues/play_media', payload);
    } catch (err) {
      this.log.warn('music assistant rpc failed', {
        endpoint: 'player_queues/play_media',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (typeof options?.shuffle === 'boolean') {
      await this.safeRpc('player_queues/shuffle', {
        queue_id: queueId,
        shuffle_enabled: options.shuffle,
      });
    }
    return true;
  }

  public async playQueueIndex(queueId: string, index: number | string): Promise<boolean> {
    if (!queueId || index === undefined || index === null) return false;
    const payload: Record<string, unknown> = { queue_id: queueId, index };
    try {
      await this.ensureConnected();
      await this.client.rpc('player_queues/play_index', payload);
      return true;
    } catch (err) {
      this.log.warn('music assistant rpc failed', {
        endpoint: 'player_queues/play_index',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  public async getQueueItems(queueId: string, offset = 0, limit = 200): Promise<any[]> {
    if (!queueId) return [];
    const payload: Record<string, unknown> = { queue_id: queueId, offset, limit };
    const result = await this.safeRpc<any[]>('player_queues/items', payload, []);
    return Array.isArray(result) ? result : [];
  }

  public async clearQueue(queueId: string): Promise<boolean> {
    if (!queueId) return false;
    const payload: Record<string, unknown> = { queue_id: queueId };
    const result = await this.safeRpc<any>('player_queues/clear', payload, false);
    return Boolean(result);
  }

  /**
   * Play `url` on a player as an announcement: Music Assistant lowers or pauses what the player
   * is on, plays the clip at `volumeLevel`, waits for it to be heard out and then puts the
   * player back where it was — queue, track position and volume included.
   *
   * MA answers only once all of that is over, so the promise can take as long as the clip
   * itself. It rejects when MA refuses the request (unknown player, unreachable URL, an MA
   * without the command), which callers use to fall back to something else.
   */
  public async playAnnouncement(playerId: string, url: string, volumeLevel?: number): Promise<void> {
    if (!playerId || !url) {
      throw new Error('announcement needs a player and a url');
    }
    const payload: Record<string, unknown> = {
      player_id: playerId,
      url,
      // A doorbell must not be preceded by MA's own chime.
      pre_announce: false,
    };
    if (typeof volumeLevel === 'number' && Number.isFinite(volumeLevel)) {
      payload.volume_level = Math.max(0, Math.min(100, Math.round(volumeLevel)));
    }
    await this.ensureConnected();
    await this.client.rpc('players/cmd/play_announcement', payload);
  }

  public async playerCommand(
    playerId: string,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!playerId || !command) return false;
    const payload: Record<string, unknown> = { player_id: playerId, ...(args ?? {}) };
    const result = await this.safeRpc(`players/cmd/${command}`, payload, null);
    return result !== null;
  }
}
