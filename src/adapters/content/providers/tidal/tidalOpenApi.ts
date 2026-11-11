import type { TidalQuality } from '@/domain/config/types';

/**
 * TIDAL's official API (openapi.tidal.com/v2): JSON:API documents, read the way Music Assistant's
 * provider reads them (jsonapi.py, parsers_v2.py).
 *
 * A token minted for a third-party app — sign-in with PKCE through an app from
 * developer.tidal.com — is refused by the v1 catalogue ("Required scopes: r_usr", a scope such an
 * app cannot get) and by v1 playback. So for those accounts the catalogue and playback go through
 * here. To keep the catalogue provider unchanged, resources are turned into the same shapes the v1
 * API returns (`{ id, title, artist: { name }, album: { title } }`), with the artwork as a URL
 * instead of a v1 image id.
 */

export const TIDAL_OPENAPI_BASE = 'https://openapi.tidal.com/v2';
export const JSONAPI_CONTENT_TYPE = 'application/vnd.api+json';

/** The size the catalogue shows artwork at; the file nearest above it is picked. */
const PREFERRED_IMAGE_WIDTH = 320;

type Resource = {
  id?: string | number;
  type?: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, { data?: Identifier | Identifier[] | null }>;
  meta?: Record<string, any>;
};
type Identifier = { id?: string | number; type?: string; meta?: Record<string, any> };

export class JsonApiDocument {
  private readonly included = new Map<string, Resource>();

  constructor(public readonly raw: { data?: unknown; included?: unknown; links?: { next?: unknown } }) {
    for (const resource of Array.isArray(raw.included) ? (raw.included as Resource[]) : []) {
      if (resource?.type && resource.id != null) this.included.set(`${resource.type}:${resource.id}`, resource);
    }
  }

  get data(): Resource {
    return this.raw.data && !Array.isArray(this.raw.data) && typeof this.raw.data === 'object' ? (this.raw.data as Resource) : {};
  }

  get dataList(): Resource[] {
    return Array.isArray(this.raw.data) ? (this.raw.data as Resource[]) : [];
  }

  /** The opaque cursor of the next page, from `links.next`'s `page[cursor]`; null on the last page. */
  get nextCursor(): string | null {
    const next = this.raw.links?.next;
    if (typeof next !== 'string' || !next) return null;
    try {
      return new URL(next, TIDAL_OPENAPI_BASE).searchParams.get('page[cursor]') || null;
    } catch {
      return null;
    }
  }

  resolve(identifier: Identifier | null | undefined): Resource | null {
    if (!identifier?.type || identifier.id == null) return null;
    return this.included.get(`${identifier.type}:${identifier.id}`) ?? null;
  }

  related(resource: Resource, relationship: string): Resource[] {
    const linkage = resource.relationships?.[relationship]?.data;
    if (!linkage) return [];
    const list = Array.isArray(linkage) ? linkage : [linkage];
    return list.map((id) => this.resolve(id)).filter((r): r is Resource => r !== null);
  }

  relatedOne(resource: Resource, relationship: string): Resource | null {
    return this.related(resource, relationship)[0] ?? null;
  }
}

/** The include paths each request asks for: few enough for the API's cap on included resources. */
export const OPENAPI_INCLUDES = {
  search: {
    track: ['tracks.artists', 'tracks.albums.coverArt'],
    album: ['albums.coverArt'],
    artist: ['artists.profileArt'],
    playlist: ['playlists.coverArt'],
  },
  track: ['artists', 'albums', 'albums.coverArt'],
  albumItems: ['items.artists', 'items.albums.coverArt'],
  artistAlbums: ['albums.artists', 'albums.coverArt'],
  playlistItems: ['items.artists', 'items.albums.coverArt'],
} as const;

/* -------------------------------------------------------------------------- */
/* Catalogue: JSON:API resources in the v1 shapes the provider maps           */
/* -------------------------------------------------------------------------- */

export type V1LikeTrack = {
  id: string;
  title: string;
  duration?: number;
  artist: { name: string };
  album: { title: string };
  coverUrl: string;
};
export type V1LikeAlbum = { id: string; title: string; artist: { name: string }; coverUrl: string };
export type V1LikeArtist = { id: string; name: string; coverUrl: string };
export type V1LikePlaylist = { uuid: string; title: string; creator: { name: string }; coverUrl: string };

export function trackFromResource(doc: JsonApiDocument, resource: Resource): V1LikeTrack {
  const a = resource.attributes ?? {};
  const album = doc.relatedOne(resource, 'albums');
  return {
    id: String(resource.id ?? ''),
    title: withVersion(a.title, a.version) || 'Track',
    duration: parseIsoDuration(a.duration),
    artist: { name: artistNames(doc, resource) },
    album: { title: String(album?.attributes?.title ?? '') },
    coverUrl: album ? imageUrl(doc, album, 'coverArt') : '',
  };
}

export function albumFromResource(doc: JsonApiDocument, resource: Resource): V1LikeAlbum {
  const a = resource.attributes ?? {};
  return {
    id: String(resource.id ?? ''),
    title: withVersion(a.title, a.version) || 'Album',
    artist: { name: artistNames(doc, resource) },
    coverUrl: imageUrl(doc, resource, 'coverArt'),
  };
}

export function artistFromResource(doc: JsonApiDocument, resource: Resource): V1LikeArtist {
  return {
    id: String(resource.id ?? ''),
    name: String(resource.attributes?.name ?? 'Artist'),
    coverUrl: imageUrl(doc, resource, 'profileArt'),
  };
}

export function playlistFromResource(doc: JsonApiDocument, resource: Resource): V1LikePlaylist {
  return {
    uuid: String(resource.id ?? ''),
    title: String(resource.attributes?.name ?? 'Playlist'),
    creator: { name: resource.attributes?.playlistType === 'MIX' ? 'TIDAL' : '' },
    coverUrl: imageUrl(doc, resource, 'coverArt'),
  };
}

/** The results of `GET /searchResults?filter[query]=…` per kind, in the order Tidal ranked them. */
export function searchFromDocument(doc: JsonApiDocument): {
  tracks: V1LikeTrack[];
  albums: V1LikeAlbum[];
  artists: V1LikeArtist[];
  playlists: V1LikePlaylist[];
} {
  const root = doc.dataList[0];
  if (!root) return { tracks: [], albums: [], artists: [], playlists: [] };
  return {
    tracks: doc.related(root, 'tracks').map((r) => trackFromResource(doc, r)),
    albums: doc.related(root, 'albums').map((r) => albumFromResource(doc, r)),
    artists: doc.related(root, 'artists').map((r) => artistFromResource(doc, r)),
    playlists: doc.related(root, 'playlists').map((r) => playlistFromResource(doc, r)),
  };
}

/** A relationship page (`…/relationships/items`): the linkage in order, resolved to its resources. */
export function relationshipItems(doc: JsonApiDocument): Resource[] {
  return doc.dataList.map((id) => doc.resolve(id)).filter((r): r is Resource => r !== null);
}

function artistNames(doc: JsonApiDocument, resource: Resource): string {
  return doc
    .related(resource, 'artists')
    .map((artist) => String(artist.attributes?.name ?? ''))
    .filter(Boolean)
    .join(', ');
}

function withVersion(title: unknown, version: unknown): string {
  const t = typeof title === 'string' ? title.trim() : '';
  const v = typeof version === 'string' ? version.trim() : '';
  return v && !t.toLowerCase().includes(v.toLowerCase()) ? `${t} (${v})` : t;
}

/** The artwork file nearest above the preferred width, else the largest there is. */
function imageUrl(doc: JsonApiDocument, resource: Resource, relationship: string): string {
  const files = (doc.relatedOne(resource, relationship)?.attributes?.files ?? []) as Array<{
    href?: string;
    meta?: { width?: number };
  }>;
  const usable = files.filter((f) => typeof f?.href === 'string' && f.href);
  if (!usable.length) return '';
  const rank = (f: { meta?: { width?: number } }) => {
    const width = f.meta?.width ?? 0;
    return [width < PREFERRED_IMAGE_WIDTH ? 1 : 0, Math.abs(width - PREFERRED_IMAGE_WIDTH)] as const;
  };
  usable.sort((x, y) => rank(x)[0] - rank(y)[0] || rank(x)[1] - rank(y)[1]);
  return String(usable[0]!.href);
}

/** ISO-8601 duration ("PT3M57S") to whole seconds. */
export function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return undefined;
  return Math.floor(Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0));
}

/* -------------------------------------------------------------------------- */
/* Playback: trackManifests                                                   */
/* -------------------------------------------------------------------------- */

/** The format each quality asks for; the API takes the list as repeated `formats` keys. */
export const OPENAPI_FORMATS: Record<TidalQuality, string> = {
  LOW: 'HEAACV1',
  HIGH: 'AACLC',
  LOSSLESS: 'FLAC',
  HI_RES_LOSSLESS: 'FLAC_HIRES',
};

export function trackManifestUrl(trackId: string, quality: TidalQuality): URL {
  const url = new URL(`${TIDAL_OPENAPI_BASE}/trackManifests/${encodeURIComponent(trackId)}`);
  url.searchParams.set('manifestType', 'MPEG_DASH');
  url.searchParams.append('formats', OPENAPI_FORMATS[quality]);
  // DATA: the MPD comes inline, so nothing else has to be fetched before it is served to ffmpeg.
  url.searchParams.set('uriScheme', 'DATA');
  url.searchParams.set('usage', 'PLAYBACK');
  url.searchParams.set('adaptive', 'false');
  return url;
}

export type TidalTrackManifest =
  | {
      kind: 'dash';
      manifest: string;
      /** `PREVIEW` when Tidal serves a 30-second clip instead of the track. */
      presentation?: string;
      /** Why it is a preview, e.g. `FULL_REQUIRES_HIGHER_ACCESS_TIER`. */
      previewReason?: string;
      formats: string[];
    }
  | { kind: 'drm' }
  | { kind: 'unsupported'; reason: string };

/** Read a `trackManifests` document: the MPD from its `data:` URI, and whether it is a preview. */
export function parseTrackManifest(body: unknown): TidalTrackManifest {
  const doc = new JsonApiDocument((body ?? {}) as JsonApiDocument['raw']);
  const a = doc.data.attributes ?? {};
  if (a.drmData) return { kind: 'drm' };
  const manifest = decodeDataUri(a.uri);
  if (!manifest) return { kind: 'unsupported', reason: 'no inline manifest' };
  if (!/<MPD[\s>]/.test(manifest)) return { kind: 'unsupported', reason: 'not an MPEG-DASH manifest' };
  if (hasContentProtection(manifest)) return { kind: 'drm' };
  return {
    kind: 'dash',
    manifest,
    presentation: typeof a.trackPresentation === 'string' ? a.trackPresentation : undefined,
    previewReason: typeof a.previewReason === 'string' ? a.previewReason : undefined,
    formats: Array.isArray(a.formats) ? a.formats.map(String) : [],
  };
}

export function hasContentProtection(mpd: string): boolean {
  return /<(?:\w+:)?ContentProtection\b/i.test(mpd);
}

/** `data:[<type>][;base64],<payload>` to its text; null for anything else. */
export function decodeDataUri(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null;
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  try {
    return /;base64$/i.test(header) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
  } catch {
    return null;
  }
}
