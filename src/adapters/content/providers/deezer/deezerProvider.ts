import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import type { ContentProvider, ProviderSearchCategories, ProviderSearchResult } from '@/adapters/content/ContentProvider';
import { RateLimiter } from '@/adapters/content/utils/rateLimit';

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

const DEEZER_API_BASE = 'https://api.deezer.com';

interface DeezerProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  arl?: string;
}

/**
 * Lightweight Deezer catalog provider that mirrors the Apple Music facade shape.
 * Uses the public Deezer API for metadata (no playback).
 */
/** Deezer allows 50 requests per 5 seconds; a second is enough for the window to move on. */
const DEEZER_QUOTA_PAUSE_MS = 1000;
const DEEZER_QUOTA_ATTEMPTS = 3;

/** `{"error":{"type":"Exception","message":"Quota limit exceeded","code":4}}`, served as a 200. */
function isDeezerQuotaError(body: unknown): boolean {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error === 'object' && error !== null && Number(error.code) === 4;
}

export class DeezerProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly audiopathPrefix: string;
  private readonly log = createLogger('Content', 'Deezer');
  private readonly label: string;
  private readonly arl?: string;
  private readonly requestTimeoutMs = 10_000;
  /** The public API counts per address, so one limiter serves every request this provider makes. */
  private readonly rateLimiter = new RateLimiter();

  constructor(options: DeezerProviderOptions) {
    this.providerId = options.providerId;
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.label = options.label || 'Deezer';
    this.arl = options.arl;
  }

  public get accountId(): string {
    return 'deezer';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'deezer',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Deezer API is public for catalog; ARL is only needed for user-specific requests.
    return this.arl ?? null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Deezer catalog playlists are not enumerated here; search returns playlists.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'chartsTracks': {
        const result = await this.fetchChartTracks(limit || 50, offset);
        return {
          id: folderId,
          name: 'Top Tracks',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'chartsAlbums': {
        const result = await this.fetchChartAlbums(limit || 50, offset);
        return {
          id: folderId,
          name: 'Top Albums',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'chartsArtists': {
        const result = await this.fetchChartArtists(limit || 50, offset);
        return {
          id: folderId,
          name: 'Top Artists',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'chartsPlaylists': {
        const result = await this.fetchChartPlaylists(limit || 50, offset);
        return {
          id: folderId,
          name: 'Top Playlists',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'albumItem': {
        const result = await this.fetchAlbumTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Album',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'artistItem': {
        const result = await this.fetchArtistAlbums(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Artist',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'playlistItem': {
        const result = await this.fetchPlaylistTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlist',
          service: 'deezer',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'deezer',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const normalized = this.normalizeItemId(trackId, 'track');
    if (!normalized.id) return null;
    const track = await this.fetchJson<any>(`${DEEZER_API_BASE}/track/${encodeURIComponent(normalized.id)}`);
    if (!track) return null;
    return this.mapTrack(track);
  }

  public async search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<ProviderSearchResult> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const result: ProviderSearchCategories = {};

    const requestedTypes = Object.keys(limits);
    const activeTypes =
      requestedTypes.length > 0 ? new Set(requestedTypes) : new Set(['track', 'album', 'artist', 'playlist']);

    // Parallelize calls per type; global search often asks for multiple categories at once.
    const tasks: Array<Promise<void>> = [];
    if (activeTypes.has('track')) {
      tasks.push(
        this.fetchSearchResults('track', query, limits.track ?? limit)
          .then((tracks) => {
            result.tracks = tracks.map((track) => this.mapTrack(track));
          })
          .catch(() => {
            result.tracks = [];
          }),
      );
    }
    if (activeTypes.has('album')) {
      tasks.push(
        this.fetchSearchResults('album', query, limits.album ?? limit)
          .then((albums) => {
            result.albums = albums.map((album) => this.mapAlbum(album));
          })
          .catch(() => {
            result.albums = [];
          }),
      );
    }
    if (activeTypes.has('artist')) {
      tasks.push(
        this.fetchSearchResults('artist', query, limits.artist ?? limit)
          .then((artists) => {
            result.artists = artists.map((artist) => this.mapArtist(artist));
          })
          .catch(() => {
            result.artists = [];
          }),
      );
    }
    if (activeTypes.has('playlist')) {
      tasks.push(
        this.fetchSearchResults('playlist', query, limits.playlist ?? limit)
          .then((playlists) => {
            result.playlists = playlists.map((playlist) => this.mapPlaylist(playlist));
          })
          .catch(() => {
            result.playlists = [];
          }),
      );
    }

    await Promise.all(tasks);

    // See AppleMusicProvider.search: the search `user` must equal the account
    // segment in the audiopaths so the native client can browse searched albums.
    return { result, providerId: this.providerId, user: this.providerId.split('@')[1] || this.providerId };
  }

  public dispose(): void {
    /* nothing to clean up */
  }

  /* ------------------------------------------------------------------------ */
  /* Mapping helpers                                                          */
  /* ------------------------------------------------------------------------ */

  private buildRootFolder(offset: number): ContentFolder {
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'deezer',
      start: offset,
      totalitems: 4,
      items: [
        this.folderLink('top-tracks', 'Top Tracks'),
        this.folderLink('top-albums', 'Top Albums'),
        this.folderLink('top-artists', 'Top Artists'),
        this.folderLink('top-playlists', 'Top Playlists'),
      ],
    };
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      items: 0,
    };
  }

  private makeUri(type: string, id: string): string {
    return `${this.audiopathPrefix}:${type}:${id}`;
  }

  private stripProviderPrefix(value: string): string {
    const raw = value || '';
    const lower = raw.toLowerCase();
    const providerLower = this.providerId.toLowerCase();
    const direct = `${providerLower}:`;
    if (lower.startsWith(direct)) {
      return raw.slice(direct.length);
    }
    const at = `@${providerLower}:`;
    if (lower.startsWith(at)) {
      return raw.slice(at.length);
    }
    return raw;
  }

  private normalizeItemId(
    value: string,
    kind: 'track' | 'album' | 'artist' | 'playlist',
  ): { id: string } {
    const raw = this.stripProviderPrefix(value || '').trim();
    const match = raw.match(new RegExp(`(?:^|:)${kind}:(.+)$`, 'i'));
    const id = match ? (match[1] ?? raw) : raw;
    return { id };
  }

  private normalizeFolderId(
    folderId: string,
  ):
    | { type: 'root' }
    | { type: 'chartsTracks' }
    | { type: 'chartsAlbums' }
    | { type: 'chartsArtists' }
    | { type: 'chartsPlaylists' }
    | { type: 'albumItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'playlistItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start') {
      return { type: 'root' };
    }
    if (lower === 'top-tracks' || lower === 'tracks') {
      return { type: 'chartsTracks' };
    }
    if (lower === 'top-albums' || lower === 'albums') {
      return { type: 'chartsAlbums' };
    }
    if (lower === 'top-artists' || lower === 'artists') {
      return { type: 'chartsArtists' };
    }
    if (lower === 'top-playlists' || lower === 'playlists') {
      return { type: 'chartsPlaylists' };
    }

    const albumMatch = raw.match(/(?:^|:)album:(.+)$/i);
    if (albumMatch) {
      return { type: 'albumItem', id: albumMatch[1] ?? '' };
    }
    const artistMatch = raw.match(/(?:^|:)artist:(.+)$/i);
    if (artistMatch) {
      return { type: 'artistItem', id: artistMatch[1] ?? '' };
    }
    const playlistMatch = raw.match(/(?:^|:)playlist:(.+)$/i);
    if (playlistMatch) {
      return { type: 'playlistItem', id: playlistMatch[1] ?? '' };
    }
    return { type: 'unknown' };
  }

  private mapTrack(track: any): ContentFolderItem {
    const id = String(track?.id ?? '');
    const name = String(track?.title ?? 'Track');
    const artist = track?.artist?.name ?? '';
    const album = track?.album?.title ?? '';
    const cover = track?.album?.cover_xl ?? track?.album?.cover_medium ?? '';
    return {
      id: this.makeUri('track', id),
      audiopath: this.makeUri('track', id),
      name,
      title: name,
      artist,
      album,
      coverurl: cover,
      thumbnail: cover,
      kind: 'track',
      tag: 'track',
      duration: typeof track?.duration === 'number' ? track.duration : undefined,
      hasCover: !!cover,
      provider: 'deezer',
    };
  }

  private mapAlbum(album: any): ContentFolderItem {
    const id = String(album?.id ?? '');
    const name = String(album?.title ?? 'Album');
    const artist = album?.artist?.name ?? '';
    const cover = album?.cover_xl ?? album?.cover_medium ?? '';
    return {
      id: this.makeUri('album', id),
      audiopath: this.makeUri('album', id),
      name,
      title: name,
      artist,
      coverurl: cover,
      thumbnail: cover,
      kind: 'album',
      tag: 'album',
      provider: 'deezer',
    };
  }

  private mapArtist(artistObj: any): ContentFolderItem {
    const id = String(artistObj?.id ?? '');
    const name = String(artistObj?.name ?? 'Artist');
    const cover = artistObj?.picture_xl ?? artistObj?.picture_medium ?? '';
    return {
      id: this.makeUri('artist', id),
      audiopath: this.makeUri('artist', id),
      name,
      title: name,
      artist: name,
      coverurl: cover,
      thumbnail: cover,
      kind: 'artist',
      tag: 'artist',
      provider: 'deezer',
    };
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const id = String(playlist?.id ?? '');
    const name = String(playlist?.title ?? 'Playlist');
    const owner = playlist?.user?.name ?? '';
    const cover = playlist?.picture_xl ?? playlist?.picture_medium ?? '';
    return {
      id: this.makeUri('playlist', id),
      audiopath: this.makeUri('playlist', id),
      name,
      title: name,
      owner,
      owner_id: owner,
      coverurl: cover,
      thumbnail: cover,
      kind: 'playlist',
      tag: 'playlist',
      provider: 'deezer',
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Deezer API helpers                                                       */
  /* ------------------------------------------------------------------------ */

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      for (let attempt = 1; ; attempt += 1) {
        const res = await this.rateLimiter.fetch(() =>
          fetch(url, {
            headers: {
              Accept: 'application/json',
            },
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          }),
        );
        if (!res.ok) {
          return null;
        }
        const data = (await res.json()) as T;
        // Deezer reports its quota in the body of a 200. Taken for data it is an object with no
        // `data` in it, and the folder it was fetched for came out empty.
        if (!isDeezerQuotaError(data)) {
          return data;
        }
        this.rateLimiter.block(DEEZER_QUOTA_PAUSE_MS);
        if (attempt >= DEEZER_QUOTA_ATTEMPTS) {
          this.log.warn('deezer quota exceeded; giving up', { url, attempt });
          return null;
        }
        this.log.debug('deezer quota exceeded; waiting', { url, attempt });
      }
    } catch (err) {
      this.log.warn('deezer request failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchSearchResults(kind: 'track' | 'album' | 'artist' | 'playlist', query: string, limit: number): Promise<any[]> {
    const url = new URL(`${DEEZER_API_BASE}/search/${kind}`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    const data = await this.fetchJson<any>(url.toString());
    return Array.isArray(data?.data) ? data.data : [];
  }

  private async fetchChartTracks(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/chart/0/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((track: any) => this.mapTrack(track)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchChartAlbums(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/chart/0/albums`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((album: any) => this.mapAlbum(album)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchChartArtists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/chart/0/artists`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((artist: any) => this.mapArtist(artist)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchChartPlaylists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/chart/0/playlists`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((playlist: any) => this.mapPlaylist(playlist)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/album/${encodeURIComponent(albumId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((track: any) => this.mapTrack(track)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchArtistAlbums(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/artist/${encodeURIComponent(artistId)}/albums`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((album: any) => this.mapAlbum(album)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${DEEZER_API_BASE}/playlist/${encodeURIComponent(playlistId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('index', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((track: any) => this.mapTrack(track)),
      total: typeof data?.total === 'number' ? data.total : undefined,
    };
  }
}
