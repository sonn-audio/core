import { decodeTrackUri } from '@/domain/media/trackIdentity';
/**
 * Decodes a raw Loxone audiopath (including any appended routing hints) into a
 * usable URI for downstream outputs.
 *
 * The MiniServer often appends suffixes such as `/parentpath/...`, `/noshuffle`
 * or query markers to the original payload. Those hints are stripped before the
 * base64 payload (if present) is decoded. When the payload is not base64 the
 * cleaned string is returned unchanged so higher layers can still inspect it.
 */
export function decodeAudiopath(path: string): string {
  if (!path) {
    return '';
  }
  // What is Loxone's about this is the hints; unwrapping the payload is not, so
  // that half lives in domain/media for the consumers that never see a hint.
  return decodeTrackUri(stripRoutingSuffix(path));
}

/**
 * Wraps an external provider URI in a Loxone-compatible audiopath.
 * Defaults to the MusicAssistant bridge prefix so the queue accepts it.
 */
export function encodeAudiopath(
  originalUri: string,
  itemType = 'track',
  providerPrefix = 'spotify@nouser',
  useBase64 = true,
): string {
  if (!originalUri) return '';
  if (useBase64) {
    const encoded = Buffer.from(originalUri, 'utf-8').toString('base64');
    return `${providerPrefix}:${itemType}:b64_${encoded}`;
  }
  return `${providerPrefix}:${itemType}:${originalUri}`;
}

function stripRoutingSuffix(path: string): string {
  let working = path;

  working = working
    .replace(/\/parentid\/.*$/i, '')
    .replace(/\/parentpath\/.*$/i, '')
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');

  return working;
}

/**
 * Normalises a provider-scoped Loxone audiopath to its provider-less canonical
 * form, mirroring how room favourites are stored. Strips a leading
 * `spotify@<account>:` bridge prefix down to `spotify:` and collapses the Apple
 * `:library-track:` alias to `:track:`.
 */
export function normalizeProviderAudiopath(audiopath: string): string {
  if (!audiopath) {
    return audiopath;
  }
  if (audiopath.startsWith('spotify@')) {
    const tail = audiopath.replace(/^spotify@[^:]+:/i, 'spotify:');
    return tail.replace(/:library-track:/i, ':track:');
  }
  return audiopath.replace(/:library-track:/i, ':track:');
}

/**
 * The set of keys an audiopath may be stored under / looked up by in the
 * harvested-metadata cache. Both the harvest (store) and resolve (lookup) sides
 * run an audiopath through this, so a listing item indexed under its raw
 * provider path is still found when a caller later asks with the decoded or
 * provider-stripped variant (e.g. a normalised room-favourite path).
 */
export function metadataKeyVariants(audiopath: string): string[] {
  const raw = (audiopath || '').trim();
  if (!raw) {
    return [];
  }
  const variants: string[] = [];
  const add = (value: string | undefined | null): void => {
    const trimmed = (value || '').trim();
    if (trimmed && !variants.includes(trimmed)) {
      variants.push(trimmed);
    }
  };
  add(raw);
  const decoded = decodeAudiopath(raw);
  add(decoded);
  add(normalizeProviderAudiopath(raw));
  add(normalizeProviderAudiopath(decoded));
  // Bridge between the service-native core form and the `spotify:<kind>:<id>`
  // form that favourites/recents (kept Loxone-side) look up with. A harvest
  // stored under `applemusic:track:X` must still be found when a room-favourite
  // resolve asks with `spotify:track:X` (the getqueue-collapsed shape), and
  // vice-versa. Only the bridged STREAMING services map to spotify — `library`/
  // `radio`/etc. keep their own identity.
  const native = parseServiceNativeAudiopath(raw);
  if (native && BRIDGE_STREAMING_SERVICES.has(native.service)) {
    add(`spotify:${native.kind}:${native.id}`);
  }
  return variants;
}

/**
 * Services bridged to Loxone as Spotify (present as `cmd:spotify`, carry a
 * `spotify:`-shaped audiopath on the Loxone wire). NOT `library`/`radio`/
 * `local`/`linein`/`musicassistant` — those are their own native concepts.
 */
export const BRIDGE_STREAMING_SERVICES = new Set([
  'applemusic',
  'deezer',
  'tidal',
  'amazonmusic',
  'soundcloud',
  'ytmusic',
  'youtube',
]);

/**
 * The bridged services that have queue handling: a folder of theirs can be
 * browsed and turned into a queue, and playback treats the result as service
 * content rather than as a local file.
 *
 * An ordered subset of {@link BRIDGE_STREAMING_SERVICES} — `youtube` is bridged
 * but has never had queue handling and falls through to the Spotify path. Kept
 * as an array because the order is the order the queue builder tries them in.
 */
export const BRIDGE_QUEUE_SERVICES = [
  'applemusic',
  'deezer',
  'tidal',
  'amazonmusic',
  'ytmusic',
  'soundcloud',
] as const;

const BRIDGE_QUEUE_SERVICE_SET: ReadonlySet<string> = new Set(BRIDGE_QUEUE_SERVICES);

/** Whether this service's content is queued as service content. */
export function isBridgeQueueService(service: string | null | undefined): boolean {
  return service != null && BRIDGE_QUEUE_SERVICE_SET.has(service);
}

/**
 * Services whose stream URL is resolved by yt-dlp, which takes 5-7 s.
 *
 * Long enough that a caller must show the listener something in the meantime,
 * and long enough that a play cannot be treated as immediate. Membership is
 * about how slow the resolve is, not about which service it is: one that stops
 * needing yt-dlp leaves the set and nothing else moves.
 */
const SLOW_STREAM_RESOLUTION_SERVICES: ReadonlySet<string> = new Set(['ytmusic', 'youtube']);

export function hasSlowStreamResolution(service: string | null | undefined): boolean {
  return service != null && SLOW_STREAM_RESOLUTION_SERVICES.has(service);
}

/**
 * What a stream request's audiopath names: whose it is, what kind of thing, and
 * which one.
 *
 * Two forms reach here and both must work. Service-native
 * (`deezer:track:X`, or `deezer:<slug>:track:X` once an account slug is in
 * play) and the legacy Loxone-bridged `spotify@<bridgeId>:<kind>:<id>`. The
 * slug is why a plain `:` split is not enough: it would read the slug as the
 * kind and reject the path.
 *
 * `kind` comes back with any `library-` prefix stripped and reported through
 * {@link ParsedTrackAudiopath.isLibrary} instead, so a caller tests one thing.
 * Every stream service parsed this itself; four of the six then compared the
 * unstripped kind to `'track'` and so rejected a library track outright.
 */
export type ParsedTrackAudiopath = {
  /** `<service>`, `<service>:<slug>` or the legacy `spotify@<bridgeId>`. */
  providerKey: string;
  /** Base kind, `library-` stripped: 'track', 'album', 'artist', 'playlist', 'radio'. */
  kind: string;
  /** Decoded id, still whatever the service uses. */
  id: string;
  isLibrary: boolean;
};

export function parseTrackAudiopath(audiopath: string): ParsedTrackAudiopath | null {
  const raw = String(audiopath || '');
  const native = parseServiceNativeAudiopath(raw);
  let providerKey: string;
  let kindRaw: string;
  let rawId: string;
  if (native) {
    providerKey = native.slug ? `${native.service}:${native.slug}` : native.service;
    kindRaw = native.isLibrary ? `library-${native.kind}` : native.kind;
    rawId = native.id;
  } else {
    const parts = raw.split(':');
    if (parts.length < 3) {
      return null;
    }
    providerKey = parts[0] ?? '';
    kindRaw = (parts[1] ?? '').toLowerCase();
    rawId = parts.slice(2).join(':');
  }
  const trimmedId = rawId.trim();
  const id = decodeAudiopath(trimmedId) || trimmedId;
  if (!providerKey || !id) {
    return null;
  }
  const isLibrary = kindRaw.startsWith('library-');
  return {
    providerKey,
    kind: isLibrary ? kindRaw.slice('library-'.length) : kindRaw,
    id,
    isLibrary,
  };
}

/**
 * Lightweight provider detection for Loxone audiopaths.
 */
export function detectServiceFromAudiopath(
  p: string,
):
  | 'spotify'
  | 'radio'
  | 'library'
  | 'musicassistant'
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'amazonmusic'
  | 'ytmusic'
  | 'soundcloud' {
  const raw = (p || '').toLowerCase();
  if (
    raw.includes('musicassistant') ||
    raw.startsWith('musicassistant://') ||
    raw.startsWith('musicassistant@')
  ) {
    return 'musicassistant';
  }
  if (raw.includes('applemusic')) {
    return 'applemusic';
  }
  if (raw.includes('deezer')) {
    return 'deezer';
  }
  if (raw.includes('tidal')) {
    return 'tidal';
  }
  if (raw.includes('amazonmusic')) {
    return 'amazonmusic';
  }
  if (raw.includes('soundcloud')) {
    return 'soundcloud';
  }
  if (raw.includes('ytmusic') || raw.includes('youtube music') || raw.includes('bridge-ytmusic')) {
    return 'ytmusic';
  }
  if (raw.startsWith('tunein:') || raw.startsWith('radio:') || raw.includes('tunein')) {
    return 'radio';
  }
  const decoded = decodeAudiopath(p);
  const lower = decoded.toLowerCase();
  if (lower.includes('musicassistant') || lower.startsWith('musicassistant')) {
    return 'musicassistant';
  }
  if (lower.includes('applemusic')) {
    return 'applemusic';
  }
  if (lower.includes('deezer')) {
    return 'deezer';
  }
  if (lower.includes('tidal')) {
    return 'tidal';
  }
  if (lower.includes('amazonmusic')) {
    return 'amazonmusic';
  }
  if (lower.includes('soundcloud')) {
    return 'soundcloud';
  }
  if (lower.includes('ytmusic') || lower.includes('youtube music') || lower.includes('bridge-ytmusic')) {
    return 'ytmusic';
  }
  if (lower.includes('radioparadise')) {
    return 'radio';
  }
  if (lower.startsWith('tunein:') || lower.startsWith('radio:') || /(tunein|radio)/.test(lower)) {
    return 'radio';
  }
  if (lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
    return 'spotify';
  }
  return 'library';
}

/**
 * Rough item-kind detection from an audiopath: track, album, playlist, artist or a
 * radio station. Used for recents entries, which need a kind to render an icon.
 */
export function detectItemType(
  audiopath: string,
  service?: string,
): 'track' | 'album' | 'playlist' | 'artist' | 'tunein' | string {
  const lower = (audiopath || '').toLowerCase();
  const svc = service ?? detectServiceFromAudiopath(audiopath);
  if (/(tunein|radio)/.test(lower)) return 'tunein';
  if (lower.includes('playlist')) return 'playlist';
  if (lower.includes('album')) return `${svc}_album`;
  if (lower.includes('artist')) return `${svc}_artist`;
  if (lower.includes('track')) return `${svc}_track`;
  return 'track';
}

/**
 * The closed set of content kinds a service-native audiopath may carry, plus the
 * Apple `library-*` aliases. Shared by the service-native parser and any caller
 * that needs to distinguish a `<kind>` segment from an `<acct>` slug.
 */
export const KNOWN_KINDS = [
  'track',
  'album',
  'artist',
  'playlist',
  'radio',
  'library-track',
  'library-album',
  'library-artist',
  'library-playlist',
] as const;

const KNOWN_KIND_SET = new Set<string>(KNOWN_KINDS);

export type ServiceNativeKind =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'radio';

export interface ServiceNativeAudiopath {
  /** Real service, e.g. 'applemusic' | 'tidal' | 'spotify'. */
  service: string;
  /** Account slug; undefined when omitted (single-account services). */
  slug?: string;
  /** Base kind with the `library-` prefix stripped. */
  kind: ServiceNativeKind;
  /** True when the source kind carried the Apple `library-` prefix. */
  isLibrary: boolean;
  /** Greedy remainder after the kind segment (still possibly `b64_`-wrapped). */
  id: string;
}

/**
 * Parse a service-native audiopath `<service>[:<acct>]:<kind>:<id>`.
 *
 * Disambiguation is purely structural: after splitting on `:`, if the second
 * segment is a KNOWN_KIND there is no account (implicit default); otherwise the
 * second segment is the account slug and the third is the kind. Slugs are never
 * members of the closed kind vocabulary, so this is unambiguous. The id is the
 * greedy remainder (rejoined with `:`) so base64 payloads survive.
 *
 * Returns null for anything that is not a well-formed service-native path (e.g.
 * the legacy `spotify@bridge-...` form, or non-conforming input), so callers can
 * fall back to legacy handling during the transition.
 */
export function parseServiceNativeAudiopath(
  audiopath: string,
): ServiceNativeAudiopath | null {
  const raw = (audiopath || '').trim();
  if (!raw || raw.includes('@') || raw.includes('://')) {
    // `@` is the legacy Loxone/account form; `://` is a scheme URI. Neither is
    // service-native.
    return null;
  }
  const parts = raw.split(':');
  if (parts.length < 3) {
    return null;
  }
  const service = (parts[0] ?? '').toLowerCase();
  if (!service) {
    return null;
  }
  const secondIsKind = KNOWN_KIND_SET.has((parts[1] ?? '').toLowerCase());
  const slug = secondIsKind ? undefined : parts[1];
  const kindIdx = secondIsKind ? 1 : 2;
  const kindRaw = (parts[kindIdx] ?? '').toLowerCase();
  if (!KNOWN_KIND_SET.has(kindRaw)) {
    return null;
  }
  const id = parts.slice(kindIdx + 1).join(':');
  if (!id) {
    return null;
  }
  const isLibrary = kindRaw.startsWith('library-');
  const kind = (isLibrary ? kindRaw.slice('library-'.length) : kindRaw) as ServiceNativeKind;
  return { service, slug: slug || undefined, kind, isLibrary, id };
}

/**
 * Small heuristic to infer the source category from a URI, as an `AudioType`
 * (File, Radio, LineIn, Spotify).
 */
export function inferAudiotype(uri: string): number {
  const lower = uri.toLowerCase();
  if (
    lower.includes('musicassistant') ||
    lower.includes('applemusic') ||
    lower.includes('deezer') ||
    lower.includes('tidal') ||
    lower.includes('amazonmusic') ||
    lower.includes('soundcloud') ||
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@')
  ) {
    return 5;
  }
  if (
    lower.startsWith('radio://') ||
    lower.startsWith('tunein:') ||
    lower.startsWith('radioparadise:') ||
    lower.includes('tunein')
  ) {
    return 1;
  }
  if (lower.startsWith('linein:') || lower.startsWith('linein://')) {
    return 3;
  }
  if (
    lower.startsWith('library:') ||
    lower.startsWith('library://') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('file:')
  ) {
    return 0;
  }
  return 0;
}
