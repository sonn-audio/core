import Database from 'better-sqlite3';
import path from 'node:path';
import { statSync } from 'node:fs';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';

export interface TrackInsert {
  storageId: string;
  relPath: string;
  title: string;
  album: string;
  artist: string;
  albumArtist?: string;
  audiopath: string;
  cover?: string;
  mtime?: number;
  size?: number;
  duration?: number;
  /** The file's own audio format, when the scan could read it. See {@link TrackSourceFormat}. */
  format?: TrackSourceFormat | null;
  /** Disc and track number; zero for one the scan looked for and did not find. */
  discNo?: number;
  trackNo?: number;
}

/**
 * A file's native audio format, as the scanner found it.
 *
 * Recorded so the engine can skip a resample that would not change anything: without it a local file
 * reaches the arg builder as an unknown quantity, `isBitPerfect` cannot clear its first guard, and a
 * FLAC that already matches the output gets run through soxr and dithered for nothing.
 *
 * `bitDepth` is null for lossy codecs, which have no original depth to preserve — the same contract
 * as `ProbedSourceFormat`, so the two are interchangeable to a caller.
 */
export interface TrackSourceFormat {
  codec: string;
  sampleRate: number;
  channels: number;
  bitDepth: 16 | 24 | 32 | null;
  lossless: boolean;
}

export interface StoredTrack {
  id: number;
  storage_id: string;
  rel_path: string;
  title: string;
  album: string;
  artist: string;
  album_artist: string;
  audiopath: string;
  cover?: string | null;
  mtime?: number | null;
  size?: number | null;
  duration?: number | null;
  /** Null on rows written before the format columns existed — see `getSourceFormat`. */
  codec?: string | null;
  sample_rate?: number | null;
  bit_depth?: number | null;
  channels?: number | null;
  lossless?: number | null;
  /** Null on rows written before the scan read positions; zero when it looked and found none. */
  disc_no?: number | null;
  track_no?: number | null;
}

/**
 * An album in the order it was made: disc, then track.
 *
 * The folder sits between the two. Discs that are told apart only by living in separate folders
 * carry no disc number at all, and without it their tracks would interleave — 1, 1, 2, 2 — where
 * sorting by path used to keep them whole. A track with no number goes after the numbered ones,
 * in path order, which is all the order it has.
 */
const ALBUM_TRACK_ORDER = `
  COALESCE(NULLIF(disc_no, 0), 1),
  LOWER(rtrim(rel_path, replace(rel_path, '/', ''))),
  COALESCE(NULLIF(track_no, 0), 1000000),
  LOWER(rel_path)`;

export interface PagedResult<T> {
  total: number;
  items: T[];
}

export interface AlbumRow {
  storage_id: string;
  album: string;
  artist: string;
  track_count: number;
  cover: string | null;
  rel_path: string | null;
}

export interface AlbumCoverRow {
  storage_id: string;
  album: string;
  artist: string;
  cover: string | null;
  rel_path: string | null;
  last_mtime: number | null;
}

export interface ArtistRow {
  storage_id: string;
  name: string;
  track_count: number;
  cover: string | null;
  rel_path: string | null;
  last_mtime: number | null;
}

export interface ArtistCoverInsert {
  storageId: string;
  name: string;
  cover: string;
  relPath: string;
  mtime?: number;
}

export interface TrackFileRow {
  storage_id: string;
  rel_path: string;
  cover: string | null;
}

export interface PlaylistRow {
  id: number;
  name: string;
  created_at: number;
  updated_at: number;
  item_count: number;
  cover: string | null;
  rel_path: string | null;
}

export interface PlaylistItemRow {
  playlist_id: number;
  position: number;
  audiopath: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  duration: number | null;
  cover: string | null;
  rel_path: string | null;
}

export interface PlaylistItemInsert {
  audiopath: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  cover?: string;
  relPath?: string;
}

export class LocalLibraryStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  // Schema versions for `PRAGMA user_version`.
  private static readonly SCHEMA_V2 = 2; // adds FTS5 search table + triggers
  private static readonly SCHEMA_V3 = 3; // adds album artist for album grouping
  private static readonly SCHEMA_V4 = 4; // adds artist_covers sidecar table
  private static readonly SCHEMA_V5 = 5; // adds user-editable playlists
  private static readonly SCHEMA_V6 = 6; // adds materialized album rollup
  private static readonly SCHEMA_V7 = 7; // adds track_waveforms sidecar table
  private static readonly SCHEMA_V8 = 8; // adds the source audio format on tracks

  public constructor(options: { dbPath?: string } = {}) {
    this.dbPath = options.dbPath ?? resolveDataDir('music', 'library.db');
  }

  public async init(): Promise<void> {
    await ensureDir(path.dirname(this.dbPath));
    if (this.db) {
      return;
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.migrate();
  }

  public reset(): void {
    const db = this.requireDb();
    db.exec('DELETE FROM tracks;');
    db.exec('DELETE FROM artist_covers;');
    db.exec('DELETE FROM album_rollup;');
  }

  public upsertArtistCover(entry: ArtistCoverInsert): void {
    const db = this.requireDb();
    db.prepare(
      `
      INSERT INTO artist_covers (storage_id, name, cover, rel_path, last_mtime)
      VALUES (@storageId, @name, @cover, @relPath, @mtime)
      ON CONFLICT(storage_id, name) DO UPDATE SET
        cover = excluded.cover,
        rel_path = excluded.rel_path,
        last_mtime = excluded.last_mtime
    `,
    ).run({
      storageId: entry.storageId,
      name: entry.name,
      cover: entry.cover,
      relPath: entry.relPath,
      mtime: typeof entry.mtime === 'number' ? entry.mtime : null,
    });
  }

  /**
   * A stored waveform, or null when there is none for this exact file.
   *
   * The size and mtime are compared rather than trusted: the row is keyed by path, and a path is not
   * a promise about its contents. A caller that cannot stat the file passes nothing and gets whatever
   * is stored, which is the right trade for a picture.
   */
  public getWaveform(
    path: string,
    file?: { size: number; mtimeMs: number },
  ): { buckets: Uint8Array; durationMs: number | null } | null {
    const db = this.requireDb();
    const row = db
      .prepare(
        'SELECT buckets, duration_ms AS durationMs, file_size AS fileSize, file_mtime AS fileMtime'
        + ' FROM track_waveforms WHERE path = ?',
      )
      .get(path) as
      | { buckets: Buffer; durationMs: number | null; fileSize: number | null; fileMtime: number | null }
      | undefined;
    if (!row) {
      return null;
    }
    if (file && row.fileSize !== null && row.fileMtime !== null) {
      const changed = row.fileSize !== file.size || row.fileMtime !== Math.round(file.mtimeMs);
      if (changed) {
        return null;
      }
    }
    return { buckets: new Uint8Array(row.buckets), durationMs: row.durationMs };
  }

  public upsertWaveform(entry: {
    path: string;
    buckets: Uint8Array;
    durationMs: number | null;
    file?: { size: number; mtimeMs: number };
  }): void {
    const db = this.requireDb();
    db.prepare(
      `
      INSERT INTO track_waveforms (path, buckets, duration_ms, file_size, file_mtime, computed_at)
      VALUES (@path, @buckets, @durationMs, @fileSize, @fileMtime, @computedAt)
      ON CONFLICT(path) DO UPDATE SET
        buckets = excluded.buckets,
        duration_ms = excluded.duration_ms,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        computed_at = excluded.computed_at
    `,
    ).run({
      path: entry.path,
      buckets: Buffer.from(entry.buckets),
      durationMs: entry.durationMs,
      fileSize: entry.file?.size ?? null,
      fileMtime: entry.file ? Math.round(entry.file.mtimeMs) : null,
      computedAt: Date.now(),
    });
  }

  public insertTrack(track: TrackInsert): void {
    const db = this.requireDb();
    const params = {
      ...track,
      albumArtist: normalizeGroupArtist(track.albumArtist || track.artist),
      codec: track.format?.codec ?? null,
      sampleRate: track.format?.sampleRate ?? null,
      bitDepth: track.format?.bitDepth ?? null,
      channels: track.format?.channels ?? null,
      lossless: track.format ? (track.format.lossless ? 1 : 0) : null,
      discNo: track.discNo ?? 0,
      trackNo: track.trackNo ?? 0,
    };
    // A retag can move a track to a different album artist; the group it left
    // has to be recomputed too or it keeps a row with a stale track count.
    const previous = db
      .prepare(
        `SELECT ${ALBUM_GROUP_EXPR} AS group_artist FROM tracks WHERE storage_id = ? AND rel_path = ?`,
      )
      .get(track.storageId, track.relPath) as { group_artist: string } | undefined;
    const stmt = db.prepare(`
      INSERT INTO tracks (storage_id, rel_path, title, album, artist, album_artist, audiopath, cover, mtime, size, duration,
        codec, sample_rate, bit_depth, channels, lossless, disc_no, track_no)
      VALUES (@storageId, @relPath, @title, @album, @artist, @albumArtist, @audiopath, @cover, @mtime, @size, @duration,
        @codec, @sampleRate, @bitDepth, @channels, @lossless, @discNo, @trackNo)
      ON CONFLICT(storage_id, rel_path) DO UPDATE SET
        title = excluded.title,
        album = excluded.album,
        artist = excluded.artist,
        album_artist = excluded.album_artist,
        audiopath = excluded.audiopath,
        cover = excluded.cover,
        mtime = excluded.mtime,
        size = excluded.size,
        duration = excluded.duration,
        codec = excluded.codec,
        sample_rate = excluded.sample_rate,
        bit_depth = excluded.bit_depth,
        channels = excluded.channels,
        lossless = excluded.lossless,
        disc_no = excluded.disc_no,
        track_no = excluded.track_no
    `);
    stmt.run(params);
    // Keep the rollup in step with the row just written, so a caller that inserts
    // and immediately browses sees its track. A bulk scan still calls
    // rebuildAlbumRollup() once at the end, which is cheaper than N of these.
    const groupArtist = normalizeGroupArtist(params.albumArtist);
    this.refreshAlbumRollupFor(params.storageId, groupArtist);
    if (previous && previous.group_artist !== groupArtist) {
      this.refreshAlbumRollupFor(params.storageId, previous.group_artist);
    }
  }

  /**
   * Recomputes the rollup rows for one album group. Deriving from `tracks` rather
   * than incrementing a counter means it cannot drift, and a retag that moves a
   * track between albums leaves no stale row behind.
   */
  private refreshAlbumRollupFor(storageId: string, groupArtist: string): void {
    const db = this.requireDb();
    db.prepare('DELETE FROM album_rollup WHERE storage_id = ? AND artist = ?').run(
      storageId,
      groupArtist,
    );
    db.prepare(
      `
      INSERT INTO album_rollup
        (storage_id, artist, album, track_count, cover, rel_path, last_mtime, sort_album, sort_artist)
      SELECT storage_id, ${ALBUM_GROUP_EXPR}, album, COUNT(*), MAX(NULLIF(cover, '')),
             MIN(rel_path), MAX(mtime), LOWER(album), LOWER(${ALBUM_GROUP_EXPR})
      FROM tracks
      WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ?
      GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
    `,
    ).run(storageId, groupArtist);
  }

  public getStats(): { tracks: number; albums: number; artists: number } {
    const db = this.requireDb();
    const trackCount = db.prepare('SELECT COUNT(*) AS count FROM tracks').get() as { count: number };
    const albumCount = db
      .prepare('SELECT COUNT(*) AS count FROM album_rollup')
      .get() as { count: number };
    const artistCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks GROUP BY storage_id, artist)',
      )
      .get() as { count: number };
    return { tracks: trackCount.count, albums: albumCount.count, artists: artistCount.count };
  }

  public getStatsForStorage(storageId: string): { tracks: number; albums: number; artists: number } {
    const db = this.requireDb();
    const trackCount = db
      .prepare('SELECT COUNT(*) AS count FROM tracks WHERE storage_id = ?')
      .get(storageId) as { count: number };
    const albumCount = db
      .prepare('SELECT COUNT(*) AS count FROM album_rollup WHERE storage_id = ?')
      .get(storageId) as { count: number };
    const artistCount = db
      .prepare(
        'SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks WHERE storage_id = ? GROUP BY storage_id, artist)',
      )
      .get(storageId) as { count: number };
    return { tracks: trackCount.count, albums: albumCount.count, artists: artistCount.count };
  }

  /**
   * Served from {@link rebuildAlbumRollup}'s table: an indexed range scan with no
   * grouping and no sort, so paging stays flat however deep it goes.
   */
  public getAlbums(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<AlbumRow> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM album_rollup ${where}`)
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `
        SELECT storage_id, album, artist, track_count, cover, rel_path
        FROM album_rollup
        ${where}
        ORDER BY sort_album, sort_artist
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as AlbumRow[];

    return { total: total.count, items: rows };
  }

  public getAlbumCoverSamples(limit: number): AlbumCoverRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, album, ${ALBUM_GROUP_EXPR} AS artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
        ORDER BY last_mtime DESC, LOWER(album)
        LIMIT ?
      `,
      )
      .all(limit) as AlbumCoverRow[];
  }

  public getAlbumCoverSamplesForStorage(storageId: string, limit: number): AlbumCoverRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, album, ${ALBUM_GROUP_EXPR} AS artist,
          MAX(NULLIF(cover, '')) AS cover,
          MIN(rel_path) AS rel_path,
          MAX(mtime) AS last_mtime
        FROM tracks
        WHERE storage_id = ?
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
        ORDER BY last_mtime DESC, LOWER(album)
        LIMIT ?
      `,
      )
      .all(storageId, limit) as AlbumCoverRow[];
  }

  /**
   * Artists with no stored cover, and one track path each to locate their folder.
   *
   * Drives the background artist-art fetch after a scan. Only artists that
   * actually need a picture are returned, so a second scan does no lookups.
   */
  public listArtistsWithoutCover(limit: number): Array<{
    storage_id: string;
    name: string;
    rel_path: string;
  }> {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT t.storage_id, t.artist AS name, MIN(t.rel_path) AS rel_path
        FROM tracks t
        LEFT JOIN artist_covers ac
          ON ac.storage_id = t.storage_id AND ac.name = t.artist
        WHERE ac.name IS NULL AND TRIM(t.artist) <> ''
        GROUP BY t.storage_id, t.artist
        ORDER BY COUNT(*) DESC
        LIMIT ?
      `,
      )
      .all(limit) as Array<{ storage_id: string; name: string; rel_path: string }>;
  }

  public getArtists(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<ArtistRow> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count FROM (SELECT storage_id, artist FROM tracks ${where} GROUP BY storage_id, artist)`,
      )
      .get(...params) as { count: number };

    const rows = db
      .prepare(
        `
        SELECT t.storage_id AS storage_id,
               t.artist AS name,
               COUNT(*) AS track_count,
               ac.cover AS cover,
               ac.rel_path AS rel_path,
               ac.last_mtime AS last_mtime
        FROM tracks t
        LEFT JOIN artist_covers ac
          ON ac.storage_id = t.storage_id AND ac.name = t.artist
        ${where ? where.replace(/storage_id/g, 't.storage_id') : ''}
        GROUP BY t.storage_id, t.artist
        ORDER BY LOWER(t.artist)
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as ArtistRow[];

    return { total: total.count, items: rows };
  }

  public getArtist(storageId: string, name: string): ArtistRow | null {
    const db = this.requireDb();
    const row = db
      .prepare(
        `
        SELECT t.storage_id AS storage_id,
               t.artist AS name,
               COUNT(*) AS track_count,
               ac.cover AS cover,
               ac.rel_path AS rel_path,
               ac.last_mtime AS last_mtime
        FROM tracks t
        LEFT JOIN artist_covers ac
          ON ac.storage_id = t.storage_id AND ac.name = t.artist
        WHERE t.storage_id = ? AND t.artist = ?
        GROUP BY t.storage_id, t.artist
      `,
      )
      .get(storageId, name) as ArtistRow | undefined;
    return row ?? null;
  }

  public getTracks(
    storageId: string | null,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const params: (string | number)[] = [];
    let where = '';
    if (storageId) {
      where = 'WHERE storage_id = ?';
      params.push(storageId);
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS count FROM tracks ${where}`)
      .get(...params) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        ${where}
        ORDER BY LOWER(artist), LOWER(album), LOWER(title)
        LIMIT ? OFFSET ?
      `,
      )
      .all(...params, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public getTracksForAlbum(
    storageId: string,
    albumArtist: string,
    album: string,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM tracks
         WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?`,
      )
      .get(storageId, albumArtist, album) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?
        ORDER BY ${ALBUM_TRACK_ORDER}
        LIMIT ? OFFSET ?
      `,
      )
      .all(storageId, albumArtist, album, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public getTracksForArtist(
    storageId: string,
    artist: string,
    offset: number,
    limit: number,
  ): PagedResult<StoredTrack> {
    const db = this.requireDb();
    const total = db
      .prepare(
        'SELECT COUNT(*) AS count FROM tracks WHERE storage_id = ? AND artist = ?',
      )
      .get(storageId, artist) as { count: number };
    const rows = db
      .prepare(
        `
        SELECT * FROM tracks
        WHERE storage_id = ? AND artist = ?
        ORDER BY LOWER(album), ${ALBUM_TRACK_ORDER}
        LIMIT ? OFFSET ?
      `,
      )
      .all(storageId, artist, limit, offset) as StoredTrack[];
    return { total: total.count, items: rows };
  }

  public findByAudiopath(audiopath: string): StoredTrack | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM tracks WHERE audiopath = ? LIMIT 1')
      .get(audiopath) as StoredTrack | undefined;
    return row ?? null;
  }

  /**
   * The recorded native format of a track, or null when it cannot be vouched for.
   *
   * This is read on the playback path to let the engine take a bypass, so a *wrong* answer is worse
   * than no answer: a declared format that does not match the file makes `isBitPerfect` clear its
   * guard, leaves the filter chain empty, and lets ffmpeg insert its own resampler with default
   * options — a silent conversion in place of the described one. Null keeps the old behaviour, which
   * is merely a resample nobody needed.
   *
   * So the row is only believed while it still describes the file on disk. `mtime` and `size` were
   * already recorded per track; comparing them costs one stat and catches the case the scan cannot:
   * a file re-encoded in place between scans.
   *
   * Keyed on `rel_path` rather than the audiopath, because the caller is the playback path and what
   * it holds is a file path. `rel_path` already carries its storage prefix (`local/…`, `nas/<id>/…`),
   * so it identifies a file across storages on its own.
   *
   * @param absolutePath Where the file actually is, for the staleness check. Omit to skip it.
   */
  public getSourceFormat(relPath: string, absolutePath?: string): TrackSourceFormat | null {
    const db = this.requireDb();
    const row = db
      .prepare(
        'SELECT codec, sample_rate, bit_depth, channels, lossless, mtime, size FROM tracks WHERE rel_path = ? LIMIT 1',
      )
      .get(relPath) as
      | {
          codec: string | null;
          sample_rate: number | null;
          bit_depth: number | null;
          channels: number | null;
          lossless: number | null;
          mtime: number | null;
          size: number | null;
        }
      | undefined;
    if (!row?.codec || !row.sample_rate || !row.channels) {
      return null;
    }
    if (absolutePath && !this.fileStillMatches(absolutePath, row.mtime, row.size)) {
      return null;
    }
    const depth = row.bit_depth;
    return {
      codec: row.codec,
      sampleRate: row.sample_rate,
      channels: row.channels,
      bitDepth: depth === 16 || depth === 24 || depth === 32 ? depth : null,
      lossless: row.lossless === 1,
    };
  }

  private fileStillMatches(
    absolutePath: string,
    mtime: number | null,
    size: number | null,
  ): boolean {
    if (mtime == null || size == null) {
      return false;
    }
    try {
      const stat = statSync(absolutePath);
      // `Math.floor`, because that is how the scan wrote it. Rounding here instead would disagree
      // with the stored value for most files and quietly reject every format this exists to serve.
      return Math.floor(stat.mtimeMs) === mtime && stat.size === size;
    } catch {
      // Unreadable or moved: not something to declare a format for.
      return false;
    }
  }

  public findByStoragePath(storageId: string, relPath: string): StoredTrack | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM tracks WHERE storage_id = ? AND rel_path = ? LIMIT 1')
      .get(storageId, relPath) as StoredTrack | undefined;
    return row ?? null;
  }

  public getTrackFilesForAudiopath(audiopath: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE audiopath = ?
      `,
      )
      .all(audiopath) as TrackFileRow[];
  }

  public getTrackFilesForAlbum(storageId: string, albumArtist: string, album: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?
      `,
      )
      .all(storageId, albumArtist, album) as TrackFileRow[];
  }

  public getTrackFilesForArtist(storageId: string, artist: string): TrackFileRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT storage_id, rel_path, cover
        FROM tracks
        WHERE storage_id = ? AND artist = ?
      `,
      )
      .all(storageId, artist) as TrackFileRow[];
  }

  /** Storage ids that currently have rows, so removed shares can be cleaned up. */
  public listStorageIds(): string[] {
    const db = this.requireDb();
    const rows = db.prepare('SELECT DISTINCT storage_id FROM tracks').all() as Array<{
      storage_id: string;
    }>;
    return rows.map((row) => row.storage_id);
  }

  /**
   * Drops every row for one storage. Used by the rescan to refresh a single
   * storage in isolation, so a share that failed to mount keeps the rows it had
   * instead of being wiped by a whole-table reset.
   */
  public deleteTracksForStorage(storageId: string): number {
    const db = this.requireDb();
    const changes = db.prepare('DELETE FROM tracks WHERE storage_id = ?').run(storageId).changes;
    if (changes > 0) {
      this.rebuildAlbumRollup();
    }
    return changes;
  }

  /**
   * Removes rows for a storage that the current scan did not see — the files were
   * deleted or moved while the server was not looking. `seenRelPaths` must be the
   * complete set the scan just indexed for that storage.
   */
  public deleteTracksMissingFrom(storageId: string, seenRelPaths: Set<string>): number {
    const db = this.requireDb();
    const existing = db
      .prepare('SELECT rel_path FROM tracks WHERE storage_id = ?')
      .all(storageId) as Array<{ rel_path: string }>;
    const stale = existing.filter((row) => !seenRelPaths.has(row.rel_path));
    if (stale.length === 0) {
      return 0;
    }
    const stmt = db.prepare('DELETE FROM tracks WHERE storage_id = ? AND rel_path = ?');
    const run = db.transaction((rows: Array<{ rel_path: string }>) => {
      for (const row of rows) {
        stmt.run(storageId, row.rel_path);
      }
    });
    run(stale);
    this.rebuildAlbumRollup();
    return stale.length;
  }

  /** Wraps a batch of writes in one transaction. A rescan otherwise commits per track. */
  public transaction<T>(fn: () => T): T {
    const db = this.requireDb();
    return db.transaction(fn)();
  }

  /**
   * Truncates the WAL and refreshes planner statistics. Called after a scan: a
   * full rescan writes a large WAL that nothing else reclaims, which matters on
   * the SD cards these servers usually run from.
   */
  public checkpoint(): void {
    const db = this.requireDb();
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('optimize');
    } catch {
      // Housekeeping only — never fail a scan over it.
    }
  }

  public deleteTracksByAudiopath(audiopath: string): number {
    const db = this.requireDb();
    const result = db.prepare('DELETE FROM tracks WHERE audiopath = ?').run(audiopath);
    if (result.changes > 0) {
      this.rebuildAlbumRollup();
    }
    return result.changes;
  }

  public deleteTracksForAlbum(storageId: string, albumArtist: string, album: string): number {
    const db = this.requireDb();
    const result = db
      .prepare(`DELETE FROM tracks WHERE storage_id = ? AND ${ALBUM_GROUP_EXPR} = ? AND album = ?`)
      .run(storageId, albumArtist, album);
    if (result.changes > 0) {
      this.rebuildAlbumRollup();
    }
    return result.changes;
  }

  public deleteTracksForArtist(storageId: string, artist: string): number {
    const db = this.requireDb();
    const result = db
      .prepare('DELETE FROM tracks WHERE storage_id = ? AND artist = ?')
      .run(storageId, artist);
    if (result.changes > 0) {
      this.rebuildAlbumRollup();
    }
    return result.changes;
  }

  public searchTracks(query: string, limit: number): StoredTrack[] {
    const db = this.requireDb();
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.* FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?
            ORDER BY LOWER(t.artist), LOWER(t.album), LOWER(t.title)
            LIMIT ?
          `,
          )
          .all(fts, limit) as StoredTrack[];
      } catch {
        // FTS missing/disabled; fall back to LIKE.
      }
    }

    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
          SELECT * FROM tracks
          WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?
          ORDER BY LOWER(artist), LOWER(album), LOWER(title)
          LIMIT ?
        `,
      )
      .all(like, like, like, limit) as StoredTrack[];
  }

  public searchAlbums(query: string, limit: number): AlbumRow[] {
    const db = this.requireDb();
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.storage_id,
                   t.album,
                   ${ALBUM_GROUP_EXPR_T} AS artist,
                   COUNT(*) AS track_count,
                   MAX(t.cover) AS cover,
                   MAX(t.rel_path) AS rel_path
            FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            WHERE tracks_fts MATCH ?
            GROUP BY t.storage_id, ${ALBUM_GROUP_EXPR_T}, t.album
            ORDER BY LOWER(${ALBUM_GROUP_EXPR_T}), LOWER(t.album)
            LIMIT ?
          `,
          )
          .all(fts, limit) as AlbumRow[];
      } catch {
        // fall back to LIKE
      }
    }

    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
          SELECT storage_id,
                 album,
                 ${ALBUM_GROUP_EXPR} AS artist,
                 COUNT(*) AS track_count,
                 MAX(cover) AS cover,
                 MAX(rel_path) AS rel_path
          FROM tracks
          WHERE LOWER(album) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album_artist) LIKE ?
          GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album
          ORDER BY LOWER(${ALBUM_GROUP_EXPR}), LOWER(album)
          LIMIT ?
        `,
      )
      .all(like, like, like, limit) as AlbumRow[];
  }

  public searchArtists(query: string, limit: number): ArtistRow[] {
    const db = this.requireDb();
    const fts = this.toFtsQuery(query);
    if (fts) {
      try {
        return db
          .prepare(
            `
            SELECT t.storage_id AS storage_id,
                   t.artist AS name,
                   COUNT(*) AS track_count,
                   ac.cover AS cover,
                   ac.rel_path AS rel_path,
                   ac.last_mtime AS last_mtime
            FROM tracks_fts
            JOIN tracks t ON t.id = tracks_fts.rowid
            LEFT JOIN artist_covers ac
              ON ac.storage_id = t.storage_id AND ac.name = t.artist
            WHERE tracks_fts MATCH ?
            GROUP BY t.storage_id, t.artist
            ORDER BY LOWER(t.artist)
            LIMIT ?
          `,
          )
          .all(fts, limit) as ArtistRow[];
      } catch {
        // fall back to LIKE
      }
    }

    const like = `%${query.toLowerCase()}%`;
    return db
      .prepare(
        `
          SELECT t.storage_id AS storage_id,
                 t.artist AS name,
                 COUNT(*) AS track_count,
                 ac.cover AS cover,
                 ac.rel_path AS rel_path,
                 ac.last_mtime AS last_mtime
          FROM tracks t
          LEFT JOIN artist_covers ac
            ON ac.storage_id = t.storage_id AND ac.name = t.artist
          WHERE LOWER(t.artist) LIKE ?
          GROUP BY t.storage_id, t.artist
          ORDER BY LOWER(t.artist)
          LIMIT ?
        `,
      )
      .all(like, limit) as ArtistRow[];
  }

  private migrate(): void {
    const db = this.requireDb();
    const baseSchema = `
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        album TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_artist TEXT NOT NULL DEFAULT '',
        audiopath TEXT NOT NULL,
        cover TEXT,
        mtime INTEGER,
        size INTEGER,
        duration REAL,
        UNIQUE(storage_id, rel_path)
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_storage ON tracks(storage_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(storage_id, album);
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(storage_id, artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_audiopath ON tracks(audiopath);
    `;
    db.exec(baseSchema);

    db.exec(`
      CREATE TABLE IF NOT EXISTS artist_covers (
        storage_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cover TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        last_mtime INTEGER,
        PRIMARY KEY (storage_id, name)
      );
    `);

    const userVersion = Number(db.pragma('user_version', { simple: true }) ?? 0);
    this.ensureAlbumArtistColumn(db);
    this.ensureTrackFormatColumns(db);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_album_artist ON tracks(storage_id, album_artist, album);');
    db.exec('UPDATE tracks SET album_artist = artist WHERE NULLIF(TRIM(album_artist), \'\') IS NULL;');

    // Add FTS-backed searching for large libraries. If FTS5 is unavailable, we keep the LIKE fallback.
    if (userVersion >= LocalLibraryStore.SCHEMA_V2 && userVersion < LocalLibraryStore.SCHEMA_V3) {
      this.recreateFts(db);
    } else if (userVersion < LocalLibraryStore.SCHEMA_V2) {
      const enabled = this.tryEnableFts(db);
      if (enabled) {
        // Build the index once for existing databases.
        try {
          db.exec('INSERT INTO tracks_fts(tracks_fts) VALUES(\'rebuild\');');
        } catch {
          /* ignore */
        }
      }
    } else {
      // Ensure the virtual table still exists even if user_version was bumped previously.
      this.tryEnableFts(db);
    }

    if (userVersion < LocalLibraryStore.SCHEMA_V4) {
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V4}`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS local_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_playlist_items (
        playlist_id INTEGER NOT NULL REFERENCES local_playlists(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        audiopath TEXT NOT NULL,
        title TEXT,
        artist TEXT,
        album TEXT,
        duration INTEGER,
        cover TEXT,
        rel_path TEXT,
        PRIMARY KEY (playlist_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON local_playlist_items(playlist_id);
    `);

    if (userVersion < LocalLibraryStore.SCHEMA_V5) {
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V5}`);
    }

    // Album browse used to GROUP BY an expression over two columns, which no
    // index can satisfy: every page built two temp b-trees over the whole table
    // (~100ms per page at 100k tracks, and worse the deeper you paged). The
    // rollup below is derived data — rebuilt from `tracks` after every scan — but
    // it turns that into a single indexed range scan (~0.1ms, flat with depth).
    // Sort keys are materialized too, so ORDER BY needs no sort at all.
    db.exec(`
      CREATE TABLE IF NOT EXISTS album_rollup (
        storage_id TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        track_count INTEGER NOT NULL,
        cover TEXT,
        rel_path TEXT,
        last_mtime INTEGER,
        sort_album TEXT NOT NULL,
        sort_artist TEXT NOT NULL,
        PRIMARY KEY (storage_id, artist, album)
      );
      CREATE INDEX IF NOT EXISTS idx_album_rollup_sort
        ON album_rollup(storage_id, sort_album, sort_artist);
      CREATE INDEX IF NOT EXISTS idx_album_rollup_recent
        ON album_rollup(storage_id, last_mtime DESC);
    `);

    if (userVersion < LocalLibraryStore.SCHEMA_V6) {
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V6}`);
      // Existing databases get their rollup filled immediately, so the first
      // browse after an upgrade is not empty.
      this.rebuildAlbumRollup();
    }

    /*
     * Prepared waveforms, keyed by the file they were computed from.
     *
     * A sidecar rather than a column on `tracks`, for the same reason `artist_covers` is one: a scan
     * rewrites `tracks`, and an envelope that took a whole-file decode to produce should not be thrown
     * away because the folder was rescanned. Keyed by the *file* rather than by an audiopath, which is
     * what makes it one row per track: the same file is addressed as a raw `library://` path and as an
     * opaque browse id, and both must find the shape the other computed. It also covers a file that is
     * not in the index at all — a share that has not been scanned yet still gets a waveform the first
     * time it is played.
     *
     * `file_size` and `file_mtime` are the invalidation: a re-encoded or replaced file keeps its path,
     * and serving the old shape for new audio is worse than having none.
     */
    db.exec(`
      CREATE TABLE IF NOT EXISTS track_waveforms (
        path TEXT PRIMARY KEY,
        buckets BLOB NOT NULL,
        duration_ms INTEGER,
        file_size INTEGER,
        file_mtime INTEGER,
        computed_at INTEGER NOT NULL
      );
    `);

    if (userVersion < LocalLibraryStore.SCHEMA_V7) {
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V7}`);
    }
    if (userVersion < LocalLibraryStore.SCHEMA_V8) {
      // The columns themselves are added by ensureTrackFormatColumns, which runs unconditionally;
      // this only records how far the schema has come.
      db.pragma(`user_version = ${LocalLibraryStore.SCHEMA_V8}`);
    }
  }

  /**
   * Rebuilds the album rollup from `tracks`.
   *
   * Cheap enough to do wholesale (~290ms at 100k tracks) and simple enough to be
   * obviously correct, which beats incrementally patching rows and drifting out
   * of sync. Callers run it once at the end of a scan, not per track.
   */
  public rebuildAlbumRollup(): void {
    const db = this.requireDb();
    const rebuild = db.transaction(() => {
      db.exec('DELETE FROM album_rollup;');
      db.exec(`
        INSERT INTO album_rollup
          (storage_id, artist, album, track_count, cover, rel_path, last_mtime, sort_album, sort_artist)
        SELECT storage_id,
               ${ALBUM_GROUP_EXPR} AS artist,
               album,
               COUNT(*),
               MAX(NULLIF(cover, '')),
               MIN(rel_path),
               MAX(mtime),
               LOWER(album),
               LOWER(${ALBUM_GROUP_EXPR})
        FROM tracks
        GROUP BY storage_id, ${ALBUM_GROUP_EXPR}, album;
      `);
    });
    rebuild();
  }

  // -- Playlists ----------------------------------------------------------------

  public createPlaylist(name: string): PlaylistRow {
    const db = this.requireDb();
    const now = Date.now();
    const result = db
      .prepare('INSERT INTO local_playlists (name, created_at, updated_at) VALUES (?, ?, ?)')
      .run(name, now, now);
    const id = Number(result.lastInsertRowid);
    return {
      id,
      name,
      created_at: now,
      updated_at: now,
      item_count: 0,
      cover: null,
      rel_path: null,
    };
  }

  public renamePlaylist(id: number, name: string): boolean {
    const db = this.requireDb();
    const result = db
      .prepare('UPDATE local_playlists SET name = ?, updated_at = ? WHERE id = ?')
      .run(name, Date.now(), id);
    return result.changes > 0;
  }

  public deletePlaylist(id: number): boolean {
    const db = this.requireDb();
    const tx = db.transaction((pid: number) => {
      db.prepare('DELETE FROM local_playlist_items WHERE playlist_id = ?').run(pid);
      const r = db.prepare('DELETE FROM local_playlists WHERE id = ?').run(pid);
      return r.changes > 0;
    });
    return tx(id);
  }

  public getPlaylist(id: number): PlaylistRow | null {
    const db = this.requireDb();
    const row = db
      .prepare(
        `
        SELECT p.id, p.name, p.created_at, p.updated_at,
          (SELECT COUNT(*) FROM local_playlist_items WHERE playlist_id = p.id) AS item_count,
          (SELECT cover FROM local_playlist_items WHERE playlist_id = p.id AND cover IS NOT NULL ORDER BY position LIMIT 1) AS cover,
          (SELECT rel_path FROM local_playlist_items WHERE playlist_id = p.id AND cover IS NOT NULL ORDER BY position LIMIT 1) AS rel_path
        FROM local_playlists p
        WHERE p.id = ?
      `,
      )
      .get(id) as PlaylistRow | undefined;
    return row ?? null;
  }

  public listPlaylists(offset: number, limit: number): PagedResult<PlaylistRow> {
    const db = this.requireDb();
    const total = db.prepare('SELECT COUNT(*) AS count FROM local_playlists').get() as {
      count: number;
    };
    const items = db
      .prepare(
        `
        SELECT p.id, p.name, p.created_at, p.updated_at,
          (SELECT COUNT(*) FROM local_playlist_items WHERE playlist_id = p.id) AS item_count,
          (SELECT cover FROM local_playlist_items WHERE playlist_id = p.id AND cover IS NOT NULL ORDER BY position LIMIT 1) AS cover,
          (SELECT rel_path FROM local_playlist_items WHERE playlist_id = p.id AND cover IS NOT NULL ORDER BY position LIMIT 1) AS rel_path
        FROM local_playlists p
        ORDER BY LOWER(p.name)
        LIMIT ? OFFSET ?
      `,
      )
      .all(limit, offset) as PlaylistRow[];
    return { total: total.count, items };
  }

  public getPlaylistItems(id: number, offset: number, limit: number): PagedResult<PlaylistItemRow> {
    const db = this.requireDb();
    const total = db
      .prepare('SELECT COUNT(*) AS count FROM local_playlist_items WHERE playlist_id = ?')
      .get(id) as { count: number };
    const items = db
      .prepare(
        `
        SELECT playlist_id, position, audiopath, title, artist, album, duration, cover, rel_path
        FROM local_playlist_items
        WHERE playlist_id = ?
        ORDER BY position
        LIMIT ? OFFSET ?
      `,
      )
      .all(id, limit, offset) as PlaylistItemRow[];
    return { total: total.count, items };
  }

  public getAllPlaylistItems(id: number): PlaylistItemRow[] {
    const db = this.requireDb();
    return db
      .prepare(
        `
        SELECT playlist_id, position, audiopath, title, artist, album, duration, cover, rel_path
        FROM local_playlist_items
        WHERE playlist_id = ?
        ORDER BY position
      `,
      )
      .all(id) as PlaylistItemRow[];
  }

  public appendPlaylistItems(id: number, items: PlaylistItemInsert[]): number {
    if (items.length === 0) {
      return 0;
    }
    const db = this.requireDb();
    const tx = db.transaction((pid: number, entries: PlaylistItemInsert[]) => {
      const maxRow = db
        .prepare('SELECT COALESCE(MAX(position), -1) AS max FROM local_playlist_items WHERE playlist_id = ?')
        .get(pid) as { max: number };
      let nextPos = maxRow.max + 1;
      const insert = db.prepare(`
        INSERT INTO local_playlist_items
          (playlist_id, position, audiopath, title, artist, album, duration, cover, rel_path)
        VALUES (@playlist_id, @position, @audiopath, @title, @artist, @album, @duration, @cover, @rel_path)
      `);
      for (const entry of entries) {
        insert.run({
          playlist_id: pid,
          position: nextPos,
          audiopath: entry.audiopath,
          title: entry.title ?? null,
          artist: entry.artist ?? null,
          album: entry.album ?? null,
          duration: typeof entry.duration === 'number' ? Math.round(entry.duration) : null,
          cover: entry.cover ?? null,
          rel_path: entry.relPath ?? null,
        });
        nextPos += 1;
      }
      db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pid);
      return entries.length;
    });
    return tx(id, items);
  }

  public removePlaylistItem(id: number, position: number): boolean {
    const db = this.requireDb();
    const tx = db.transaction((pid: number, pos: number) => {
      const result = db
        .prepare('DELETE FROM local_playlist_items WHERE playlist_id = ? AND position = ?')
        .run(pid, pos);
      if (result.changes === 0) {
        return false;
      }
      // Compact positions above the removed one.
      db.prepare(
        `UPDATE local_playlist_items
         SET position = position - 1
         WHERE playlist_id = ? AND position > ?`,
      ).run(pid, pos);
      db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pid);
      return true;
    });
    return tx(id, position);
  }

  public movePlaylistItem(id: number, from: number, to: number): boolean {
    const db = this.requireDb();
    const tx = db.transaction((pid: number, fromPos: number, toPos: number) => {
      const item = db
        .prepare('SELECT * FROM local_playlist_items WHERE playlist_id = ? AND position = ?')
        .get(pid, fromPos) as PlaylistItemRow | undefined;
      if (!item) {
        return false;
      }
      db.prepare('DELETE FROM local_playlist_items WHERE playlist_id = ? AND position = ?').run(
        pid,
        fromPos,
      );
      if (toPos > fromPos) {
        db.prepare(
          `UPDATE local_playlist_items
           SET position = position - 1
           WHERE playlist_id = ? AND position > ? AND position <= ?`,
        ).run(pid, fromPos, toPos);
      } else {
        db.prepare(
          `UPDATE local_playlist_items
           SET position = position + 1
           WHERE playlist_id = ? AND position >= ? AND position < ?`,
        ).run(pid, toPos, fromPos);
      }
      db.prepare(
        `INSERT INTO local_playlist_items
           (playlist_id, position, audiopath, title, artist, album, duration, cover, rel_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        pid,
        toPos,
        item.audiopath,
        item.title,
        item.artist,
        item.album,
        item.duration,
        item.cover,
        item.rel_path,
      );
      db.prepare('UPDATE local_playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pid);
      return true;
    });
    return tx(id, from, to);
  }

  private ensureAlbumArtistColumn(db: Database.Database): void {
    const columns = db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'album_artist')) {
      db.exec('ALTER TABLE tracks ADD COLUMN album_artist TEXT NOT NULL DEFAULT \'\';');
    }
  }

  /**
   * Add the source-format columns to an existing database.
   *
   * Idempotent and unconditional, like `ensureAlbumArtistColumn`: a `user_version` bump alone cannot
   * be trusted to mean the columns exist, since a database may have been created by a newer schema
   * and then opened by an older build. Existing rows keep NULLs and simply read as undeclared until
   * the next scan fills them in — which is the same state they are in today, so nothing regresses
   * while a library is still unscanned.
   */
  private ensureTrackFormatColumns(db: Database.Database): void {
    const columns = db.prepare('PRAGMA table_info(tracks)').all() as Array<{ name: string }>;
    const present = new Set(columns.map((column) => column.name));
    const additions: Array<[string, string]> = [
      ['codec', 'TEXT'],
      ['sample_rate', 'INTEGER'],
      ['bit_depth', 'INTEGER'],
      ['channels', 'INTEGER'],
      ['lossless', 'INTEGER'],
      // Not a format, but the same story: only the file knows, so old rows wait for a re-read.
      ['disc_no', 'INTEGER'],
      ['track_no', 'INTEGER'],
    ];
    for (const [name, type] of additions) {
      if (!present.has(name)) {
        db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type};`);
      }
    }
  }

  private recreateFts(db: Database.Database): boolean {
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS tracks_ai;
        DROP TRIGGER IF EXISTS tracks_ad;
        DROP TRIGGER IF EXISTS tracks_au;
        DROP TABLE IF EXISTS tracks_fts;
      `);
    } catch {
      return false;
    }
    const enabled = this.tryEnableFts(db);
    if (enabled) {
      try {
        db.exec('INSERT INTO tracks_fts(tracks_fts) VALUES(\'rebuild\');');
      } catch {
        /* ignore */
      }
    }
    return enabled;
  }

  private tryEnableFts(db: Database.Database): boolean {
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts
        USING fts5(title, album, artist, album_artist, content='tracks', content_rowid='id');

        CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
          INSERT INTO tracks_fts(rowid, title, album, artist, album_artist)
          VALUES (new.id, new.title, new.album, new.artist, new.album_artist);
        END;

        CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, album, artist, album_artist)
          VALUES('delete', old.id, old.title, old.album, old.artist, old.album_artist);
        END;

        CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
          INSERT INTO tracks_fts(tracks_fts, rowid, title, album, artist, album_artist)
          VALUES('delete', old.id, old.title, old.album, old.artist, old.album_artist);
          INSERT INTO tracks_fts(rowid, title, album, artist, album_artist)
          VALUES (new.id, new.title, new.album, new.artist, new.album_artist);
        END;
      `);
      // Touch the table to ensure it's usable.
      db.prepare('SELECT 1 FROM tracks_fts LIMIT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private toFtsQuery(query: string): string | null {
    const raw = String(query || '').trim().toLowerCase();
    if (!raw) {
      return null;
    }
    // Unicode-aware: an ASCII-only class would split "Björk" into "bj" + "rk"
    // and match nothing, even though the track is indexed. Letters and numbers
    // in any script count as word characters.
    const tokens = raw.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!tokens.length) {
      return null;
    }
    // Prefix matching keeps "typed as you go" searches responsive.
    return tokens.map((t) => `${t}*`).join(' ');
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('LocalLibraryStore not initialized');
    }
    return this.db;
  }
}

const ALBUM_GROUP_EXPR = 'COALESCE(NULLIF(TRIM(album_artist), \'\'), artist)';
const ALBUM_GROUP_EXPR_T = 'COALESCE(NULLIF(TRIM(t.album_artist), \'\'), t.artist)';

function normalizeGroupArtist(value: string): string {
  const normalized = String(value || '').trim();
  return normalized || 'Unknown Artist';
}
