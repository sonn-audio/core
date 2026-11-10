import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { LIBRARY_AUDIO_MIME_TYPES } from '@/shared/audio/libraryAudioFiles';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { BrowsableService, ContentFolder, ContentFolderItem } from '@/ports/ContentTypes';
import { decodeTrackUri } from '@/domain/media/trackIdentity';
import { resolveItemKind } from '@/domain/media/contentKind';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';
import {
  encodeContainerId,
  encodeSongId,
  musicFolderId,
  type SubsonicContainerKind,
} from '@/adapters/subsonic/subsonicIds';
import type { SubsonicNode } from '@/adapters/subsonic/subsonicResponse';

/**
 * Page size used when materialising a directory that the client cannot page.
 *
 * Kept at 50 because that is the largest page every provider accepts: Spotify
 * rejects anything above 50 on most endpoints and Apple Music above 100, and a
 * rejected page comes back as an *empty* folder rather than an error — which
 * reads as "this bridge has no content" instead of "the request was too big".
 */
const COLLECT_PAGE_SIZE = 50;

/** Default ceiling on a single materialised directory (see collectChildren). */
const DEFAULT_DIRECTORY_LIMIT = 1000;

/** How long a service's probed collection entry points stay valid. */
const ID3_PROBE_TTL_MS = 5 * 60 * 1000;

// The engine transcodes to MP3 at the configured output settings, so bitrate and
// audio attributes we advertise for a provider track describe what a client will
// actually receive rather than the provider's own encoding (which we never see).
const MP3_BITRATE_BPS = mp3BitrateToBps(audioOutputSettings.mp3Bitrate);
const MP3_BITRATE_KBPS = Math.max(1, Math.round(MP3_BITRATE_BPS / 1000));

const AUDIO_MIME: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(LIBRARY_AUDIO_MIME_TYPES).map(([ext, mime]) => [ext.slice(1), mime]),
  ),
  opus: 'audio/opus',
  wma: 'audio/x-ms-wma',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
};

/**
 * Root-child names that mark a service's collection entry points.
 *
 * Providers all name these folders the same way but decorate them differently —
 * "Albums", "My Playlists", "Your Likes", "Saved Albums" — so a possessive
 * prefix is stripped before matching the bare noun.
 */
const COLLECTION_PREFIX = /^(my|your|saved|followed|liked)\s+/i;
const ALBUM_ROOT_PATTERN = /^albums?$/i;
const ARTIST_ROOT_PATTERN = /^artists?$/i;
const PLAYLIST_ROOT_PATTERN = /^(playlists?|likes)$/i;

/** Normalise a root-child name for collection matching. */
export function collectionNoun(name: string): string {
  return name.trim().replace(COLLECTION_PREFIX, '').trim();
}

export type Id3Roots = {
  albums: string | null;
  artists: string | null;
  playlists: string | null;
};

export type CollectedChildren = {
  items: ContentFolderItem[];
  /** True when the listing hit the directory cap and is therefore incomplete. */
  truncated: boolean;
  /** Total the content layer reported, when it knew one. */
  total: number;
};

/**
 * Maps the content layer onto Subsonic's entity model.
 *
 * Subsonic offers two browse models and clients are split between them, so both
 * are served from the same source:
 *
 *   - **folder model** (`getMusicFolders` → `getIndexes` → `getMusicDirectory`):
 *     a generic recursive directory walk, which is structurally what
 *     `getServiceFolder`/`getMediaFolder` already are. Every service — local
 *     library, radio and each streaming bridge — is browsable this way.
 *   - **ID3 model** (`getArtists` → `getArtist` → `getAlbum`): needs *enumerable*
 *     artist and album sets. A streaming catalogue has none ("every artist on
 *     Tidal" is not a list), but a user's own collection does, and every bridge
 *     exposes it as named root folders. {@link id3Roots} probes for those, so the
 *     ID3 view over a bridge is its collection rather than its catalogue.
 *
 * The one real friction point is that `getMusicDirectory` has no paging in the
 * protocol — the whole directory must be in one response — while the content
 * layer is paged. {@link collectChildren} bridges that by loop-fetching up to a
 * configurable cap, and reports when it truncated.
 */
export class SubsonicCatalog {
  private readonly log = createLogger('Subsonic', 'Catalog');
  private readonly id3ProbeCache = new Map<string, { roots: Id3Roots; expiresAt: number }>();

  constructor(
    private readonly config: ConfigPort,
    private readonly contentManager: ContentManager,
  ) {}

  // ── Service catalogue ──────────────────────────────────────────────────────

  public services(): BrowsableService[] {
    const cfg = this.config.getConfig().content.subsonic;
    return this.contentManager.listBrowsableServices(cfg?.providers);
  }

  public serviceByKey(key: string): BrowsableService | undefined {
    return this.services().find((service) => service.key === key);
  }

  /** Resolve a client-supplied numeric `musicFolderId` back to its service. */
  public serviceByMusicFolderId(raw: string | null): BrowsableService | undefined {
    if (!raw || !raw.trim()) {
      return undefined;
    }
    const wanted = Number.parseInt(raw, 10);
    if (!Number.isFinite(wanted)) {
      return undefined;
    }
    return this.services().find((service) => musicFolderId(service.key) === wanted);
  }

  private directoryLimit(): number {
    const configured = this.config.getConfig().content.subsonic?.directoryLimit;
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return DEFAULT_DIRECTORY_LIMIT;
  }

  // ── Browsing ──────────────────────────────────────────────────────────────

  /** One page of a folder, straight through to the content layer. */
  public async page(
    service: BrowsableService,
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    try {
      return await service.browse(folderId, offset, limit);
    } catch (error) {
      this.log.warn('browse failed', {
        service: service.key,
        folderId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Materialise a whole directory, because `getMusicDirectory` and `getArtist`
   * have no paging in the protocol.
   *
   * A large provider container (a 5000-track playlist, a full "Liked Songs")
   * would otherwise mean dozens of upstream calls behind one client request, so
   * the walk stops at the configured cap. Truncation is reported back and logged
   * rather than passed off as a complete listing.
   */
  public async collectChildren(
    service: BrowsableService,
    folderId: string,
  ): Promise<CollectedChildren> {
    const cap = this.directoryLimit();
    const items: ContentFolderItem[] = [];
    let offset = 0;
    let total = 0;

    while (items.length < cap) {
      const remaining = cap - items.length;
      const folder = await this.page(
        service,
        folderId,
        offset,
        Math.min(COLLECT_PAGE_SIZE, remaining),
      );
      const batch = folder?.items ?? [];
      if (typeof folder?.totalitems === 'number' && folder.totalitems > total) {
        total = folder.totalitems;
      }
      if (!batch.length) {
        break;
      }
      items.push(...batch);
      offset += batch.length;
      if (total > 0 && offset >= total) {
        break;
      }
      // A provider that ignores paging returns the same page forever; a short
      // page means we reached the end.
      if (batch.length < Math.min(COLLECT_PAGE_SIZE, remaining)) {
        break;
      }
    }

    const truncated = items.length >= cap && (total === 0 || total > items.length);
    if (truncated) {
      this.log.warn('directory truncated at cap', {
        service: service.key,
        folderId,
        returned: items.length,
        total: total || 'unknown',
        cap,
      });
    }
    return { items, truncated, total: total || items.length };
  }

  /**
   * Probe a service for its collection entry points by matching the names of its
   * root children. Provider-agnostic on purpose: every bridge names these
   * folders in the same human way, and hardcoding per-provider folder ids would
   * rot the moment a provider reorders its root.
   *
   * A service without a recognisable collection (e.g. Deezer, which exposes only
   * charts) simply gets no ID3 view and stays folder-browsable.
   */
  public async id3Roots(service: BrowsableService): Promise<Id3Roots> {
    const cached = this.id3ProbeCache.get(service.key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.roots;
    }

    const roots: Id3Roots = { albums: null, artists: null, playlists: null };
    const folder = await this.page(service, service.id3Probe, 0, COLLECT_PAGE_SIZE);
    for (const item of folder?.items ?? []) {
      const noun = collectionNoun(item.name || item.title || '');
      const folderId = item.id || item.audiopath;
      if (!noun || !folderId) {
        continue;
      }
      if (!roots.albums && ALBUM_ROOT_PATTERN.test(noun)) {
        roots.albums = folderId;
      } else if (!roots.artists && ARTIST_ROOT_PATTERN.test(noun)) {
        roots.artists = folderId;
      } else if (!roots.playlists && PLAYLIST_ROOT_PATTERN.test(noun)) {
        roots.playlists = folderId;
      }
    }

    this.id3ProbeCache.set(service.key, { roots, expiresAt: now + ID3_PROBE_TTL_MS });
    this.log.debug('probed id3 roots', { service: service.key, ...roots });
    return roots;
  }

  public invalidateProbes(): void {
    this.id3ProbeCache.clear();
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Search one service. The content layer's source syntax carries per-category
   * limits, which is exactly what search2/search3 ask for, so the counts map
   * straight through.
   *
   * The separator is `#`, not `=` — `parseSearchLimits` splits `type#limit`, and
   * an `=` would make the whole entry the type name and silently fall back to
   * the default limit.
   */
  public async search(
    service: BrowsableService,
    query: string,
    limits: { artist: number; album: number; song: number },
  ): Promise<Record<string, ContentFolderItem[]>> {
    if (!service.searchSource) {
      return {};
    }
    const filters = [
      `track#${Math.max(1, limits.song)}`,
      `album#${Math.max(1, limits.album)}`,
      `artist#${Math.max(1, limits.artist)}`,
    ].join(',');
    try {
      const { result } = await this.contentManager.globalSearch(
        `${service.searchSource}:${filters}`,
        query,
      );
      return result ?? {};
    } catch (error) {
      this.log.debug('search failed', {
        service: service.key,
        message: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  // ── Entity mapping ────────────────────────────────────────────────────────

  public isTrack(item: ContentFolderItem): boolean {
    // Playable here means both: something this server can stream, and something a
    // client should list as a song rather than browse into. An album carries an
    // audiopath too — "play the whole thing" — so the kind has to agree.
    return resolveItemKind(item) === 'track' && !!item.audiopath;
  }

  /** The `<child>` shape shared by getMusicDirectory, search results and lists. */
  public child(
    item: ContentFolderItem,
    service: BrowsableService,
    parentId: string,
  ): SubsonicNode {
    return this.isTrack(item)
      ? this.song(item, parentId)
      : this.directoryChild(item, service, parentId);
  }

  public directoryChild(
    item: ContentFolderItem,
    service: BrowsableService,
    parentId: string,
    kind: SubsonicContainerKind = 'dir',
  ): SubsonicNode {
    // The child id must be what the content layer accepts back as a folderId on
    // the next browse: the listing item's `id`, NOT its audiopath — the
    // audiopath is a play target, not a browse key.
    const folderId = item.id || item.audiopath || service.rootFolderId;
    const id = encodeContainerId(kind, service.key, folderId);
    const title = item.name || item.title || 'Folder';
    return {
      id,
      parent: parentId,
      isDir: true,
      title,
      name: title,
      album: item.album || undefined,
      artist: item.artist || undefined,
      coverArt: item.coverurl || item.thumbnail ? id : undefined,
      songCount: typeof item.items === 'number' && item.items > 0 ? item.items : undefined,
    };
  }

  /**
   * A playable song. Deliberately service-agnostic: the audiopath is the track's
   * full identity, so a song id keeps resolving no matter which service surfaced
   * it — and keeps working after a rescan or a bridge being re-added.
   */
  public song(item: ContentFolderItem, parentId: string): SubsonicNode {
    const audiopath = item.audiopath ?? '';
    const id = encodeSongId(audiopath);
    const title = item.name || item.title || 'Track';
    const suffix = suffixFor(audiopath);
    const duration = normaliseDuration(item.duration);
    const local = isLocalAudiopath(audiopath);
    return {
      id,
      parent: parentId,
      isDir: false,
      title,
      album: item.album || undefined,
      artist: item.artist || undefined,
      coverArt: item.coverurl || item.thumbnail ? id : undefined,
      duration,
      // Local files stream byte-for-byte, so their real container is honest.
      // Provider tracks are transcoded by the engine, so we advertise MP3.
      suffix: local ? suffix : 'mp3',
      contentType: local ? (AUDIO_MIME[suffix] ?? 'audio/mpeg') : 'audio/mpeg',
      bitRate: local ? undefined : MP3_BITRATE_KBPS,
      // Some clients sort or group on `path`; a stable synthetic one is enough.
      path: synthPath(item, title, local ? suffix : 'mp3'),
      type: 'music',
      isVideo: false,
    };
  }

  /** The `<album>` shape for getAlbumList2 / getArtist children. */
  public album(
    item: ContentFolderItem,
    service: BrowsableService,
  ): SubsonicNode {
    const folderId = item.id || item.audiopath || service.rootFolderId;
    const id = encodeContainerId('album', service.key, folderId);
    const name = item.name || item.title || 'Album';
    return {
      id,
      name,
      title: name,
      album: name,
      artist: item.artist || service.title,
      coverArt: item.coverurl || item.thumbnail ? id : undefined,
      songCount: typeof item.items === 'number' && item.items > 0 ? item.items : 0,
      duration: 0,
      isDir: true,
      parent: encodeContainerId('dir', service.key, service.rootFolderId),
    };
  }

  /** The `<artist>` shape for getArtists / getIndexes. */
  public artist(item: ContentFolderItem, service: BrowsableService): SubsonicNode {
    const folderId = item.id || item.audiopath || service.rootFolderId;
    const id = encodeContainerId('artist', service.key, folderId);
    const name = item.name || item.title || 'Artist';
    return {
      id,
      name,
      coverArt: item.coverurl || item.thumbnail ? id : undefined,
      albumCount: typeof item.items === 'number' && item.items > 0 ? item.items : 0,
    };
  }

  /**
   * Resolve the cover art URL behind an entity id, so getCoverArt can serve the
   * bytes. Song covers come from the metadata cache; container covers need a
   * listing lookup, which is a cache hit whenever the client just browsed there.
   */
  public async coverUrlForSong(audiopath: string): Promise<string | null> {
    try {
      const meta = await this.contentManager.resolveMetadata(audiopath);
      return meta?.coverurl?.trim() || null;
    } catch {
      return null;
    }
  }

  public async coverUrlForContainer(
    service: BrowsableService,
    folderId: string,
  ): Promise<string | null> {
    // The cover of a container is not addressable directly; take the first child
    // that carries one. One page is enough and is normally already cached.
    const folder = await this.page(service, folderId, 0, 1);
    const first = folder?.items?.[0];
    const raw = first?.coverurl || first?.thumbnail;
    return raw?.trim() || null;
  }
}

function normaliseDuration(duration?: number): number | undefined {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return undefined;
  }
  return Math.round(duration);
}

function isLocalAudiopath(audiopath: string): boolean {
  const decoded = decodeTrackUri(audiopath);
  return decoded.startsWith('library://') || decoded.startsWith('alerts://');
}

function suffixFor(audiopath: string): string {
  const decoded = decodeTrackUri(audiopath);
  const withoutQuery = decoded.split('?')[0] ?? '';
  const ext = path.extname(withoutQuery).replace(/^\./, '').toLowerCase();
  return ext && AUDIO_MIME[ext] ? ext : 'mp3';
}

function synthPath(item: ContentFolderItem, title: string, suffix: string): string {
  const safe = (value: string): string => value.replace(/[/\\]/g, '_').trim() || 'Unknown';
  return `${safe(item.artist || 'Unknown Artist')}/${safe(item.album || 'Unknown Album')}/${safe(title)}.${suffix}`;
}
