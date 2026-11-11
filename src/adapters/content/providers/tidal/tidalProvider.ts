import type { ContentFolder, ContentFolderItem, ContentFolderSection, ContentServiceAccount, PlaylistEntry } from '@/ports/ContentTypes';
import { FileType } from '@/domain/zones/enums';
import { createLogger } from '@/shared/logging/logger';
import { DEFAULT_MIN_SEARCH_LIMIT } from '@/adapters/content/utils/searchLimits';
import type { ContentProvider, ProviderSearchCategories, ProviderSearchResult } from '@/adapters/content/ContentProvider';
import type { TidalApiAccess } from '@/adapters/content/providers/tidal/tidalAuth';
import { TIDAL_API_BASE, TIDAL_SESSIONS_URL } from '@/adapters/content/providers/tidal/tidalAuthClient';
import {
  albumFromResource,
  JSONAPI_CONTENT_TYPE,
  JsonApiDocument,
  OPENAPI_INCLUDES,
  OPENAPI_MIX_COLLECTIONS,
  playlistFromResource,
  relationshipItems,
  TIDAL_OPENAPI_BASE,
  trackFromResource,
} from '@/adapters/content/providers/tidal/tidalOpenApi';
import {
  extendModule,
  isMixId,
  mixImageUrl,
  moduleItems,
  moduleTotal,
  musicModules,
  PAGE_PARAMS,
  type PageItem,
  type RawPage,
  TIDAL_MY_MIXES_PAGE,
  TIDAL_PAGES,
  TIDAL_PAGES_BASE,
  type TidalPageNode,
} from '@/adapters/content/providers/tidal/tidalPages';

/** Pages of a cursor-paginated relationship walked at most to reach an offset. */
const MAX_OPENAPI_PAGES = 20;

/** Mixes listed at most per mix collection; an account has a handful of each. */
const MAX_MIXES_PER_COLLECTION = 50;

/** How long a fetched page is served from memory: TIDAL reshuffles them a few times a day. */
const PAGE_CACHE_MS = 15 * 60 * 1000;

/** How long an artist's page is kept, so paging through it does not ask for it again. */
const ARTIST_PAGE_CACHE_MS = 5 * 60 * 1000;
const ARTIST_PAGE_CACHE_SIZE = 20;

/** Top tracks on an artist's page; the rest of the page is records. */
const ARTIST_TOP_TRACKS = 10;

/** Records of each kind on an artist's page. */
const ARTIST_RECORDS = 50;

/** Related items listed at most: similar artists, albums and tracks, a radio. */
const MAX_RELATED = 100;

/** The related lists, by the node prefix they are browsed under and the name they are shown with. */
const RELATED = {
  'artist-similar': 'Similar Artists',
  'artist-radio': 'Artist Radio',
  'album-similar': 'Similar Albums',
  'track-radio': 'Track Radio',
  'track-similar': 'Similar Tracks',
} as const;
type RelatedKind = keyof typeof RELATED;

type FolderResult = { items: ContentFolderItem[]; total?: number };
type ArtistPage = { topTracks: ContentFolderItem[]; albums: ContentFolderItem[]; singles: ContentFolderItem[] };
type CollectionKind = 'tracks' | 'albums' | 'artists' | 'playlists';
type ApiResource = Parameters<typeof trackFromResource>[1];

/**
 * The account's sections, by the node names they are browsed under. The Loxone app reaches them
 * through its slot table (`loxoneServiceFolders`); every other consumer by these names.
 */
const COLLECTION_NAMES: Record<CollectionKind, string> = {
  tracks: 'Tracks',
  albums: 'Albums',
  artists: 'Artists',
  playlists: 'Playlists',
};

interface TidalProviderOptions {
  providerId: string;
  serviceNativePrefix?: string;
  label?: string;
  /** The streaming service (config entry) whose account this catalogue is browsed as. */
  serviceId: string;
  /** Authenticated requests: the token, its refresh and the account's country. */
  auth: TidalApiAccess;
}

/**
 * Lightweight Tidal catalog provider that mirrors the Apple Music facade shape (no playback).
 *
 * The account is a device-flow sign-in or a pasted token, and reads api.tidal.com/v1. The official
 * openapi.tidal.com/v2 takes the same token and is asked only for what v1 does not have: similar
 * albums and tracks, and the daily, discovery and new-release mixes.
 */
export class TidalProvider implements ContentProvider {
  public readonly providerId: string;
  private readonly audiopathPrefix: string;
  private readonly log = createLogger('Content', 'Tidal');
  private readonly label: string;
  private readonly serviceId: string;
  private readonly auth: TidalApiAccess;
  private refusalLogged = false;
  /** The account's v1 user id, once `/sessions` said it. */
  private v1User: string | null = null;
  /** Whether the token reads the editorial pages (it needs `r_usr`); unknown until one was asked for. */
  private pagesAccess: 'unknown' | 'ok' | 'refused' = 'unknown';
  private readonly pageCache = new Map<string, { at: number; page: RawPage }>();
  private readonly artistPages = new Map<string, { at: number; page: ArtistPage }>();

  constructor(options: TidalProviderOptions) {
    this.providerId = options.providerId;
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.label = options.label || 'Tidal';
    this.serviceId = options.serviceId;
    this.auth = options.auth;
  }

  public get accountId(): string {
    return 'tidal';
  }

  public get displayLabel(): string {
    return this.label;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.providerId,
      label: this.displayLabel,
      provider: 'tidal',
      fake: true,
    };
  }

  public async fetchAccessToken(): Promise<string | null> {
    // Tidal's token is never handed out: requests go through the auth, which refreshes it.
    return null;
  }

  public async getPlaylists(_offset: number, _limit: number): Promise<PlaylistEntry[]> {
    // Tidal catalog playlists are not enumerated here; search returns playlists.
    return [];
  }

  public async getFolder(folderId: string, offset: number, limit: number): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);
    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'page':
        return this.buildPageFolder(folderId, normalized.node, offset, limit || 50);
      case 'pageModule':
        return this.buildModuleFolder(folderId, normalized.node, normalized.index, offset, limit || 50);
      case 'collection':
        return this.listFolder(folderId, 'My Collection', offset, {
          items: (Object.keys(COLLECTION_NAMES) as CollectionKind[]).map((kind) =>
            this.folderLink(`collection-${kind}`, COLLECTION_NAMES[kind]),
          ),
        });
      case 'collectionKind':
        return this.listFolder(
          folderId,
          COLLECTION_NAMES[normalized.kind],
          offset,
          await this.fetchCollection(normalized.kind, limit || 50, offset),
        );
      case 'playlists':
        return this.listFolder(folderId, 'My Playlists', offset, await this.fetchOwnPlaylists(limit || 50, offset));
      case 'mixes':
        return this.listFolder(folderId, 'Mixes', offset, await this.fetchMixes(limit || 50, offset));
      case 'albumItem': {
        const result = await this.fetchAlbumTracks(normalized.id, limit || 50, offset);
        // After the last track: the albums TIDAL puts beside this one (on the next page when this
        // one is full).
        if (typeof result.total === 'number' && offset + result.items.length >= result.total) {
          if (result.items.length < (limit || 50)) result.items.push(this.relatedLink('album-similar', normalized.id));
          result.total += 1;
        }
        return {
          id: folderId,
          name: 'Album',
          service: 'tidal',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      case 'artistItem':
        return this.buildArtistFolder(folderId, normalized.id, offset, limit || 50);
      case 'related': {
        const result = await this.fetchRelated(normalized.kind, normalized.id, limit || 50, offset);
        return this.listFolder(folderId, RELATED[normalized.kind], offset, { ...result, total: Math.min(result.total ?? 0, MAX_RELATED) });
      }
      case 'playlistItem': {
        const result = await this.fetchPlaylistTracks(normalized.id, limit || 50, offset);
        return {
          id: folderId,
          name: 'Playlist',
          service: 'tidal',
          start: offset,
          totalitems: typeof result.total === 'number' ? result.total : result.items.length,
          items: result.items,
        };
      }
      default:
        return {
          id: folderId,
          name: this.displayLabel,
          service: 'tidal',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const normalized = this.normalizeItemId(trackId, 'track');
    if (!normalized.id) return null;
    const track = await this.fetchJson<any>(`${TIDAL_API_BASE}/tracks/${encodeURIComponent(normalized.id)}`);
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

    await this.searchV1(query, activeTypes, limits, limit, result);

    // See AppleMusicProvider.search: the search `user` must equal the account
    // segment in the audiopaths so the native client can browse searched albums.
    return { result, providerId: this.providerId, user: this.providerId.split('@')[1] || this.providerId };
  }

  private async searchV1(
    query: string,
    activeTypes: Set<string>,
    limits: Record<string, number>,
    limit: number,
    result: ProviderSearchCategories,
  ): Promise<void> {
    if (activeTypes.has('track')) {
      const tracks = await this.fetchSearchResults('tracks', query, limits.track ?? limit);
      result.tracks = tracks.map((track) => this.mapTrack(track));
    }
    if (activeTypes.has('album')) {
      const albums = await this.fetchSearchResults('albums', query, limits.album ?? limit);
      result.albums = albums.map((album) => this.mapAlbum(album));
    }
    if (activeTypes.has('artist')) {
      const artists = await this.fetchSearchResults('artists', query, limits.artist ?? limit);
      result.artists = artists.map((artist) => this.mapArtist(artist));
    }
    if (activeTypes.has('playlist')) {
      const playlists = await this.fetchSearchResults('playlists', query, limits.playlist ?? limit);
      result.playlists = playlists.map((playlist) => this.mapPlaylist(playlist));
    }
  }

  public dispose(): void {
    /* nothing to clean up */
  }

  /* ------------------------------------------------------------------------ */
  /* Mapping helpers                                                          */
  /* ------------------------------------------------------------------------ */

  private async buildRootFolder(offset: number): Promise<ContentFolder> {
    const items: ContentFolderItem[] = [];
    // TIDAL's editorial pages, for a token v1 reads them for (it needs `r_usr`).
    if (await this.pagesAvailable()) {
      for (const page of TIDAL_PAGES) items.push(this.folderLink(page.node, page.name));
    }
    items.push(this.folderLink('collection', 'My Collection'), this.folderLink('playlists', 'My Playlists'), this.folderLink('mixes', 'Mixes'));
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'tidal',
      start: offset,
      totalitems: items.length,
      items: items.slice(offset),
    };
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return { id, name, type: FileType.Folder, kind: 'category', items: 0 };
  }

  /**
   * An entry into one of an item's related lists. A folder without an audiopath on purpose: playing
   * the artist or album it sits in must not queue another artist's music.
   */
  private relatedLink(kind: RelatedKind, id: string): ContentFolderItem {
    return this.folderLink(`${kind}:${id}`, RELATED[kind]);
  }

  private listFolder(id: string, name: string, offset: number, result: FolderResult): ContentFolder {
    return {
      id,
      name,
      service: 'tidal',
      start: offset,
      totalitems: typeof result.total === 'number' ? result.total : offset + result.items.length,
      items: result.items,
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
    | { type: 'page'; node: TidalPageNode }
    | { type: 'pageModule'; node: TidalPageNode; index: number }
    | { type: 'collection' }
    | { type: 'collectionKind'; kind: CollectionKind }
    | { type: 'playlists' }
    | { type: 'mixes' }
    | { type: 'albumItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'related'; kind: RelatedKind; id: string }
    | { type: 'playlistItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root').trim();
    const lower = raw.toLowerCase();
    if (lower === 'root' || lower === 'start') {
      return { type: 'root' };
    }
    const page = TIDAL_PAGES.find((p) => p.node === lower);
    if (page) return { type: 'page', node: page.node };
    const moduleMatch = lower.match(/^page-module:([a-z-]+):(\d+)$/);
    const modulePage = moduleMatch ? TIDAL_PAGES.find((p) => p.node === moduleMatch[1]) : undefined;
    if (modulePage) return { type: 'pageModule', node: modulePage.node, index: Number(moduleMatch![2]) };
    if (lower === 'collection') return { type: 'collection' };
    if (lower === 'playlists') return { type: 'playlists' };
    if (lower === 'mixes') return { type: 'mixes' };
    const kind = lower.match(/^collection-(tracks|albums|artists|playlists)$/)?.[1] as CollectionKind | undefined;
    if (kind) return { type: 'collectionKind', kind };
    const relatedMatch = raw.match(/(?:^|:)((?:artist|album|track)-(?:similar|radio)):(.+)$/i);
    const relatedKind = relatedMatch?.[1]?.toLowerCase();
    if (relatedKind && relatedKind in RELATED) {
      return { type: 'related', kind: relatedKind as RelatedKind, id: relatedMatch![2] ?? '' };
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
    const artist = track?.artist?.name ?? artistNames(track?.artists);
    const album = track?.album?.title ?? '';
    const cover = track?.coverUrl || buildImageUrl(track?.album?.cover, 320);
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
      provider: 'tidal',
    };
  }

  private mapAlbum(album: any): ContentFolderItem {
    const id = String(album?.id ?? '');
    const name = String(album?.title ?? 'Album');
    const artist = album?.artist?.name ?? artistNames(album?.artists);
    const cover = album?.coverUrl || buildImageUrl(album?.cover, 320);
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
      provider: 'tidal',
    };
  }

  private mapArtist(artistObj: any): ContentFolderItem {
    const id = String(artistObj?.id ?? '');
    const name = String(artistObj?.name ?? 'Artist');
    const cover = artistObj?.coverUrl || buildImageUrl(artistObj?.picture, 320);
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
      provider: 'tidal',
    };
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const id = String(playlist?.uuid ?? playlist?.id ?? '');
    const name = String(playlist?.title ?? 'Playlist');
    const owner = playlist?.creator?.name || playlist?.creator?.username || (playlist?.type === 'EDITORIAL' ? 'TIDAL' : '');
    const cover = playlist?.coverUrl || buildImageUrl(playlist?.squareImage, 320);
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
      provider: 'tidal',
    };
  }

  /** A mix opens and plays like a playlist; its id tells it apart when it is opened. */
  private mapMix(mix: any): ContentFolderItem {
    return this.mapPlaylist({
      uuid: String(mix?.id ?? mix?.mixId ?? ''),
      title: typeof mix?.title === 'string' && mix.title.trim() ? mix.title : 'Mix',
      creator: { name: 'TIDAL' },
      coverUrl: mixImageUrl(mix ?? {}),
    });
  }

  private mapPageItem(entry: PageItem): ContentFolderItem {
    switch (entry.kind) {
      case 'track':
        return this.mapTrack(entry.item);
      case 'album':
        return this.mapAlbum(entry.item);
      case 'artist':
        return this.mapArtist(entry.item);
      case 'playlist':
        return this.mapPlaylist(entry.item);
      case 'mix':
        return this.mapMix(entry.item);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Editorial pages (tidal.com/v1/pages/*)                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Whether this account reads the pages: only when its token carries `r_usr` — which the first
   * page asked for says, and which is remembered from then on.
   */
  private async pagesAvailable(): Promise<boolean> {
    if (this.pagesAccess === 'refused') return false;
    if (this.pagesAccess === 'ok') return true;
    // Home is the page opened first anyway, so asking it here costs nothing it is cached for.
    return (await this.fetchPage(TIDAL_PAGES[0].path)) !== null;
  }

  /** A page, from memory while it is fresh. Null when TIDAL refused or failed it; it is then left out. */
  private async fetchPage(path: string): Promise<RawPage | null> {
    const cached = this.pageCache.get(path);
    if (cached && Date.now() - cached.at < PAGE_CACHE_MS) return cached.page;
    const page = await this.fetchPageJson<RawPage>(path, {});
    if (page && Array.isArray(page.rows)) {
      this.pageCache.set(path, { at: Date.now(), page });
      return page;
    }
    return null;
  }

  /**
   * A request to the page host. Kept apart from {@link fetchJson}: a page TIDAL will not show this
   * account is left out quietly, and remembered as such.
   */
  private async fetchPageJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const url = new URL(`${TIDAL_PAGES_BASE}/${path.replace(/^\//, '')}`);
    for (const [key, value] of Object.entries({ ...PAGE_PARAMS, ...params })) url.searchParams.set(key, value);
    try {
      const res = await this.auth.fetch(this.serviceId, url);
      if (!res) return null;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          if (this.pagesAccess !== 'refused') this.log.info('tidal pages are not available to this account', { status: res.status, serviceId: this.serviceId });
          if (this.pagesAccess === 'unknown') this.pagesAccess = 'refused';
        } else {
          this.log.debug('tidal page request failed', { path: url.pathname, status: res.status });
        }
        return null;
      }
      this.pagesAccess = 'ok';
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn('tidal page request failed', { path: url.pathname, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** A page as a folder of its shelves; the shelves' first items come along as sections. */
  private async buildPageFolder(folderId: string, node: TidalPageNode, offset: number, limit: number): Promise<ContentFolder> {
    const spec = TIDAL_PAGES.find((p) => p.node === node)!;
    const page = await this.fetchPage(spec.path);
    const modules = musicModules(page);
    const links: ContentFolderItem[] = [];
    const sections: ContentFolderSection[] = [];
    for (const { index, title, module } of modules) {
      const items = moduleItems(module).map((entry) => this.mapPageItem(entry));
      const id = `page-module:${node}:${index}`;
      links.push({ ...this.folderLink(id, title), items: moduleTotal(module), coverurl: items[0]?.coverurl, thumbnail: items[0]?.coverurl });
      sections.push({ id, name: title, items });
    }
    return {
      id: folderId,
      name: spec.name,
      service: 'tidal',
      start: offset,
      totalitems: links.length,
      items: links.slice(offset, offset + limit),
      ...(offset === 0 && sections.length ? { sections } : {}),
    };
  }

  /** One shelf, extended past what the page embedded through its `dataApiPath`, as far as it is paged. */
  private async buildModuleFolder(
    folderId: string,
    node: TidalPageNode,
    index: number,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const spec = TIDAL_PAGES.find((p) => p.node === node)!;
    const page = await this.fetchPage(spec.path);
    const found = musicModules(page).find((m) => m.index === index);
    if (!found) return this.listFolder(folderId, spec.name, offset, { items: [], total: 0 });
    await extendModule(found.module, offset + limit, async (path, from, count) => {
      const more = await this.fetchPageJson<{ items?: unknown[] }>(path, { offset: String(from), limit: String(count) });
      return Array.isArray(more?.items) ? more.items : null;
    });
    const all = moduleItems(found.module);
    const total = moduleTotal(found.module);
    const fetched = found.module.pagedList?.items?.length ?? all.length;
    return {
      id: folderId,
      name: found.title,
      service: 'tidal',
      start: offset,
      // When the rest could not be fetched, what there is is all that is promised.
      totalitems: fetched >= Math.min(offset + limit, total) ? total : all.length,
      items: all.slice(offset, offset + limit).map((entry) => this.mapPageItem(entry)),
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Tidal API helpers                                                        */
  /* ------------------------------------------------------------------------ */

  private async fetchJson<T>(url: string): Promise<T | null> {
    try {
      const res = await this.auth.fetch(this.serviceId, new URL(url));
      if (!res) {
        return null;
      }
      if (!res.ok) {
        this.noteRefusal(res.status);
        return null;
      }
      this.refusalLogged = false;
      const data = (await res.json()) as T;
      return data;
    } catch (err) {
      this.log.warn('tidal request failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchSearchResults(kind: 'tracks' | 'albums' | 'artists' | 'playlists', query: string, limit: number): Promise<any[]> {
    const url = new URL(`${TIDAL_API_BASE}/search/${kind}`);
    url.searchParams.set('query', query);
    url.searchParams.set('limit', String(limit));
    const data = await this.fetchJson<any>(url.toString());
    return Array.isArray(data?.items) ? data.items : [];
  }

  /* ------------------------------------------------------------------------ */
  /* Artists, and what TIDAL puts beside an item                              */
  /* ------------------------------------------------------------------------ */

  /**
   * An artist's page, shaped like Spotify's: their top tracks, then their albums, then their
   * singles and EPs, as one list a client can play through — followed by the entries into similar
   * artists and the artist's radio — and the same split into sections for a client that groups.
   */
  private async buildArtistFolder(folderId: string, artistId: string, offset: number, limit: number): Promise<ContentFolder> {
    const page = await this.fetchArtistPage(artistId);
    const links = [this.relatedLink('artist-similar', artistId), this.relatedLink('artist-radio', artistId)];
    const all = [...page.topTracks, ...page.albums, ...page.singles, ...links];
    const sections: ContentFolderSection[] = [];
    if (page.topTracks.length) sections.push({ id: 'artist-top-tracks', name: 'Top Tracks', items: page.topTracks });
    if (page.albums.length) sections.push({ id: 'artist-albums', name: 'Albums', items: page.albums });
    if (page.singles.length) sections.push({ id: 'artist-singles', name: 'Singles & EPs', items: page.singles });
    sections.push({ id: 'artist-more', name: 'More', items: links });
    return {
      id: folderId,
      name: 'Artist',
      service: 'tidal',
      start: offset,
      totalitems: all.length,
      items: all.slice(offset, offset + limit),
      ...(offset === 0 ? { sections } : {}),
    };
  }

  private async fetchArtistPage(artistId: string): Promise<ArtistPage> {
    const cached = this.artistPages.get(artistId);
    if (cached && Date.now() - cached.at < ARTIST_PAGE_CACHE_MS) return cached.page;
    const id = encodeURIComponent(artistId);
    const [topTracks, albums, singles] = await Promise.all([
      this.fetchListV1(`artists/${id}/toptracks`, ARTIST_TOP_TRACKS, 0, {}, (t) => this.mapTrack(t)),
      this.fetchListV1(`artists/${id}/albums`, ARTIST_RECORDS, 0, {}, (a) => this.mapAlbum(a)),
      this.fetchListV1(`artists/${id}/albums`, ARTIST_RECORDS, 0, { filter: 'EPSANDSINGLES' }, (a) => this.mapAlbum(a)),
    ]);
    const page: ArtistPage = { topTracks: topTracks.items, albums: albums.items, singles: singles.items };
    if (this.artistPages.size >= ARTIST_PAGE_CACHE_SIZE) {
      const oldest = this.artistPages.keys().next().value;
      if (oldest !== undefined) this.artistPages.delete(oldest);
    }
    this.artistPages.set(artistId, { at: Date.now(), page });
    return page;
  }

  /** A related list: from v1 where it has one, from the official API for similar albums and tracks. */
  private async fetchRelated(kind: RelatedKind, rawId: string, limit: number, offset: number): Promise<FolderResult> {
    const id = encodeURIComponent(rawId);
    const window = Math.min(limit, Math.max(MAX_RELATED - offset, 0));
    if (window <= 0) return { items: [], total: MAX_RELATED };
    const v2Tracks = (doc: JsonApiDocument, r: ApiResource) => (r.type === 'tracks' ? this.mapTrack(trackFromResource(doc, r)) : null);
    switch (kind) {
      case 'artist-similar':
        return this.fetchListV1(`artists/${id}/similar`, window, offset, {}, (a) => this.mapArtist(a));
      case 'artist-radio':
        return this.fetchListV1(`artists/${id}/radio`, window, offset, {}, (t) => this.mapTrack(t));
      case 'track-radio':
        return this.fetchListV1(`tracks/${id}/radio`, window, offset, {}, (t) => this.mapTrack(t));
      // v1 has no similar albums or tracks; the official API has, and takes a v1 account's token too.
      case 'album-similar':
        return this.walkRelationship(`albums/${id}/relationships/similarAlbums`, OPENAPI_INCLUDES.similarAlbums, offset, window, (doc, r) =>
          r.type === 'albums' ? this.mapAlbum(albumFromResource(doc, r)) : null,
        );
      case 'track-similar':
        return this.walkRelationship(`tracks/${id}/relationships/similarTracks`, OPENAPI_INCLUDES.similarTracks, offset, window, v2Tracks);
    }
  }

  /** The artists TIDAL puts beside this one, for the about panel and the player's artist page. */
  public async getRelatedArtists(folderId: string, limit: number): Promise<ContentFolderItem[]> {
    const normalized = this.normalizeFolderId(folderId);
    if (normalized.type !== 'artistItem' || !normalized.id) return [];
    const { items } = await this.fetchRelated('artist-similar', normalized.id, Math.max(1, Math.min(limit, MAX_RELATED)), 0);
    return items;
  }

  /** One window of a v1 list (`limit`/`offset`, with `totalNumberOfItems`). */
  private async fetchListV1(
    path: string,
    limit: number,
    offset: number,
    params: Record<string, string>,
    map: (entry: any) => ContentFolderItem,
  ): Promise<FolderResult> {
    const url = new URL(`${TIDAL_API_BASE}/${path}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.filter(Boolean).map(map),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : offset + items.length,
    };
  }

  private async fetchAlbumTracks(
    albumId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const url = new URL(`${TIDAL_API_BASE}/albums/${encodeURIComponent(albumId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map((track: any) => this.mapTrack(track)),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (isMixId(playlistId)) return this.fetchMixTracksV1(playlistId, limit, offset);
    const url = new URL(`${TIDAL_API_BASE}/playlists/${encodeURIComponent(playlistId)}/tracks`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map((entry: any) => this.mapTrack(entry?.item ?? entry)),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }

  /**
   * A mix's tracks from v1 (`mixes/{id}/items`). A mix is not a v1 playlist; it answers its whole
   * track list at once, whatever the limit, so the window is cut here.
   */
  private async fetchMixTracksV1(mixId: string, limit: number, offset: number): Promise<FolderResult> {
    const url = new URL(`${TIDAL_API_BASE}/mixes/${encodeURIComponent(mixId)}/items`);
    url.searchParams.set('limit', String(Math.max(offset + limit, 100)));
    const data = await this.fetchJson<any>(url.toString());
    const tracks = (Array.isArray(data?.items) ? data.items : [])
      .filter((entry: any) => String(entry?.type ?? 'track').toLowerCase() === 'track' && entry?.item)
      .map((entry: any) => this.mapTrack(entry.item));
    return { items: tracks.slice(offset, offset + limit), total: tracks.length };
  }

  /** The account's favourites of one kind, newest first. */
  private fetchCollection(kind: CollectionKind, limit: number, offset: number): Promise<FolderResult> {
    return this.fetchUserListV1(`favorites/${kind}`, limit, offset, { order: 'DATE', orderDirection: 'DESC' }, (entry) =>
      this.mapV1(kind, entry?.item ?? entry),
    );
  }

  /** The playlists the account owns, most recently changed first. */
  private fetchOwnPlaylists(limit: number, offset: number): Promise<FolderResult> {
    return this.fetchUserListV1('playlists', limit, offset, {}, (playlist) => this.mapPlaylist(playlist));
  }

  /**
   * The account's mixes, as one list of playlists: on v1 the "My Mixes" page, then the daily,
   * discovery and new-release mixes the official API lists (it takes a device-flow token too).
   */
  private async fetchMixes(limit: number, offset: number): Promise<FolderResult> {
    const all: ContentFolderItem[] = [];
    const seen = new Set<string>();
    if (await this.pagesAvailable()) {
      const page = await this.fetchPage(TIDAL_MY_MIXES_PAGE);
      for (const { module } of musicModules(page)) {
        for (const entry of moduleItems(module)) {
          if (entry.kind !== 'mix' && entry.kind !== 'playlist') continue;
          const item = this.mapPageItem(entry);
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          all.push(item);
        }
      }
    }
    for (const collection of OPENAPI_MIX_COLLECTIONS) {
      const { items } = await this.walkRelationship(
        `${collection}/me/relationships/items`,
        OPENAPI_INCLUDES.mixes,
        0,
        MAX_MIXES_PER_COLLECTION,
        (doc, r) => (r.type === 'playlists' ? this.mapPlaylist(playlistFromResource(doc, r)) : null),
      );
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        all.push(item);
      }
    }
    return { items: all.slice(offset, offset + limit), total: all.length };
  }

  private mapV1(kind: CollectionKind, item: any): ContentFolderItem {
    switch (kind) {
      case 'tracks':
        return this.mapTrack(item);
      case 'albums':
        return this.mapAlbum(item);
      case 'artists':
        return this.mapArtist(item);
      case 'playlists':
        return this.mapPlaylist(item);
    }
  }

  /** v1 names the account by its numeric id, which `/sessions` says for any token. */
  private async v1UserId(): Promise<string | null> {
    if (this.v1User) return this.v1User;
    const session = await this.fetchJson<{ userId?: unknown }>(TIDAL_SESSIONS_URL);
    const id = session?.userId != null ? String(session.userId) : '';
    this.v1User = id || null;
    return this.v1User;
  }

  /** One page of `users/{id}/<path>` from v1, offset-paginated with the total alongside. */
  private async fetchUserListV1(
    path: string,
    limit: number,
    offset: number,
    params: Record<string, string>,
    map: (entry: any) => ContentFolderItem,
  ): Promise<FolderResult> {
    const userId = await this.v1UserId();
    if (!userId) return { items: [], total: 0 };
    const url = new URL(`${TIDAL_API_BASE}/users/${encodeURIComponent(userId)}/${path}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const data = await this.fetchJson<any>(url.toString());
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      items: items.map(map),
      total: typeof data?.totalNumberOfItems === 'number' ? data.totalNumberOfItems : undefined,
    };
  }

  private noteRefusal(status: number): void {
    if ((status === 401 || status === 403) && !this.refusalLogged) {
      this.refusalLogged = true;
      this.log.warn('Tidal refused the catalogue for this account; sign in again', { status, serviceId: this.serviceId });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* openapi.tidal.com/v2: similar albums and tracks, and the mix collections */
  /* ------------------------------------------------------------------------ */

  private async fetchDocument(
    path: string,
    include: readonly string[],
    params: Record<string, string> = {},
  ): Promise<JsonApiDocument | null> {
    const url = new URL(`${TIDAL_OPENAPI_BASE}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (include.length) url.searchParams.set('include', include.join(','));
    try {
      const res = await this.auth.fetch(this.serviceId, url, { headers: { Accept: JSONAPI_CONTENT_TYPE } });
      if (!res) return null;
      if (!res.ok) {
        this.noteRefusal(res.status);
        if (res.status !== 401 && res.status !== 403) {
          this.log.warn('tidal openapi request failed', { path, status: res.status });
        }
        return null;
      }
      this.refusalLogged = false;
      const body = (await res.json()) as JsonApiDocument['raw'];
      return body && 'data' in body ? new JsonApiDocument(body) : null;
    } catch (err) {
      this.log.warn('tidal openapi request failed', { path, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * One window of a cursor-paginated relationship. The API pages by cursor and folders by offset,
   * so this walks pages from the start until the window is covered (or a page cap is reached).
   */
  private async walkRelationship(
    path: string,
    include: readonly string[],
    offset: number,
    limit: number,
    map: (doc: JsonApiDocument, resource: ApiResource) => ContentFolderItem | null,
    params: Record<string, string> = {},
  ): Promise<FolderResult> {
    const collected: ContentFolderItem[] = [];
    let cursor: string | null = null;
    let more = false;
    for (let page = 0; page < MAX_OPENAPI_PAGES; page += 1) {
      const doc = await this.fetchDocument(path, include, cursor ? { ...params, 'page[cursor]': cursor } : params);
      if (!doc) break;
      for (const resource of relationshipItems(doc)) {
        const item = map(doc, resource);
        if (item) collected.push(item);
      }
      cursor = doc.nextCursor;
      more = cursor !== null;
      if (!more || collected.length >= offset + limit) break;
    }
    const items = collected.slice(offset, offset + limit);
    // The total is unknown until the last page; claim one more while there is one, so a client
    // pages on.
    return { items, total: more ? Math.max(collected.length, offset + items.length) + 1 : collected.length };
  }
}

function artistNames(artists: unknown): string {
  return (Array.isArray(artists) ? artists : [])
    .map((a) => (typeof a?.name === 'string' ? a.name : ''))
    .filter(Boolean)
    .join(', ');
}

function buildImageUrl(coverId: string | null | undefined, size = 320): string {
  if (!coverId) return '';
  const path = coverId.replace(/-/g, '/');
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
}
