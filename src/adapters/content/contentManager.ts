import {
  buildBrowsableServices,
  parseProviderAllowlist,
} from '@/adapters/content/browsableServices';
import { resizeTuneInCoverUrl, COVER_ART_NOW_PLAYING_SIZE } from '@/shared/coverArt';
import type { ConfigPort } from '@/ports/ConfigPort';
import type {
  BrowsableService,
  ContentFolder,
  ContentFolderItem,
  ContentItemMetadata,
  ContentServiceEntry,
  PlaylistEntry,
  RadioMenuEntry,
  ScanStatus,
} from '@/ports/ContentTypes';
import {
  decodeAudiopath,
  detectServiceFromAudiopath,
  metadataKeyVariants,
  parseServiceNativeAudiopath,
} from '@/domain/zones/audiopath';
import { buildBridgeRegistry, type BridgeRegistry } from '@/domain/zones/bridgeIdentity';
import {
  LocalLibraryProvider,
  type LibraryCoverSample,
  type LibraryDeleteResult,
  type LibraryStats,
} from '@/adapters/content/providers/localLibraryProvider';
import type { NotifierPort } from '@/ports/NotifierPort';
import { TuneInProvider, type TuneInProviderOptions } from '@/adapters/content/providers/tunein/tuneinProvider';
import { RadioParadiseProvider } from '@/adapters/content/providers/radioparadise/radioParadiseProvider';
import { SomaFmProvider } from '@/adapters/content/providers/somafm/somaFmProvider';
import {
  SpotifyServiceManager,
  SpotifyServiceManagerProvider,
} from '@/adapters/content/providers/spotifyServiceManager';
import { ContentCacheManager } from '@/adapters/content/utils/contentCacheManager';
import type { StorageConfig } from '@/adapters/content/storage/storageManager';
import {
  addStorage,
  deleteStorage,
  listStorages,
} from '@/adapters/content/storage/storageManager';
import { parseSearchLimits } from '@/adapters/content/utils/searchLimits';
import {
  intersectSearchCategories,
  searchCategoriesForLoxone,
} from '@/adapters/content/providerCapabilities';
import { createLogger } from '@/shared/logging/logger';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';

const AVAILABLE_SERVICES = [
  {
    cmd: 'spotify',
    config: [
      {
        name: 'Username',
        regex: '%5B%5E%3C%3E%26%25%5C%5C%2F\'%5D%7B3%2C99%7D%24', // legacy-safe regex from Loxone
        type: 'text',
      },
      {
        link: 'https://www.spotify.com/legal/end-user-agreement',
        name: 'EULA',
        type: 'eula',
      },
    ],
    helplink: 'http://www.loxone.com/help/musicserver-spotify',
    icon: 'https://extended-app-content.s3.eu-central-1.amazonaws.com/audioZone/services/Icon-Spotify.svg',
    name: 'Spotify',
    registerlink: 'https://www.spotify.com/signup',
  },
];

/**
 * A folder id that is also a service-native path — `applemusic:library-album:b64_x`,
 * `library:album:…`, `spotify:playlist:…`. Two segments at least, so a bare provider id such
 * as `album:111` is left alone: those repeat across services and would collide in a cache
 * keyed by path only.
 */
const NATIVE_PATH = /^[a-z][a-z0-9]*:[^:]+:/i;

function emptyFolder(id: string, name: string, start: number, service: string): ContentFolder {
  return { id, name, items: [], totalitems: 0, start, service };
}

export class ContentManager {
  private readonly log = createLogger('Content', 'Manager');
  private spotify: SpotifyServiceManager | null = null;
  private readonly spotifyManagerProvider: SpotifyServiceManagerProvider;
  private readonly library: LocalLibraryProvider;

  /**
   * The recorded native format of a library track, for the engine's bit-perfect decision.
   *
   * Narrow on purpose, like `waveformStore`: the playback path needs one answer about one file, not
   * the library provider.
   */
  public get sourceFormatLookup(): LocalLibraryProvider['sourceFormats']['get'] {
    return (absolutePath) => this.library.sourceFormats.get(absolutePath);
  }

  /** The library's waveform sidecar, for whoever prepares and serves them. */
  public get waveformStore(): {
    getWaveform: LocalLibraryProvider['waveforms']['get'];
    upsertWaveform: LocalLibraryProvider['waveforms']['upsert'];
    } {
    return {
      getWaveform: (path, file) => this.library.waveforms.get(path, file),
      upsertWaveform: (entry) => this.library.waveforms.upsert(entry),
    };
  }

  private tunein: TuneInProvider;
  private radioParadise: RadioParadiseProvider;
  private somaFm: SomaFmProvider;
  private readonly cache = new ContentCacheManager();
  private readonly globalSearchCache = new Map<
    string,
    {
      expiresAt: number;
      value: { result: Record<string, ContentFolderItem[]>; user: string; providerId: string };
    }
  >();

  private readonly globalSearchInflight = new Map<
    string,
    Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }>
  >();

  private readonly globalSearchTtlMs = 10_000;
  private readonly globalSearchNegativeTtlMs = 2_000;
  private readonly metadataCache = new Map<string, { expiresAt: number; value: ContentItemMetadata | null }>();
  private readonly metadataInflight = new Map<string, Promise<ContentItemMetadata | null>>();
  private readonly metadataTtlMs = 5 * 60 * 1000;
  private readonly metadataNegativeTtlMs = 30 * 1000;
  // Metadata harvested from every served folder listing, keyed per
  // metadataKeyVariants(). Lets resolveMetadata() answer favourites/recents (and
  // the now-playing path) from the listing the player just browsed instead of a
  // second browse. Bounded LRU keyed by audiopath variant; entries share the
  // metadata TTL so a stale listing eventually re-resolves live.
  private readonly metadataByAudiopath = new Map<string, { expiresAt: number; value: ContentItemMetadata }>();
  private readonly metadataByAudiopathMax = 5000;
  private initialized = false;
  private readonly configPort: ConfigPort;
  private readonly customRadioStore: CustomRadioStore;
  // Cached bridge registry (service-native <-> Loxone identity translation).
  // Rebuilt lazily and invalidated on config refresh.
  private bridgeRegistry: BridgeRegistry | null = null;

  constructor(
    notifier: NotifierPort,
    configPort: ConfigPort,
    spotifyManagerProvider: SpotifyServiceManagerProvider,
    customRadioStore: CustomRadioStore,
  ) {
    this.library = new LocalLibraryProvider(notifier, configPort);
    this.configPort = configPort;
    this.spotifyManagerProvider = spotifyManagerProvider;
    this.customRadioStore = customRadioStore;
    this.tunein = new TuneInProvider(this.customRadioStore, this.readTuneInConfig());
    this.radioParadise = new RadioParadiseProvider({ iconBaseUrl: this.readLocalIconBaseUrl() });
    this.somaFm = new SomaFmProvider();
  }

  public setNotifier(notifier: NotifierPort): void {
    this.library.setNotifier(notifier);
  }

  /**
   * Ensures the manager is wired to the persisted configuration before use.
   *
   * Reads the configuration that is already loaded rather than loading it again. A load swaps
   * the whole config object, and the zones registered just before this hold the old one: every
   * later volume change from the Miniserver then landed on a copy no zone reads, so a new
   * Vbuzzer was saved and logged and the wake-up still climbed to the old level (#392).
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const configPort = this.getConfigPort();
    try {
      configPort.getConfig();
    } catch {
      await configPort.load();
    }
    this.refreshFromConfig();
    await this.library.initialize();
    this.initialized = true;
  }

  /**
   * Forces a re-run of initialization so config/provider state can be rebuilt without
   * restarting the process.
   */
  public async reinitialize(): Promise<void> {
    this.initialized = false;
    await this.initialize();
  }

  /**
   * Rebuilds provider adapters after config changes (setconfig).
   */
  public refreshFromConfig(): void {
    this.cache.clearAll();
    this.globalSearchCache.clear();
    this.globalSearchInflight.clear();
    this.metadataCache.clear();
    this.metadataInflight.clear();
    this.metadataByAudiopath.clear();
    this.bridgeRegistry = null;
    this.spotify = this.spotifyManagerProvider.reload();
    this.tunein = new TuneInProvider(this.customRadioStore, this.readTuneInConfig());
    this.radioParadise = new RadioParadiseProvider({ iconBaseUrl: this.readLocalIconBaseUrl() });
    this.somaFm = new SomaFmProvider();
  }

  /**
   * The bridge registry for service-native ⇄ Loxone identity translation, built
   * from `content.streamingServices`. Cached until the next config refresh.
   * Callers (Loxone command intake, state/queue emit) use it with toServiceNative
   * / toLoxoneAudiopath from `@/domain/zones/bridgeIdentity`. "Bridge" here is
   * the Loxone-adapter concept; the accounts themselves are neutral.
   */
  public getBridgeRegistry(): BridgeRegistry {
    if (!this.bridgeRegistry) {
      const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
      this.bridgeRegistry = buildBridgeRegistry(bridges);
    }
    return this.bridgeRegistry;
  }

  public getAvailableServices() {
    return AVAILABLE_SERVICES;
  }

  public getServices(): ContentServiceEntry[] {
    return this.requireSpotify().listServiceEntries() as unknown as ContentServiceEntry[];
  }

  /**
   * Resolve a service provider by id (currently only spotify) for follow-state operations.
   */
  public resolveServiceProvider(service: string, user?: string) {
    if (!service && !user) {
      return null;
    }
    const spotify = this.requireSpotify();
    if (service && spotify.hasProvider(service)) {
      return spotify;
    }
    if (user && spotify.hasProvider(user)) {
      return spotify;
    }
    return null;
  }

  public getDefaultSpotifyAccountId(): string | null {
    return this.requireSpotify().getDefaultAccountId();
  }

  /**
   * The browsable service catalogue. See {@link ContentPort.listBrowsableServices}.
   *
   * Built here rather than by each caller: the DLNA server, the Subsonic API, the public API and
   * the admin screen all used to call the builder themselves and pass this manager into every
   * `browse` they got back, which is how a content-layer detail ended up in four adapter families.
   */
  public listBrowsableServices(providers?: string[] | null): BrowsableService[] {
    return buildBrowsableServices(this.configPort, this, parseProviderAllowlist(providers));
  }

  public getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const safeFolderId = folderId || 'root';
    const cacheKey = this.cache.key('media', 'local', safeFolderId, offset, limit);
    const fetcher = () =>
      this.library
        .getMediaFolder(safeFolderId, offset, limit)
        .then((folder) => this.harvestFolderMetadata(folder));
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.harvestFolderMetadata(cached);
      void this.cache.refresh(cacheKey, fetcher);
      return Promise.resolve(cached);
    }
    return this.cache.refresh(cacheKey, fetcher);
  }

  /** Radio Paradise is available unless explicitly disabled in config. */
  private isRadioParadiseEnabled(): boolean {
    return this.configPort.getConfig().content?.radio?.radioParadise?.enabled !== false;
  }

  /** SomaFM is available only once it is switched on; see {@link RadioContentConfig}. */
  private isSomaFmEnabled(): boolean {
    return this.configPort.getConfig().content?.radio?.somaFm?.enabled === true;
  }

  public async getRadios(): Promise<RadioMenuEntry[]> {
    // Radio Paradise now lives under the built-in Loxone Radio tile (the
    // `loxoneradio` service folder), so it is intentionally absent here. SomaFM has no
    // such tile to live under, so it is listed here and reached by its own name.
    const entries = await this.tunein.getMenuEntries();
    return this.isSomaFmEnabled() ? [...entries, this.somaFm.getMenuEntry()] : entries;
  }

  /** Public browse tree for the built-in Radio service. */
  public async getRadioFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    if (folderId === 'start') {
      const menu = await this.getRadios();
      const items: ContentFolderItem[] = [];
      if (this.isRadioParadiseEnabled()) {
        items.push({ id: 'radioparadise', name: 'Radio Paradise', kind: 'category' });
      }
      items.push(
        ...menu.map((entry) => ({
          id: entry.cmd === 'local' ? 'tunein' : entry.cmd,
          name: entry.name,
          kind: 'category' as const,
        })),
      );
      return {
        id: 'start',
        name: 'Radio',
        items: items.slice(offset, offset + limit),
        totalitems: items.length,
        start: offset,
      };
    }
    if (folderId === 'radioparadise') {
      return this.isRadioParadiseEnabled()
        ? this.radioParadise.getFolder('start', offset, limit)
        : null;
    }
    if (folderId === 'somafm') {
      return this.isSomaFmEnabled() ? this.somaFm.getFolder('start', offset, limit) : null;
    }
    if (folderId === 'tunein') {
      return this.tunein.getFolder('local', 'start', offset, limit);
    }
    if (folderId === 'custom') {
      return this.tunein.getFolder('custom', 'start', offset, limit);
    }
    return null;
  }

  /** Add a manually-defined custom radio stream (native `audio/cfg/radios/add`). */
  public async addCustomRadio(
    name: string,
    stream: string,
    coverurl?: string,
  ): Promise<{ id: string; name: string; stream: string }> {
    const entry = await this.customRadioStore.add({ name, stream, coverurl: coverurl || undefined });
    return { id: entry.id, name: entry.name, stream: entry.stream };
  }

  /** Remove a custom radio stream by id (native `audio/cfg/radios/del`). */
  public async removeCustomRadio(id: string): Promise<boolean> {
    return this.customRadioStore.remove(id);
  }

  public getPlaylists(
    service: string,
    user: string,
    offset: number,
    limit: number,
  ): Promise<PlaylistEntry[]> {
    if (service === 'lms') {
      return this.library.listPlaylists(offset, limit);
    }
    return this.requireSpotify().getPlaylists(service, user, offset, limit);
  }

  // -- Local playlist editing -------------------------------------------------

  public async listLocalPlaylists(
    offset: number,
    limit: number,
  ): Promise<{ items: PlaylistEntry[]; total: number }> {
    const items = await this.library.listPlaylists(offset, limit);
    const total = this.library.getPlaylistCount();
    return { items, total };
  }

  public createLocalPlaylist(name: string): PlaylistEntry {
    this.cache.clearAll();
    return this.library.createPlaylist(name);
  }

  public renameLocalPlaylist(id: number, name: string): PlaylistEntry | null {
    this.cache.clearAll();
    return this.library.renamePlaylist(id, name);
  }

  public deleteLocalPlaylist(id: number): boolean {
    this.cache.clearAll();
    return this.library.deletePlaylist(id);
  }

  public getLocalPlaylist(id: number): PlaylistEntry | null {
    return this.library.getPlaylist(id);
  }

  public async addItemsToLocalPlaylist(playlistId: number, rawId: string): Promise<number> {
    this.cache.clearAll();
    return this.library.addItemsToPlaylist(playlistId, rawId);
  }

  public removeLocalPlaylistItem(playlistId: number, position: number): boolean {
    this.cache.clearAll();
    return this.library.removePlaylistItem(playlistId, position);
  }

  public moveLocalPlaylistItem(playlistId: number, from: number, to: number): boolean {
    this.cache.clearAll();
    return this.library.movePlaylistItem(playlistId, from, to);
  }

  public getLocalPlaylistItems(
    playlistId: number,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    return this.library
      .getPlaylistItemsFolder(playlistId, offset, limit)
      .then((folder) => this.harvestFolderMetadata(folder));
  }

  public async getServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    // Always fetch Spotify podcasts live: users expect immediate updates and
    // stale cache entries can mask empty/non-empty transitions.
    if (service === 'spotify' && this.isSpotifyPodcastsFolder(folderId)) {
      this.log.debug('content cache bypass', { service, user, folderId, offset, limit });
      return this.fetchServiceFolder(service, user, folderId, offset, limit);
    }

    // cache only browse-like folders; tunein is cheap enough to skip
    // For yt-dlp-backed providers, normalize the limit for offset=0 so the Loxone app
    // (limit=20) and queue builder (limit=50) share one cache entry — avoids a second
    // yt-dlp call per play. Other providers keep exact-limit caching.
    const isYtDlpService = service === 'youtube' || service === 'ytmusic';
    const effectiveLimit = isYtDlpService && offset === 0 ? Math.max(limit, 50) : limit;
    const cacheKey = this.cache.key(service, user, folderId, offset, effectiveLimit);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.log.debug('content cache hit', { service, user, folderId, offset, limit });
      this.harvestFolderMetadata(cached);
      void this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, effectiveLimit));
      return cached;
    }
    this.log.debug('content cache miss', { service, user, folderId, offset, limit });
    return this.cache.refresh(cacheKey, () => this.fetchServiceFolder(service, user, folderId, offset, effectiveLimit));
  }

  private isSpotifyPodcastsFolder(folderId: string): boolean {
    const raw = String(folderId || '').trim().toLowerCase();
    if (!raw) {
      return false;
    }
    if (raw === '7' || raw === 'podcasts' || raw === 'podcast') {
      return true;
    }
    if (raw.includes('liked')) {
      return false;
    }
    if (raw.includes('podcasts') || raw.includes('show')) {
      return true;
    }
    return false;
  }

  private async fetchServiceFolder(
    service: string,
    user: string,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    let folder: ContentFolder | null;
    if (service === 'local' || service === 'custom') {
      folder = await this.tunein.getFolder(service, folderId, offset, limit);
    } else if (service.toLowerCase() === 'radioparadise') {
      folder = this.isRadioParadiseEnabled()
        ? await this.radioParadise.getFolder(folderId, offset, limit)
        : emptyFolder(folderId, 'Radio Paradise', offset, 'radioparadise');
    } else if (service.toLowerCase() === 'somafm') {
      folder = this.isSomaFmEnabled()
        ? await this.somaFm.getFolder(folderId === 'root' ? 'start' : folderId, offset, limit)
        : emptyFolder(folderId, 'SomaFM', offset, 'somafm');
    } else if (service.toLowerCase() === 'loxoneradio') {
      // The V17 client ships a built-in Loxone Radio tile and browses it via
      // getservicefolder/loxoneradio. Loxone's own streams are gated behind an mTLS
      // device certificate a software audioserver can't present, so we surface the
      // Radio Paradise stations here. Their audiopath stays `radioparadise:<id>`, so
      // playback and metadata resolution are unaffected by which folder listed them.
      // When Radio Paradise is disabled this returns an empty folder (the client
      // handles an empty Radio tile fine).
      folder = this.isRadioParadiseEnabled()
        ? await this.radioParadise.getFolder(folderId === 'root' ? 'start' : folderId, offset, limit)
        : emptyFolder(folderId, 'Radio', offset, 'loxoneradio');
    } else {
      folder = await this.requireSpotify().getFolder(service, user, folderId, offset, limit);
    }
    return this.harvestFolderMetadata(folder);
  }

  /**
   * Indexes every item of a served folder into the harvested-metadata cache so a
   * later resolveMetadata(<item audiopath>) is a cache hit rather than a second
   * browse. Returns the folder untouched for chaining onto fetchers.
   */
  private harvestFolderMetadata(folder: ContentFolder | null): ContentFolder | null {
    if (folder?.items?.length) {
      for (const item of folder.items) {
        this.storeHarvestedItem(item);
      }
    }
    return folder;
  }

  private storeHarvestedItem(item: ContentFolderItem): void {
    const audiopath = (item.audiopath ?? '').trim();
    // A container row (album, artist, playlist) usually carries no audiopath of its own — it
    // is addressed by its folder id. That id is a service-native path for every provider
    // that has one, so index it too: without this, favouriting a browsed album could not
    // find its own cover and artist, while the tracks inside it could.
    const folderId = (item.id ?? '').trim();
    const keyPaths = [audiopath].filter(Boolean);
    if (folderId && folderId !== audiopath && NATIVE_PATH.test(folderId)) {
      keyPaths.push(folderId);
    }
    if (keyPaths.length === 0) {
      return;
    }
    // Leave radio/stream items to the live tunein path: it sets the `station`
    // field that a harvested metadata entry can't carry.
    if (
      keyPaths.some((p) => detectServiceFromAudiopath(p) === 'radio' || /^https?:\/\//i.test(p))
    ) {
      return;
    }
    const title = (item.title || item.name || '').trim();
    // A title-less entry is useless and could mask a richer live resolve; skip it.
    if (!title) {
      return;
    }
    const value: ContentItemMetadata = {
      title,
      artist: (item.artist ?? '').trim(),
      album: (item.album ?? '').trim(),
      coverurl: item.coverurl ?? '',
      ...(item.animatedCoverUrl ? { animatedCoverUrl: item.animatedCoverUrl } : {}),
      duration: typeof item.duration === 'number' && item.duration > 0 ? Math.round(item.duration) : undefined,
    };
    const expiresAt = Date.now() + this.metadataTtlMs;
    for (const keyPath of keyPaths) {
      for (const key of metadataKeyVariants(keyPath)) {
        this.setHarvestedEntry(key, value, expiresAt);
      }
    }
  }

  private setHarvestedEntry(key: string, value: ContentItemMetadata, expiresAt: number): void {
    // Re-insert so the most-recently-harvested keys sit at the tail (LRU order).
    if (this.metadataByAudiopath.has(key)) {
      this.metadataByAudiopath.delete(key);
    }
    this.metadataByAudiopath.set(key, { value, expiresAt });
    while (this.metadataByAudiopath.size > this.metadataByAudiopathMax) {
      const oldest = this.metadataByAudiopath.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.metadataByAudiopath.delete(oldest);
    }
  }

  private lookupHarvestedMetadata(audiopath: string): ContentItemMetadata | null {
    const now = Date.now();
    for (const key of metadataKeyVariants(audiopath)) {
      const entry = this.metadataByAudiopath.get(key);
      if (!entry) {
        continue;
      }
      if (entry.expiresAt <= now) {
        this.metadataByAudiopath.delete(key);
        continue;
      }
      // LRU touch.
      this.metadataByAudiopath.delete(key);
      this.metadataByAudiopath.set(key, entry);
      return entry.value;
    }
    return null;
  }

  /**
   * The artists the provider itself puts beside this one, or nothing when it has no such notion.
   *
   * Uncached: it is asked once per artist per month behind the about cache, so a second cache in
   * front of it would only add a way for the two to disagree.
   */
  public getRelatedArtists(
    service: string,
    user: string,
    folderId: string,
    limit: number,
  ): Promise<ContentFolderItem[]> {
    return this.requireSpotify().getRelatedArtists(service, user, folderId, limit);
  }

  public getServiceTrack(
    service: string,
    user: string,
    trackId: string,
  ): Promise<ContentFolderItem | null> {
    return this.requireSpotify().getTrack(service, user, trackId);
  }

  public rescanLibrary(): Promise<void> {
    // A scan can significantly change local library folders; drop cached folder pages.
    this.cache.clearAll();
    return this.library.rescan();
  }

  /**
   * Indexes one changed path instead of rebuilding the whole library. Used when a
   * single file is added or removed (upload, WebDAV write) — see
   * {@link LocalLibraryProvider.queuePathSync}.
   */
  /**
   * Folder a loose upload belongs in based on its tags ('Artist/Album'), or ''
   * when the tags don't say. See {@link LocalLibraryProvider.resolveTagBasedSubdir}.
   */
  public resolveLibraryUploadSubdir(relPath: string): Promise<string> {
    return this.library.resolveTagBasedSubdir(relPath);
  }

  public syncLibraryPath(relPath: string): void {
    this.cache.clearAll();
    this.library.queuePathSync(relPath);
  }

  public getScanStatus(): ScanStatus {
    return this.library.getScanStatus();
  }

  public getLibraryStats(): LibraryStats | null {
    return this.library.getLibraryStats();
  }

  public getLibraryStorageStats(storageId: string): LibraryStats | null {
    return this.library.getStorageStats(storageId);
  }

  public getLibraryCoverSamples(limit: number): LibraryCoverSample[] {
    return this.library.getCoverSamples(limit);
  }

  public getLibraryStorageCoverSamples(storageId: string, limit: number): LibraryCoverSample[] {
    return this.library.getStorageCoverSamples(storageId, limit);
  }

  public deleteLibraryTrackByAudiopath(audiopath: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteTrackByAudiopath(audiopath);
  }

  public deleteLibraryAlbumByFolderId(albumId: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteAlbumByFolderId(albumId);
  }

  public deleteLibraryArtistByFolderId(artistId: string): Promise<LibraryDeleteResult> {
    this.cache.clearAll();
    return this.library.deleteArtistByFolderId(artistId);
  }

  public getGlobalSearchDescription(): Record<string, string[]> {
    const desc: Record<string, string[]> = {};
    // Which real providers sit behind the accounts the app can see. A bridge is announced
    // to Loxone as Spotify — the app knows no other streaming source — but what it can
    // actually search is the bridged provider's business, so both are tracked.
    const providerTypes = new Set<string>();
    const bridgedProviders = new Set<string>();
    let hasRealSpotify = false;
    const spotify = this.requireSpotify();
    for (const account of spotify.listAccounts()) {
      if (account.fake) {
        providerTypes.add('spotify');
        if (account.provider) {
          bridgedProviders.add(account.provider.toLowerCase());
        }
        continue;
      }
      hasRealSpotify = true;
      if (account.provider) {
        providerTypes.add(account.provider.toLowerCase());
      }
    }
    if (providerTypes.size === 0) {
      providerTypes.add('spotify');
    }

    // Read from the capability table rather than asserted. This used to hand every
    // provider Spotify's six categories, which is false for SoundCloud (no album search)
    // and badly false for YouTube/YT Music (tracks only) — so the app offered tabs that
    // could never fill.
    for (const provider of providerTypes) {
      desc[provider] = searchCategoriesForLoxone(provider);
    }
    // The `spotify` entry stands for every bridged service too, so it may only promise what
    // all of them can deliver: announcing `show` because real Spotify has podcasts would
    // put an empty tab in front of an Apple Music user. Real Spotify keeps its own set.
    if (bridgedProviders.size > 0 && !hasRealSpotify) {
      desc.spotify = intersectSearchCategories([...bridgedProviders]);
    }
    // `local` and `tunein` keep the names the Loxone app knows, which are not our provider
    // ids: it asks for `station`/`custom` on TuneIn, and calls the library `local`. The
    // categories come from the table; the naming stays the app's.
    desc.local = searchCategoriesForLoxone('library');
    desc.tunein = ['station', 'custom'];
    return desc;
  }

  public async globalSearch(
    source: string,
    query: string,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }> {
    const safeSource = String(source || '').trim();
    const safeQuery = String(query || '').trim();
    if (!safeSource || !safeQuery) {
      return { result: {}, user: 'nouser', providerId: 'unknown' };
    }

    const now = Date.now();
    const cacheKey = `${safeSource}|${safeQuery.toLowerCase()}`;
    const cached = this.globalSearchCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.globalSearchInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.globalSearchUncached(safeSource, safeQuery)
      .then((value) => {
        const hasResults = Object.keys(value.result ?? {}).length > 0;
        const ttl = hasResults ? this.globalSearchTtlMs : this.globalSearchNegativeTtlMs;
        this.globalSearchCache.set(cacheKey, { expiresAt: Date.now() + ttl, value });
        return value;
      })
      .finally(() => {
        this.globalSearchInflight.delete(cacheKey);
      });

    this.globalSearchInflight.set(cacheKey, promise);
    return promise;
  }

  private async globalSearchUncached(
    source: string,
    query: string,
  ): Promise<{ result: Record<string, ContentFolderItem[]>; user: string; providerId: string }> {
    const [providerPart = '', filterPart = ''] = source.split(':');
    const { limits } = parseSearchLimits(filterPart);
    const [providerIdRaw = '', userRaw = ''] = providerPart.split('@');
    const providerCandidate = providerPart || providerIdRaw || '';

    // Local library search
    const providerId = providerIdRaw || 'local';
    if (providerId.toLowerCase() === 'local' || providerId.toLowerCase() === 'library') {
      const result = this.library.search(query, limits);
      return { result, user: 'local', providerId: 'local' };
    }

    // TuneIn (radio) search
    const tuneinProviderId = providerIdRaw || 'tunein';
    if (tuneinProviderId.toLowerCase() === 'tunein' || tuneinProviderId.toLowerCase() === 'radio') {
      const { station, custom } = await this.tunein.search(query, {
        station: limits.station,
        custom: limits.custom,
      });
      return {
        result: { station, custom },
        user: userRaw || 'nouser',
        providerId: 'tunein',
      };
    }

    // Spotify + bridge providers (supports multiple accounts)
    const spotify = this.requireSpotify();
    if (spotify.hasProvider(providerCandidate)) {
      const { result, user, providerId } = await spotify.search(source, query);
      return { result, user, providerId };
    }

    const user = source.split('@')[1]?.split(':')[0] ?? 'nouser';
    const fallbackProviderId = providerIdRaw || providerCandidate || 'unknown';
    return { result: {}, user, providerId: fallbackProviderId };
  }

  /**
   * Describe a container by its id — what it is called, who performs it, its cover.
   *
   * Browsing a folder cannot answer this: a folder never names itself. Every
   * provider returns the literal 'Album' or 'Artist' as the folder name, because
   * the Loxone app takes the title from the parent listing and never asks. Any
   * other consumer does need to ask: a DLNA controller opening an album, or a
   * player rendering an album screen from a link, has only the id.
   *
   * Two sources, cheapest first: the harvest cache knows anything that has been
   * listed, and otherwise the folder's own first child carries the album and
   * artist it belongs to. A playlist has neither until it has been listed once —
   * naming it exactly needs a per-provider lookup, which is the next step.
   */
  public async resolveFolder(
    service: string,
    user: string,
    folderId: string,
  ): Promise<ContentFolderItem | null> {
    const id = String(folderId || '').trim();
    if (!id || id === 'root' || id === 'start') {
      return null;
    }

    if (service === 'library' && id.startsWith('library:playlist:')) {
      const playlistId = Number.parseInt(id.slice('library:playlist:'.length), 10);
      const playlist = Number.isFinite(playlistId) ? this.library.getPlaylist(playlistId) : null;
      if (!playlist) {
        return null;
      }
      return {
        id,
        name: playlist.name,
        kind: 'playlist',
        audiopath: id,
        coverurl: playlist.coverurl || undefined,
      };
    }

    if (id.includes(':')) {
      const meta = await this.resolveMetadata(id).catch(() => null);
      const name = meta?.album?.trim() || meta?.title?.trim();
      if (name) {
        return {
          id,
          name,
          // Loxone FileType for a browsable container; `kind` carries the real meaning.
          type: 7,
          kind: 'album',
          artist: meta?.artist || undefined,
          coverurl: meta?.coverurl || undefined,
        };
      }
    }

    const folder =
      service === 'library'
        ? await this.getMediaFolder(id, 0, 1).catch(() => null)
        : await this.getServiceFolder(service, user, id, 0, 1).catch(() => null);
    const first = folder?.items?.[0];
    if (!first) {
      return null;
    }
    // Tracks name the album they sit in; albums name their artist.
    const derived = first.album?.trim() || undefined;
    if (!derived && !first.artist?.trim()) {
      return null;
    }
    return {
      id,
      name: derived ?? first.artist!.trim(),
      type: 7,
      kind: derived ? 'album' : 'artist',
      artist: first.artist || undefined,
      coverurl: first.coverurl || undefined,
    };
  }

  public async resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    const raw = String(audiopath || '').trim();
    const decoded = decodeAudiopath(raw);
    const cacheKey = (decoded && decoded !== raw ? decoded : raw) || raw;
    const now = Date.now();

    const cached = this.metadataCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      // A positive memoised result wins; for a cached negative, give the harvest
      // cache a chance first — a listing may have arrived since it was recorded.
      if (cached.value) {
        return cached.value;
      }
      const harvestedAfterNegative = this.lookupHarvestedMetadata(raw);
      if (harvestedAfterNegative) {
        this.metadataCache.set(cacheKey, { value: harvestedAfterNegative, expiresAt: Date.now() + this.metadataTtlMs });
        return harvestedAfterNegative;
      }
      return null;
    }
    if (cached) {
      this.metadataCache.delete(cacheKey);
    }

    // Metadata harvested from a previously served listing answers without a
    // second browse or any per-service live lookup. Memoise the hit so repeat
    // calls short-circuit on the metadataCache fast path above.
    const harvested = this.lookupHarvestedMetadata(raw);
    if (harvested) {
      this.metadataCache.set(cacheKey, { value: harvested, expiresAt: Date.now() + this.metadataTtlMs });
      return harvested;
    }

    const inflight = this.metadataInflight.get(cacheKey);
    if (inflight) {
      return inflight;
    }

    const promise = this.resolveMetadataUncached(raw)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug('resolve metadata failed', { audiopath: raw, message: msg });
        return null;
      })
      .then((value) => {
        const ttl = value ? this.metadataTtlMs : this.metadataNegativeTtlMs;
        this.metadataCache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
        return value;
      })
      .finally(() => {
        if (this.metadataInflight.get(cacheKey) === promise) {
          this.metadataInflight.delete(cacheKey);
        }
      });

    this.metadataInflight.set(cacheKey, promise);
    return promise;
  }

  private async resolveMetadataUncached(audiopath: string): Promise<ContentItemMetadata | null> {
    const decodedPath = decodeAudiopath(audiopath);
    const detectedService = detectServiceFromAudiopath(audiopath);

    // Music Assistant bridge items: try to resolve via bridge provider (stored under spotify manager).
    if (detectedService === 'musicassistant') {
      const providerSegment = (audiopath.split(':')[0] ?? '').trim();
      const spotify = this.requireSpotify();
      const accounts = spotify.listAccounts();
      const bridgeAccount =
        accounts.find((acc) => acc.provider === 'musicassistant' && acc.id === providerSegment) ??
        accounts.find((acc) => acc.provider === 'musicassistant');
      const providerId =
        ((providerSegment && spotify.hasProvider(providerSegment) ? providerSegment : null) ??
          bridgeAccount?.id ??
          providerSegment) ||
        'musicassistant';
      const userId = providerId.split('@')[1] ?? providerSegment.split('@')[1] ?? 'musicassistant';
      const parts = audiopath.split(':');
      const maybeId = parts[parts.length - 1] ?? audiopath;
      const candidates = new Set<string>();
      if (maybeId) {
        candidates.add(maybeId);
      }
      if (decodedPath && !decodedPath.startsWith('b64_')) {
        try {
          const b64 = Buffer.from(decodedPath, 'utf-8').toString('base64');
          candidates.add(`b64_${b64}`);
        } catch {
          /* ignore */
        }
      }
      for (const trackId of candidates) {
        const track = await spotify.getTrack(providerId, userId, trackId);
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            ...(track.animatedCoverUrl ? { animatedCoverUrl: track.animatedCoverUrl } : {}),
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
      }
    }

    if (audiopath.startsWith('library:')) {
      return this.library.resolveItem(audiopath);
    }

    const httpCandidate =
      /^https?:\/\//i.test(audiopath) ? audiopath : /^https?:\/\//i.test(decodedPath) ? decodedPath : '';
    if (httpCandidate) {
      const station = await this.tunein.resolveStationByStream(httpCandidate);
      if (station) {
        return {
          title: station.name || '',
          artist: '',
          album: '',
          // The station's own cover is sized for a browse list; this one is going to be
          // shown as the now-playing art, so ask TuneIn for its larger variant.
          coverurl: station.coverurl
            ? resizeTuneInCoverUrl(station.coverurl, COVER_ART_NOW_PLAYING_SIZE)
            : '',
          station: station.name || '',
        };
      }
    }

    // One service-native lookup for every streaming provider, replacing the four
    // near-identical per-provider blocks that used to stand here.
    //
    // They all matched with `^([^:]+):track:` — a pattern that cannot see an account slug,
    // so `deezer:ab12:track:9` matched nothing and a server with two accounts of one
    // service resolved no metadata at all. `parseServiceNativeAudiopath` is the domain's
    // own parser and already knows a slug from a kind, so the rule lives in one place.
    const native =
      parseServiceNativeAudiopath(audiopath) ?? parseServiceNativeAudiopath(decodedPath);
    if (native && native.kind === 'track') {
      // Name the account when the path carries one: the provider registry refuses to guess
      // between several accounts of a service rather than answer from the wrong library.
      const service = native.slug ? `${native.service}:${native.slug}` : native.service;
      if (this.requireSpotify().hasProvider(service)) {
        const trackRef = `${native.isLibrary ? 'library-' : ''}track:${native.id}`;
        // The id goes over raw: each provider decodes its own `b64_` form in getTrack().
        const track = await this.getServiceTrack(service, native.slug ?? '', trackRef);
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            ...(track.animatedCoverUrl ? { animatedCoverUrl: track.animatedCoverUrl } : {}),
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
        this.log.debug('service-native metadata unresolved', { audiopath, service, trackRef });
      }
    }

    // The Loxone disguise (`spotify@<account>:track:…`) is not service-native — stored
    // favourites and recents still arrive in that shape, so it keeps its own path.
    const normalized = audiopath.trim();
    const trackMatch = normalized.match(/^([^:]+):track:(.+)$/i);
    if (trackMatch) {
      const providerSegment = trackMatch[1] ?? '';
      const trackId = trackMatch[2] ?? '';
      const [provider = '', user = ''] = providerSegment.split('@');
      const spotify = this.requireSpotify();
      const serviceId = spotify.hasProvider(providerSegment)
        ? providerSegment
        : provider;
      if (spotify.hasProvider(serviceId)) {
        const track = await this.getServiceTrack(serviceId, user, trackId);
        if (track) {
          return {
            title: track.title ?? track.name ?? '',
            artist: track.artist ?? '',
            album: track.album ?? '',
            coverurl: track.coverurl ?? '',
            duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
          };
        }
      }
    }

    return null;
  }

  public listStorages(): Promise<StorageConfig[]> {
    return listStorages();
  }

  public async addStorage(config: Omit<StorageConfig, 'id'> & { id?: string }): Promise<StorageConfig> {
    return addStorage(config);
  }

  public async deleteStorage(id: string): Promise<void> {
    await deleteStorage(id);
  }

  private readTuneInConfig(): TuneInProviderOptions {
    try {
      const cfg = this.getConfigPort().getConfig();
      const username = cfg.content?.radio?.tuneInUsername;
      return {
        username: typeof username === 'string' && username.trim()
          ? username.trim()
          : undefined,
      };
    } catch {
      /* ignore */
    }
    return {};
  }

  private readLocalIconBaseUrl(): string {
    try {
      const cfg = this.getConfigPort().getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
      return `http://${host}:7090/assets/icons`;
    } catch {
      return 'http://127.0.0.1:7090/assets/icons';
    }
  }

  private getConfigPort(): ConfigPort {
    return this.configPort;
  }

  private requireSpotify(): SpotifyServiceManager {
    if (!this.spotify) {
      this.spotify = this.spotifyManagerProvider.get();
    }
    return this.spotify;
  }
}

type ContentManagerDeps = {
  notifier: NotifierPort;
  configPort: ConfigPort;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  customRadioStore: CustomRadioStore;
};

export function createContentManager(deps: ContentManagerDeps): ContentManager {
  return new ContentManager(
    deps.notifier,
    deps.configPort,
    deps.spotifyManagerProvider,
    deps.customRadioStore,
  );
}
