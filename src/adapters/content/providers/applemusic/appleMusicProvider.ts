import type { ContentFolder, ContentFolderItem, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import {
  FileType,
  decodeId,
  mapTrack,
  mapLibraryTrack,
  mapAlbum,
  mapLibraryAlbum,
  mapArtist,
  mapLibraryArtist,
  mapPlaylist,
  mapLibraryPlaylist,
  mapRecommendationItem,
  pickAlbumShelf,
} from './appleMusicParsers';
import { getShippedDeveloperToken, buildBaseHeaders, scrapeBearerToken, describeFetchError } from './appleMusicAuth';
import { collageKey, collageCachedUrl, ensureCollage } from '@/shared/playlistCollage';
import type { ArtworkOriginSettings } from '@/shared/artworkOrigin';
import type { ContentProvider, ProviderSearchCategories, ProviderSearchResult } from '@/adapters/content/ContentProvider';

const APPLE_MUSIC_API_BASE = 'https://amp-api.music.apple.com/v1';
const BEARER_TOKEN_TTL_MS = 30 * 60 * 1000;

/** The largest page Apple's API accepts. Beyond it the request is rejected, not truncated. */
const APPLE_MAX_PAGE = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function appleLocalizedText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['standard', 'default', 'en-US', 'en', 'nl-NL', 'nl']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return Object.values(record).find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)?.trim() ?? '';
}

interface AppleMusicProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  storefront?: string;
  developerToken?: string;
  userToken?: string;
  /** Host clients use to fetch locally-served mosaic covers (the /music route). */
  coverHost?: string;
  /** Scheme and port of those mosaic covers; defaults to the plain gateway. */
  coverOrigin?: ArtworkOriginSettings;
}

/**
 * Lightweight Apple Music provider that mirrors the Spotify facade shape.
 * Uses the iTunes/Apple Music APIs for metadata (no playback).
 */
export class AppleMusicProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly audiopathPrefix: string;
  private readonly log = createLogger('Content', 'AppleMusic');
  private readonly label: string;
  private storefront: string;
  private readonly developerToken?: string;
  private readonly userToken?: string;
  private readonly coverHost: string;
  private readonly coverOrigin: ArtworkOriginSettings;
  private bearerToken?: string;
  private bearerTokenFetchedAt = 0;
  private bearerTokenPromise: Promise<string | null> | null = null;
  private storefrontResolved = false;
  private storefrontPromise: Promise<string> | null = null;

  constructor(options: AppleMusicProviderOptions) {
    this.providerId = options.providerId;
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.label = options.label || 'Apple Music';
    this.storefront = (options.storefront || 'us').toLowerCase();
    this.developerToken = options.developerToken;
    this.userToken = options.userToken;
    this.coverHost = options.coverHost || '127.0.0.1';
    this.coverOrigin = options.coverOrigin ?? {};
  }

  public get accountId(): string {
    return 'applemusic';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'applemusic',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Apple Music uses developer/user tokens; no runtime fetch.
    return this.developerToken ?? null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Catalog playlists are not enumerated here; search returns playlists.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'albums': {
        const albumResult = await this.inPages((size, from) => this.fetchLibraryAlbums(size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Albums',
          service: 'applemusic',
          start: offset,
          totalitems: typeof albumResult.total === 'number' ? albumResult.total : albumResult.items.length,
          items: albumResult.items,
        };
      }
      case 'artists': {
        const artistResult = await this.inPages((size, from) => this.fetchLibraryArtists(size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Artists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof artistResult.total === 'number' ? artistResult.total : artistResult.items.length,
          items: artistResult.items,
        };
      }
      case 'playlists': {
        const playlistResult = await this.inPages((size, from) => this.fetchLibraryPlaylists(size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof playlistResult.total === 'number' ? playlistResult.total : playlistResult.items.length,
          items: playlistResult.items,
        };
      }
      case 'newReleases': {
        const newResult = await this.fetchNewReleases(limit || 50, offset);
        return {
          id: folderId,
          name: 'New Releases',
          service: 'applemusic',
          start: offset,
          totalitems: typeof newResult.total === 'number' ? newResult.total : newResult.items.length,
          items: newResult.items,
        };
      }
      case 'recommendationsPlaylists': {
        const recResult = await this.fetchRecommendations(limit || 50, offset, new Set(['playlists']));
        return {
          id: folderId,
          name: 'Recommended Playlists',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recResult.total === 'number' ? recResult.total : recResult.items.length,
          items: recResult.items,
        };
      }
      case 'recommendationsAlbums': {
        const recResult = await this.fetchRecommendations(limit || 50, offset, new Set(['albums']));
        return {
          id: folderId,
          name: 'Recommended Albums',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recResult.total === 'number' ? recResult.total : recResult.items.length,
          items: recResult.items,
        };
      }
      case 'songs': {
        const songsResult = await this.inPages((size, from) => this.fetchLibrarySongs(size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Songs',
          service: 'applemusic',
          start: offset,
          totalitems: typeof songsResult.total === 'number' ? songsResult.total : songsResult.items.length,
          items: songsResult.items,
        };
      }
      case 'recent': {
        const recentResult = await this.inPages((size, from) => this.fetchLibraryRecentAlbums(size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Recently Added',
          service: 'applemusic',
          start: offset,
          totalitems: typeof recentResult.total === 'number' ? recentResult.total : recentResult.items.length,
          items: recentResult.items,
        };
      }
      case 'albumItem': {
        const result = normalized.source === 'library'
          ? await this.inPages((size, from) => this.fetchLibraryAlbumTracks(normalized.id, size, from), limit || 50, offset)
          : await this.inPages((size, from) => this.fetchAlbumTracks(normalized.id, size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Album',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'artistItem': {
        const result = normalized.source === 'library'
          ? await this.inPages((size, from) => this.fetchLibraryArtistAlbums(normalized.id, size, from), limit || 50, offset)
          : await this.inPages((size, from) => this.fetchArtistTopTracks(normalized.id, size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Artist',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'playlistItem': {
        const result = normalized.source === 'library'
          ? await this.inPages((size, from) => this.fetchLibraryPlaylistTracks(normalized.id, size, from), limit || 50, offset)
          : await this.inPages((size, from) => this.fetchPlaylistTracks(normalized.id, size, from), limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlist',
          service: 'applemusic',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'applemusic',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const normalized = this.normalizeItemId(trackId, 'track');
    const id = normalized.id;
    if (!id) {
      return null;
    }
    const item = normalized.source === 'library'
      ? await this.lookup(`${APPLE_MUSIC_API_BASE}/me/library/songs/${encodeURIComponent(id)}?include=catalog`)
      : await this.lookup(`${APPLE_MUSIC_API_BASE}/catalog/${await this.ensureStorefront()}/songs/${encodeURIComponent(id)}?include=albums`);
    if (!item) {
      return null;
    }
    return normalized.source === 'library' ? mapLibraryTrack(this.audiopathPrefix, item) : mapTrack(this.audiopathPrefix, item);
  }

  /**
   * The artists Apple itself puts beside this one.
   *
   * Worth asking the provider rather than deriving it: "who else would I like" is editorial data
   * that a catalogue owner has and a metadata database does not. MusicBrainz can only tell us who
   * *played in* a band — factually related, but a shelf of former members is not a shelf of music
   * to try next.
   *
   * A library artist has to be turned into a catalogue artist first: `similar-artists` is a
   * catalogue view, and the id in a library id is Apple's private library id. Empty is a normal
   * answer — a local upload has no catalogue counterpart to ask about.
   */
  public async getRelatedArtists(folderId: string, limit: number): Promise<ContentFolderItem[]> {
    const normalized = this.normalizeFolderId(folderId);
    if (normalized.type !== 'artistItem') {
      return [];
    }
    const catalogId =
      normalized.source === 'catalog'
        ? normalized.id
        : await this.resolveCatalogArtistId(normalized.id);
    if (!catalogId) {
      return [];
    }
    const storefront = await this.ensureStorefront();
    const url =
      `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/artists/${encodeURIComponent(catalogId)}` +
      `/view/similar-artists?limit=${Math.max(1, Math.min(APPLE_MAX_PAGE, limit))}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return items.map((entry: unknown) => mapArtist(this.audiopathPrefix, entry));
  }

  /** The catalogue id behind a library artist, or null when Apple has none for it. */
  private async resolveCatalogArtistId(libraryArtistId: string): Promise<string | null> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/artists/${encodeURIComponent(libraryArtistId)}?include=catalog`;
    const data = await this.fetchJson<any>(url);
    const catalog = data?.data?.[0]?.relationships?.catalog?.data?.[0]?.id;
    return typeof catalog === 'string' && catalog ? catalog : null;
  }

  public async search(query: string, limits: Record<string, number>, maxLimit: number): Promise<ProviderSearchResult> {
    const limit = Math.min(
      Math.max(...(Object.values(limits).length ? Object.values(limits) : [maxLimit]), DEFAULT_MIN_SEARCH_LIMIT),
      maxLimit,
    );
    const storefront = await this.ensureStorefront();
    const url = new URL(`${APPLE_MUSIC_API_BASE}/catalog/${storefront}/search`);
    // Apple's search endpoint chokes on apostrophes; strip them like MA does.
    url.searchParams.set('term', query.replace(/'/g, ''));
    url.searchParams.set('limit', String(limit));
    const requestedTypes = Object.keys(limits).map((k) => k.trim().toLowerCase()).filter(Boolean);
    const typeSet = requestedTypes.length ? new Set(requestedTypes) : null;
    const activeTypes: Array<'songs' | 'albums' | 'artists' | 'playlists'> = [];
    const wants = (key: string) => (typeSet ? typeSet.has(key) : true);
    if (wants('track') || wants('tracks') || wants('song') || wants('songs')) activeTypes.push('songs');
    if (wants('album') || wants('albums')) activeTypes.push('albums');
    if (wants('artist') || wants('artists')) activeTypes.push('artists');
    if (wants('playlist') || wants('playlists')) activeTypes.push('playlists');
    if (!activeTypes.length) {
      activeTypes.push('songs', 'albums', 'artists', 'playlists');
    }
    url.searchParams.set('types', activeTypes.join(','));

    const data = await this.fetchJson<any>(url.toString());
    const result: ProviderSearchCategories = {};
    if (data?.results?.songs?.data) {
      const max = limits.track ?? limits.tracks ?? limit;
      result.tracks = data.results.songs.data.slice(0, max).map((t: unknown) => mapTrack(this.audiopathPrefix, t));
    }
    if (data?.results?.albums?.data) {
      const max = limits.album ?? limits.albums ?? limit;
      result.albums = data.results.albums.data.slice(0, max).map((a: unknown) => mapAlbum(this.audiopathPrefix, a));
    }
    if (data?.results?.artists?.data) {
      const max = limits.artist ?? limits.artists ?? limit;
      result.artists = data.results.artists.data.slice(0, max).map((a: unknown) => mapArtist(this.audiopathPrefix, a));
    }
    if (data?.results?.playlists?.data) {
      const max = limits.playlist ?? limits.playlists ?? limit;
      result.playlists = data.results.playlists.data.slice(0, max).map((p: unknown) => mapPlaylist(this.audiopathPrefix, p));
    }
    // The search `user` must match the account segment in the items' audiopaths
    // (`spotify@<account>:…`) — the native client browses a searched album via
    // this user, and a non-account label like 'applemusic' can't be resolved,
    // leaving the album stuck loading. Mirror the real-Spotify behaviour where
    // the search user equals the account id.
    return { result, providerId: this.providerId, user: this.providerId.split('@')[1] || this.providerId };
  }

  public dispose(): void {
    /* nothing to clean up */
  }

  /* ------------------------------------------------------------------------ */
  /* Mapping helpers                                                          */
  /* ------------------------------------------------------------------------ */

  private async buildRootFolder(offset: number): Promise<ContentFolder> {
    const sections = await this.fetchHomeSections();
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'applemusic',
      start: offset,
      totalitems: 8,
      // Node names, not the Loxone app's slot indices: the Loxone adapter maps its
      // slots onto these, so this tree can grow without touching that protocol.
      items: [
        this.folderLink('new-releases', 'New Releases'),
        this.folderLink('recommended-playlists', 'Recommended Playlists'),
        this.folderLink('recommended-albums', 'Recommended Albums'),
        this.folderLink('albums', 'Albums'),
        this.folderLink('artists', 'Artists'),
        this.folderLink('playlists', 'Playlists'),
        // The Loxone app has no slot for these, so they stay out of its view while
        // every other consumer can browse them — the point of publishing nodes
        // instead of the app's slot indices.
        this.folderLink('recent', 'Recently Added'),
        this.folderLink('songs', 'Songs'),
      ],
      sections,
    };
  }

  /** Preserve Apple's Home shelves instead of flattening them into one duplicate-prone list. */
  private async fetchHomeSections(): Promise<NonNullable<ContentFolder['sections']>> {
    const data = await this.fetchRecommendationsData().catch((error) => {
      this.log.warn('apple music home recommendations failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    const groups = Array.isArray(data?.data) ? data.data : [];
    const allSeen = new Set<string>();
    const sections: Array<{ id: string; name: string; items: ContentFolderItem[] } | null> = groups
      .map((group: any, index: number) => {
        const contents = group?.relationships?.contents?.data;
        if (!Array.isArray(contents)) return null;
        const items: ContentFolderItem[] = [];
        const seen = new Set<string>();
        for (const entry of contents) {
          const mapped = mapRecommendationItem(this.audiopathPrefix, entry);
          if (!mapped || seen.has(mapped.id) || allSeen.has(mapped.id)) continue;
          seen.add(mapped.id);
          allSeen.add(mapped.id);
          items.push(mapped);
        }
        if (!items.length) return null;
        const attrs = group?.attributes ?? {};
        const name = appleLocalizedText(attrs.name) || appleLocalizedText(attrs.title);
        return { id: String(group?.id ?? `home-${index}`), name: name || 'Recommended for you', items };
      });
    return sections.filter((section): section is { id: string; name: string; items: ContentFolderItem[] } => section !== null);
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      kind: 'category',
      items: 0,
    };
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
  ): { id: string; source: 'catalog' | 'library' } {
    const raw = this.stripProviderPrefix(value || '').trim();
    const libraryMatch = raw.match(new RegExp(`(?:^|:)library-${kind}:(.+)$`, 'i'));
    if (libraryMatch) {
      return { id: decodeId(libraryMatch[1] ?? ''), source: 'library' };
    }
    const match = raw.match(new RegExp(`(?:^|:)${kind}:(.+)$`, 'i'));
    const id = decodeId(match ? (match[1] ?? '') : raw);
    // Apple library ids carry an a./i./l./p. prefix (artist/item/album/playlist). Loxone recents
    // and MA-bridge audiopaths store library items as `…:<kind>:<libId>` without the `library-`
    // marker, so detect those by prefix and route them to the library endpoint — otherwise a
    // catalog lookup 404s and metadata never resolves (the stream service uses the same heuristic).
    const source = /^[ailp]\./i.test(id) ? 'library' : 'catalog';
    return { id, source };
  }

  private normalizeFolderId(folderId: string):
    | { type: 'root' }
    | { type: 'albums' }
    | { type: 'artists' }
    | { type: 'playlists' }
    | { type: 'newReleases' }
    | { type: 'recommendationsPlaylists' }
    | { type: 'recommendationsAlbums' }
    | { type: 'songs' }
    | { type: 'recent' }
    | { type: 'albumItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'artistItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'playlistItem'; id: string; source: 'catalog' | 'library' }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start') {
      return { type: 'root' };
    }
    if (lower === 'albums' || lower === 'album') {
      return { type: 'albums' };
    }
    if (lower === 'artists' || lower === 'artist') {
      return { type: 'artists' };
    }
    if (lower === 'playlists' || lower === 'playlist') {
      return { type: 'playlists' };
    }
    if (lower === 'new-releases' || lower === 'new') {
      return { type: 'newReleases' };
    }
    if (lower === 'recommendations-playlists' || lower === 'recommended-playlists') {
      return { type: 'recommendationsPlaylists' };
    }
    if (lower === 'recommendations-albums' || lower === 'recommended-albums') {
      return { type: 'recommendationsAlbums' };
    }
    if (lower === 'songs' || lower === 'tracks') {
      return { type: 'songs' };
    }
    if (lower === 'recent' || lower === 'recently-added') {
      return { type: 'recent' };
    }

    const libraryAlbumMatch = raw.match(/(?:^|:)library-album:(.+)$/i);
    if (libraryAlbumMatch) {
      return { type: 'albumItem', id: decodeId(libraryAlbumMatch[1] ?? ''), source: 'library' };
    }
    const libraryArtistMatch = raw.match(/(?:^|:)library-artist:(.+)$/i);
    if (libraryArtistMatch) {
      return { type: 'artistItem', id: decodeId(libraryArtistMatch[1] ?? ''), source: 'library' };
    }
    const libraryPlaylistMatch = raw.match(/(?:^|:)library-playlist:(.+)$/i);
    if (libraryPlaylistMatch) {
      return { type: 'playlistItem', id: decodeId(libraryPlaylistMatch[1] ?? ''), source: 'library' };
    }

    const albumMatch = raw.match(/(?:^|:)album:(.+)$/i);
    if (albumMatch) {
      return { type: 'albumItem', id: decodeId(albumMatch[1] ?? ''), source: 'catalog' };
    }
    const artistMatch = raw.match(/(?:^|:)artist:(.+)$/i);
    if (artistMatch) {
      return { type: 'artistItem', id: decodeId(artistMatch[1] ?? ''), source: 'catalog' };
    }
    const playlistMatch = raw.match(/(?:^|:)playlist:(.+)$/i);
    if (playlistMatch) {
      return { type: 'playlistItem', id: decodeId(playlistMatch[1] ?? ''), source: 'catalog' };
    }
    return { type: 'unknown' };
  }

  /* ------------------------------------------------------------------------ */
  /* Apple Music fetch helpers                                                */
  /* ------------------------------------------------------------------------ */

  private async fetchJson<T>(url: string, retryAuth = true): Promise<T | null> {
    const requestUrl = this.withMotionArtwork(url);
    const maxAttempts = 3;
    let lastStatus = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const headers = await this.buildAuthHeaders();
        let res = await fetch(requestUrl, { headers, signal: AbortSignal.timeout(15_000) });
        if ((res.status === 401 || res.status === 403) && retryAuth && attempt === 0) {
          await this.refreshBearerToken();
          const retryHeaders = await this.buildAuthHeaders();
          res = await fetch(requestUrl, { headers: retryHeaders, signal: AbortSignal.timeout(15_000) });
        }
        if (res.ok) {
          return (await res.json()) as T;
        }
        lastStatus = res.status;
        // Transient: rate-limited (429), gateway/overload (500/503/504) → back off and retry.
        if (this.isTransientStatus(res.status) && attempt < maxAttempts - 1) {
          const waitMs = this.computeRetryDelay(res, attempt);
          this.log.debug('apple music request retrying', { url: requestUrl, status: res.status, attempt: attempt + 1, waitMs });
          await sleep(waitMs);
          continue;
        }
        return null;
      } catch (err) {
        // Network/timeout errors are usually transient; retry with backoff until the last attempt.
        if (attempt < maxAttempts - 1) {
          await sleep(this.computeRetryDelay(null, attempt));
          continue;
        }
        this.log.warn('apple music request failed', { url: requestUrl, message: describeFetchError(err) });
        return null;
      }
    }
    if (lastStatus) {
      this.log.warn('apple music request gave up after retries', { url: requestUrl, status: lastStatus });
    }
    return null;
  }

  /** Apple keeps motion artwork behind an extended attribute on every resource type. */
  private withMotionArtwork(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'amp-api.music.apple.com') {
        parsed.searchParams.set('extend', 'editorialVideo');
        return parsed.toString();
      }
    } catch {
      /* Keep the original URL for the existing error path. */
    }
    return url;
  }

  private isTransientStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 503 || status === 504;
  }

  private computeRetryDelay(res: Response | null, attempt: number): number {
    const header = res?.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, 15_000);
      }
    }
    const base = 500 * 2 ** attempt;
    return Math.min(base + Math.round(Math.random() * 300), 8_000);
  }

  private async lookup(url: string): Promise<any | null> {
    const data = await this.fetchJson<any>(url);
    const items = data?.data;
    if (Array.isArray(items) && items.length) {
      return items[0];
    }
    return null;
  }

  private async fetchAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => mapTrack(this.audiopathPrefix, t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchArtistTopTracks(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/artists/${encodeURIComponent(artistId)}/view/top-songs?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => mapTrack(this.audiopathPrefix, t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = `${APPLE_MUSIC_API_BASE}/catalog/${storefront}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => mapTrack(this.audiopathPrefix, t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  /**
   * Apple pages at 100, and asking for more is not merely capped — the request is rejected, which
   * arrives here as an empty page. A browse view then says "nothing here" over a library of 362
   * artists, which is how this surfaced: the player asks for 120 at a time.
   *
   * So a larger ask is split into upstream pages and stitched back together. Anything within
   * Apple's own page size is one request, exactly as before. `total` comes from the last page
   * that reported one, and a short page ends the loop — that is Apple saying there is no more,
   * whatever the count claimed.
   */
  private async inPages(
    fetchPage: (limit: number, offset: number) => Promise<{ items: ContentFolderItem[]; total?: number }>,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (limit <= APPLE_MAX_PAGE) {
      return fetchPage(limit, offset);
    }
    const items: ContentFolderItem[] = [];
    let total: number | undefined;
    let cursor = offset;
    while (items.length < limit) {
      const page = await fetchPage(Math.min(APPLE_MAX_PAGE, limit - items.length), cursor);
      if (typeof page.total === 'number') {
        total = page.total;
      }
      if (page.items.length === 0) {
        break;
      }
      items.push(...page.items);
      cursor += page.items.length;
      if (typeof total === 'number' && cursor >= total) {
        break;
      }
    }
    return { items, total };
  }

  private async fetchLibraryAlbums(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => mapLibraryAlbum(this.audiopathPrefix, entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryArtists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    // Request catalog relationship so we can reuse catalog artwork without extra calls.
    const url = `${APPLE_MUSIC_API_BASE}/me/library/artists?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    const mapped: ContentFolderItem[] = items.map((entry: any) => mapLibraryArtist(this.audiopathPrefix, entry));
    return {
      items: mapped,
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryPlaylists(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists?limit=${limit}&offset=${offset}`;
    const data = await this.fetchJson<any>(url);
    const raw: any[] = Array.isArray(data?.data) ? data.data : [];
    const items: ContentFolderItem[] = raw.map((entry: any) => mapLibraryPlaylist(this.audiopathPrefix, entry));
    // Apple exposes no artwork for many user playlists — the app builds a mosaic
    // from the tracks, which the API doesn't return. Mirror Music Assistant: tile
    // the track covers into a server-side mosaic. Generation is lazy + cached, so
    // we serve a cached mosaic when present and otherwise the first track's cover
    // (never blank) while the mosaic builds in the background.
    const coverless = items
      .map((it, idx) => ({ it, id: raw[idx]?.id }))
      .filter(({ it, id }) => !it.coverurl && id)
      .slice(0, 16);
    await Promise.all(
      coverless.map(async ({ it, id }) => {
        const key = collageKey(this.audiopathPrefix, 'playlist', String(id));
        const cached = await collageCachedUrl(this.coverHost, key, this.coverOrigin);
        if (cached) {
          it.coverurl = cached;
          it.thumbnail = cached;
          return;
        }
        const tracks = await this.fetchLibraryPlaylistTracks(String(id), 60, 0).catch(() => null);
        const covers = (tracks?.items ?? [])
          .map((t) => t.coverurl)
          .filter((c): c is string => typeof c === 'string' && c.length > 0);
        if (covers.length) {
          ensureCollage(key, covers);
          const first = covers[0];
          it.coverurl = first;
          it.thumbnail = first;
        }
      }),
    );
    return {
      items,
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibrarySongs(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/songs?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => mapLibraryTrack(this.audiopathPrefix, entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryRecentAlbums(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums?limit=${limit}&offset=${offset}&sort=-dateAdded&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => mapLibraryAlbum(this.audiopathPrefix, entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/albums/${encodeURIComponent(albumId)}/tracks?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => mapLibraryTrack(this.audiopathPrefix, t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((t: any) => mapLibraryTrack(this.audiopathPrefix, t)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchLibraryArtistAlbums(
    artistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/artists/${encodeURIComponent(artistId)}/albums?limit=${limit}&offset=${offset}&include=catalog`;
    const data = await this.fetchJson<any>(url);
    const items = Array.isArray(data?.data) ? data.data : [];
    return {
      items: items.map((entry: any) => mapLibraryAlbum(this.audiopathPrefix, entry)),
      total: typeof data?.meta?.total === 'number' ? data.meta.total : undefined,
    };
  }

  private async fetchRecommendations(
    limit: number,
    offset: number,
    allowedTypes?: Set<string>,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.fetchRecommendationsData();
    // `limit`/`offset` on /me/recommendations page the recommendation GROUPS,
    // not the items inside them — and Apple returns an empty payload when the
    // limit exceeds its (~30) maximum. So fetch the groups with a safe fixed
    // limit, flatten + filter their contents, then page the flattened items
    // client-side. (Previously the caller's limit≥50 hit the cap → no content.)
    const groups = Array.isArray(data?.data) ? data.data : [];
    const all: ContentFolderItem[] = [];
    for (const group of groups) {
      const contents = group?.relationships?.contents?.data;
      if (!Array.isArray(contents)) {
        continue;
      }
      for (const entry of contents) {
        const type = entry?.type;
        if (allowedTypes && (!type || !allowedTypes.has(type))) {
          continue;
        }
        const mapped = mapRecommendationItem(this.audiopathPrefix, entry);
        if (mapped) {
          all.push(mapped);
        }
      }
    }
    const start = Math.max(0, offset);
    const items = limit > 0 ? all.slice(start, start + limit) : all.slice(start);
    return {
      items,
      total: all.length,
    };
  }

  private async fetchRecommendationsData(): Promise<any> {
    const url = new URL(`${APPLE_MUSIC_API_BASE}/me/recommendations`);
    url.searchParams.set('limit', '30');
    // Motion artwork is an extended Apple attribute used by the web player.
    url.searchParams.set('extend', 'editorialVideo');
    return this.fetchJson<any>(url.toString());
  }

  /**
   * The albums Apple is currently featuring as new.
   *
   * There is no `new-releases` endpoint — that one was borrowed from Spotify, and
   * Apple answers it with the same "Invalid Path Value" it gives a made-up route, so
   * this section had been silently empty since it was written. What Apple has is the
   * editorial home feed: a grouping of shelves, one of which is the new-release one.
   *
   * Which shelf that is cannot be asked for by name. Every shelf title is localized
   * ('Nieuw deze week'), and the element ids rotate weekly, so the only durable
   * handles are the ones that describe the shelf rather than name it: it lists
   * albums, and Apple marks its lead shelf `emphasize`. Prefer that; fall back to the
   * first album shelf.
   */
  private async fetchNewReleases(
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const storefront = await this.ensureStorefront();
    const url = new URL(`${APPLE_MUSIC_API_BASE}/editorial/${storefront}/groupings`);
    url.searchParams.set('platform', 'web');
    url.searchParams.set('name', 'music');
    // The feed inlines every shelf's contents, most of which are playlists, songs and
    // videos this section never shows. Naming the fields we use takes it from ~360KB
    // to ~100KB; `id` and `type` always come regardless.
    url.searchParams.set('fields[albums]', 'name,artistName,artwork');
    for (const other of ['playlists', 'songs', 'stations', 'music-videos']) {
      url.searchParams.set(`fields[${other}]`, 'name');
    }
    const data = await this.fetchJson<any>(url.toString());
    const albums = pickAlbumShelf(data);
    if (!albums.length) {
      // Better empty than wrong: showing the charts here would label "most played" as
      // new. A storefront whose feed has no album shelf is worth knowing about.
      this.log.warn('apple music new releases: no album shelf in the editorial feed', { storefront });
      return { items: [], total: 0 };
    }
    const page = albums.slice(offset, offset + (limit || 50));
    return {
      items: page.map((entry: any) => mapAlbum(this.audiopathPrefix, entry)),
      total: albums.length,
    };
  }

  private async buildAuthHeaders(): Promise<Record<string, string>> {
    const headers = buildBaseHeaders(this.userToken);
    // Prefer a configured developer token, then the shipped one (only if unexpired); scrape last.
    let bearer: string | null = this.developerToken ?? getShippedDeveloperToken();
    if (!bearer) bearer = await this.ensureBearerToken();
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    }
    return headers;
  }

  private async ensureBearerToken(): Promise<string | null> {
    if (!this.userToken) {
      return null;
    }
    if (this.bearerToken && Date.now() - this.bearerTokenFetchedAt < BEARER_TOKEN_TTL_MS) {
      return this.bearerToken;
    }
    if (this.bearerTokenPromise) {
      return this.bearerTokenPromise;
    }
    this.bearerTokenPromise = (async () => {
      try {
        const token = await scrapeBearerToken(buildBaseHeaders(this.userToken));
        if (!token) {
          this.log.warn('apple music token fetch failed: bearer token not found');
          return null;
        }
        this.bearerToken = token;
        this.bearerTokenFetchedAt = Date.now();
        return token;
      } catch (err) {
        this.log.warn('apple music token fetch failed', { message: describeFetchError(err) });
        return null;
      }
    })();
    try {
      return await this.bearerTokenPromise;
    } finally {
      this.bearerTokenPromise = null;
    }
  }

  private async refreshBearerToken(): Promise<void> {
    this.bearerToken = undefined;
    this.bearerTokenFetchedAt = 0;
    await this.ensureBearerToken();
  }

  private async ensureStorefront(): Promise<string> {
    if (this.storefrontResolved) {
      return this.storefront;
    }
    if (this.storefrontPromise) {
      return this.storefrontPromise;
    }
    this.storefrontPromise = (async () => {
      if (!this.userToken) {
        this.storefrontResolved = true;
        return this.storefront;
      }
      const account = await this.fetchJson<any>(`${APPLE_MUSIC_API_BASE}/me/account?meta=subscription`);
      const storefront = account?.meta?.subscription?.storefront;
      if (storefront) {
        this.storefront = String(storefront).toLowerCase();
      }
      this.storefrontResolved = true;
      return this.storefront;
    })();
    try {
      return await this.storefrontPromise;
    } finally {
      this.storefrontPromise = null;
    }
  }
}
