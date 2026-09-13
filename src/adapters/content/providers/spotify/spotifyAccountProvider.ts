import type { SpotifyAccountConfig } from '@/domain/config/types';
import type { ContentItemKind } from '@/domain/media/contentKind';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentFolderSection,
  ContentServiceAccount,
  PlaylistEntry,
} from '@/ports/ContentTypes';
import type { ContentProvider, ProviderSearchResult } from '@/adapters/content/ContentProvider';
import { searchSpotifyAccount } from '@/adapters/content/providers/spotify/spotifySearch';
import { createHash } from 'node:crypto';
import { createLogger, type ComponentLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import { resolveSpotifyClientId } from '@/adapters/content/providers/spotify/utils';
import {
  fetchBrowseCategories as pfBrowseCategories,
  fetchCategoryEntries as pfCategoryEntries,
  fetchPlaylistTracks as pfPlaylistTracks,
  fetchAlbumTracks as pfAlbumTracks,
  fetchArtistTopTracks as pfArtistTopTracks,
  search as pfSearch,
  setPathfinderLocale,
  type PathfinderSession,
  type BrowseCategory,
  type MediaEntry,
} from '@/adapters/content/providers/spotify/spotifyPathfinder';
import { webPathfinderSession } from '@/adapters/content/providers/spotify/spotifyWebTokens';

/** Short, non-reversible fingerprint of a refresh token, for tracking its
 *  identity across refresh/rotation/restart in logs without leaking the token. */
function tokenFingerprint(token: string | undefined | null): string {
  if (!token) {
    return 'none';
  }
  return createHash('sha1').update(token).digest('hex').slice(0, 8);
}

const enum FileType {
  Folder = 1,
  File = 2,
  PlaylistBrowsable = 7,
}

/**
 * Decode a pathfinder browse URI from a category folder id. Pathfinder
 * categories store their `spotify:page:...` URI base64url-encoded (see
 * mapBrowseCategory); legacy/hardcoded category ids decode to non-URIs and
 * return null (those fallback categories have no drillable contents).
 */
function decodeBrowseUri(categoryId: string): string | null {
  try {
    const decoded = Buffer.from(categoryId, 'base64url').toString('utf8');
    return decoded.startsWith('spotify:') ? decoded : null;
  } catch {
    return null;
  }
}

/** Search result types pathfinder (searchDesktop) covers; podcasts go via Web API. */
const PATHFINDER_SEARCH_TYPES = new Set(['track', 'album', 'artist', 'playlist']);

/**
 * The sections this account can publish, each addressed by its own name.
 *
 * The Loxone app asks for these by an index into its own enum instead; that
 * mapping lives in the Loxone adapter (`loxoneServiceFolders`), so the order here
 * is presentation only and a section may be added without a slot to give it.
 *
 * "Can" rather than "does": this is the full menu, and `buildRootFolder` publishes
 * the subset the account can actually fill right now.
 */
const SPOTIFY_ROOT_FOLDERS: ReadonlyArray<{
  type: 'popular' | 'new' | 'genres' | 'playlists' | 'liked' | 'albums' | 'artists' | 'podcasts';
  name: string;
}> = [
  { type: 'popular', name: 'Popular Playlists' },
  { type: 'new', name: 'New Releases' },
  { type: 'genres', name: 'Genres & Moods' },
  { type: 'playlists', name: 'My Playlists' },
  { type: 'liked', name: 'Liked Songs' },
  { type: 'albums', name: 'Albums' },
  { type: 'artists', name: 'Artists' },
  { type: 'podcasts', name: 'Podcasts' },
];

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_HTTP_TIMEOUT_MS = 10_000;
/** Every paged Web API endpoint caps `limit` at 50 and answers 400 "Invalid limit" above it. */
const SPOTIFY_PAGE_MAX = 50;
/** Spotify's stable "Music" browse hub: the source for "Popular Playlists" (the
 *  Features section). Its editorial playlists (New Music Friday NL, Hot Hits NL,
 *  …) match what the real audioserver shows there. */
const SPOTIFY_POPULAR_BROWSE_URI = 'spotify:page:0JQ5DAqbMKFSi39LMRT0Cy';

/** Spotify's stable "New Releases" browse page: editorial new-release albums,
 *  matching the real audioserver's "New Releases" section. */
const SPOTIFY_NEW_RELEASES_BROWSE_URI = 'spotify:page:0JQ5DAqbMKFz6FAsUtgAab';

/** Map a Spotify account country to an Accept-Language locale so pathfinder
 *  localizes content names (e.g. "Top 50 - Nederland"). Covers the common
 *  markets where language != country code; falls back to English. */
const COUNTRY_LOCALE: Record<string, string> = {
  NL: 'nl-NL', BE: 'nl-BE', DE: 'de-DE', AT: 'de-AT', CH: 'de-CH', FR: 'fr-FR',
  ES: 'es-ES', IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR', GB: 'en-GB', US: 'en-US',
  IE: 'en-IE', SE: 'sv-SE', NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', PL: 'pl-PL',
  CZ: 'cs-CZ', GR: 'el-GR', HU: 'hu-HU', RO: 'ro-RO', TR: 'tr-TR', MX: 'es-MX',
};
function localeForCountry(country: string | undefined): string {
  const cc = (country || '').trim().toUpperCase();
  return COUNTRY_LOCALE[cc] ?? 'en';
}

export interface SpotifyAccountState extends SpotifyAccountConfig {
  id: string;
  refreshToken?: string;
}

export interface SpotifyConnectDevice {
  id: string;
  name: string;
  type?: string;
  isActive?: boolean;
  isPrivateSession?: boolean;
  isRestricted?: boolean;
  supportsVolume?: boolean;
  volumePercent?: number;
}

export type PersistAccountCallback = (
  accountId: string,
  patch: Partial<SpotifyAccountConfig>,
) => Promise<SpotifyAccountConfig | null>;

export type CredentialLoginCallback = (
  accountId: string,
  creds: { username: string; credentials: string },
) => Promise<void>;

export interface SpotifyAccountProviderOptions {
  providerId: string;
  account: SpotifyAccountState;
  clientId?: string;
  persistAccount: PersistAccountCallback;
  /**
   * Service-native audiopath prefix for the items this provider emits, e.g.
   * `applemusic:p0gngd` or (single-account) `applemusic`. Bridge providers set
   * this so browse/track ids are service-native (`applemusic:p0gngd:track:X`)
   * instead of the Loxone-disguised `spotify@bridge-...` form. When absent (real
   * Spotify accounts), makeUri falls back to `providerId` — unchanged behaviour.
   */
  serviceNativePrefix?: string;
}

interface SpotifyApiResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
}

/**
 * Wraps Spotify API operations for a single configured account.
 */
/** The kinds Spotify exposes a follow state for; see {@link SpotifyAccountProvider.followable}. */
const FOLLOWABLE_KINDS = new Set<ContentItemKind>(['album', 'artist', 'playlist', 'show']);

export class SpotifyAccountProvider implements ContentProvider {
  public readonly providerId: string;
  /** Service-native audiopath prefix; see SpotifyAccountProviderOptions. */
  protected readonly audiopathPrefix: string;

  private readonly log: ComponentLogger;
  private readonly persistAccountState: PersistAccountCallback;
  private readonly clientId: string;

  private account: SpotifyAccountState;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private authError = false;
  private refreshPromise: Promise<string | null> | null = null;
  // Stable identity for the pathfinder token cache; see getPathfinderSession.
  private pathfinderSession: PathfinderSession | null = null;

  constructor(options: SpotifyAccountProviderOptions) {
    this.providerId = options.providerId;
    // Emit service-native ids when a bridge prefix is supplied; real Spotify
    // accounts fall back to providerId (spotify@<account>) — unchanged.
    this.audiopathPrefix = options.serviceNativePrefix ?? options.providerId;
    this.account = { ...options.account };
    this.persistAccountState = options.persistAccount;
    this.clientId = resolveSpotifyClientId({ clientId: this.account.clientId ?? options.clientId });
    this.log = createLogger('Content', `Spotify:${this.account.id}`);
  }

  public get accountId(): string {
    return this.account.id;
  }

  public get displayLabel(): string {
    return (
      this.account.displayName ||
      this.account.user ||
      this.account.name ||
      this.account.email ||
      this.account.id
    );
  }

  public get serviceId(): string {
    return this.providerId;
  }

  public get hasAuthError(): boolean {
    return this.authError;
  }

  /**
   * Whether a row of this kind should offer a follow control.
   *
   * Mirrors what `SpotifyServiceManager.getFollowState` can actually answer: album, artist,
   * playlist and show, and only for a real Spotify account — the bridged services piggy-backing
   * on this class (Apple Music and friends, via `FakeSpotifyAccountProvider`) are skipped there
   * by the same `fake` flag, so they must not advertise the control either.
   *
   * One rule rather than a literal per mapper. The same album used to come back as browsable
   * from search and followable from the library, so whether the app drew a follow button
   * depended on where you had found the record.
   */
  public followable(kind: ContentItemKind): boolean {
    return FOLLOWABLE_KINDS.has(kind) && !this.getServiceAccount().fake;
  }

  public getServiceAccount(): ContentServiceAccount {
    return {
      id: this.serviceId,
      label: this.displayLabel,
      provider: 'spotify',
      product: this.account.product,
    };
  }

  /**
   * List Spotify Connect devices visible to this account.
   */
  public async listConnectDevices(): Promise<SpotifyConnectDevice[]> {
    const payload = await this.request<{ devices?: any[] }>(`${SPOTIFY_API_BASE}/me/player/devices`);
    const devices = Array.isArray(payload?.devices) ? payload?.devices ?? [] : [];
    return devices
      .map((entry) => this.mapConnectDevice(entry))
      .filter((device): device is SpotifyConnectDevice => !!device);
  }

  public updateAccount(newState: SpotifyAccountConfig): void {
    this.account = { ...this.account, ...newState } as SpotifyAccountState;
  }

  /** Current refresh token (possibly rotated in-memory). Used to decide whether
   *  a manager reload can reuse this provider instead of recreating it. */
  public get configuredRefreshToken(): string | undefined {
    return (
      this.account.refreshToken?.trim() ||
      (this.account as { refresh_token?: string }).refresh_token?.toString().trim() ||
      undefined
    );
  }

  /**
   * Resolve a single track by id.
   */
  public async getTrack(trackId: string): Promise<ContentFolderItem | null> {
    const id = (trackId || '').trim();
    if (!id) {
      return null;
    }
    const data = await this.request<any>(`${SPOTIFY_API_BASE}/tracks/${encodeURIComponent(id)}`);
    if (!data) {
      return null;
    }
    return this.mapTrack(data);
  }

  private get userKey(): string {
    return this.account.user || this.account.displayName || this.account.name || this.account.id;
  }

  protected makeUri(type: string, id: string): string {
    // Service-native prefix for bridge providers (applemusic:slug:...), else the
    // provider id for real Spotify (spotify@account:...). No double user segment.
    return `${this.audiopathPrefix}:${type}:${id}`;
  }

  public async getPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]> {
    const rawItems = await this.fetchUserPlaylists(offset, limit);
    return rawItems.items.map((item) => ({
      id: item.id,
      name: item.name,
      tracks: item.items ?? 0,
      audiopath: item.audiopath ?? item.id,
      coverurl: item.coverurl,
    }));
  }

  public async getFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);

    switch (normalized.type) {
      case 'root':
        return this.buildRootFolder(offset);
      case 'playlists':
        return this.buildFolder(
          folderId,
          'My Playlists',
          await this.fetchUserPlaylists(offset, limit),
          offset,
        );
      case 'albums':
        return this.buildFolder(
          folderId,
          'Albums',
          await this.fetchUserAlbums(offset, limit),
          offset,
        );
      case 'artists':
        return this.buildFolder(
          folderId,
          'Artists',
          await this.fetchUserArtists(limit || 20),
          offset,
        );
      case 'liked':
        return this.buildFolder(
          folderId,
          'Liked Songs',
          await this.fetchLikedSongs(offset, limit || 50),
          offset,
        );
      case 'podcasts':
        return this.buildFolder(
          folderId,
          'Podcasts',
          await this.fetchUserPodcasts(offset, limit || 20),
          offset,
        );
      case 'popular': {
        // Popular Playlists = the editorial playlists from Spotify's Music browse
        // hub (New Music Friday NL, Hot Hits NL, …) — matches the real audioserver.
        const session = await this.getPathfinderSession();
        const playlists = (await pfCategoryEntries(session, SPOTIFY_POPULAR_BROWSE_URI)).filter(
          (e) => e.kind === 'playlist',
        );
        if (playlists.length) {
          const safeOffset = Math.max(0, offset || 0);
          const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
          const sliced = playlists.slice(safeOffset, safeOffset + safeLimit);
          return this.buildFolder(
            folderId,
            'Popular Playlists',
            { items: sliced.map((e) => this.mapMediaEntry(e)), total: playlists.length },
            offset,
          );
        }
        return this.buildFolder(folderId, 'Popular Playlists', { items: [], total: 0 }, offset);
      }
      case 'new': {
        // Editorial new-release albums via the New Releases browse page.
        const session = await this.getPathfinderSession();
        const albums = (await pfCategoryEntries(session, SPOTIFY_NEW_RELEASES_BROWSE_URI)).filter(
          (e) => e.kind === 'album',
        );
        if (albums.length) {
          const safeOffset = Math.max(0, offset || 0);
          const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
          const sliced = albums.slice(safeOffset, safeOffset + safeLimit);
          return this.buildFolder(
            folderId,
            'New Releases',
            { items: sliced.map((e) => this.mapMediaEntry(e)), total: albums.length },
            offset,
          );
        }
        // Web API fallback. Unlike the rest of `/browse` — featured-playlists and the
        // per-category playlist listings both answer 404 — new-releases is alive and
        // localises to the account's country, so this section does not have to depend on the
        // scraped tokens holding up.
        return this.buildFolder(
          folderId,
          'New Releases',
          await this.fetchNewReleases(offset, limit || 20),
          offset,
        );
      }
      case 'genres':
        return this.buildFolder(
          folderId,
          'Genres & Moods',
          await this.fetchBrowseCategories(offset, limit || 20),
          offset,
        );
      case 'category':
        return this.buildFolder(
          folderId,
          'Category',
          await this.fetchCategoryPlaylists(normalized.id, offset, limit || 20),
          offset,
        );
      case 'playlistItem':
        return this.buildFolder(
          folderId,
          'Playlist',
          await this.fetchPlaylistTracks(normalized.id, offset, limit || 50),
          offset,
        );
      case 'albumItem':
        return this.buildFolder(
          folderId,
          'Album',
          await this.fetchAlbumTracks(normalized.id, offset, limit || 50),
          offset,
        );
      case 'artistItem':
        return this.buildFolder(
          folderId,
          'Artist',
          await this.fetchArtistContent(normalized.id, limit || 20),
          offset,
        );
      case 'showItem':
        return this.buildFolder(
          folderId,
          'Podcast',
          await this.fetchShowEpisodes(normalized.id, offset, limit || 50),
          offset,
        );
      default:
        return {
          id: folderId,
          name: 'Spotify',
          start: offset,
          totalitems: 0,
          items: [],
        };
    }
  }

  /**
   * The root listing, with the sections this account cannot currently fill left out.
   *
   * It used to publish all eight unconditionally, which is how a working account ended up
   * with five tiles that opened onto nothing: everything editorial (Popular Playlists,
   * Genres & Moods and the drill-in under it) is reachable only over pathfinder, and back then
   * pathfinder needed a librespot session token that stale credentials could not mint. Podcasts
   * is the same shape of problem for a different reason — most accounts simply have none.
   *
   * A tile that opens empty costs the user a tap and tells them nothing, so the root asks
   * first. The sections come back on their own once tokens can be had again.
   */
  private async buildRootFolder(offset: number): Promise<ContentFolder> {
    const hasToken = Boolean(this.account.refreshToken?.trim());
    if (!hasToken) {
      return {
        id: 'root',
        name: this.displayLabel,
        service: 'spotify',
        start: offset,
        totalitems: 1,
        items: [
          this.folderLink('error', 'Please remove and re-add this account'),
        ],
      };
    }
    const [editorial, podcasts] = await Promise.all([
      this.canOfferEditorial(),
      this.hasPodcastContent(),
    ]);
    const available = SPOTIFY_ROOT_FOLDERS.filter((folder) => {
      if (folder.type === 'popular' || folder.type === 'genres') {
        return editorial;
      }
      if (folder.type === 'podcasts') {
        return podcasts;
      }
      return true;
    });
    return {
      id: 'root',
      name: this.displayLabel,
      service: 'spotify',
      start: offset,
      totalitems: available.length,
      items: available.map((folder) => this.folderLink(folder.type, folder.name)),
    };
  }

  /**
   * Whether the editorial sections can be served at all — i.e. whether pathfinder tokens can be
   * had from either source.
   *
   * This used to ask whether librespot had a session, which is why a stale login emptied
   * Popular Playlists and Genres & Moods. Now that the scraped web tokens stand behind it the
   * answer is normally yes, so those sections stop disappearing; it stays a real check rather
   * than a constant because it is what notices Spotify changing the embed page out from under
   * the scrape. Cheap after the first call: both token layers cache.
   */
  private async canOfferEditorial(): Promise<boolean> {
    try {
      const session = await this.getPathfinderSession();
      await session.getTokens();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this account has any podcast content — saved episodes or followed shows.
   *
   * Two `limit=1` requests, and only their totals are read. The root listing is cached by the
   * content layer, so this is not paid per browse.
   */
  private async hasPodcastContent(): Promise<boolean> {
    // `null` means the question could not be asked (no token, upstream error) as opposed to
    // answered with nothing — and only a real zero should hide the section. Otherwise a
    // failed refresh would delete Podcasts from an account that has plenty.
    const probe = async (path: string): Promise<number | null> => {
      const data = await this.request<{ total?: number; items?: unknown[] }>(
        `${SPOTIFY_API_BASE}/${path}`,
        { params: { limit: '1', offset: '0' }, suppressWarn: true },
      );
      if (!data) {
        return null;
      }
      return data.total ?? data.items?.length ?? 0;
    };
    try {
      const counts = await Promise.all([probe('me/episodes'), probe('me/shows')]);
      if (counts.some((count) => count === null)) {
        return true;
      }
      return counts.some((count) => (count ?? 0) > 0);
    } catch {
      return true;
    }
  }

  private folderLink(id: string, name: string): ContentFolderItem {
    return {
      id,
      name,
      type: FileType.Folder,
      items: 0,
    };
  }

  private buildFolder(
    id: string,
    name: string,
    result: { items: ContentFolderItem[]; total?: number; sections?: ContentFolderSection[] },
    offset: number,
  ): ContentFolder {
    return {
      id,
      name,
      service: 'spotify',
      start: offset,
      totalitems: typeof result.total === 'number' ? result.total : result.items.length,
      items: result.items,
      ...(result.sections?.length ? { sections: result.sections } : {}),
    };
  }

  private normalizeFolderId(folderId: string):
    | { type: 'root' }
    | { type: 'playlists' }
    | { type: 'albums' }
    | { type: 'artists' }
    | { type: 'liked' }
    | { type: 'podcasts' }
    | { type: 'popular' }
    | { type: 'new' }
    | { type: 'genres' }
    | { type: 'category'; id: string }
    | { type: 'playlistItem'; id: string }
    | { type: 'albumItem'; id: string }
    | { type: 'artistItem'; id: string }
    | { type: 'showItem'; id: string }
    | { type: 'unknown' } {
    const raw = this.stripProviderPrefix(folderId || 'root');
    const key = raw.toLowerCase();
    const parts = raw.split(':');
    const tail = parts[parts.length - 1] ?? '';

    if (key === 'root' || key === 'start') {
      return { type: 'root' };
    }
    if (key.startsWith('playlist:') || key.startsWith('spotify:playlist:')) {
      return { type: 'playlistItem', id: tail };
    }
    if (key.startsWith('album:') || key.startsWith('spotify:album:')) {
      return { type: 'albumItem', id: tail };
    }
    if (key.startsWith('artist:') || key.startsWith('spotify:artist:')) {
      return { type: 'artistItem', id: tail };
    }
    if (key.startsWith('show:') || key.startsWith('spotify:show:')) {
      return { type: 'showItem', id: tail };
    }
    if (key.startsWith('category:') || key.startsWith('spotify:category:')) {
      return { type: 'category', id: tail };
    }
    if (key === 'playlist' || key === 'playlists') {
      return { type: 'playlists' };
    }
    if (key === 'album' || key === 'albums') {
      return { type: 'albums' };
    }
    if (key === 'artist' || key === 'artists') {
      return { type: 'artists' };
    }
    if (key === 'liked' || key.includes('liked-songs') || key.includes('favorites') || key === 'user:collection') {
      return { type: 'liked' };
    }
    if (key === 'podcasts' || key === 'podcast' || key.includes('shows')) {
      return { type: 'podcasts' };
    }
    if (
      key === 'popular' ||
      key.includes('popular-playlists') ||
      key.includes('recommend') ||
      key.includes('aanbevel')
    ) {
      return { type: 'popular' };
    }
    if (key === 'new' || key.includes('new-releases')) {
      return { type: 'new' };
    }
    if (key === 'genres' || key.includes('genres-moods')) {
      return { type: 'genres' };
    }
    return { type: 'unknown' };
  }

  private stripProviderPrefix(value: string): string {
    const raw = value || '';
    const lower = raw.toLowerCase();
    const providerLower = this.providerId.toLowerCase();

    const stripDirect = `${providerLower}:`;
    if (lower.startsWith(stripDirect)) {
      return raw.slice(stripDirect.length);
    }

    const stripWithUser = `${providerLower}@`;
    if (lower.startsWith(stripWithUser)) {
      const firstColon = raw.indexOf(':', stripWithUser.length);
      return firstColon >= 0 ? raw.slice(firstColon + 1) : raw.slice(stripWithUser.length);
    }

    const userKey = (this.userKey || '').trim();
    if (userKey) {
      const userLower = userKey.toLowerCase();
      const userPrefix = `${userLower}:`;
      if (lower.startsWith(userPrefix)) {
        return raw.slice(userPrefix.length);
      }

      const userPrefixAt = `${userLower}@`;
      if (lower.startsWith(userPrefixAt)) {
        const firstColon = raw.indexOf(':', userPrefixAt.length);
        return firstColon >= 0 ? raw.slice(firstColon + 1) : raw.slice(userPrefixAt.length);
      }

      if (raw.startsWith('@')) {
        const trimmed = raw.slice(1);
        const trimmedLower = trimmed.toLowerCase();
        if (trimmedLower.startsWith(userPrefix)) {
          return trimmed.slice(userPrefix.length);
        }
        if (trimmedLower.startsWith(userPrefixAt)) {
          const firstColon = trimmed.indexOf(':', userPrefixAt.length);
          return firstColon >= 0
            ? trimmed.slice(firstColon + 1)
            : trimmed.slice(userPrefixAt.length);
        }
        return trimmed;
      }
    }

    return raw;
  }

  /**
   * Read `limit` entries from a paged Web API endpoint, in pages Spotify accepts.
   * A browser window wider than 50 rows (the Loxone client asks for 120) becomes
   * several 50-item requests instead of one that Spotify rejects with 400.
   */
  private async fetchPaged(
    url: string,
    offset: number,
    limit: number,
    fallbackLimit: number,
    options?: { suppressWarn?: boolean },
  ): Promise<{ items: any[]; total?: number }> {
    const safeOffset = Math.max(0, offset || 0);
    const safeLimit = Math.max(1, limit || fallbackLimit);
    const collected: any[] = [];
    let total: number | undefined;
    let fetched = 0;

    while (fetched < safeLimit) {
      const pageLimit = Math.min(SPOTIFY_PAGE_MAX, safeLimit - fetched);
      const data = await this.request<{ items?: any[]; total?: number }>(url, {
        params: { offset: String(safeOffset + fetched), limit: String(pageLimit) },
        suppressWarn: options?.suppressWarn,
      });
      if (total === undefined && typeof data?.total === 'number') {
        total = data.total;
      }
      const items = Array.isArray(data?.items) ? data!.items : [];
      if (items.length === 0) {
        break;
      }
      collected.push(...items);
      fetched += items.length;
      if (items.length < pageLimit) {
        break;
      }
    }

    return { items: collected, total };
  }

  private async fetchUserPlaylists(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.fetchPaged(`${SPOTIFY_API_BASE}/me/playlists`, offset, limit, 20);

    const items = data.items;
    const visible = items.filter((pl) => {
      const playlistId = typeof pl?.id === 'string' ? pl.id.trim() : '';
      return Boolean(playlistId);
    });
    return { items: visible.map((pl) => this.mapPlaylist(pl)), total: data.total ?? visible.length };
  }

  private async fetchPlaylistTracks(
    playlistId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!playlistId) {
      return { items: [], total: 0 };
    }
    const safeOffset = Math.max(0, offset || 0);
    const safeLimit = Math.max(1, limit || 50);

    // Primary path: pathfinder (one call, fully hydrated). Unlike the Web API
    // (Feb 2026: only the owner's playlists return items), this works for any
    // playlist the account can see — including other users' public playlists.
    const session = await this.getPathfinderSession();
    const result = await pfPlaylistTracks(
      session,
      `spotify:playlist:${playlistId}`,
      safeOffset,
      safeLimit,
    );
    if (result) {
      return { items: result.items.map((e) => this.mapMediaEntry(e)), total: result.total };
    }

    // Fallback: Web API /items (owner-only since Feb 2026).
    const data = await this.fetchPaged(
      `${SPOTIFY_API_BASE}/playlists/${encodeURIComponent(playlistId)}/items`,
      safeOffset,
      safeLimit,
      50,
      { suppressWarn: true },
    );
    const mapped: ContentFolderItem[] = [];
    for (const entry of data.items) {
      const track = (entry as any)?.item ?? (entry as any)?.track ?? entry;
      if (track) {
        mapped.push(this.mapTrack(track));
      }
    }
    return { items: mapped, total: data.total ?? mapped.length };
  }

  private async fetchAlbumTracks(
    albumId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!albumId) {
      return { items: [], total: 0 };
    }

    // Primary path: pathfinder (tracks hydrated with album/cover/artist).
    const session = await this.getPathfinderSession();
    const result = await pfAlbumTracks(session, `spotify:album:${albumId}`, offset, limit || 50);
    if (result) {
      return { items: result.items.map((e) => this.mapMediaEntry(e)), total: result.total };
    }

    // Fallback: Web API. Fetch album metadata once to enrich track rows.
    const albumMeta = await this.request<{ name?: string; images?: any[] }>(
      `${SPOTIFY_API_BASE}/albums/${encodeURIComponent(albumId)}`,
    );

    const data = await this.fetchPaged(
      `${SPOTIFY_API_BASE}/albums/${encodeURIComponent(albumId)}/tracks`,
      offset,
      limit,
      50,
    );
    const mapped = data.items.map((track) => this.mapTrack(track, albumMeta || undefined));
    return { items: mapped, total: data.total ?? mapped.length };
  }

  private async fetchUserAlbums(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const data = await this.fetchPaged(`${SPOTIFY_API_BASE}/me/albums`, offset, limit, 20);
    const mapped = data.items
      .map((entry) => entry?.album)
      .filter(Boolean)
      .map((album) => this.mapAlbum(album, true));
    return { items: mapped, total: data.total ?? mapped.length };
  }

  private async fetchLikedSongs(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const cappedLimit = Math.min(Math.max(limit || 50, 1), 50);
    const data = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/tracks`,
      {
        params: { offset: String(Math.max(0, offset || 0)), limit: String(cappedLimit) },
        suppressWarn: true,
      },
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    const mapped = items
      .map((entry) => entry?.track)
      .filter(Boolean)
      .map((track) => this.mapTrack(track));
    return { items: mapped, total: data?.total ?? mapped.length };
  }

  private async fetchUserArtists(
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const cappedLimit = Math.min(Math.max(limit || 20, 1), 50);
    const data = await this.request<{ artists?: { items?: any[]; total?: number } }>(
      `${SPOTIFY_API_BASE}/me/following?type=artist&limit=${cappedLimit}`,
    );
    const items = Array.isArray(data?.artists?.items) ? data!.artists!.items : [];
    if (items.length) {
      const mapped = items.map((artist) => this.mapArtist(artist));
      return { items: mapped, total: data?.artists?.total ?? mapped.length };
    }

    // Dev-mode/scope fallback: derive artists from saved albums.
    const albumData = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/albums`,
      {
        params: { offset: '0', limit: String(cappedLimit) },
        suppressWarn: true,
      },
    );
    const albumEntries = Array.isArray(albumData?.items) ? albumData.items : [];
    const albumArtists = albumEntries
      .map((entry) => entry?.album?.artists)
      .flat()
      .filter(Boolean);
    const uniqueArtists = this.dedupeById(albumArtists).slice(0, cappedLimit);
    if (uniqueArtists.length) {
      this.log.debug('spotify artists fallback to saved albums', {
        count: uniqueArtists.length,
      });
      const mapped = uniqueArtists.map((artist) => this.mapArtist(artist));
      return { items: mapped, total: mapped.length };
    }

    return { items: [], total: 0 };
  }

  private async fetchUserPodcasts(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const cappedLimit = Math.min(Math.max(limit || 20, 1), 50);
    const safeOffset = Math.max(0, offset || 0);

    // Primary view: saved episodes ("Your Episodes").
    const episodes = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/episodes`,
      {
        params: { offset: String(safeOffset), limit: String(cappedLimit) },
        suppressWarn: false,
      },
    );
    const episodeItems = Array.isArray(episodes?.items) ? episodes.items : [];
    const mappedEpisodes = episodeItems
      .map((entry) => entry?.episode)
      .filter(Boolean)
      .map((episode) => this.mapEpisode(episode));
    if (mappedEpisodes.length) {
      return { items: mappedEpisodes, total: episodes?.total ?? mappedEpisodes.length };
    }

    // Secondary view: followed/saved podcast shows.
    const shows = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/me/shows`,
      {
        params: { offset: String(safeOffset), limit: String(cappedLimit) },
        suppressWarn: false,
      },
    );
    const showItems = Array.isArray(shows?.items) ? shows.items : [];
    const mappedShows = showItems
      .map((entry) => entry?.show)
      .filter(Boolean)
      .map((show) => this.mapShow(show));
    return { items: mappedShows, total: shows?.total ?? mappedShows.length };
  }

  private dedupeById(items: any[]): any[] {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      result.push(item);
    }
    return result;
  }

  /** Editorial new releases for the account's country, straight off the Web API. */
  private async fetchNewReleases(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const market = (this.account.country || '').trim().toUpperCase();
    const data = await this.request<{ albums?: { items?: any[]; total?: number } }>(
      `${SPOTIFY_API_BASE}/browse/new-releases`,
      {
        params: {
          offset: String(Math.max(0, offset || 0)),
          limit: String(Math.min(Math.max(limit || 20, 1), 50)),
          ...(market ? { country: market } : {}),
        },
        suppressWarn: true,
      },
    );
    const items = Array.isArray(data?.albums?.items) ? data.albums.items : [];
    const mapped = items.filter(Boolean).map((album) => this.mapAlbum(album));
    return { items: mapped, total: data?.albums?.total ?? mapped.length };
  }

  private async fetchBrowseCategories(
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    const safeOffset = Math.max(0, offset || 0);
    const safeLimit = Math.min(Math.max(limit || 20, 1), 50);

    // Primary path: real editorial Genres & Moods via pathfinder (browsePage).
    // The Web API browse routes are dead since Feb 2026.
    const session = await this.getPathfinderSession();
    const categories = await pfBrowseCategories(session);
    if (categories.length) {
      const sliced = categories.slice(safeOffset, safeOffset + safeLimit);
      return {
        items: sliced.map((cat) => this.mapBrowseCategory(cat)),
        total: categories.length,
      };
    }

    // No fallback on purpose. `/browse/categories` does still answer, and used to be
    // stood in for by a hardcoded list of ten genre names — but the drill-in
    // (`/browse/categories/<id>/playlists`) is 404 either way, so both roads end in a
    // category tile that opens onto nothing. A section of tiles that cannot be opened is
    // worse than no section, and `canOfferEditorial` keeps it out of the root entirely
    // while pathfinder is unavailable.
    return { items: [], total: 0 };
  }

  private async fetchCategoryPlaylists(
    categoryId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!categoryId) {
      return { items: [], total: 0 };
    }

    // Pathfinder categories carry their browse URI base64url-encoded in the id
    // (see mapBrowseCategory). When present, drill in over the protocol.
    const browseUri = decodeBrowseUri(categoryId);
    if (browseUri) {
      const session = await this.getPathfinderSession();
      const entries = await pfCategoryEntries(session, browseUri);
      if (entries.length) {
        const safeOffset = Math.max(0, offset || 0);
        const safeLimit = Math.min(Math.max(limit || 20, 1), 50);
        const sliced = entries.slice(safeOffset, safeOffset + safeLimit);
        return {
          items: sliced.map((entry) => this.mapMediaEntry(entry)),
          total: entries.length,
        };
      }
      return { items: [], total: 0 };
    }

    // Non-pathfinder category id (only the hardcoded fallback list when pathfinder
    // is unavailable): no clean way to resolve its contents, so return empty.
    return { items: [], total: 0 };
  }

  /**
   * An artist's page: their popular tracks, then their records.
   *
   * Pathfinder answers this in one call and is preferred, but it depends on tokens scraped from
   * the web player — and when that scrape stops working, that call is the only thing standing
   * between a followed artist and an empty folder. Since `Artists` lists exactly the artists the
   * user follows, that empty folder is a dead end on a tile they chose themselves,
   * so the ordinary Web API endpoints back it up: `top-tracks` and `albums` both still answer
   * with the account's refresh token, unlike the browse routes.
   *
   * Sections rather than one flat list, because "popular tracks" and "albums" are different
   * questions and a consumer that can group them should. `items` stays filled with the same
   * content in order for the consumers (the Loxone app among them) that only read that.
   */
  private async fetchArtistContent(
    artistId: string,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number; sections?: ContentFolderSection[] }> {
    if (!artistId) {
      return { items: [], total: 0 };
    }

    // Artist top tracks via pathfinder artist overview — one call for the whole page.
    const session = await this.getPathfinderSession();
    const tracks = await pfArtistTopTracks(session, `spotify:artist:${artistId}`);
    if (tracks && tracks.length) {
      return { items: tracks.map((e) => this.mapMediaEntry(e)), total: tracks.length };
    }

    const market = (this.account.country || '').trim().toUpperCase();
    const cappedLimit = Math.min(Math.max(limit || 20, 1), 50);
    const [topTracks, albums] = await Promise.all([
      this.request<{ tracks?: any[] }>(
        `${SPOTIFY_API_BASE}/artists/${encodeURIComponent(artistId)}/top-tracks`,
        { params: market ? { market } : {}, suppressWarn: true },
      ),
      this.request<{ items?: any[]; total?: number }>(
        `${SPOTIFY_API_BASE}/artists/${encodeURIComponent(artistId)}/albums`,
        {
          params: {
            limit: String(cappedLimit),
            include_groups: 'album,single',
            ...(market ? { market } : {}),
          },
          suppressWarn: true,
        },
      ),
    ]);

    const trackItems = (Array.isArray(topTracks?.tracks) ? topTracks.tracks : [])
      .filter(Boolean)
      .map((track) => this.mapTrack(track));
    // `include_groups` mixes albums and singles; Spotify returns them newest-first, which is
    // the order an artist page wants anyway.
    const albumItems = (Array.isArray(albums?.items) ? albums.items : [])
      .filter(Boolean)
      .map((album) => this.mapAlbum(album));

    const sections: ContentFolderSection[] = [];
    if (trackItems.length) {
      sections.push({ id: 'artist-top-tracks', name: 'Popular', items: trackItems });
    }
    if (albumItems.length) {
      sections.push({ id: 'artist-albums', name: 'Albums & singles', items: albumItems });
    }

    const items = [...trackItems, ...albumItems];
    return {
      items,
      total: items.length,
      ...(sections.length > 1 ? { sections } : {}),
    };
  }

  private async fetchShowEpisodes(
    showId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: ContentFolderItem[]; total?: number }> {
    if (!showId) {
      return { items: [], total: 0 };
    }
    const cappedLimit = Math.min(Math.max(limit || 50, 1), 50);
    const data = await this.request<{ items?: any[]; total?: number }>(
      `${SPOTIFY_API_BASE}/shows/${encodeURIComponent(showId)}/episodes`,
      {
        params: { offset: String(Math.max(0, offset || 0)), limit: String(cappedLimit) },
        suppressWarn: true,
      },
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    const mapped = items.map((episode) => this.mapEpisode(episode));
    return { items: mapped, total: data?.total ?? mapped.length };
  }

  /**
   * Search this account — pathfinder where it reaches, the Web API for the rest.
   *
   * The same entry point every other provider has. Which of the two answered is Spotify's
   * business, so the registry no longer needs a branch for it.
   */
  public async search(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<ProviderSearchResult> {
    return searchSpotifyAccount(this, query, limits, maxLimit);
  }

  /**
   * Multi-type search via pathfinder (track/album/artist/playlist). Returns the
   * serviceManager search shape, or null when pathfinder is unavailable (caller
   * falls back to the Web API). Shows/episodes are not covered here yet.
   */
  public async searchPathfinder(
    query: string,
    limits: Record<string, number>,
    maxLimit: number,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; totals: Record<string, number> } | null> {
    // Pathfinder search covers music types only. If shows/episodes are requested
    // — including an unfiltered all-types search — defer to the Web API, which
    // serves every type, so podcast results are not silently dropped.
    const requestedTypes = Object.keys(limits);
    const musicOnly =
      requestedTypes.length > 0 && requestedTypes.every((t) => PATHFINDER_SEARCH_TYPES.has(t));
    if (!musicOnly) {
      return null;
    }
    const session = await this.getPathfinderSession();
    const limit = Math.min(Math.max(maxLimit || 20, 1), 20);
    const sr = await pfSearch(session, query, limit);
    if (!sr) {
      return null;
    }
    const result: Record<string, ContentFolderItem[]> = {};
    const totals: Record<string, number> = {};
    const sections: Array<{ key: string; kind: 'track' | 'album' | 'artist' | 'playlist'; entries: MediaEntry[] }> = [
      { key: 'tracks', kind: 'track', entries: sr.tracks },
      { key: 'albums', kind: 'album', entries: sr.albums },
      { key: 'artists', kind: 'artist', entries: sr.artists },
      { key: 'playlists', kind: 'playlist', entries: sr.playlists },
    ];
    for (const { key, kind, entries } of sections) {
      const requested = Object.keys(limits).length === 0 || kind in limits;
      if (!requested || !entries.length) {
        continue;
      }
      const max = limits[kind] ?? maxLimit;
      result[key] = entries.slice(0, max).map((e) => this.mapSearchEntry(e));
      totals[key] = entries.length;
    }
    return { result, totals };
  }

  /** Map a pathfinder search entry to the search-result item shape (type 2/7). */
  private mapSearchEntry(entry: MediaEntry): ContentFolderItem {
    const id = entry.uri.split(':').pop() ?? '';
    const uri = this.makeUri(entry.kind, id);
    const cover = entry.cover || '';
    const base = {
      id: uri,
      name: entry.name,
      title: entry.name,
      audiopath: uri,
      coverurl: cover,
      thumbnail: cover,
      hasCover: Boolean(cover),
    };
    if (entry.kind === 'track') {
      return {
        ...base,
        artist: entry.owner ?? '',
        album: entry.album ?? '',
        duration: entry.durationSec,
        owner: entry.album || undefined,
        kind: 'track',
        tag: 'track',
      } as ContentFolderItem;
    }
    if (entry.kind === 'artist') {
      return { ...base, artist: entry.name, kind: 'artist', tag: 'artist', followable: this.followable('artist') };
    }
    if (entry.kind === 'album') {
      return { ...base, artist: entry.owner ?? '', kind: 'album', tag: 'album', followable: this.followable('album') };
    }
    return {
      ...base,
      artist: '',
      owner: entry.owner ?? '',
      kind: 'playlist',
      tag: 'playlist',
      followable: this.followable('playlist'),
    };
  }

  private mapPlaylist(playlist: any): ContentFolderItem {
    const id = String(playlist?.id ?? '');
    const cover = this.extractImage(playlist?.images);
    const totalItems = Number(playlist?.items?.total ?? playlist?.tracks?.total ?? 0);
    return {
      id: this.makeUri('playlist', id),
      name: String(playlist?.name ?? 'Playlist'),
      title: String(playlist?.name ?? 'Playlist'),
      kind: 'playlist',
      followable: this.followable('playlist'),
      items: totalItems,
      coverurl: cover,
      thumbnail: this.extractImage(playlist?.images, 1) ?? cover,
      audiopath: this.makeUri('playlist', id),
      owner: playlist?.owner?.display_name ?? playlist?.owner?.id ?? '',
      tag: 'playlist',
      followed: Boolean(playlist?.is_following),
    };
  }

  private mapAlbum(album: any, followed = false): ContentFolderItem {
    const id = String(album?.id ?? '');
    const cover = this.extractImage(album?.images);
    const owner =
      Array.isArray(album?.artists) && album.artists.length > 0
        ? album.artists.map((a: { name?: string } | null) => a?.name).filter(Boolean).join(', ')
        : '';
    return {
      id: this.makeUri('album', id),
      name: String(album?.name ?? 'Album'),
      title: String(album?.name ?? 'Album'),
      kind: 'album',
      followable: this.followable('album'),
      items: Number(album?.total_tracks ?? 0),
      coverurl: cover,
      thumbnail: this.extractImage(album?.images, 1) ?? cover,
      audiopath: this.makeUri('album', id),
      owner,
      tag: 'album',
      followed,
    };
  }

  private mapArtist(artist: any): ContentFolderItem {
    const id = String(artist?.id ?? '');
    const cover = this.extractImage(artist?.images);
    return {
      id: this.makeUri('artist', id),
      name: String(artist?.name ?? 'Artist'),
      title: String(artist?.name ?? 'Artist'),
      kind: 'artist',
      followable: this.followable('artist'),
      coverurl: cover,
      thumbnail: this.extractImage(artist?.images, 1) ?? cover,
      audiopath: this.makeUri('artist', id),
      tag: 'artist',
    };
  }

  private mapShow(show: any): ContentFolderItem {
    const id = String(show?.id ?? '');
    const cover = this.extractImage(show?.images);
    const publisher = String(show?.publisher ?? '');
    const name = String(show?.name ?? 'Podcast');
    return {
      id: this.makeUri('show', id),
      name,
      title: name,
      kind: 'show',
      followable: this.followable('show'),
      coverurl: cover,
      thumbnail: this.extractImage(show?.images, 1) ?? cover,
      audiopath: this.makeUri('show', id),
      owner: publisher,
      artist: publisher,
      tag: 'show',
    };
  }

  private mapEpisode(episode: any): ContentFolderItem {
    const id = String(episode?.id ?? '');
    const showName = String(episode?.show?.name ?? '');
    const cover =
      this.extractImage(episode?.images) ??
      this.extractImage(episode?.show?.images);
    // Undefined, never a stand-in number: a guessed length is indistinguishable from a real one and
    // the zone clock ends a track at whatever it is told (#350). Every other provider already answers
    // this way; Spotify was the only one inventing a value.
    const durationSec = Number.isFinite(episode?.duration_ms)
      ? Math.max(1, Math.round(Number(episode.duration_ms) / 1000))
      : undefined;
    const name = String(episode?.name ?? 'Episode');
    return {
      id: this.makeUri('episode', id),
      name,
      title: name,
      kind: 'episode',
      coverurl: cover,
      thumbnail:
        this.extractImage(episode?.images, 1) ??
        this.extractImage(episode?.show?.images, 1) ??
        cover,
      audiopath: this.makeUri('episode', id),
      artist: showName,
      album: showName,
      duration: durationSec,
      tag: 'episode',
    } as ContentFolderItem;
  }

  /** Map a pathfinder Genres & Moods category card to a (drillable) folder.
   *  Categories are FOLDERS (not directly playable): the Loxone app validates
   *  category items as tag "category" + type Folder and drills in on tap. */
  private mapBrowseCategory(cat: BrowseCategory): ContentFolderItem {
    const encoded = Buffer.from(cat.uri, 'utf8').toString('base64url');
    return {
      id: this.makeUri('category', encoded),
      name: cat.title,
      title: cat.title,
      type: FileType.Folder,
      coverurl: cat.cover,
      thumbnail: cat.cover,
      tag: 'category',
    };
  }

  /** Map a normalized pathfinder entry (track/playlist/album/artist) to a folder item. */
  private mapMediaEntry(entry: MediaEntry): ContentFolderItem {
    // A sub-category (e.g. inside the Podcasts/Audiobooks hubs) is a drillable
    // folder, mapped exactly like a top-level Genres & Moods card.
    if (entry.kind === 'category') {
      return this.mapBrowseCategory({ uri: entry.uri, title: entry.name, cover: entry.cover });
    }
    const id = entry.uri.split(':').pop() ?? '';
    const uri = this.makeUri(entry.kind, id);
    const base = {
      id: uri,
      name: entry.name,
      title: entry.name,
      coverurl: entry.cover,
      thumbnail: entry.cover,
      audiopath: uri,
    };
    // Tracks and podcast episodes are leaf/playable items.
    if (entry.kind === 'track' || entry.kind === 'episode') {
      return {
        ...base,
        kind: entry.kind,
        artist: entry.owner ?? '',
        album: entry.album ?? '',
        duration: entry.durationSec,
        tag: entry.kind,
      } as ContentFolderItem;
    }
    if (entry.kind === 'artist') {
      return { ...base, kind: 'artist', tag: 'artist', followable: this.followable('artist') };
    }
    // playlist / album / show: navigable containers.
    return {
      ...base,
      kind: entry.kind,
      owner: entry.owner ?? '',
      tag: entry.kind,
      followable: this.followable(entry.kind),
    };
  }

  private mapTrack(track: any, albumContext?: { name?: string; images?: any[] }): ContentFolderItem {
    const id = String(track?.id ?? track?.uri ?? '');
    const artists = Array.isArray(track?.artists)
      ? track.artists
        .map((a: { name?: unknown } | null) => (typeof a?.name === 'string' ? a.name : ''))
        .filter(Boolean)
        .join(', ')
      : '';
    const album = albumContext?.name ?? track?.album?.name ?? '';
    const coverImages = albumContext?.images ?? track?.album?.images;
    const cover = this.extractImage(coverImages);
    const durationSec = Number.isFinite(track?.duration_ms)
      ? Math.max(1, Math.round(Number(track.duration_ms) / 1000))
      : undefined;

    return {
      id: this.makeUri('track', id),
      name: String(track?.name ?? 'Track'),
      title: String(track?.name ?? 'Track'),
      kind: 'track',
      coverurl: cover,
      thumbnail: this.extractImage(coverImages, 1) ?? cover,
      audiopath: this.makeUri('track', id),
      artist: artists,
      album,
      duration: durationSec,
      tag: 'track',
    } as ContentFolderItem;
  }

  private extractImage(images: any, index = 0): string | undefined {
    if (!images) {
      return undefined;
    }
    if (Array.isArray(images) && images.length > 0) {
      const entry = images[Math.min(index, images.length - 1)];
      if (typeof entry?.url === 'string') {
        return entry.url;
      }
    }
    return undefined;
  }

  private async request<T>(
    url: string,
    options?: { params?: Record<string, string>; method?: string; body?: any; suppressWarn?: boolean },
  ): Promise<T | null> {
    const token = await this.getAccessToken();
    if (!token) {
      this.authError = true;
      this.log.warn('spotify api request skipped, no access token', { url });
      return null;
    }

    const apiUrl = new URL(url);
    if (options?.params) {
      for (const [key, value] of Object.entries(options.params)) {
        apiUrl.searchParams.set(key, value);
      }
    }

    const response = await this.rawRequest<T>(apiUrl.toString(), {
      method: options?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      body: options?.body,
    });

    if (!response.ok) {
      // Retry once on token expiry. A 403 is often a policy/mode restriction.
      if (response.status === 401) {
        this.authError = true;
        const retryToken = await this.getAccessToken();
        if (retryToken && retryToken !== token) {
          const retryResponse = await this.rawRequest<T>(apiUrl.toString(), {
            method: options?.method ?? 'GET',
            headers: {
              Authorization: `Bearer ${retryToken}`,
              Accept: 'application/json',
            },
            body: options?.body,
          });
          if (retryResponse.ok) {
            this.authError = false;
            return retryResponse.body;
          }
        }
      }
      const logFn = options?.suppressWarn ? this.log.debug.bind(this.log) : this.log.warn.bind(this.log);
      logFn('spotify api request failed', {
        url: apiUrl.toString(),
        status: response.status,
        body: response.body,
      });
      return null;
    }

    this.authError = false;
    return response.body;
  }

  private mapConnectDevice(entry: any): SpotifyConnectDevice | null {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) {
      return null;
    }
    const id = entry.id.trim();
    const name =
      (typeof entry.name === 'string' && entry.name.trim()) || id;
    return {
      id,
      name,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      isActive: entry.is_active === true,
      isPrivateSession: entry.is_private_session === true,
      isRestricted: entry.is_restricted === true,
      supportsVolume: entry.supports_volume === true,
      volumePercent:
        typeof entry.volume_percent === 'number' ? entry.volume_percent : undefined,
    };
  }

  private async rawRequest<T>(url: string, init: RequestInit): Promise<SpotifyApiResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SPOTIFY_HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const text = await safeReadText(res, '', {
          onError: 'debug',
          log: this.log,
          label: 'spotify account api read failed',
          context: { status: res.status },
        });
        return {
          ok: false,
          status: res.status,
          body: text as unknown as T | null,
        };
      }
      const data = (await res.json()) as T;
      return {
        ok: true,
        status: res.status,
        body: data,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.log.warn('spotify api timeout', { url, timeoutMs: SPOTIFY_HTTP_TIMEOUT_MS });
        return {
          ok: false,
          status: 0,
          body: null,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('spotify api error', { url, message });
      return {
        ok: false,
        status: 0,
        body: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getAccessToken(): Promise<string | null> {
    const hasValid = this.accessToken && Date.now() < this.tokenExpiresAt - 5_000;
    if (hasValid) {
      return this.accessToken!;
    }

    const refreshToken =
      this.account.refreshToken?.trim() ||
      (this.account as { refresh_token?: string }).refresh_token?.toString().trim();
    if (!refreshToken) {
      this.log.warn('no refresh token configured for spotify account');
      return null;
    }

    // Prevent multiple concurrent refresh attempts with the same token.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshAccessToken(refreshToken);
    const token = await this.refreshPromise;
    this.refreshPromise = null;
    return token;
  }

  /**
   * Public accessor for callers that need a Spotify access token (e.g. outputs).
   */
  public async fetchAccessToken(forceRefresh = false): Promise<string | null> {
    if (forceRefresh) {
      this.accessToken = '';
      this.tokenExpiresAt = 0;
    }
    return this.getAccessToken();
  }

  private async refreshAccessToken(refreshToken: string): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });

    const maxAttempts = 3;
    let delayMs = 500;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });

        if (!res.ok) {
          const text = await safeReadText(res, '', {
            onError: 'debug',
            log: this.log,
            label: 'spotify account api refresh read failed',
            context: { status: res.status },
          });
          this.log.warn('spotify token refresh failed', {
            status: res.status,
            body: text.slice(0, 200),
            attempt,
          });
          let parsedError: Record<string, unknown> = {};
          try { parsedError = JSON.parse(text); } catch { /* ignore */ }
          if (res.status === 400 && parsedError['error'] === 'invalid_grant') {
            // Do NOT wipe the stored refresh token here. Spotify rotates refresh
            // tokens on every refresh (PKCE), so a stale/duplicate use — e.g. a
            // freshly reloaded provider refreshing with a token a sibling already
            // rotated — also returns invalid_grant. Wiping on that false positive
            // destroyed the just-rotated valid token and forced a re-link on every
            // restart. Keep the token: persistAccountState propagates the rotated
            // value to this provider, so the next attempt self-heals. A genuinely
            // revoked token simply keeps failing (clear log) until a manual re-link.
            this.authError = true;
            this.log.warn('spotify token refresh rejected (invalid_grant); keeping stored token', {
              refreshTokenFp: tokenFingerprint(refreshToken),
              body: text.slice(0, 200),
              attempt,
            });
            break;
          }
          if (attempt < maxAttempts && res.status >= 500) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs *= 2;
            continue;
          }
          break;
        }

        const payload = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string } | null;
        const accessToken = typeof payload?.access_token === 'string' ? payload.access_token : '';
        const expiresIn = Number(payload?.expires_in ?? 3600);
        const rotatedRefreshToken =
          typeof payload?.refresh_token === 'string' ? payload.refresh_token : '';
        const scope = typeof payload?.scope === 'string' ? payload.scope : '';

        if (!accessToken) {
          this.log.warn('spotify token refresh response missing access_token');
          break;
        }

        this.accessToken = accessToken;
        this.tokenExpiresAt = Date.now() + expiresIn * 1000;
        this.authError = false;
        const rotated = Boolean(rotatedRefreshToken && rotatedRefreshToken !== refreshToken);
        this.log.debug('spotify token refreshed', {
          scope: scope || undefined,
          usedRefreshTokenFp: tokenFingerprint(refreshToken),
          rotated,
          newRefreshTokenFp: rotated ? tokenFingerprint(rotatedRefreshToken) : undefined,
        });

        if (rotated) {
          await this.persistAccountPatch({ refreshToken: rotatedRefreshToken });
        }

        return accessToken;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('spotify token refresh error', { message, attempt });
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
          continue;
        }
      }
    }

    // If we reach here, refresh failed. Re-use a recently valid token if we still have one.
    if (this.accessToken && Date.now() < this.tokenExpiresAt + 60_000) {
      this.log.warn('spotify refresh failed; reusing last access token temporarily', {
        expiresInMs: this.tokenExpiresAt - Date.now(),
      });
      return this.accessToken;
    }

    this.authError = true;
    return null;
  }

  private async persistAccountPatch(patch: Partial<SpotifyAccountConfig>): Promise<void> {
    const updated = await this.persistAccountState(this.account.id, patch);
    if (updated) {
      this.account = { ...this.account, ...updated } as SpotifyAccountState;
    } else {
      this.account = { ...this.account, ...patch } as SpotifyAccountState;
    }
  }

  /**
   * The session pathfinder queries run on.
   *
   * Scraped web tokens, which is all there is: the other source was a librespot session, whose
   * token was *this account* and so returned its own algorithmic shelves (Discover Weekly, Release
   * Radar, Daily Mix) where the scrape is anonymous and returns the generic editorial hub. Asking
   * librespot for it had already been switched off — the call took the whole process down from
   * inside the native addon — so the shelves were long gone before librespot itself was.
   *
   * One object per provider rather than the shared scraper itself: the pathfinder layer caches
   * minted tokens in a `WeakMap` keyed on identity, so handing every provider the same object would
   * make them share one cache entry, and a new object per call would re-mint on every query.
   */
  private async getPathfinderSession(): Promise<PathfinderSession> {
    this.pathfinderSession ??= {
      getTokens: async () => {
        // Pathfinder answers in the account's own language and market. This used to sit behind
        // opening a librespot session, which had been switched off — so the locale was in practice
        // never set at all and every account browsed in the default one.
        setPathfinderLocale(localeForCountry(this.account.country));
        return webPathfinderSession.getTokens();
      },
    };
    return this.pathfinderSession;
  }

  /** Nothing to close any more; kept so callers need not care whether a provider holds anything. */
  public dispose(): void {
    this.pathfinderSession = null;
  }
}
