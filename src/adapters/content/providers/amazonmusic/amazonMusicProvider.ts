import type { AmazonMusicCredentials } from '@/domain/config/types';
import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import type { ContentProvider, ProviderSearchCategories, ProviderSearchResult } from '@/adapters/content/ContentProvider';
import { AmazonMusicClient } from './amazonMusicClient';
import { AmazonMusicMapper, coverOf, isCatalogPlaylistId } from './amazonMusicParsers';

const enum FileType {
  Folder = 1,
}

/** How long a fetched album or playlist is kept, so paging through it costs one request. */
const CONTAINER_TTL_MS = 60_000;
const LIBRARY_PAGE_SIZE = 100;

type Container = { name: string; cover?: string; artist?: string; items: ContentFolderItem[] };

interface AmazonMusicProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  credentials?: AmazonMusicCredentials;
}

const SEARCH_TYPES: Record<string, { type: string; key: string }> = {
  track: { type: 'catalog_track', key: 'tracks' },
  album: { type: 'catalog_album', key: 'albums' },
  artist: { type: 'catalog_artist', key: 'artists' },
  playlist: { type: 'catalog_playlist', key: 'playlists' },
};

/**
 * Amazon Music, browsed and searched as its Android app does it.
 *
 * The root offers the account's own and followed playlists — the parts of an Amazon library its
 * API lists — and everything else is reached through search: albums, artists, catalogue
 * playlists. Every request is signed with the device registration made at sign-in; without one
 * the provider answers empty rather than failing, so a half-configured account just looks empty.
 */
export class AmazonMusicProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly log = createLogger('Content', 'AmazonMusic');
  private readonly label: string;
  private readonly client: AmazonMusicClient | null;
  private readonly map: AmazonMusicMapper;
  private readonly containers = new Map<string, { at: number; value: Promise<Container | null> }>();

  constructor(options: AmazonMusicProviderOptions) {
    this.providerId = options.providerId;
    this.label = options.label || 'Amazon Music';
    this.map = new AmazonMusicMapper(options.serviceNativePrefix ?? options.providerId);
    let client: AmazonMusicClient | null = null;
    if (options.credentials?.adpToken && options.credentials.devicePrivateKey) {
      try {
        client = new AmazonMusicClient(options.credentials);
      } catch (err) {
        this.log.warn('amazon music credentials unusable', {
          providerId: this.providerId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.log.info('amazon music account not signed in', { providerId: this.providerId });
    }
    this.client = client;
  }

  public get accountId(): string {
    return 'amazonmusic';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return { id: this.providerId, label: this.displayLabel, provider: 'amazonmusic', fake: true };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Requests are signed per call with the device key; there is no bearer to hand out.
    return null;
  }

  public async getPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]> {
    const items = await this.libraryPlaylists('owned', offset, limit);
    return items.map((item) => ({
      id: item.id,
      name: item.name,
      // The library listing does not count tracks; a playlist's own page does.
      tracks: 0,
      audiopath: item.audiopath ?? item.id,
      coverurl: item.coverurl,
    }));
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const pageSize = limit || 50;
    const folder = this.parseFolderId(folderId);
    const page = (name: string, items: ContentFolderItem[], extra: Partial<ContentFolder> = {}): ContentFolder => ({
      id: folderId,
      name,
      service: 'amazonmusic',
      start: offset,
      totalitems: items.length,
      totalKnown: true,
      items: items.slice(offset, offset + pageSize),
      ...extra,
    });

    switch (folder.type) {
      case 'root':
        return page(this.displayLabel, [
          this.folderLink('playlists', 'My Playlists'),
          this.folderLink('followed-playlists', 'Followed Playlists'),
        ]);
      case 'owned':
      case 'followed': {
        // These page upstream, so the slice is already the page.
        const items = await this.libraryPlaylists(folder.type, offset, pageSize);
        return {
          id: folderId,
          name: folder.type === 'owned' ? 'My Playlists' : 'Followed Playlists',
          service: 'amazonmusic',
          start: offset,
          totalitems: offset + items.length + (items.length >= pageSize ? 1 : 0),
          totalKnown: false,
          items,
        };
      }
      case 'album':
      case 'playlist':
      case 'artist': {
        const container = await this.container(folder.type, folder.id);
        if (!container) return page(folder.type === 'album' ? 'Album' : folder.type === 'artist' ? 'Artist' : 'Playlist', []);
        return page(container.name, container.items, { coverurl: container.cover, artist: container.artist });
      }
      default:
        return page(this.displayLabel, []);
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const asin = this.idOf(trackId, 'track');
    if (!asin || !this.client) return null;
    try {
      const resp = await this.client.lookup([asin]);
      const track = resp.trackList?.[0];
      return track ? this.map.track(track) : null;
    } catch (err) {
      this.warn('track lookup failed', err, { asin });
      return null;
    }
  }

  public async search(query: string, limits: Record<string, number>, maxLimit: number): Promise<ProviderSearchResult> {
    const user = this.providerId.split('@')[1] || this.providerId;
    const result: ProviderSearchCategories = {};
    if (!this.client || !query.trim()) {
      return { result, providerId: this.providerId, user };
    }
    const requested = Object.keys(limits).filter((kind) => SEARCH_TYPES[kind]);
    const kinds = requested.length ? requested : Object.keys(SEARCH_TYPES);
    const values = Object.values(limits);
    const limit = Math.min(Math.max(...(values.length ? values : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT), maxLimit);
    try {
      const docs = await this.client.search(
        query,
        kinds.map((kind) => SEARCH_TYPES[kind]!.type),
        limit,
      );
      for (const kind of kinds) {
        const { type, key } = SEARCH_TYPES[kind]!;
        const mapOne =
          kind === 'track'
            ? (doc: any) => this.map.track(doc)
            : kind === 'album'
              ? (doc: any) => this.map.album(doc)
              : kind === 'artist'
                ? (doc: any) => this.map.artist(doc)
                : (doc: any) => this.map.playlist(doc);
        result[key] = (docs[type] ?? [])
          .map(mapOne)
          .filter((item): item is ContentFolderItem => item !== null)
          .slice(0, limits[kind] ?? limit);
      }
    } catch (err) {
      this.warn('search failed', err, { query });
    }
    // See AppleMusicProvider.search: the search `user` must equal the account
    // segment in the audiopaths so the native client can browse searched albums.
    return { result, providerId: this.providerId, user };
  }

  public dispose(): void {
    this.containers.clear();
  }

  /* ------------------------------------------------------------------------ */

  private folderLink(id: string, name: string): ContentFolderItem {
    return { id, name, type: FileType.Folder, items: 0 };
  }

  private warn(message: string, err: unknown, context: Record<string, unknown> = {}): void {
    this.log.warn(`amazon music ${message}`, {
      ...context,
      providerId: this.providerId,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  /** The id after `<kind>:`, wherever the prefix in front of it came from. */
  private idOf(value: string, kind: string): string {
    const match = new RegExp(`(?:^|:)${kind}:(.+)$`, 'i').exec((value || '').trim());
    return (match?.[1] ?? value ?? '').trim();
  }

  private parseFolderId(
    folderId: string,
  ):
    | { type: 'root' | 'owned' | 'followed' | 'unknown' }
    | { type: 'album' | 'artist' | 'playlist'; id: string } {
    const raw = (folderId || 'root').trim();
    const tail = raw.split(':').pop()?.toLowerCase() ?? '';
    if (!raw || raw === 'root' || raw === 'start') return { type: 'root' };
    if (tail === 'playlists' && !/:playlist:/i.test(raw)) return { type: 'owned' };
    if (tail === 'followed-playlists') return { type: 'followed' };
    for (const kind of ['album', 'artist', 'playlist'] as const) {
      const match = new RegExp(`(?:^|:)${kind}:(.+)$`, 'i').exec(raw);
      if (match?.[1]) return { type: kind, id: match[1] };
    }
    return { type: 'unknown' };
  }

  private async libraryPlaylists(which: 'owned' | 'followed', offset: number, limit: number): Promise<ContentFolderItem[]> {
    if (!this.client) return [];
    try {
      const raw =
        which === 'owned'
          ? await this.client.ownedPlaylists(offset, Math.min(limit, LIBRARY_PAGE_SIZE))
          : await this.client.followedPlaylists(offset, Math.min(limit, LIBRARY_PAGE_SIZE));
      return raw.map((entry) => this.map.playlist(entry)).filter((item): item is ContentFolderItem => item !== null);
    } catch (err) {
      this.warn(`${which} playlists failed`, err);
      return [];
    }
  }

  private container(kind: 'album' | 'artist' | 'playlist', id: string): Promise<Container | null> {
    const key = `${kind}:${id}`;
    const now = Date.now();
    for (const [cachedKey, entry] of this.containers) {
      if (now - entry.at > CONTAINER_TTL_MS) this.containers.delete(cachedKey);
    }
    const cached = this.containers.get(key);
    if (cached) return cached.value;
    const value = this.fetchContainer(kind, id).catch((err) => {
      this.warn(`${kind} fetch failed`, err, { id });
      this.containers.delete(key);
      return null;
    });
    this.containers.set(key, { at: now, value });
    return value;
  }

  private async fetchContainer(kind: 'album' | 'artist' | 'playlist', id: string): Promise<Container | null> {
    if (!this.client) return null;
    if (kind === 'album') {
      const album = (await this.client.lookup([id])).albumList?.[0];
      if (!album) return null;
      const cover = coverOf(album);
      const name = String(album.title ?? 'Album');
      return {
        name,
        cover,
        artist: album.artist?.name ?? album.primaryArtistName,
        items: this.tracks(album.tracks, { album: name, cover }),
      };
    }
    if (kind === 'artist') {
      const albums = await this.client.artistAlbums(id, 100);
      const items = albums.map((album) => this.map.album(album)).filter((item): item is ContentFolderItem => item !== null);
      const name = albums[0]?.artist?.name ?? albums[0]?.primaryArtistName ?? 'Artist';
      return { name, items };
    }
    // Playlist: a catalogue ASIN expands through a lookup (or the playlist service when the lookup
    // comes back without tracks); a user playlist is a UUID only the playlist service knows.
    let playlist: any = null;
    if (isCatalogPlaylistId(id)) {
      playlist = (await this.client.lookup([id])).playlistList?.[0] ?? null;
      if (!Array.isArray(playlist?.tracks) || playlist.tracks.length === 0) {
        playlist = (await this.client.catalogPlaylist(id)) ?? playlist;
      }
    } else {
      playlist = (await this.client.playlistsById([id]))[0] ?? null;
    }
    if (!playlist) return null;
    const meta = playlist.metadata && typeof playlist.metadata === 'object' ? playlist.metadata : playlist;
    return {
      name: String(meta.title ?? playlist.title ?? 'Playlist'),
      cover: coverOf(meta) ?? coverOf(playlist),
      items: this.tracks(playlist.tracks),
    };
  }

  private tracks(raw: unknown, context: { album?: string; cover?: string } = {}): ContentFolderItem[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((track) => this.map.track(track, context)).filter((item): item is ContentFolderItem => item !== null);
  }
}
