/**
 * TIDAL's editorial pages (tidal.com/v1/pages/*): Home, For You, New, Top and Hi-Res, read the way
 * Music Assistant reads them (recommendations.py, tidal_page_parser.py).
 *
 * A page is rows of modules; a module is one shelf ("Popular playlists on TIDAL", "New Tracks").
 * Most modules carry their items in `pagedList.items` — only the first handful when the shelf is
 * longer, with the rest behind `pagedList.dataApiPath`, which takes `offset` and `limit`. Highlight
 * modules carry `highlight[].item` instead. Every item is a v1 resource (track, album, artist,
 * playlist) or a mix.
 *
 * Only an account whose token carries `r_usr` reads these: a third-party app's sign-in gets 403.
 */

/** Where the page feed lives: not api.tidal.com, but the web player's host. */
export const TIDAL_PAGES_BASE = 'https://tidal.com/v1';

/** The pages offered at the root, by the node each is browsed under. */
export const TIDAL_PAGES = [
  { node: 'home', path: 'pages/home', name: 'Home' },
  { node: 'for-you', path: 'pages/for_you', name: 'For You' },
  { node: 'new-music', path: 'pages/explore_new_music', name: 'New Music' },
  { node: 'top-music', path: 'pages/explore_top_music', name: 'Top Music' },
  { node: 'hi-res', path: 'pages/hi_res', name: 'Hi-Res' },
] as const;

export type TidalPageNode = (typeof TIDAL_PAGES)[number]['node'];

/** The page holding the account's own mixes ("My Mix", "My Daily Discovery", …) as a MIX_LIST. */
export const TIDAL_MY_MIXES_PAGE = 'pages/my_collection_my_mixes';

/** Items a module is extended to at most; a shelf is a sample, not the catalogue. */
export const MAX_PAGE_MODULE_ITEMS = 200;

/** The parameters every page request carries besides the country. */
export const PAGE_PARAMS: Readonly<Record<string, string>> = { deviceType: 'BROWSER', locale: 'en_US' };

export type PageItemKind = 'track' | 'album' | 'artist' | 'playlist' | 'mix';
export type PageItem = { kind: PageItemKind; item: Record<string, any> };

export type RawModule = {
  type?: string;
  title?: string;
  pagedList?: { items?: unknown[]; totalNumberOfItems?: number; dataApiPath?: string };
  highlight?: Array<{ type?: string; item?: unknown }>;
  [key: string]: unknown;
};
export type RawPage = { title?: string; rows?: Array<{ modules?: RawModule[] }> };

export type PageModule = { index: number; title: string; type: string; module: RawModule };

/** Every module of a page in order, numbered by its position across the rows. */
export function allModules(page: RawPage | null | undefined): PageModule[] {
  const out: PageModule[] = [];
  for (const row of Array.isArray(page?.rows) ? page.rows : []) {
    for (const module of Array.isArray(row?.modules) ? row.modules : []) {
      out.push({ index: out.length, title: String(module?.title ?? ''), type: String(module?.type ?? ''), module: module ?? {} });
    }
  }
  return out;
}

/**
 * The modules worth a folder: titled, not video, and with something in them. Untitled modules are
 * page furniture (a mix's header, a text block saying there is nothing yet).
 */
export function musicModules(page: RawPage | null | undefined): PageModule[] {
  return allModules(page).filter((m) => isMusicModule(m.module) && moduleItems(m.module).length > 0);
}

export function isMusicModule(module: RawModule): boolean {
  const title = typeof module.title === 'string' ? module.title.trim() : '';
  return Boolean(title) && module.type !== 'VIDEO_LIST' && !/video/i.test(title);
}

/** A module's items, typed by the module's kind and, where it mixes kinds, by their own shape. */
export function moduleItems(module: RawModule): PageItem[] {
  const type = String(module.type ?? '');
  if (type === 'HIGHLIGHT_MODULE') {
    return (Array.isArray(module.highlight) ? module.highlight : [])
      .map((h) => (isRecord(h?.item) ? pageItem(h.item, String(h.type ?? '')) : null))
      .filter((i): i is PageItem => i !== null);
  }
  const hint = LIST_HINTS[type] ?? '';
  const items = Array.isArray(module.pagedList?.items) ? module.pagedList.items : [];
  return items.map((raw) => (isRecord(raw) ? pageItem(raw, hint) : null)).filter((i): i is PageItem => i !== null);
}

const LIST_HINTS: Record<string, string> = {
  TRACK_LIST: 'TRACK',
  ALBUM_LIST: 'ALBUM',
  ARTIST_LIST: 'ARTIST',
  PLAYLIST_LIST: 'PLAYLIST',
  MIX_LIST: 'MIX',
};

/**
 * One item of a module. The hint is the module's kind or the highlight's `type`; without one — or
 * for a `{ type, item }` wrapper — the item is recognised by its fields, as MA does.
 */
export function pageItem(raw: Record<string, any>, hint = ''): PageItem | null {
  let item = raw;
  let type = hint.toUpperCase();
  if (isRecord(raw.item) && typeof raw.type === 'string' && (!type || type === 'MIXED')) {
    item = raw.item;
    type = raw.type.toUpperCase();
  }
  // A playlist of a PLAYLIST_LIST may itself be a mix.
  if (type === 'PLAYLIST' && ('mixType' in item || 'mixId' in item)) type = 'MIX';
  if (!type) type = inferType(item);
  switch (type) {
    case 'TRACK':
      return item.id != null ? { kind: 'track', item } : null;
    case 'ALBUM':
      return item.id != null ? { kind: 'album', item } : null;
    case 'ARTIST':
      return item.id != null ? { kind: 'artist', item } : null;
    case 'PLAYLIST':
      // A podcast's "playlist" holds episodes TIDAL does not stream (`allowStreaming: false`).
      if (item.type === 'PODCAST') return null;
      return item.uuid != null || item.id != null ? { kind: 'playlist', item } : null;
    case 'MIX':
      return item.id != null || item.mixId != null ? { kind: 'mix', item } : null;
    default:
      // Videos, podcasts' episodes, links to other pages: nothing that plays here.
      return null;
  }
}

function inferType(item: Record<string, any>): string {
  if ('mixId' in item || 'mixType' in item) return 'MIX';
  if ('uuid' in item) return 'PLAYLIST';
  if ('duration' in item && 'album' in item) return 'TRACK';
  if ('numberOfTracks' in item && ('artists' in item || 'artist' in item)) return 'ALBUM';
  if ('picture' in item && 'name' in item && !('album' in item)) return 'ARTIST';
  return '';
}

/**
 * Fetch the items a module did not embed, until it holds `target` (bounded by its total and
 * {@link MAX_PAGE_MODULE_ITEMS}). The module's `pagedList.items` is extended in place, so a cached
 * page keeps what was fetched. A failed or empty fetch stops it with what there is.
 */
export async function extendModule(
  module: RawModule,
  target: number,
  fetchMore: (path: string, offset: number, limit: number) => Promise<unknown[] | null>,
): Promise<void> {
  const paged = module.pagedList;
  const path = paged?.dataApiPath;
  if (!paged || typeof path !== 'string' || !path || !Array.isArray(paged.items)) return;
  const items = paged.items;
  const goal = Math.min(target, moduleTotal(module));
  while (items.length < goal) {
    const more = await fetchMore(path, items.length, goal - items.length);
    if (!more?.length) break;
    items.push(...more.slice(0, goal - items.length));
  }
}

/** How many items a module has, as far as it is followed here. */
export function moduleTotal(module: RawModule): number {
  if (!module.pagedList) return Array.isArray(module.highlight) ? module.highlight.length : 0;
  const embedded = Array.isArray(module.pagedList?.items) ? module.pagedList.items.length : 0;
  const total = typeof module.pagedList?.totalNumberOfItems === 'number' ? module.pagedList.totalNumberOfItems : 0;
  if (!module.pagedList?.dataApiPath) return embedded;
  return Math.max(embedded, Math.min(total, MAX_PAGE_MODULE_ITEMS));
}

/** A mix's artwork: the image sizes v1 gives a mix, the smallest that is still sharp. */
export function mixImageUrl(mix: Record<string, any>): string {
  const images = isRecord(mix.images) ? mix.images : {};
  for (const size of ['MEDIUM', 'SMALL', 'LARGE']) {
    const url = images[size]?.url;
    if (typeof url === 'string' && url) return url;
  }
  return '';
}

/** A mix id: 30-odd hex characters, where a playlist has a dashed UUID. */
export function isMixId(id: string): boolean {
  return /^[0-9a-f]{16,40}$/i.test(id);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
