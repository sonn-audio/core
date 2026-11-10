import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import * as mm from 'music-metadata';
import { Jimp, JimpMime } from 'jimp';
import { createLogger } from '@/shared/logging/logger';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';
import { bestEffort, bestEffortSync } from '@/shared/bestEffort';
import { isLibraryAudioFile, mayLackAudioStream } from '@/shared/audio/libraryAudioFiles';
import {
  COVER_ART_JPEG_QUALITY,
  COVER_ART_MAX_BYTES,
  COVER_ART_NOW_PLAYING_SIZE,
  coverArtArchiveSize,
} from '@/shared/coverArt';
import type {
  ContentFolder,
  ContentFolderItem,
  ContentItemMetadata,
  ScanStatus,
} from '@/ports/ContentTypes';
import type { SearchLimits } from '@/adapters/content/utils/searchLimits';
import { waitForMusicBrainzSlot } from '@/adapters/content/enrichment/musicBrainz';
import { ensureNasMounts, listStorages } from '@/adapters/content/storage/storageManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import {
  LocalLibraryStore,
  type AlbumRow,
  type AlbumCoverRow,
  type ArtistRow,
  type PlaylistItemRow,
  type PlaylistRow,
  type StoredTrack,
  type TrackFileRow,
  type TrackSourceFormat,
} from '@/adapters/content/providers/localLibraryStore';
import type { PlaylistEntry } from '@/ports/ContentTypes';

const FILE_TYPE_FOLDER = 1;
const FILE_TYPE_FILE = 2;
const COVER_CANDIDATES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
const ARTIST_COVER_CANDIDATES = ['artist.jpg', 'artist.jpeg', 'artist.png', 'artist.webp'];
const NAS_DIR_TIMEOUT_MS = 3000;
/** Quiet period before queued path changes are indexed, so a file copy settles first. */
const PATH_SYNC_SETTLE_MS = 1500;
const MUSICBRAINZ_ENDPOINT = 'https://musicbrainz.org/ws/2/release/';
const MUSICBRAINZ_ARTIST_ENDPOINT = 'https://musicbrainz.org/ws/2/artist/';
const WIKIDATA_CLAIMS_ENDPOINT = 'https://www.wikidata.org/w/api.php';
/** Width to request from Commons; artist tiles never need more. */
const ARTIST_ART_SIZE = 500;
/** MusicBrainz search score below which a match is treated as wrong. */
const ARTIST_ART_MIN_SCORE = 90;
/** Ceiling per scan, so a huge library can't hold the rate limiter forever. */
const ARTIST_ART_MAX_PER_SCAN = 50;
const MUSICBRAINZ_USER_AGENT = 'sonn-core/1.0 (library-cover-fallback)';
const COVER_ART_ARCHIVE_RELEASE = 'https://coverartarchive.org/release';
const ALERTS_PUBLIC_DIR = path.resolve(process.cwd(), 'public', 'alerts');
const SD_ROOT_FOLDER_ID = 'library-sd';
const SD_ALERTS_FOLDER_ID = 'library-sd-alerts';
const SD_EVENT_SOUNDS_FOLDER_ID = 'library-sd-event-sounds';

interface RescanOptions {
  silent?: boolean;
}

export interface LibraryStats {
  tracks: number;
  albums: number;
  artists: number;
}

export interface LibraryCoverSample {
  id: string;
  album: string;
  artist: string;
  coverurl: string;
}

export interface LibraryDeleteResult {
  deletedTracks: number;
  deletedFiles: number;
  missingFiles: number;
}

interface LocalTrack {
  id: string;
  relPath: string;
  storageId: string;
  title: string;
  album: string;
  artist: string;
  albumArtist?: string;
  audiopath: string;
  cover?: string | null;
  duration?: number;
}

interface SafeTags {
  title: string;
  album: string;
  artist: string;
  albumArtist: string;
  compilation: boolean;
  picture?: mm.IPicture;
  duration?: number;
  /** The file's own audio format, when the parse reported enough of it to be usable. */
  format?: TrackSourceFormat | null;
  /** Whether the parse found an audio stream; unset when the file could not be parsed at all. */
  hasAudioStream?: boolean;
}

/** `music-metadata`'s track type for an audio stream (its `TrackType.audio`, which it does not export). */
const TRACK_TYPE_AUDIO = 0x02;

/**
 * Whether a parsed file carries an audio stream.
 *
 * `format.hasAudio` cannot answer this: the MP4 parser starts it at `true` and never clears it, so a
 * video-only `.mp4` reports audio too. The per-stream list is set from the track's own handler and
 * sample description, and a reported sample rate is the same answer for parsers that list no streams.
 */
function hasAudioStream(format: mm.IAudioMetadata['format']): boolean {
  return (
    (format.trackInfo ?? []).some((track) => track.type === TRACK_TYPE_AUDIO) ||
    Boolean(format.sampleRate)
  );
}

/**
 * `music-metadata`'s format block, narrowed to what the engine can act on.
 *
 * The scan already parses every file for its tags; this reads four more fields off the same result
 * instead of discarding them. Nothing is inferred: without a rate and a channel count there is no
 * usable answer, and a depth is only reported for a lossless codec — a lossy file has no original
 * depth to preserve, and claiming one would invite a bit-perfect verdict that cannot be true.
 */
function toTrackSourceFormat(format: mm.IAudioMetadata['format']): TrackSourceFormat | null {
  const sampleRate = format.sampleRate;
  const channels = format.numberOfChannels;
  if (!sampleRate || !channels) {
    return null;
  }
  const lossless = format.lossless === true;
  const depth = format.bitsPerSample;
  return {
    codec: (format.codec ?? '').toLowerCase() || 'unknown',
    sampleRate,
    channels,
    bitDepth: lossless && (depth === 16 || depth === 24 || depth === 32) ? depth : null,
    lossless,
  };
}

type AlbumIdPayload = { storageId: string; artist: string; album: string };
type ArtistIdPayload = { storageId: string; artist: string };
type FolderIdPayload = { storageId: string; relPath: string };

/**
 * Local-library implementation backed by a lightweight on-disk database.
 * - Persists tracks/albums/artists keyed by storage id
 * - Exposes Loxone-compatible media folders
 * - Emits `rescan_event` notifications just like the real AudioServer
 */
export class LocalLibraryProvider {
  private readonly log = createLogger('Content', 'Library');
  private readonly baseDir = resolveDataDir('music');
  private readonly store = new LocalLibraryStore();

  /**
   * The waveform sidecar, exposed as the two operations a caller needs.
   *
   * Narrow on purpose: the store is this provider's own and stays that way, but a prepared waveform is
   * keyed by a file path and has nothing to do with browsing — so rather than handing out the database,
   * this hands out the two statements that touch that one table.
   */
  /**
   * What the scan recorded about a file's own audio format.
   *
   * Validated against the file on disk inside the store — a stale row answers null rather than a
   * wrong format, because a wrong one would earn a bit-perfect bypass it cannot honour.
   */
  public readonly sourceFormats = {
    get: (absolutePath: string) => {
      // The engine holds a filesystem path; the library is keyed by the path relative to its root.
      // Anything outside that root is not a library track — an alert, a stray file — and has no row.
      const relPath = path.relative(this.baseDir, absolutePath);
      if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return null;
      }
      return this.store.getSourceFormat(relPath, absolutePath);
    },
  };

  public readonly waveforms = {
    get: (path: string, file?: { size: number; mtimeMs: number }) => this.store.getWaveform(path, file),
    upsert: (entry: {
      path: string;
      buckets: Uint8Array;
      durationMs: number | null;
      file?: { size: number; mtimeMs: number };
    }) => this.store.upsertWaveform(entry),
  };

  private notifier: NotifierPort;
  private readonly configPort: ConfigPort;
  private scanStatus: ScanStatus = 0;
  private scanning = false;
  private initialized = false;
  private stats: LibraryStats | null = null;
  private readonly coverLookupCache = new Map<string, string | null>();
  private readonly artistCoverProbeCache = new Map<string, string | null>();
  /** Artists already looked up without result, so a rescan doesn't re-ask. */
  private readonly artistArtMisses = new Set<string>();
  private artistArtRunning = false;
  /** Paths awaiting an incremental index pass, coalesced by {@link queuePathSync}. */
  private readonly pendingPathSyncs = new Set<string>();
  private pathSyncTimer: NodeJS.Timeout | null = null;
  private pathSyncRunning = false;
  private onPathSyncSettled: (() => void) | null = null;

  constructor(notifier: NotifierPort, configPort: ConfigPort) {
    this.notifier = notifier;
    this.configPort = configPort;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.ensureBaseStructure({ includeNasStorages: false });
    await this.store.init();
    this.initialized = true;
    this.rescan({ silent: true }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('initial library scan failed', { message });
    });
  }

  public getScanStatus(): ScanStatus {
    return this.scanStatus;
  }

  public getLibraryStats(): LibraryStats | null {
    if (this.stats) {
      return this.stats;
    }
    // Best-effort stats read; if the store is unavailable return null.
    return bestEffortSync(
      () => {
        const stats = this.store.getStats();
        this.stats = stats;
        return stats;
      },
      { fallback: null, onError: 'debug', log: this.log, label: 'library stats read failed' },
    );
  }

  public getStorageStats(storageId: string): LibraryStats | null {
    if (!storageId) {
      return null;
    }
    // Best-effort stats read; missing storage yields null.
    return bestEffortSync(
      () => this.store.getStatsForStorage(storageId),
      {
        fallback: null,
        onError: 'debug',
        log: this.log,
        label: 'storage stats read failed',
        context: { storageId },
      },
    );
  }

  public getCoverSamples(limit = 8): LibraryCoverSample[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamples(safeLimit === 0 ? 1_000_000 : safeLimit);
        return rows.map((row) => this.mapCoverSample(row));
      },
      { fallback: [], onError: 'debug', log: this.log, label: 'cover sample read failed' },
    );
  }

  public getStorageCoverSamples(storageId: string, limit = 8): LibraryCoverSample[] {
    if (!storageId) {
      return [];
    }
    const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.round(limit)) : 8;
    // Best-effort sample read; failure yields an empty list.
    return bestEffortSync(
      () => {
        const rows = this.store.getAlbumCoverSamplesForStorage(
          storageId,
          safeLimit === 0 ? 1_000_000 : safeLimit,
        );
        return rows.map((row) => this.mapCoverSample(row));
      },
      {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'storage cover sample read failed',
        context: { storageId },
      },
    );
  }

  public async deleteTrackByAudiopath(audiopath: string): Promise<LibraryDeleteResult> {
    const safeAudiopath = String(audiopath || '').trim();
    if (!safeAudiopath) {
      throw new Error('invalid-audiopath');
    }

    const rows = this.store.getTrackFilesForAudiopath(safeAudiopath);
    if (rows.length === 0) {
      throw new Error('track-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksByAudiopath(safeAudiopath);
    this.stats = null;
    return { ...fileResult, deletedTracks };
  }

  public async deleteAlbumByFolderId(albumId: string): Promise<LibraryDeleteResult> {
    const safeId = String(albumId || '').trim();
    if (!safeId.startsWith('library:album:')) {
      throw new Error('invalid-album-id');
    }
    const payload = decodeAlbumKey(safeId.slice('library:album:'.length));
    if (!payload) {
      throw new Error('invalid-album-id');
    }

    const rows = this.store.getTrackFilesForAlbum(payload.storageId, payload.artist, payload.album);
    if (rows.length === 0) {
      throw new Error('album-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksForAlbum(payload.storageId, payload.artist, payload.album);
    this.stats = null;
    return { ...fileResult, deletedTracks };
  }

  public async deleteArtistByFolderId(artistId: string): Promise<LibraryDeleteResult> {
    const safeId = String(artistId || '').trim();
    if (!safeId.startsWith('library:artist:')) {
      throw new Error('invalid-artist-id');
    }
    const payload = decodeArtistKey(safeId.slice('library:artist:'.length));
    if (!payload) {
      throw new Error('invalid-artist-id');
    }

    const rows = this.store.getTrackFilesForArtist(payload.storageId, payload.artist);
    if (rows.length === 0) {
      throw new Error('artist-not-found');
    }

    const fileResult = await this.deleteAudioFiles(rows);
    const deletedTracks = this.store.deleteTracksForArtist(payload.storageId, payload.artist);
    this.stats = null;
    return { ...fileResult, deletedTracks };
  }

  /**
   * Triggers a full rescan of /data/music including NAS storages.
   */
  public async rescan(options: RescanOptions = {}): Promise<void> {
    if (this.scanning) {
      this.log.debug('ignoring rescan request; job already running');
      return;
    }

    this.scanning = true;
    this.stats = null;
    const silent = options.silent ?? false;
    this.updateScanStatus(1, silent);

    try {
      await this.ensureBaseStructure({ includeNasStorages: true });
      await ensureNasMounts(this.baseDir);
      await this.store.init();
      this.artistCoverProbeCache.clear();

      // Each storage is refreshed on its own. The table is deliberately NOT
      // wiped up front: an unreachable share would then lose every track it had
      // and the scan would still report success. Instead a storage that cannot
      // be read is left exactly as it was.
      await this.rescanStorage('local', 'local');

      // Best-effort storage listing; if missing, scan local only.
      const storages = await bestEffort(() => listStorages(), {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'list storages failed',
      });
      const knownStorageIds = new Set<string>(['local']);
      for (const storage of storages) {
        const storageId = String(storage.id);
        knownStorageIds.add(storageId);
        await this.rescanStorage(storageId, path.join('nas', storageId));
      }

      // A share removed from the config keeps no rows behind.
      for (const orphaned of this.store.listStorageIds()) {
        if (!knownStorageIds.has(orphaned)) {
          const dropped = this.store.deleteTracksForStorage(orphaned);
          this.log.info('dropped tracks for removed storage', { storageId: orphaned, dropped });
        }
      }

      // Album browse reads a rollup derived from `tracks`; refresh it once the
      // whole scan has settled rather than per storage.
      this.store.rebuildAlbumRollup();
      this.store.checkpoint();

      // Artist pictures come from the network at one request per second, so the
      // scan finishes and reports first; pictures appear as they arrive.
      void this.fetchMissingArtistCovers().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.debug('artist art pass failed', { message });
      });

      const stats: LibraryStats = this.store.getStats();
      this.stats = stats;
      this.log.info('library scan complete', { ...stats });
      this.updateScanStatus(2, silent, stats);
      this.updateScanStatus(2, silent, stats); // audio server emits duplicated "finished" events
      this.updateScanStatus(0, silent, stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error('library scan failed', { message });
      this.stats = null;
      this.updateScanStatus(0, silent);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Indexes a single file that appeared, changed or disappeared on disk, without
   * touching the rest of the library.
   *
   * A full {@link rescan} re-reads tags, cover art and artist art for every file;
   * fine once at boot, far too expensive per file when audio arrives one write at
   * a time. This keeps the index correct for the one path that actually changed.
   *
   * `relPath` is relative to the music dir (e.g. `local/Artist/Album/01.mp3`).
   */
  public async syncPath(relPath: string): Promise<'added' | 'updated' | 'removed' | 'ignored'> {
    const safeRel = normalizeLibraryRelPath(relPath);
    if (!safeRel || !isLibraryAudioFile(safeRel)) {
      return 'ignored';
    }

    await this.store.init();

    const storageId = resolveStorageIdFromRelPath(safeRel);
    const existing = this.store.findByStoragePath(storageId, safeRel);

    let fileStat: Stats | null = null;
    try {
      fileStat = await fsp.stat(path.join(this.baseDir, safeRel));
    } catch {
      fileStat = null;
    }

    if (!fileStat?.isFile()) {
      if (!existing) {
        return 'ignored';
      }
      this.store.deleteTracksByAudiopath(existing.audiopath);
      this.stats = null;
      return 'removed';
    }

    if (
      existing &&
      existing.size === fileStat.size &&
      existing.mtime === Math.floor(fileStat.mtimeMs)
    ) {
      return 'ignored';
    }

    const indexed = await this.addTrack(storageId, safeRel);
    this.stats = null;
    if (!indexed) {
      return existing ? 'removed' : 'ignored';
    }
    return existing ? 'updated' : 'added';
  }

  /**
   * Where a loose upload belongs, based on its tags: `Artist/Album`, or '' when
   * the tags don't say.
   *
   * Only for files dropped without a folder of their own — a whole album keeps the
   * structure it arrived with. Grouping uses {@link resolveAlbumArtist}, the same
   * rule the indexer applies, so a compilation files under one folder instead of
   * scattering across per-track artists.
   *
   * Reads the file on disk rather than a buffer, so nothing large is held in
   * memory; call it after the upload has landed.
   */
  public async resolveTagBasedSubdir(relPath: string): Promise<string> {
    const safeRel = normalizeLibraryRelPath(relPath);
    if (!safeRel) {
      return '';
    }
    const metadata = await this.readMetadata(path.join(this.baseDir, safeRel));
    const albumRaw = metadata.album.trim();
    const artistRaw = metadata.artist.trim();
    if (!albumRaw || (!artistRaw && !metadata.albumArtist.trim() && !metadata.compilation)) {
      return '';
    }

    const baseInfo = createTrackFromPath(safeRel);
    const groupArtist = resolveAlbumArtist(metadata, baseInfo, artistRaw).trim();
    if (!groupArtist || isUnknownTagValue(groupArtist) || isUnknownTagValue(albumRaw)) {
      return '';
    }

    const artistDir = toSafeFolderName(groupArtist);
    const albumDir = toSafeFolderName(albumRaw);
    if (!artistDir || !albumDir) {
      return '';
    }
    return `${artistDir}/${albumDir}`;
  }

  /**
   * Queues a path for incremental indexing, coalescing bursts.
   *
   * Copying an album lands as many sequential writes; indexing each the moment it
   * arrives would re-read tags while the next file is still being written. Paths
   * accumulate and drain once the writes go quiet, so a whole album settles as a
   * single pass. Unlike {@link rescan}, concurrent callers are never dropped.
   */
  public queuePathSync(relPath: string, settleMs = PATH_SYNC_SETTLE_MS): void {
    const safeRel = normalizeLibraryRelPath(relPath);
    if (!safeRel || !isLibraryAudioFile(safeRel)) {
      return;
    }
    this.pendingPathSyncs.add(safeRel);
    if (this.pathSyncTimer) {
      clearTimeout(this.pathSyncTimer);
    }
    this.pathSyncTimer = setTimeout(() => {
      this.pathSyncTimer = null;
      void this.drainPathSyncs();
    }, settleMs);
    this.pathSyncTimer.unref?.();
  }

  /** Resolves once no path sync is queued or running. Test/shutdown aid. */
  public async waitForPathSyncs(): Promise<void> {
    if (!this.pathSyncTimer && !this.pathSyncRunning && this.pendingPathSyncs.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.onPathSyncSettled = resolve;
    });
  }

  private async drainPathSyncs(): Promise<void> {
    if (this.pathSyncRunning) {
      return;
    }
    this.pathSyncRunning = true;
    let changed = 0;
    try {
      // Re-read the set each round: a write that lands mid-drain queues a new path.
      while (this.pendingPathSyncs.size > 0) {
        const batch = [...this.pendingPathSyncs];
        this.pendingPathSyncs.clear();
        for (const relPath of batch) {
          try {
            const result = await this.syncPath(relPath);
            if (result !== 'ignored') {
              changed += 1;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn('incremental library sync failed', { relPath, message });
          }
        }
      }

      if (changed > 0) {
        this.store.rebuildAlbumRollup();
        const stats: LibraryStats = this.store.getStats();
        this.stats = stats;
        this.log.info('library updated incrementally', { changed, ...stats });
        this.updateScanStatus(0, false, stats);
      }
    } finally {
      this.pathSyncRunning = false;
      if (!this.pathSyncTimer && this.pendingPathSyncs.size === 0) {
        const settled = this.onPathSyncSettled;
        this.onPathSyncSettled = null;
        settled?.();
      }
    }
  }

  /**
   * Returns a Loxone-compatible media folder payload.
   */
  public async getMediaFolder(
    folderId: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const normalized = this.normalizeFolderId(folderId);

    if (normalized === 'root') {
      return this.buildRootFolder(offset, limit);
    }

    if (normalized === SD_ROOT_FOLDER_ID || normalized === 'library:sd') {
      return this.buildSdFolder(offset, limit);
    }

    if (normalized === 'library-local') {
      return this.buildStorageFolder('local', 'Local Media', offset, limit);
    }

    if (normalized === SD_ALERTS_FOLDER_ID || normalized === 'alerts://') {
      return this.buildAlertFilesFolder(SD_ALERTS_FOLDER_ID, 'alerts', '', offset, limit);
    }

    if (
      normalized === SD_EVENT_SOUNDS_FOLDER_ID ||
      normalized === 'alerts://Event_Sounds' ||
      normalized === 'alerts://Event_Sounds/'
    ) {
      return this.buildAlertFilesFolder(
        SD_EVENT_SOUNDS_FOLDER_ID,
        'Event_Sounds',
        'Event_Sounds',
        offset,
        limit,
      );
    }

    if (normalized.startsWith('library-nas-') && !/-albums$|-artists$|-tracks$|-folders$/.test(normalized)) {
      const storageId = normalized.replace('library-nas-', '');
      return this.buildStorageFolder(storageId, await this.getStorageLabel(storageId), offset, limit);
    }

    if (normalized.endsWith('-albums')) {
      const storageId = this.extractStorageId(normalized, '-albums');
      return this.buildAlbumFolder(storageId, offset, limit);
    }

    if (normalized.endsWith('-artists')) {
      const storageId = this.extractStorageId(normalized, '-artists');
      return this.buildArtistFolder(storageId, offset, limit);
    }

    if (normalized.endsWith('-tracks')) {
      const storageId = this.extractStorageId(normalized, '-tracks');
      return this.buildTrackFolder(storageId, offset, limit);
    }

    if (normalized.endsWith('-folders')) {
      const storageId = this.extractStorageId(normalized, '-folders');
      if (!storageId) {
        return null;
      }
      return this.buildDriveFolder(storageId, '', offset, limit);
    }

    if (normalized === 'library-local-playlists') {
      const playlists = await this.listPlaylists(offset, limit);
      const items: ContentFolderItem[] = playlists.map((playlist) => ({
        id: playlist.audiopath,
        name: playlist.name,
        type: FILE_TYPE_FOLDER,
        audiopath: playlist.audiopath,
        ...(playlist.coverurl ? { coverurl: playlist.coverurl } : {}),
        items: playlist.tracks,
        provider: 'library',
        origin: 'local',
        kind: 'playlist',
        tag: 'playlist',
      }));
      return this.buildFolder('library-local-playlists', 'Playlists', items, offset, limit);
    }

    if (normalized.startsWith('library:album:')) {
      const key = normalized.slice('library:album:'.length);
      return this.buildAlbumTracks(key, offset, limit);
    }

    if (normalized.startsWith('library:artist:')) {
      const key = normalized.slice('library:artist:'.length);
      return this.buildArtistTracks(key, offset, limit);
    }

    if (normalized.startsWith('library:playlist:')) {
      const idPart = normalized.slice('library:playlist:'.length);
      const playlistId = Number.parseInt(idPart, 10);
      if (!Number.isFinite(playlistId)) {
        return null;
      }
      return this.getPlaylistItemsFolder(playlistId, offset, limit);
    }

    if (normalized.startsWith('library:folder:')) {
      const key = normalized.slice('library:folder:'.length);
      const payload = decodeFolderKey(key);
      if (!payload) {
        return null;
      }
      return this.buildDriveFolder(payload.storageId, payload.relPath, offset, limit);
    }

    return null;
  }

  private async buildRootFolder(offset: number, limit: number): Promise<ContentFolder> {
    // Best-effort storage listing; empty list means local-only view.
    const storages = await bestEffort(() => listStorages(), {
      fallback: [],
      onError: 'debug',
      log: this.log,
      label: 'list storages failed',
    });
    const items: ContentFolderItem[] = [
      this.storageRootItem('local', 'Local Media'),
      this.sdSpecialFolderItem(SD_ALERTS_FOLDER_ID, 'alerts', 'alerts://'),
      this.sdSpecialFolderItem(SD_EVENT_SOUNDS_FOLDER_ID, 'Event_Sounds', 'alerts://Event_Sounds'),
      ...storages.map((storage) => this.storageRootItem(String(storage.id), storage.name)),
    ];
    return this.buildFolder('root', 'Local Media', items, offset, limit);
  }

  private async buildSdFolder(offset: number, limit: number): Promise<ContentFolder> {
    const items: ContentFolderItem[] = [
      this.sdSpecialFolderItem(SD_ALERTS_FOLDER_ID, 'alerts', 'alerts://'),
      this.sdSpecialFolderItem(SD_EVENT_SOUNDS_FOLDER_ID, 'Event_Sounds', 'alerts://Event_Sounds'),
    ];
    return this.buildFolder(SD_ROOT_FOLDER_ID, 'SD Card', items, offset, limit);
  }

  private async buildStorageFolder(
    storageId: string,
    label: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const prefix = storageId === 'local' ? 'library-local' : `library-nas-${storageId}`;
    const items: ContentFolderItem[] = [
      this.categoryItem(prefix, 'Albums', 'albums', storageId, { tag: 'nas', nas: true }),
      this.categoryItem(prefix, 'Artists', 'artists', storageId, { tag: 'nas', nas: true }),
      this.categoryItem(prefix, 'Tracks', 'tracks', storageId, { tag: 'nas', nas: true }),
      // The one way in that does not depend on tags: a share whose files are named well and tagged
      // badly is still browsable by the folders someone filed it into.
      this.categoryItem(prefix, 'Folders', 'folders', storageId, { tag: 'nas', nas: true }),
      ...(storageId === 'local' ? [this.categoryItem(prefix, 'Playlists', 'playlists', storageId)] : []),
    ];
    return this.buildFolder(prefix, label, items, offset, limit);
  }

  private async buildAlertFilesFolder(
    id: string,
    name: string,
    relativeDir: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const files = await this.listAlertAudioFiles(relativeDir);
    const items = files.map((file) => this.alertFileItem(file.relativePath, file.name, file.duration));
    return this.buildFolder(id, name, items, offset, limit);
  }

  private async buildAlbumFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getAlbums(storageId, offset, limit);
    const folderItems = items.map((album) => this.albumItem(album));
    const name = storageId === 'local' ? 'Albums' : `${this.getStorageName(storageId)} Albums`;
    const id =
      storageId === 'local' ? 'library-local-albums' : `library-nas-${storageId}-albums`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildArtistFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getArtists(storageId, offset, limit);
    const folderItems = items.map((artist) => this.artistItem(artist));
    const name = storageId === 'local' ? 'Artists' : `${this.getStorageName(storageId)} Artists`;
    const id =
      storageId === 'local' ? 'library-local-artists' : `library-nas-${storageId}-artists`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildTrackFolder(
    storageId: string | null,
    offset: number,
    limit: number,
  ): Promise<ContentFolder> {
    const { items, total } = this.store.getTracks(storageId, offset, limit);
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    const name = storageId === 'local' ? 'Tracks' : `${this.getStorageName(storageId)} Tracks`;
    const id =
      storageId === 'local' ? 'library-local-tracks' : `library-nas-${storageId}-tracks`;
    return this.buildFolder(id, name, folderItems, offset, limit, total, true);
  }

  private async buildDriveFolder(
    storageId: string,
    relPath: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const storageRoot = this.getStorageRootRelativePath(storageId);
    const safeRelPath = sanitizeFolderRelPath(relPath);
    const relativeDir = safeRelPath ? path.join(storageRoot, safeRelPath) : storageRoot;
    const absoluteDir = this.resolveSafeLibraryPath(relativeDir);

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return null;
    }

    const folders = entries
      .filter((entry) => entry.isDirectory())
      .sort(compareDirentNames)
      .map((entry) => this.driveFolderItem(storageId, safeRelPath, entry.name));
    const files = entries
      .filter((entry) => entry.isFile() && isLibraryAudioFile(entry.name))
      .sort(compareDirentNames)
      .map((entry) => this.driveTrackItem(storageId, storageRoot, safeRelPath, entry.name))
      .filter((item): item is ContentFolderItem => item !== null);
    const items = [...folders, ...files];
    const folderName = safeRelPath ? path.basename(safeRelPath) : 'Folders';
    const id = safeRelPath
      ? buildFolderId(storageId, safeRelPath)
      : storageId === 'local'
        ? 'library-local-folders'
        : `library-nas-${storageId}-folders`;
    return this.buildFolder(id, folderName, items, offset, limit);
  }

  private async buildAlbumTracks(
    albumKey: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const payload = decodeAlbumKey(albumKey);
    if (!payload) {
      return null;
    }

    const { items, total } = this.store.getTracksForAlbum(
      payload.storageId,
      payload.artist,
      payload.album,
      offset,
      limit,
    );
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    const folder = this.buildFolder(`library:album:${albumKey}`, payload.album, folderItems, offset, limit, total, true);
    /*
     * The album describes itself: its cover and its artist ride the folder, not only the rows.
     * The first track's artwork *is* the album's — that is how the album grid finds it too —
     * so this costs nothing beyond reading a field that was already mapped.
     */
    const cover = folderItems.find((item) => item.coverurl)?.coverurl;
    return { ...folder, ...(cover ? { coverurl: cover } : {}), artist: payload.artist };
  }

  private async buildArtistTracks(
    artistKey: string,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const payload = decodeArtistKey(artistKey);
    if (!payload) {
      return null;
    }

    const { items, total } = this.store.getTracksForArtist(
      payload.storageId,
      payload.artist,
      offset,
      limit,
    );
    const folderItems = items.map((track) => this.trackItem(this.normalizeTrack(track)));
    const folder = this.buildFolder(`library:artist:${artistKey}`, payload.artist, folderItems, offset, limit, total, true);
    /*
     * The artist's own portrait — the Wikidata/Commons fetch already put it beside the music
     * (`artist.jpg`), and the artist *listing* has always shown it. The artist's own page was
     * the one place it never reached, because the folder carried a name and nothing else.
     */
    const row = this.store.getArtist(payload.storageId, payload.artist);
    const cover = row ? this.artistItem(row).coverurl : '';
    return { ...folder, ...(cover ? { coverurl: cover } : {}) };
  }

  public search(
    query: string,
    limits: SearchLimits,
  ): {
    tracks: ContentFolderItem[];
    albums: ContentFolderItem[];
    artists: ContentFolderItem[];
    playlists: ContentFolderItem[];
    folders: ContentFolderItem[];
  } {
    const safeQuery = query?.trim();
    if (!safeQuery) {
      return { tracks: [], albums: [], artists: [], playlists: [], folders: [] };
    }
    const getLimit = (key: string, fallback = 10) => {
      const value = limits[key];
      return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Number(value), 50) : fallback;
    };

    const tracks = this.store.searchTracks(safeQuery, getLimit('track'));
    const albums = this.store.searchAlbums(safeQuery, getLimit('album'));
    const artists = this.store.searchArtists(safeQuery, getLimit('artist'));

    return {
      tracks: tracks.map((t) => this.trackItem(this.normalizeTrack(t))),
      albums: albums.map((a) => this.albumItem(a)),
      artists: artists.map((a) => this.artistItem(a)),
      playlists: [],
      folders: [],
    };
  }

  private buildFolder(
    id: string,
    name: string,
    items: ContentFolderItem[],
    offset: number,
    limit: number,
    totalItems?: number,
    itemsPrePaged = false,
  ): ContentFolder {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    const pagedItems = itemsPrePaged ? items : items.slice(safeOffset, safeOffset + safeLimit);
    return {
      id,
      name,
      start: safeOffset,
      totalitems: totalItems ?? items.length,
      items: pagedItems,
    };
  }

  private storageRootItem(storageId: string, label: string): ContentFolderItem {
    const isLocal = storageId === 'local';
    const id = isLocal ? 'library-local' : `library-nas-${storageId}`;
    const audiopath = isLocal ? 'library:local' : `library:nas:${storageId}`;
    return {
      id,
      name: label,
      type: FILE_TYPE_FOLDER,
      items: 4,
      provider: 'library',
      title: label,
      audiopath,
      nas: true,
      origin: storageId,
      tag: 'nas',
    };
  }

  private sdSpecialFolderItem(id: string, name: string, uri: string): ContentFolderItem {
    return {
      id,
      name,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: name,
      audiopath: uri,
      origin: 'local',
      tag: 'sd',
    };
  }

  private categoryItem(
    prefix: string,
    label: string,
    suffix: 'albums' | 'artists' | 'tracks' | 'folders' | 'playlists',
    storageId: string,
    options?: { tag?: string; nas?: boolean },
  ) {
    const audiopath = `library:nas:${storageId}:${suffix}`;
    return {
      id: `${prefix}-${suffix}`,
      name: label,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: label,
      audiopath,
      nas: options?.nas,
      origin: storageId,
      tag: options?.tag,
    };
  }

  private normalizeFolderId(folderId: string): string {
    if (!folderId || folderId === '0') {
      return 'root';
    }
    return folderId.trim();
  }

  private extractStorageId(folderId: string, suffix: string): string | null {
    if (folderId.startsWith('library-local')) {
      return 'local';
    }
    if (folderId.startsWith('library-nas-') && folderId.endsWith(suffix)) {
      return folderId.slice('library-nas-'.length, -suffix.length);
    }
    return null;
  }

  private trackItem(track: LocalTrack): ContentFolderItem {
    return {
      id: track.audiopath,
      name: track.title,
      type: FILE_TYPE_FILE,
      kind: 'track',
      audiopath: track.audiopath,
      coverurl: this.buildCoverUrl(track),
      artist: track.artist ?? '',
      album: track.album ?? '',
      duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
      tag: track.storageId === 'local' ? 'sd' : 'nas',
    };
  }

  private driveFolderItem(storageId: string, parentRelPath: string, name: string): ContentFolderItem {
    const relPath = parentRelPath ? path.join(parentRelPath, name) : name;
    const id = buildFolderId(storageId, relPath);
    return {
      id,
      name,
      type: FILE_TYPE_FOLDER,
      provider: 'library',
      title: name,
      audiopath: id,
      nas: storageId !== 'local',
      origin: storageId,
      tag: storageId === 'local' ? 'sd' : 'nas',
    };
  }

  private driveTrackItem(
    storageId: string,
    storageRoot: string,
    parentRelPath: string,
    fileName: string,
  ): ContentFolderItem | null {
    const relPath = path.join(storageRoot, parentRelPath, fileName);
    const stored = bestEffortSync(
      () => this.store.findByStoragePath(storageId, relPath),
      { fallback: null, onError: 'debug', log: this.log, label: 'folder track lookup failed' },
    );
    if (stored) {
      return this.trackItem(this.normalizeTrack(stored));
    }
    // An .mp4 may be a video with no sound; only the scan, which reads its streams, can tell. Until
    // it has indexed the file, the folder view does not offer it as a track that cannot play.
    if (mayLackAudioStream(fileName)) {
      return null;
    }
    const baseInfo = createTrackFromPath(relPath);
    const track: LocalTrack = {
      id: relPath,
      relPath,
      storageId,
      title: baseInfo.title,
      album: baseInfo.album,
      artist: baseInfo.artist,
      audiopath: '',
    };
    track.audiopath = this.buildAudiopath(track);
    return this.trackItem(track);
  }

  private alertFileItem(relativePath: string, name: string, duration?: number): ContentFolderItem {
    const uri = `alerts://${encodePath(relativePath)}`;
    return {
      id: `library:alerts:${encodeURIComponent(relativePath)}`,
      name,
      type: FILE_TYPE_FILE,
      audiopath: buildAudiopath(uri, 'track', 'library:local'),
      origin: 'local',
      tag: 'sd',
      duration: typeof duration === 'number' && duration > 0 ? duration : undefined,
    };
  }

  private async listAlertAudioFiles(relativeDir: string): Promise<Array<{ name: string; relativePath: string; duration?: number }>> {
    const baseDir = relativeDir ? path.join(ALERTS_PUBLIC_DIR, relativeDir) : ALERTS_PUBLIC_DIR;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const audioEntries = entries.filter((entry) => entry.isFile() && isLibraryAudioFile(entry.name));
    const mapped = await Promise.all(
      audioEntries.map(async (entry) => {
        const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
        const absolutePath = path.join(baseDir, entry.name);
        let duration: number | undefined;
        try {
          const meta = await mm.parseFile(absolutePath);
          if (typeof meta.format.duration === 'number' && meta.format.duration > 0) {
            duration = Math.round(meta.format.duration);
          }
        } catch {
          // Ignore probe failures; duration fallback logic will remain active.
        }
        return {
          name: entry.name,
          relativePath,
          duration,
        };
      }),
    );
    return mapped
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  private getStorageRootRelativePath(storageId: string): string {
    return storageId === 'local' ? 'local' : path.join('nas', storageId);
  }

  private albumItem(album: AlbumRow): ContentFolderItem {
    const id = buildAlbumId(album.storage_id, album.artist, album.album);
    let firstTrack: LocalTrack | null = null;
    if (album.rel_path) {
      firstTrack = {
        id: album.rel_path,
        relPath: album.rel_path,
        storageId: album.storage_id,
        title: '',
        album: album.album,
        artist: album.artist,
        audiopath: '',
        cover: album.cover,
      };
    }
    return {
      id,
      name: album.album,
      type: FILE_TYPE_FOLDER,
      kind: 'album',
      coverurl: firstTrack ? this.buildCoverUrl(firstTrack) : '',
      items: album.track_count,
    };
  }

  private mapCoverSample(row: AlbumCoverRow): LibraryCoverSample {
    const cacheBust =
      typeof row.last_mtime === 'number' && Number.isFinite(row.last_mtime)
        ? Math.max(0, Math.round(row.last_mtime))
        : undefined;
    const coverurl = row.cover && row.rel_path
      ? this.buildCoverUrl({ relPath: row.rel_path, cover: row.cover }, cacheBust)
      : '';
    return {
      id: buildAlbumId(row.storage_id, row.artist, row.album),
      album: row.album,
      artist: row.artist,
      coverurl,
    };
  }

  private artistItem(artist: ArtistRow): ContentFolderItem {
    const id = buildArtistId(artist.storage_id, artist.name);
    const cacheBust =
      typeof artist.last_mtime === 'number' && Number.isFinite(artist.last_mtime)
        ? Math.max(0, Math.round(artist.last_mtime))
        : undefined;
    const coverurl =
      artist.cover && artist.rel_path
        ? this.buildCoverUrlForDir(artist.rel_path, artist.cover, cacheBust)
        : '';
    return {
      id,
      name: artist.name,
      type: FILE_TYPE_FOLDER,
      kind: 'artist',
      items: artist.track_count,
      coverurl,
    };
  }

  private normalizeTrack(track: StoredTrack): LocalTrack {
    return {
      id: String(track.id),
      relPath: track.rel_path,
      storageId: track.storage_id,
      title: track.title,
      album: track.album,
      artist: track.artist,
      albumArtist: track.album_artist,
      audiopath: track.audiopath,
      cover: track.cover ?? undefined,
      duration: typeof track.duration === 'number' ? Math.round(track.duration) : undefined,
    };
  }

  private buildAudiopath(track: LocalTrack): string {
    const encodedPath = encodePath(track.relPath);
    const uri = `library://${encodedPath}`;
    return buildAudiopath(uri, 'track', 'library:local');
  }

  private buildCoverUrl(
    track: { relPath: string; cover?: string | null },
    cacheBust?: number,
  ): string {
    if (!track?.cover) {
      return '';
    }
    const dir = path.dirname(track.relPath);
    return this.buildCoverUrlForDir(dir, track.cover, cacheBust);
  }

  private buildCoverUrlForDir(
    dirRelPath: string,
    coverFile: string,
    cacheBust?: number,
  ): string {
    if (!coverFile || !dirRelPath) {
      return '';
    }
    const host = this.resolveCoverHost();
    const baseUrl = `http://${host}:7090/music/${encodePath(path.join(dirRelPath, coverFile))}`;
    if (typeof cacheBust === 'number' && Number.isFinite(cacheBust) && cacheBust > 0) {
      return `${baseUrl}?cb=${cacheBust}`;
    }
    return baseUrl;
  }

  private resolveCoverHost(): string {
    const configured = this.getConfigPort().getSystemConfig().audioserver.ip?.trim();
    if (configured && !isLoopbackHost(configured)) {
      return configured;
    }
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal && net.address && !isLoopbackHost(net.address)) {
          return net.address;
        }
      }
    }
    return configured || '127.0.0.1';
  }

  private getConfigPort(): ConfigPort {
    return this.configPort;
  }

  private updateScanStatus(status: ScanStatus, silent: boolean, stats?: LibraryStats): void {
    this.scanStatus = status;
    if (stats) {
      this.stats = stats;
    }
    if (!silent) {
      this.notifier.notifyRescan(status, stats?.albums, stats?.tracks);
    }
  }

  private async ensureBaseStructure(options: { includeNasStorages?: boolean } = {}): Promise<void> {
    await ensureDir(this.baseDir);
    await ensureDir(path.join(this.baseDir, 'local'));
    await this.ensureNasDir(path.join(this.baseDir, 'nas'), { scope: 'nas-root' });

    if (options.includeNasStorages ?? true) {
      // Best-effort storage listing; skip NAS if unavailable.
      const storages = await bestEffort(() => listStorages(), {
        fallback: [],
        onError: 'debug',
        log: this.log,
        label: 'list storages failed',
      });
      await Promise.all(
        storages.map((storage) =>
          this.ensureNasDir(path.join(this.baseDir, 'nas', String(storage.id)), {
            scope: 'nas-storage',
            storageId: storage.id,
            name: storage.name,
          }),
        ),
      );
    }
  }

  private async ensureNasDir(dir: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await withTimeout(ensureDir(dir), NAS_DIR_TIMEOUT_MS, 'ensure nas dir');
    } catch (err) {
      if (err instanceof Error && err.message.includes('timed out')) {
        this.log.warn('nas path unavailable; skipping directory creation', {
          dir,
          code: 'ETIMEDOUT',
          ...meta,
        });
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      const errno = (err as NodeJS.ErrnoException).errno;
      if (code === 'EHOSTDOWN' || code === 'ENOTCONN' || code === 'EIO' || code === 'ESTALE' || errno === -116) {
        this.log.warn('nas path unavailable; skipping directory creation', {
          dir,
          code: code ?? `errno:${errno}`,
          ...meta,
        });
        return;
      }
      throw err;
    }
  }

  /**
   * Refreshes one storage, leaving the others untouched.
   *
   * Reconciles rather than wipes: files found are upserted, rows the walk did not
   * see are deleted afterwards. If the root cannot be read at all — an unmounted
   * share, a disconnected disk — nothing is deleted and the previous index stands,
   * because "I can't see it" must not be recorded as "it's gone".
   */
  private async rescanStorage(storageId: string, relRoot: string): Promise<void> {
    const absRoot = path.join(this.baseDir, relRoot);
    try {
      await fsp.readdir(absRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('storage unreachable; keeping its existing index', {
        storageId,
        relRoot,
        message,
      });
      return;
    }

    const seen = new Set<string>();
    const reachable = await this.scanStorage(storageId, relRoot, seen);
    if (!reachable) {
      this.log.warn('storage became unreadable mid-scan; keeping its existing index', {
        storageId,
      });
      return;
    }

    const removed = this.store.deleteTracksMissingFrom(storageId, seen);
    if (removed > 0) {
      this.log.info('pruned tracks that disappeared from disk', { storageId, removed });
    }
  }

  /**
   * Walks one storage, upserting every audio file and recording what it saw in
   * `seen`. Returns false when the root itself could not be read; an unreadable
   * *sub*directory is logged and skipped without failing the whole walk.
   */
  private async scanStorage(
    storageId: string,
    relRoot: string,
    seen: Set<string>,
  ): Promise<boolean> {
    const absRoot = path.join(this.baseDir, relRoot);
    let entries: Dirent[];

    try {
      entries = await fsp.readdir(absRoot, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('directory unreadable during scan', { relRoot, message });
      return false;
    }

    for (const entry of entries) {
      const nextRel = path.join(relRoot, entry.name);

      if (entry.isDirectory()) {
        await this.scanStorage(storageId, nextRel, seen);
        continue;
      }

      if (!entry.isFile() || !isLibraryAudioFile(entry.name)) {
        continue;
      }

      seen.add(nextRel);
      await this.addTrack(storageId, nextRel);
    }
    return true;
  }

  /**
   * Indexes one file. Resolves `false` when the file is not a track after all: unreadable, or an
   * `.mp4` whose streams hold no audio (any row it had is dropped).
   */
  private async addTrack(storageId: string, relPath: string): Promise<boolean> {
    const fullPath = path.join(this.baseDir, relPath);

    let fileStat: Stats | null = null;
    try {
      fileStat = await fsp.stat(fullPath);
    } catch {
      return false;
    }

    // Untouched file: the stored row is still accurate, so skip the expensive
    // part (tag parse, cover extraction, artist-art probe). Size is compared as
    // well as mtime because a restore or in-place edit can preserve one but not
    // the other.
    //
    // A row from before the format columns existed is *not* accurate, though, however untouched the
    // file is. Nothing can backfill it from the database — the answer is in the file — so a row with
    // no codec is re-read once. Without this, an upgraded library would keep resampling every track
    // it already had until each file happened to change.
    const known = this.store.findByStoragePath(storageId, relPath);
    if (
      known &&
      known.codec &&
      known.size === fileStat.size &&
      known.mtime === Math.floor(fileStat.mtimeMs)
    ) {
      return true;
    }

    const metadata = await this.readMetadata(fullPath);
    // A video with no sound would list as a track that plays nothing. A file the parser could not
    // read at all is given the benefit of the doubt, exactly as an unreadable .m4a is.
    if (mayLackAudioStream(relPath) && metadata.hasAudioStream === false) {
      if (known) {
        this.store.deleteTracksByAudiopath(known.audiopath);
      }
      this.log.debug('skipping file without an audio stream', { relPath });
      return false;
    }
    const baseInfo = createTrackFromPath(relPath);
    const artist = metadata.artist || baseInfo.artist;

    const track: LocalTrack = {
      id: relPath,
      relPath,
      storageId,
      title: metadata.title || baseInfo.title,
      album: metadata.album || baseInfo.album,
      artist,
      albumArtist: resolveAlbumArtist(metadata, baseInfo, artist),
      audiopath: '',
      duration: metadata.duration,
    };

    track.audiopath = this.buildAudiopath(track);
    track.cover = await this.safeEnsureCoverArt(relPath, metadata.picture, track);
    await this.ensureArtistCover(storageId, relPath, track.artist);

    this.store.insertTrack({
      storageId,
      relPath,
      title: track.title,
      album: track.album,
      artist: track.artist,
      albumArtist: track.albumArtist,
      audiopath: track.audiopath,
      cover: track.cover ?? undefined,
      mtime: fileStat?.mtimeMs ? Math.floor(fileStat.mtimeMs) : undefined,
      size: fileStat?.size,
      duration: track.duration,
      format: metadata.format,
    });
    return true;
  }

  private async safeEnsureCoverArt(
    relPath: string,
    picture: mm.IPicture | undefined,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    try {
      return await this.ensureCoverArt(relPath, picture, track);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('cover extraction failed', { relPath, message });
      return undefined;
    }
  }

  private async ensureArtistCover(
    storageId: string,
    relPath: string,
    artistName: string,
  ): Promise<void> {
    const trimmedArtist = String(artistName || '').trim();
    if (!trimmedArtist) {
      return;
    }
    const albumDir = path.dirname(relPath);
    const artistRelDir = path.dirname(albumDir);
    if (!artistRelDir || artistRelDir === '.' || artistRelDir === albumDir) {
      return;
    }
    // Storage root itself isn't an artist folder (e.g. 'local', 'nas/<id>').
    const segments = artistRelDir.split(path.sep).filter(Boolean);
    const minSegments = artistRelDir.startsWith(`nas${path.sep}`) ? 3 : 2;
    if (segments.length < minSegments) {
      return;
    }

    const cacheKey = `${storageId}::${artistRelDir}::${trimmedArtist}`;
    if (this.artistCoverProbeCache.has(cacheKey)) {
      return;
    }

    const absDir = path.join(this.baseDir, artistRelDir);
    for (const candidate of ARTIST_COVER_CANDIDATES) {
      const absFile = path.join(absDir, candidate);
      const stat = await bestEffort(() => fsp.stat(absFile), {
        fallback: null as Stats | null,
        onError: 'debug',
        log: this.log,
        label: 'artist cover stat failed',
      });
      if (stat && stat.isFile()) {
        this.store.upsertArtistCover({
          storageId,
          name: trimmedArtist,
          cover: candidate,
          relPath: artistRelDir,
          mtime: Math.floor(stat.mtimeMs),
        });
        this.artistCoverProbeCache.set(cacheKey, candidate);
        return;
      }
    }
    this.artistCoverProbeCache.set(cacheKey, null);
  }

  private async readMetadata(filePath: string): Promise<SafeTags> {
    try {
      const metadata = await mm.parseFile(filePath);
      return {
        title: metadata.common.title ?? '',
        album: metadata.common.album ?? '',
        artist: metadata.common.artist ?? '',
        albumArtist: metadata.common.albumartist || metadata.common.albumartists?.join(', ') || '',
        compilation: metadata.common.compilation === true,
        picture: metadata.common.picture?.[0],
        duration: metadata.format.duration ? Math.round(metadata.format.duration) : undefined,
        format: toTrackSourceFormat(metadata.format),
        hasAudioStream: hasAudioStream(metadata.format),
      };
    } catch {
      return { title: '', album: '', artist: '', albumArtist: '', compilation: false };
    }
  }

  private async ensureCoverArt(
    relPath: string,
    picture: mm.IPicture | undefined,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    const dir = path.join(this.baseDir, path.dirname(relPath));

    for (const candidate of COVER_CANDIDATES) {
      if (await fileExists(path.join(dir, candidate))) {
        return candidate;
      }
    }

    if (!picture?.data?.length) {
      return this.fetchAndStoreRemoteCoverArt(relPath, track);
    }

    const extension = resolveCoverExtension(picture.format);
    const fileName = `cover${extension}`;
    const outPath = path.join(dir, fileName);

    await ensureDir(dir);
    const rawBuffer = Buffer.from(picture.data);
    try {
      const image = await Jimp.read(rawBuffer);
      // One stored file serves both now-playing and browse; keep it at the larger
      // now-playing tier. (Per-list thumbnails would need an on-the-fly resize on
      // the /music endpoint — deferred.)
      const maxSize = COVER_ART_NOW_PLAYING_SIZE;
      const width = image.bitmap.width;
      const height = image.bitmap.height;
      const scale = Math.min(1, maxSize / width, maxSize / height);
      if (scale < 1) {
        image.scale(scale);
      }
      const buffer =
        extension === '.png'
          ? await image.getBuffer(JimpMime.png)
          : await image.getBuffer(JimpMime.jpeg, { quality: COVER_ART_JPEG_QUALITY });
      await fsp.writeFile(outPath, Buffer.from(buffer));
    } catch (error) {
      // Some embedded cover formats are not decoded by Jimp; store raw bytes as fallback.
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('cover resize failed; using raw embedded art', { relPath, message });
      await fsp.writeFile(outPath, rawBuffer);
    }
    return fileName;
  }

  private async fetchAndStoreRemoteCoverArt(
    relPath: string,
    track: Pick<LocalTrack, 'title' | 'album' | 'artist'>,
  ): Promise<string | undefined> {
    const album = track.album?.trim() ?? '';
    const artist = track.artist?.trim() ?? '';
    if (!album || !artist) {
      return undefined;
    }
    if (/^unknown\b/i.test(album) || /^unknown\b/i.test(artist)) {
      return undefined;
    }

    const cacheKey = `${album.toLowerCase()}|||${artist.toLowerCase()}`;
    const cached = this.coverLookupCache.get(cacheKey);
    if (cached === null) {
      return undefined;
    }

    let coverUrl = cached;
    if (!coverUrl) {
      const mbid = await this.lookupMusicBrainzReleaseMbid(album, artist);
      if (!mbid) {
        this.log.debug('remote cover lookup: no musicbrainz match', { relPath, artist, album });
        this.coverLookupCache.set(cacheKey, null);
        return undefined;
      }
      coverUrl = `${COVER_ART_ARCHIVE_RELEASE}/${encodeURIComponent(mbid)}/front-${coverArtArchiveSize(COVER_ART_NOW_PLAYING_SIZE)}`;
      this.log.info('remote cover lookup: matched musicbrainz release', {
        relPath,
        artist,
        album,
        mbid,
      });
      this.coverLookupCache.set(cacheKey, coverUrl);
    }

    try {
      const response = await fetch(coverUrl);
      if (!response.ok) {
        if (response.status === 404) {
          this.coverLookupCache.set(cacheKey, null);
        }
        this.log.debug('remote cover download failed', {
          relPath,
          artist,
          album,
          status: response.status,
          url: coverUrl,
        });
        return undefined;
      }
      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength <= 0 || arrayBuffer.byteLength > COVER_ART_MAX_BYTES) {
        return undefined;
      }
      const outDir = path.join(this.baseDir, path.dirname(relPath));
      const fileName = `cover${ext}`;
      const outPath = path.join(outDir, fileName);
      await ensureDir(outDir);
      await fsp.writeFile(outPath, Buffer.from(arrayBuffer));
      this.log.info('remote cover stored', {
        relPath,
        artist,
        album,
        fileName,
        bytes: arrayBuffer.byteLength,
      });
      return fileName;
    } catch {
      this.log.debug('remote cover download error', { relPath, artist, album, url: coverUrl });
      return undefined;
    }
  }

  /**
   * Fills in missing artist pictures after a scan, in the background.
   *
   * Cover Art Archive only serves releases, so an artist photo comes the long way
   * round: MusicBrainz artist search → its Wikidata relation → the P18 "image"
   * claim → the file on Wikimedia Commons. Everything there is freely licensed and
   * needs no API key.
   *
   * Deliberately not awaited by {@link rescan}: MusicBrainz allows one request a
   * second, so a library with many artists would otherwise stretch the scan out
   * for minutes while the index is already complete and usable.
   */
  private async fetchMissingArtistCovers(): Promise<void> {
    if (this.artistArtRunning) {
      return;
    }
    this.artistArtRunning = true;
    try {
      const pending = this.store.listArtistsWithoutCover(ARTIST_ART_MAX_PER_SCAN);
      if (pending.length === 0) {
        return;
      }
      this.log.info('fetching missing artist art', { artists: pending.length });

      let stored = 0;
      for (const entry of pending) {
        // A negative result is remembered for the process lifetime, so repeated
        // scans don't re-ask MusicBrainz about artists it has no picture for.
        const cacheKey = `${entry.storage_id}::${entry.name.toLowerCase()}`;
        if (this.artistArtMisses.has(cacheKey)) {
          continue;
        }

        // Prefer a real artist folder. A flat layout has none — the album sits
        // directly at the storage root — so the picture goes beside the album
        // instead. Only safe because such a folder holds one artist by
        // definition: if it had an artist folder we would not be here.
        const artistDir = this.resolveArtistDir(entry.rel_path) ?? path.dirname(entry.rel_path);
        if (!artistDir || artistDir === '.') {
          this.artistArtMisses.add(cacheKey);
          continue;
        }

        try {
          const fileName = await this.fetchAndStoreArtistImage(entry.name, artistDir);
          if (!fileName) {
            this.artistArtMisses.add(cacheKey);
            continue;
          }
          const absFile = path.join(this.baseDir, artistDir, fileName);
          const stat = await fsp.stat(absFile).catch(() => null);
          this.store.upsertArtistCover({
            storageId: entry.storage_id,
            name: entry.name,
            cover: fileName,
            relPath: artistDir,
            mtime: stat ? Math.floor(stat.mtimeMs) : undefined,
          });
          // The probe cache would otherwise keep reporting "no cover here".
          this.artistCoverProbeCache.clear();
          stored += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.log.debug('artist art fetch failed', { artist: entry.name, message });
          this.artistArtMisses.add(cacheKey);
        }
      }

      if (stored > 0) {
        this.log.info('artist art stored', { stored });
      }
    } finally {
      this.artistArtRunning = false;
    }
  }

  /**
   * Folder that represents the artist for a track, or null when the layout has
   * none — `local/Album/track.mp3` is an album sitting at the storage root, so
   * its parent is the storage itself and not an artist.
   */
  private resolveArtistDir(relPath: string): string | null {
    const albumDir = path.dirname(relPath);
    const artistRelDir = path.dirname(albumDir);
    if (!artistRelDir || artistRelDir === '.' || artistRelDir === albumDir) {
      return null;
    }
    const segments = artistRelDir.split(path.sep).filter(Boolean);
    const minSegments = artistRelDir.startsWith(`nas${path.sep}`) ? 3 : 2;
    return segments.length >= minSegments ? artistRelDir : null;
  }

  /** Resolves an artist to a Commons image and writes it as `artist.<ext>`. */
  private async fetchAndStoreArtistImage(
    artist: string,
    artistRelDir: string,
  ): Promise<string | null> {
    const mbid = await this.lookupMusicBrainzArtistMbid(artist);
    if (!mbid) {
      return null;
    }
    const wikidataId = await this.lookupWikidataIdForArtist(mbid);
    if (!wikidataId) {
      return null;
    }
    const commonsFile = await this.lookupWikidataImage(wikidataId);
    if (!commonsFile) {
      return null;
    }

    const url = buildCommonsThumbUrl(commonsFile, ARTIST_ART_SIZE);
    const response = await fetch(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!response.ok) {
      this.log.debug('artist art download failed', { artist, status: response.status });
      return null;
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength <= 0 || bytes.byteLength > COVER_ART_MAX_BYTES) {
      return null;
    }
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const fileName = `artist${ext}`;
    const outDir = path.join(this.baseDir, artistRelDir);
    await ensureDir(outDir);
    await fsp.writeFile(path.join(outDir, fileName), Buffer.from(bytes));
    this.log.info('artist art stored', { artist, artistRelDir, fileName, bytes: bytes.byteLength });
    return fileName;
  }

  private async lookupMusicBrainzArtistMbid(artist: string): Promise<string | null> {
    await this.waitForMusicBrainzRateLimit();
    const query = `artist:"${escapeMusicBrainzQuery(artist)}"`;
    const url = `${MUSICBRAINZ_ARTIST_ENDPOINT}?query=${encodeURIComponent(query)}&fmt=json&limit=1`;
    const response = await fetch(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      artists?: Array<{ id?: string; score?: number }>;
    };
    const best = payload.artists?.[0];
    // A weak match is worse than no picture: it would attach the wrong face to
    // an artist and look like a bug rather than a gap.
    if (!best?.id || Number(best.score ?? 0) < ARTIST_ART_MIN_SCORE) {
      return null;
    }
    return best.id;
  }

  private async lookupWikidataIdForArtist(mbid: string): Promise<string | null> {
    await this.waitForMusicBrainzRateLimit();
    const url = `${MUSICBRAINZ_ARTIST_ENDPOINT.replace(/\/$/, '')}/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`;
    const response = await fetch(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      relations?: Array<{ url?: { resource?: string } }>;
    };
    for (const relation of payload.relations ?? []) {
      const match = /wikidata\.org\/wiki\/(Q\d+)/.exec(relation.url?.resource ?? '');
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  /** The P18 ("image") claim on a Wikidata entity, as a Commons filename. */
  private async lookupWikidataImage(wikidataId: string): Promise<string | null> {
    const url = `${WIKIDATA_CLAIMS_ENDPOINT}?action=wbgetclaims&entity=${encodeURIComponent(wikidataId)}&property=P18&format=json`;
    const response = await fetch(url, { headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT } });
    if (!response.ok) {
      return null;
    }
    const payload = (await response.json()) as {
      claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> };
    };
    return payload.claims?.P18?.[0]?.mainsnak?.datavalue?.value ?? null;
  }

  private async lookupMusicBrainzReleaseMbid(album: string, artist: string): Promise<string | null> {
    await this.waitForMusicBrainzRateLimit();
    const query = `release:"${escapeMusicBrainzQuery(album)}" AND artist:"${escapeMusicBrainzQuery(artist)}"`;
    const url = new URL(MUSICBRAINZ_ENDPOINT);
    url.searchParams.set('query', query);
    url.searchParams.set('fmt', 'json');
    url.searchParams.set('limit', '5');
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'User-Agent': MUSICBRAINZ_USER_AGENT,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as {
        releases?: Array<{
          id?: string;
          title?: string;
          score?: number | string;
          'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
        }>;
      };
      const releases = Array.isArray(payload?.releases) ? payload.releases : [];
      if (releases.length === 0) {
        return null;
      }
      const targetAlbum = normalizeMetaText(album);
      const targetArtist = normalizeMetaText(artist);
      const exact = releases.find((release) => {
        const releaseTitle = normalizeMetaText(String(release.title ?? ''));
        const releaseArtist = normalizeMetaText(
          String(release['artist-credit']?.[0]?.name ?? release['artist-credit']?.[0]?.artist?.name ?? ''),
        );
        return releaseTitle === targetAlbum && releaseArtist === targetArtist && release.id;
      });
      if (exact?.id) {
        return exact.id;
      }
      releases.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
      return releases[0]?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Queues behind every other MusicBrainz caller in this process, not just this one.
   *
   * The limit MusicBrainz asks us to respect is one request per second per *application*, so a
   * limiter private to this class was only ever half of it: the about lookups are a second
   * caller, and two well-behaved streams still make two requests a second between them.
   */
  private async waitForMusicBrainzRateLimit(): Promise<void> {
    await waitForMusicBrainzSlot();
  }

  private async getStorageLabel(storageId: string): Promise<string> {
    // Best-effort storage listing; missing config falls back to local only.
    const storages = await bestEffort(() => listStorages(), {
      fallback: [],
      onError: 'debug',
      log: this.log,
      label: 'list storages failed',
    });
    return storages.find((storage) => storage.id === storageId)?.name ?? this.getStorageName(storageId);
  }

  private getStorageName(storageId: string | null): string {
    if (!storageId || storageId === 'local') {
      return 'Local';
    }
    return `NAS ${storageId}`;
  }

  private async deleteAudioFiles(rows: TrackFileRow[]): Promise<{ deletedFiles: number; missingFiles: number }> {
    let deletedFiles = 0;
    let missingFiles = 0;

    for (const row of rows) {
      const filePath = this.resolveSafeLibraryPath(row.rel_path);
      try {
        await fsp.unlink(filePath);
        deletedFiles += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          missingFiles += 1;
          continue;
        }
        throw err;
      }
    }

    return { deletedFiles, missingFiles };
  }

  private resolveSafeLibraryPath(relPath: string): string {
    const normalizedRelPath = String(relPath || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const resolved = path.resolve(this.baseDir, normalizedRelPath);
    const baseDir = path.resolve(this.baseDir) + path.sep;
    if (!resolved.startsWith(baseDir)) {
      throw new Error('invalid-library-path');
    }
    return resolved;
  }

  // -- Playlists --------------------------------------------------------------

  public async listPlaylists(offset: number, limit: number): Promise<PlaylistEntry[]> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
    const { items } = this.store.listPlaylists(safeOffset, safeLimit);
    return items.map((row) => this.playlistEntry(row));
  }

  public getPlaylistCount(): number {
    return this.store.listPlaylists(0, 0).total;
  }

  public createPlaylist(name: string): PlaylistEntry {
    const safeName = String(name || '').trim() || 'New Playlist';
    const row = this.store.createPlaylist(safeName);
    return this.playlistEntry(row);
  }

  public renamePlaylist(id: number, name: string): PlaylistEntry | null {
    const safeName = String(name || '').trim();
    if (!safeName) {
      return null;
    }
    if (!this.store.renamePlaylist(id, safeName)) {
      return null;
    }
    const row = this.store.getPlaylist(id);
    return row ? this.playlistEntry(row) : null;
  }

  public deletePlaylist(id: number): boolean {
    return this.store.deletePlaylist(id);
  }

  public getPlaylist(id: number): PlaylistEntry | null {
    const row = this.store.getPlaylist(id);
    return row ? this.playlistEntry(row) : null;
  }

  public async getPlaylistItemsFolder(
    id: number,
    offset: number,
    limit: number,
  ): Promise<ContentFolder | null> {
    const playlist = this.store.getPlaylist(id);
    if (!playlist) {
      return null;
    }
    const { items, total } = this.store.getPlaylistItems(id, offset, limit);
    const folderItems = items.map((row) => this.playlistItemToFolderItem(row));
    return this.buildFolder(`library:playlist:${id}`, playlist.name, folderItems, offset, limit, total, true);
  }

  /**
   * Resolves a Loxone "addbrowsable" or "additem" payload into one or more track rows.
   * Tracks → single entry; albums/artists/folders/playlists → expanded list.
   */
  public async resolveAddableItems(rawId: string): Promise<PlaylistItemRow[]> {
    const id = String(rawId || '').trim();
    if (!id) {
      return [];
    }

    // Direct track audiopath
    const track = this.store.findByAudiopath(id);
    if (track) {
      const normalized = this.normalizeTrack(track);
      return [
        {
          playlist_id: 0,
          position: 0,
          audiopath: normalized.audiopath,
          title: normalized.title,
          artist: normalized.artist,
          album: normalized.album,
          duration: typeof normalized.duration === 'number' ? Math.round(normalized.duration) : null,
          cover: normalized.cover ?? null,
          rel_path: normalized.relPath,
        },
      ];
    }

    // Container ids: expand via mediaFolder (walks pages up to 500 items)
    if (id.startsWith('library:')) {
      const folder = await this.getMediaFolder(id, 0, 1000);
      const tracks = folder?.items?.filter((item) => item.type === FILE_TYPE_FILE) ?? [];
      return tracks.map((item) => ({
        playlist_id: 0,
        position: 0,
        audiopath: item.audiopath ?? item.id ?? '',
        title: item.name ?? item.title ?? null,
        artist: item.artist ?? null,
        album: item.album ?? null,
        duration: typeof item.duration === 'number' ? Math.round(item.duration) : null,
        cover: null,
        rel_path: null,
      }));
    }

    return [];
  }

  public async addItemsToPlaylist(playlistId: number, rawId: string): Promise<number> {
    if (!this.store.getPlaylist(playlistId)) {
      return 0;
    }
    const resolved = await this.resolveAddableItems(rawId);
    if (resolved.length === 0) {
      return 0;
    }
    return this.store.appendPlaylistItems(
      playlistId,
      resolved.map((row) => ({
        audiopath: row.audiopath,
        title: row.title ?? undefined,
        artist: row.artist ?? undefined,
        album: row.album ?? undefined,
        duration: typeof row.duration === 'number' ? row.duration : undefined,
        cover: row.cover ?? undefined,
        relPath: row.rel_path ?? undefined,
      })),
    );
  }

  public removePlaylistItem(playlistId: number, position: number): boolean {
    return this.store.removePlaylistItem(playlistId, position);
  }

  public movePlaylistItem(playlistId: number, from: number, to: number): boolean {
    return this.store.movePlaylistItem(playlistId, from, to);
  }

  private playlistEntry(row: PlaylistRow): PlaylistEntry {
    const coverurl =
      row.cover && row.rel_path
        ? this.buildCoverUrlForDir(path.dirname(row.rel_path), row.cover)
        : '';
    return {
      id: String(row.id),
      name: row.name,
      tracks: row.item_count,
      audiopath: `library:playlist:${row.id}`,
      coverurl,
    };
  }

  private playlistItemToFolderItem(row: PlaylistItemRow): ContentFolderItem {
    const dir = row.rel_path ? path.dirname(row.rel_path) : '';
    const coverurl = row.cover && dir ? this.buildCoverUrlForDir(dir, row.cover) : '';
    return {
      id: row.audiopath,
      name: row.title ?? '',
      type: FILE_TYPE_FILE,
      audiopath: row.audiopath,
      coverurl,
      artist: row.artist ?? '',
      album: row.album ?? '',
      duration: typeof row.duration === 'number' ? row.duration : undefined,
      tag: 'sd',
    };
  }

  public resolveItem(audiopath: string): ContentItemMetadata | null {
    const raw = String(audiopath || '').trim();
    // Album container: name + album-artist + cover, taken from its first track.
    if (raw.startsWith('library:album:')) {
      const payload = decodeAlbumKey(raw.slice('library:album:'.length));
      if (!payload) {
        return null;
      }
      const first = this.store.getTracksForAlbum(payload.storageId, payload.artist, payload.album, 0, 1).items[0];
      return {
        title: payload.album,
        artist: payload.artist,
        album: payload.album,
        coverurl: first ? this.buildCoverUrl(this.normalizeTrack(first)) : '',
      };
    }
    // Artist container: name + cover for the favourite. Prefer the artist's own
    // image (artist.jpg); fall back to the first track's album cover only when
    // the artist has no dedicated cover.
    if (raw.startsWith('library:artist:')) {
      const payload = decodeArtistKey(raw.slice('library:artist:'.length));
      if (!payload) {
        return null;
      }
      const artistRow = this.store.getArtist(payload.storageId, payload.artist);
      let coverurl = artistRow ? this.artistItem(artistRow).coverurl ?? '' : '';
      if (!coverurl) {
        const first = this.store.getTracksForArtist(payload.storageId, payload.artist, 0, 1).items[0];
        coverurl = first ? this.buildCoverUrl(this.normalizeTrack(first)) : '';
      }
      return {
        title: payload.artist,
        artist: '',
        album: '',
        coverurl,
      };
    }
    const track = this.store.findByAudiopath(audiopath);
    if (!track) {
      return null;
    }
    const normalized = this.normalizeTrack(track);
    return {
      title: normalized.title,
      artist: normalized.artist,
      album: normalized.album,
      coverurl: this.buildCoverUrl(normalized),
      duration: normalized.duration,
    };
  }
}

function buildAlbumId(storageId: string, artist: string, album: string): string {
  const key = encodeAlbumKey({ storageId, artist, album });
  return `library:album:${key}`;
}

function buildArtistId(storageId: string, artist: string): string {
  const key = encodeArtistKey({ storageId, artist });
  return `library:artist:${key}`;
}

function buildFolderId(storageId: string, relPath: string): string {
  const key = encodeFolderKey({ storageId, relPath });
  return `library:folder:${key}`;
}

function encodePath(relative: string): string {
  return relative
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function createTrackFromPath(relPath: string): Pick<LocalTrack, 'title' | 'album' | 'artist'> {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  const file = segments.pop() ?? relPath;
  const baseName = file.replace(path.extname(file), '');

  if (segments.length >= 2) {
    return {
      title: baseName,
      artist: segments[segments.length - 2] ?? 'Unknown Artist',
      album: segments[segments.length - 1] ?? 'Unknown Album',
    };
  }

  return {
    title: baseName,
    artist: 'Unknown Artist',
    album: 'Unknown Album',
  };
}

function sanitizeFolderRelPath(value: string): string {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
}

function compareDirentNames(a: Dirent, b: Dirent): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
}

function resolveAlbumArtist(
  metadata: SafeTags,
  baseInfo: Pick<LocalTrack, 'artist'>,
  trackArtist: string,
): string {
  const explicit = metadata.albumArtist.trim();
  if (explicit) {
    return explicit;
  }
  if (metadata.compilation) {
    return 'Various Artists';
  }
  const pathArtist = baseInfo.artist.trim();
  if (pathArtist && !/^unknown\b/i.test(pathArtist)) {
    return pathArtist;
  }
  return trackArtist;
}

/** Placeholder tags that shouldn't become a folder ("Unknown Artist" and friends). */
function isUnknownTagValue(value: string): boolean {
  // Matches the placeholder itself ("Unknown", "Unknown Artist", "unknown album")
  // but not a real name that merely starts with the word — "Unknown Mortal
  // Orchestra" is a band, and filing it as unidentified would be wrong.
  return /^unknown(\s+(artist|album|albumartist|title))?$/i.test(value.trim());
}

/**
 * Turns a tag value into a usable folder name.
 *
 * Removes only what a filesystem genuinely cannot take — path separators and the
 * characters Windows reserves — and leaves everything else alone. Accents and
 * non-Latin scripts survive, so a tag reading "Björk" becomes the folder "Björk"
 * rather than "Bj_rk". Returns '' when nothing usable remains.
 */
function toSafeFolderName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, ' ')
    // Control characters are legal on disk but never intended.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    // A leading dot hides the folder; a trailing dot or space breaks Windows.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 96)
    .trim();
}

/**
 * Normalizes a library-relative path without rewriting the name.
 *
 * For paths that already exist on disk: accents, spaces and CJK must survive
 * verbatim or the lookup misses. Traversal is rejected rather than rewritten.
 */
function normalizeLibraryRelPath(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    return '';
  }
  return parts.join('/');
}

/**
 * Storage a library-relative path belongs to: `nas/<id>/…` is that share,
 * anything else is the built-in local folder.
 */
function resolveStorageIdFromRelPath(relPath: string): string {
  const parts = relPath.split('/');
  if (parts[0] === 'nas' && parts[1]) {
    return parts[1];
  }
  return 'local';
}

function resolveCoverExtension(format: string | undefined): '.jpg' | '.png' | '.webp' {
  const value = String(format ?? '').toLowerCase();
  if (value.includes('png')) {
    return '.png';
  }
  if (value.includes('webp')) {
    return '.webp';
  }
  return '.jpg';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Thumbnail URL for a Wikimedia Commons file.
 *
 * Commons derives the storage path from the MD5 of the underscored filename;
 * there is no lookup endpoint for it, so the path is computed the same way the
 * wiki does.
 */
function buildCommonsThumbUrl(fileName: string, width: number): string {
  const underscored = fileName.replace(/ /g, '_');
  // The hash is over the raw underscored name, before any escaping.
  const hash = createHash('md5').update(underscored).digest('hex');
  // Commons also escapes the sub-delims encodeURIComponent leaves alone, and
  // parentheses are common in photo filenames ("… (cropped).jpg").
  const encoded = encodeURIComponent(underscored).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash.slice(0, 2)}/${encoded}/${width}px-${encoded}`;
}

function escapeMusicBrainzQuery(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').trim();
}

function normalizeMetaText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function encodeAlbumKey(payload: AlbumIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAlbumKey(raw: string): AlbumIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as AlbumIdPayload;
    if (parsed.storageId && parsed.artist !== undefined && parsed.album !== undefined) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function encodeArtistKey(payload: ArtistIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeArtistKey(raw: string): ArtistIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ArtistIdPayload;
    if (parsed.storageId && parsed.artist !== undefined) {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function encodeFolderKey(payload: FolderIdPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeFolderKey(raw: string): FolderIdPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as FolderIdPayload;
    if (parsed.storageId && parsed.relPath !== undefined) {
      return { storageId: parsed.storageId, relPath: sanitizeFolderRelPath(parsed.relPath) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function buildAudiopath(uri: string, itemType: string, providerPrefix: string): string {
  const encoded = Buffer.from(uri).toString('base64');
  return `${providerPrefix}:${itemType}:b64_${encoded}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Internals exposed for tests only. Filing an upload under its tags is
 * name-sensitive enough to be worth covering directly.
 */
export const __testing = {
  toSafeFolderName,
  isUnknownTagValue,
  buildCommonsThumbUrl,
};
