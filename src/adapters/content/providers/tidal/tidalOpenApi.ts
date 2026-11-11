/**
 * TIDAL's official API (openapi.tidal.com/v2): JSON:API documents, read the way Music Assistant's
 * provider reads them (jsonapi.py, parsers_v2.py).
 *
 * The catalogue reads v1; a device-flow token is accepted here too, and this API is asked for what
 * v1 lacks: similar albums and tracks, and the account's mix collections. To keep the catalogue
 * provider unchanged, resources are turned into the same shapes the v1 API returns
 * (`{ id, title, artist: { name }, album: { title } }`), with the artwork as a URL instead of a v1
 * image id.
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
  similarAlbums: ['similarAlbums.artists', 'similarAlbums.coverArt'],
  similarTracks: ['similarTracks.artists', 'similarTracks.albums.coverArt'],
  mixes: ['items.coverArt'],
} as const;

/**
 * The account's mixes: three collections of `MIX` playlists, each read as `<resource>/me/relationships/items`.
 * A device-flow token reads them; they open like any playlist.
 */
export const OPENAPI_MIX_COLLECTIONS = ['userDailyMixes', 'userDiscoveryMixes', 'userNewReleaseMixes'] as const;

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
export type V1LikeAlbum = {
  id: string;
  title: string;
  artist: { name: string };
  coverUrl: string;
  /** `ALBUM`, `EP` or `SINGLE`, when the resource says. */
  albumType?: string;
  /** `YYYY-MM-DD`, when the resource says. */
  releaseDate?: string;
};
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
    ...(typeof a.albumType === 'string' ? { albumType: a.albumType } : {}),
    ...(typeof a.releaseDate === 'string' ? { releaseDate: a.releaseDate } : {}),
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

/**
 * The resources of a page, in order: a relationship page (`…/relationships/items`) holds linkage,
 * resolved here from `included`; a collection (`/playlists?filter[…]`) holds the resources themselves.
 */
export function relationshipItems(doc: JsonApiDocument): Resource[] {
  return doc.dataList
    .map((entry) => doc.resolve(entry) ?? (entry.attributes ? entry : null))
    .filter((r): r is Resource => r !== null);
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

/** Whether an MPEG-DASH manifest is DRM protected. */
export function hasContentProtection(mpd: string): boolean {
  return /<(?:\w+:)?ContentProtection\b/i.test(mpd);
}

