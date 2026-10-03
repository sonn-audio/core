import type { ContentFolderItem } from '@/ports/ContentTypes';

/**
 * Turning Amazon Music's records into browse rows.
 *
 * Amazon has no single shape for a track: a catalogue lookup nests the artist and album as
 * objects, a search hit flattens them into `artistName`/`albumName`, a user playlist wraps each
 * one in `metadata.requestedMetadata`, and artwork arrives under half a dozen names. Each reader
 * here accepts all of them, so the provider never has to know which endpoint a record came from.
 */

type Raw = Record<string, any>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' ? String(value) : undefined;

/** The record itself, unwrapped from a playlist entry's `metadata(.requestedMetadata)`. */
function unwrap(raw: Raw): Raw {
  if (!raw || typeof raw !== 'object') return {};
  const meta = raw.metadata;
  if (meta && typeof meta === 'object') {
    const requested = meta.requestedMetadata;
    if (requested && typeof requested === 'object') return { ...raw, ...meta, ...requested };
    return { ...raw, ...meta };
  }
  return raw;
}

export function coverOf(raw: Raw): string | undefined {
  const r = unwrap(raw);
  return (
    str(r.album?.image) ??
    str(r.image) ??
    str(r.imageFull) ??
    str(r.albumArt?.url) ??
    str(r.artOriginal?.artUrl) ??
    str(r.artOriginal?.URL) ??
    str(r.artFull?.URL) ??
    str(r.fourSquareArt?.url) ??
    str(r.fourSquareImage?.url) ??
    str(r.albumCoverImageLarge) ??
    str(r.albumCoverImageFull) ??
    str(r.albumArtImageUrl)
  );
}

/** Seconds; some endpoints answer in milliseconds, which no track is long enough to be. */
export function durationOf(raw: Raw): number | undefined {
  const r = unwrap(raw);
  const value = Number(r.duration ?? r.durationSeconds);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 86_400 ? Math.round(value / 1000) : Math.round(value);
}

export function asinOf(raw: Raw): string | undefined {
  const r = unwrap(raw);
  return str(r.asin) ?? str(r.identifier) ?? str(r.trackAsin);
}

function artistNameOf(r: Raw): string {
  return str(r.artist?.name) ?? str(r.artistName) ?? str(r.primaryArtistName) ?? str(r.albumArtistName) ?? '';
}

function withCover(item: ContentFolderItem, cover: string | undefined): ContentFolderItem {
  if (!cover) return item;
  return { ...item, coverurl: cover, thumbnail: cover, hasCover: true };
}

/** Builds rows whose ids carry this account's service-native prefix. */
export class AmazonMusicMapper {
  constructor(private readonly prefix: string) {}

  public uri(kind: 'track' | 'album' | 'artist' | 'playlist', id: string): string {
    return `${this.prefix}:${kind}:${id}`;
  }

  /** A track, or null for a record without an ASIN (nothing to play). */
  public track(raw: Raw, context: { album?: string; cover?: string } = {}): ContentFolderItem | null {
    const r = unwrap(raw);
    const asin = asinOf(r);
    if (!asin) return null;
    const name = str(r.title) ?? str(r.name) ?? 'Track';
    const uri = this.uri('track', asin);
    return withCover(
      {
        id: uri,
        audiopath: uri,
        name,
        title: name,
        artist: artistNameOf(r),
        album: str(r.album?.title) ?? str(r.album?.name) ?? str(r.albumName) ?? context.album ?? '',
        kind: 'track',
        tag: 'track',
        duration: durationOf(r),
        provider: 'amazonmusic',
      },
      coverOf(r) ?? context.cover,
    );
  }

  public album(raw: Raw): ContentFolderItem | null {
    const r = unwrap(raw);
    const asin = str(r.asin) ?? str(r.albumAsin);
    if (!asin) return null;
    const name = str(r.title) ?? str(r.albumName) ?? 'Album';
    const uri = this.uri('album', asin);
    return withCover(
      { id: uri, audiopath: uri, name, title: name, artist: artistNameOf(r), kind: 'album', tag: 'album', provider: 'amazonmusic' },
      coverOf(r),
    );
  }

  public artist(raw: Raw): ContentFolderItem | null {
    const r = unwrap(raw);
    const asin = str(r.asin) ?? str(r.artistAsin);
    if (!asin) return null;
    const name = str(r.name) ?? str(r.title) ?? str(r.artistName) ?? 'Artist';
    const uri = this.uri('artist', asin);
    return withCover(
      { id: uri, audiopath: uri, name, title: name, artist: name, kind: 'artist', tag: 'artist', provider: 'amazonmusic' },
      coverOf(r),
    );
  }

  /** A catalogue playlist (ASIN) or a user playlist (UUID `playlistId`). */
  public playlist(raw: Raw): ContentFolderItem | null {
    const r = unwrap(raw);
    const id = str(r.playlistId) ?? str(r.asin);
    if (!id) return null;
    const name = str(r.title) ?? str(r.name) ?? 'Playlist';
    const owner = str(r.curatedBy) ?? str(r.ownerName) ?? str(r.artistName) ?? '';
    const uri = this.uri('playlist', id);
    return withCover(
      {
        id: uri,
        audiopath: uri,
        name,
        title: name,
        owner,
        owner_id: owner,
        kind: 'playlist',
        tag: 'playlist',
        provider: 'amazonmusic',
      },
      coverOf(r),
    );
  }
}

/** Catalogue playlists are ten-character ASINs; a user playlist is a UUID. */
export function isCatalogPlaylistId(id: string): boolean {
  return /^[A-Z0-9]{10}$/i.test(id);
}
