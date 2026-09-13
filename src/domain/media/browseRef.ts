/**
 * Opaque ids for the public browse API.
 *
 * A caller round-trips these verbatim: browse gives you one, and it goes straight back into
 * `GET /browse/{id}`, `GET /items/{id}` or `POST /zones/{id}/play`. So the id has to carry
 * everything needed to act on it, stay valid across restarts and rescans, and reveal nothing
 * a caller might be tempted to parse.
 *
 * Three decisions, each learned from an id scheme already in this codebase:
 *
 * - **The kind travels with the id** (Subsonic's tags). The same folder is legitimately an
 *   album to one caller and a plain container to another, and a consumer needs to know what
 *   it is holding without a lookup. It is also what makes our model better than the Loxone
 *   one, whose `type` collapses album, artist, playlist and show onto a single number.
 * - **No database rowids** (`subsonicIds.ts`): a library rescan deletes and re-inserts every
 *   track, so a rowid-based id would break every stored favourite. These key on the content
 *   layer's own stable identities instead.
 * - **A playable id is the audiopath** (DLNA's `objectId.ts`), so browse → play needs no
 *   second lookup and no server-side table.
 *
 * Deliberately *not* a URI like Music Assistant's `spotify://album/x`. A URI invites
 * parsing, and `source.id` is documented as opaque — a scheme that looks structured gets
 * split on by a client sooner or later, and then we cannot change it.
 */
import type { ContentItemKind } from '@/domain/media/contentKind';

/** Separator, chosen because it is outside the base64url alphabet (`A-Za-z0-9-_`). */
const SEP = '.';

/** Version prefix, so a future scheme can be told apart from this one rather than guessed. */
const V1 = 'b1';

/**
 * A container a caller can browse into: a service root, a folder, an album, an artist.
 *
 * `service` is the provider under its own name — `applemusic`, not the Loxone bridge
 * disguise. `folderId` is the native id the content layer expects back.
 */
export type BrowseContainerRef = {
  target: 'container';
  kind: ContentItemKind;
  service: string;
  folderId: string;
};

/** Something playable: a track, a radio station, a podcast episode. */
export type BrowsePlayableRef = {
  target: 'playable';
  kind: ContentItemKind;
  audiopath: string;
};

export type BrowseRef = BrowseContainerRef | BrowsePlayableRef;

function encode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decode(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** The id for a container. */
export function encodeContainerRef(ref: Omit<BrowseContainerRef, 'target'>): string {
  return [V1, 'c', ref.kind, encode(ref.service), encode(ref.folderId || 'root')].join(SEP);
}

/** The id for something playable. */
export function encodePlayableRef(ref: Omit<BrowsePlayableRef, 'target'>): string {
  return [V1, 'p', ref.kind, encode(ref.audiopath)].join(SEP);
}

/**
 * Reads an id back, or null when it is not one of ours.
 *
 * Null rather than a throw, so a handler answers a clean `404` for a mistyped id instead of
 * turning it into a 500. Note that base64 decoding never throws in Node, so a structurally
 * valid id with a garbage payload decodes to a garbage-but-harmless folderId — which the
 * content layer then simply fails to find.
 */
export function decodeBrowseRef(id: string): BrowseRef | null {
  const parts = (id ?? '').trim().split(SEP);
  if (parts[0] !== V1) {
    return null;
  }
  const [, target, kind] = parts;
  if (!kind) {
    return null;
  }
  if (target === 'c' && parts.length === 5) {
    return {
      target: 'container',
      kind: kind as ContentItemKind,
      service: decode(parts[3]!),
      folderId: decode(parts[4]!),
    };
  }
  if (target === 'p' && parts.length === 4) {
    return { target: 'playable', kind: kind as ContentItemKind, audiopath: decode(parts[3]!) };
  }
  return null;
}

/**
 * The audiopath a caller's `uri` means, whether they sent a browse id or a raw path.
 *
 * Every route that takes a `uri` — play, queue append, insert-next — has to accept both. A
 * browse listing hands out ids and the guide promises they round-trip, so refusing one there
 * makes browse → play impossible by exactly the route a client actually takes. Meanwhile the
 * raw form has to keep working: it is what favourites, recents and `source.id` report.
 *
 * A container ref names a provider folder rather than a directly playable audiopath. Turn it
 * into the provider-prefixed folder path the queue builder already understands — unless the
 * folder id already names its own service, in which case prefixing would name it twice.
 */
export function resolveUriFromRef(uri: string): string {
  const ref = decodeBrowseRef(uri);
  if (!ref) return uri;
  if (ref.target === 'playable') return ref.audiopath;
  return namesItsOwnService(ref.folderId, ref.service)
    ? ref.folderId
    : `${ref.service}:${ref.folderId}`;
}

/**
 * Whether a folder id already carries the identity the service key would add.
 *
 * Most providers emit ids in exactly the service-native form the key uses — `applemusic:playlist:…`
 * under the key `applemusic`, `ytmusic:1ryw2i:playlist:…` under `ytmusic:1ryw2i` — and native local
 * folder ids carry their own `library:` prefix. Those are the `startsWith` case.
 *
 * Spotify is the exception, and the reason this is a function. Its account providers are keyed by
 * the Loxone provider id, so the ids they emit read `spotify@AccountA:playlist:…` while the
 * browsable key reads `spotify`, or `spotify:AccountA` once a second account makes the bare name
 * ambiguous. Prefixing produced `spotify:AccountA:spotify@AccountA:playlist:…`, and the queue
 * builder strips only the leading `spotify:` from that — leaving the account slug in front of the
 * folder id, which no provider recognises, so every playlist and album expanded to nothing the
 * moment a second Spotify account existed (#379). Left alone, the id is the same `spotify@account:`
 * form a track already plays from, which also names the account the content belongs to instead of
 * falling back to the default one.
 */
function namesItsOwnService(folderId: string, service: string): boolean {
  const id = folderId.toLowerCase();
  const key = service.toLowerCase();
  if (id.startsWith(`${key}:`)) {
    return true;
  }
  const provider = key.split(':')[0] ?? '';
  return provider.length > 0 && id.startsWith(`${provider}@`);
}
