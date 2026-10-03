/**
 * DLNA object-id codec for the MediaServer.
 *
 * UPnP object ids are opaque strings a control point round-trips verbatim in
 * Browse requests. They travel inside XML/SOAP and DIDL attributes, so we keep
 * them free of characters that would need escaping or collide with our own
 * delimiters. Two id shapes exist:
 *
 *   - Containers (browsable folders): `<service>~<base64url(folderId)>`
 *     The root container is the reserved id `0` (per the UPnP spec). Each
 *     top-level service is `svc~<b64(root)>`; deeper folders carry the service's
 *     own folder id verbatim (base64url-wrapped) so we can hand it straight back
 *     to ContentManager.getServiceFolder / getMediaFolder.
 *
 *   - Items (playable tracks): the track's audiopath, base64url-encoded, with no
 *     `~` — the absence of a service prefix distinguishes an item id from a
 *     container id. The decoded audiopath is what /dlna/track/<id> replays and
 *     what resolvePlaybackSource consumes, so the browse→play round-trip needs no
 *     second lookup.
 */

export const ROOT_OBJECT_ID = '0';

/** Services the MediaServer can surface as top-level containers. */
export type MediaServerService =
  | 'library'
  | 'radio'
  | 'spotify'
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'amazonmusic'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | 'musicassistant';

export type ContainerRef = {
  kind: 'container';
  /**
   * Stable service key: 'library'/'radio' for the built-ins, or the service-native
   * name of a streaming account (`applemusic`, or `applemusic:p0gngd` when a
   * service has more than one) — see `domain/media/serviceIdentity`. Free-form
   * rather than a fixed enum because the account part comes from config.
   */
  service: string;
  /** Native folder id understood by the content layer for this service. */
  folderId: string;
};

export type ItemRef = {
  kind: 'item';
  /** The track's own URI (`applemusic:track:…`), ready for resolvePlaybackSource. */
  audiopath: string;
};

export type ObjectRef = ContainerRef | ItemRef | { kind: 'root' };

function b64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function encodeContainerId(service: string, folderId: string): string {
  return `${service}~${b64urlEncode(folderId || 'root')}`;
}

export function encodeItemId(audiopath: string): string {
  return b64urlEncode(audiopath);
}

/**
 * Decode any object id (including the reserved root) back into a typed ref.
 * Returns null for structurally invalid ids so the SOAP layer can answer a
 * clean fault rather than throwing.
 */
export function decodeObjectId(objectId: string): ObjectRef | null {
  const raw = (objectId || '').trim();
  if (!raw || raw === ROOT_OBJECT_ID) {
    return { kind: 'root' };
  }
  const sep = raw.indexOf('~');
  if (sep === -1) {
    // No service prefix → item id (base64url audiopath).
    try {
      const audiopath = b64urlDecode(raw);
      if (!audiopath) {
        return null;
      }
      return { kind: 'item', audiopath };
    } catch {
      return null;
    }
  }
  const service = raw.slice(0, sep);
  try {
    const folderId = b64urlDecode(raw.slice(sep + 1));
    return { kind: 'container', service, folderId };
  } catch {
    return null;
  }
}
