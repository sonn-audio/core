import { FileType } from '@/domain/zones/enums';
import { resolveItemKind, type ContentItemKind } from '@/domain/media/contentKind';
import type { ContentFolderItem } from '@/ports/ContentTypes';

/**
 * What a row of each kind renders as, for a producer that did not say.
 *
 * A `Record` rather than a switch so adding a `ContentItemKind` fails to compile until this
 * table answers for it — the alternative is a new kind quietly arriving on the wire as
 * `Unknown`, which the app draws as nothing at all.
 *
 * Containers all map to `PlaylistBrowsable`: it is the one container value that says only "the
 * app may open this". The richer container types encode an affordance `kind` does not carry
 * (a follow toggle, an editable playlist), so they stay the producer's business — see
 * {@link ContentFolderItem.type}.
 */
const FILE_TYPE_BY_KIND: Record<ContentItemKind, FileType> = {
  track: FileType.File,
  radio: FileType.File,
  episode: FileType.File,
  album: FileType.PlaylistBrowsable,
  artist: FileType.PlaylistBrowsable,
  playlist: FileType.PlaylistBrowsable,
  show: FileType.PlaylistBrowsable,
  category: FileType.PlaylistBrowsable,
  folder: FileType.Folder,
};

/**
 * The Loxone `FileType` for an item, from what it says about itself.
 *
 * An explicit `type` always wins: it is how a producer asks for an affordance this table cannot
 * infer, and half the catalogue still states one.
 */
export function deriveLoxoneFileType(item: ContentFolderItem): FileType {
  if (item.type != null) {
    return item.type;
  }
  const base = FILE_TYPE_BY_KIND[resolveItemKind(item)];
  // `followable` only ever upgrades a plain container. A producer that sets it on a track is
  // asking for a row the app cannot render, so the kind wins.
  return item.followable && base === FileType.PlaylistBrowsable
    ? FileType.PlaylistFollowable
    : base;
}

/**
 * Keeps the Loxone wire exactly as the clients expect it.
 *
 * The content layer carries a neutral `kind` ('album', 'artist', …) so consumers that are not
 * Loxone — DLNA, Subsonic, our own player — can tell what an item is. The Loxone apps decide how
 * to render a row from `type` and `tag`: `tag` is passed through untouched, `type` is filled in
 * here when the producer left it out, and `kind` is ours alone and dropped rather than shipped
 * as a field the app does not know.
 */
export function stripNeutralItemFields(items: ContentFolderItem[]): ContentFolderItem[] {
  return items.map((item) => {
    // Resolved before `kind` is dropped, since that is what the resolution reads first.
    const type = deriveLoxoneFileType(item);
    const { kind: _kind, ...wire } = item;
    return { ...wire, type };
  });
}

/** The container types the app accepts for a playlist or an album row. */
const LIST_CONTAINER_TYPES: ReadonlySet<number> = new Set([
  FileType.PlaylistFollowable,
  FileType.PlaylistEditable,
  FileType.PlaylistBrowsable,
]);
/** …and for an artist or a show, which cannot be edited. */
const PLAIN_CONTAINER_TYPES: ReadonlySet<number> = new Set([
  FileType.PlaylistFollowable,
  FileType.PlaylistBrowsable,
]);

/**
 * Shapes the rows of a service folder into rows the app's schemas accept.
 *
 * The app does not read a service row field by field; it tries it against a fixed list of row
 * shapes, each pinned to a `tag` and the `type` values that tag may carry, and takes the first
 * that fits (`getservicefolder`'s preprocessing, shared-app.js module 11119). Two things follow,
 * and neither is forgiving:
 *
 * - A row that fits none of them fails the whole folder, not the row. A container whose `tag`
 *   is missing, or a category that is not a `Folder`, empties the screen it was listed on.
 * - A row that fits the wrong one is drawn as the wrong thing. The track shape requires a
 *   `thumbnail`; without one a track falls through to the last shape on the list and is drawn
 *   as a radio station.
 *
 * Providers describe a row by its `kind`, and most add the `tag` and a cover as well — but
 * "most" is a dozen producers each remembering the app's rules. This is the one place every
 * service row passes, so the rules are applied here: the `tag` follows the kind when the
 * producer left it out, the `type` is brought inside what that tag allows, and a track gets
 * the `thumbnail` the app insists on. A row that already fits is not changed.
 *
 * Only for service folders. The local library speaks a different schema (folders and files,
 * no tags), and its rows must not be touched by this.
 */
export function shapeServiceItemsForLoxone(items: ContentFolderItem[]): ContentFolderItem[] {
  return items.map((item) => {
    const kind = resolveItemKind(item);
    const type = deriveLoxoneFileType(item);
    const { kind: _kind, ...wire } = item;
    switch (kind) {
      case 'track':
        return {
          ...wire,
          tag: 'track',
          type: FileType.File,
          thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : (item.coverurl ?? ''),
        };
      case 'episode':
        return { ...wire, tag: 'episode', type: FileType.File };
      case 'album':
      case 'playlist':
        return {
          ...wire,
          tag: wire.tag ?? kind,
          type: LIST_CONTAINER_TYPES.has(type) ? type : FileType.PlaylistBrowsable,
        };
      case 'artist':
      case 'show':
        return {
          ...wire,
          tag: wire.tag ?? kind,
          type: PLAIN_CONTAINER_TYPES.has(type) ? type : FileType.PlaylistBrowsable,
        };
      case 'category':
        // The one container the app wants as a plain folder, whether it is tagged or not.
        return { ...wire, type: FileType.Folder };
      default:
        // Radio stations and plain folders fit by their type alone.
        return { ...wire, type };
    }
  });
}

/** {@link shapeServiceItemsForLoxone} for a folder payload. */
export function forLoxoneServiceFolder<T extends { items?: ContentFolderItem[] }>(folder: T): T {
  return Array.isArray(folder.items)
    ? { ...folder, items: shapeServiceItemsForLoxone(folder.items) }
    : folder;
}

/** {@link stripNeutralItemFields} for a folder payload. */
export function forLoxoneFolder<T extends { items?: ContentFolderItem[] }>(folder: T): T {
  return Array.isArray(folder.items)
    ? { ...folder, items: stripNeutralItemFields(folder.items) }
    : folder;
}

/** {@link stripNeutralItemFields} for a global-search result, keyed by category. */
export function forLoxoneSearchResult<T extends Record<string, unknown>>(result: T): T {
  const out: Record<string, unknown> = { ...result };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      out[key] = stripNeutralItemFields(value as ContentFolderItem[]);
    }
  }
  return out as T;
}

/** {@link shapeServiceItemsForLoxone} for a streaming-service search result, keyed by category. */
export function forLoxoneServiceSearchResult<T extends Record<string, unknown>>(result: T): T {
  const out: Record<string, unknown> = { ...result };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      out[key] = shapeServiceItemsForLoxone(value as ContentFolderItem[]);
    }
  }
  return out as T;
}
