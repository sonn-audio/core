import { inferAudiotype, parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import type { PlaybackMetadata } from '@/ports/types/playback';
import type { ContentFolderItem } from '@/ports/ContentTypes';

export function normalizeSpotifyAudiopath(value: string): string {
  if (!value) return value;
  let cleaned = value.trim().replace('spotify://', 'spotify:');
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    /* ignore */
  }
  cleaned = cleaned.replace(/\]+$/, '').replace(/\/+$/, '');
  // Preserve bridge-prefixed providers (e.g., spotify@bridge-<provider>-id:...).
  if (/^spotify@bridge-[^:]+:/i.test(cleaned)) {
    return cleaned;
  }
  if (/musicassistant/i.test(cleaned)) {
    return cleaned;
  }
  if (/applemusic/i.test(cleaned)) {
    return cleaned;
  }
  if (/deezer/i.test(cleaned)) {
    return cleaned;
  }
  if (/tidal/i.test(cleaned)) {
    return cleaned;
  }
  if (/^(soundcloud|ytmusic|youtube):/i.test(cleaned)) {
    return cleaned;
  }
  if (cleaned.startsWith('spotify:') && !cleaned.startsWith('spotify@')) {
    const bareIdMatch = /^spotify:([A-Za-z0-9]{22})$/i.exec(cleaned);
    if (bareIdMatch) {
      return `spotify:track:${bareIdMatch[1]}`;
    }
    return cleaned;
  }
  if (cleaned.startsWith('spotify@')) {
    const withoutPrefix = cleaned.replace(/^spotify@/i, 'spotify:');
    const parts = withoutPrefix.split(':').filter(Boolean);
    const knownTypes = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist']);
    const typeIndex = parts.findIndex((part) => knownTypes.has(part.toLowerCase()));
    if (typeIndex >= 0) {
      return `spotify:${parts.slice(typeIndex).join(':')}`;
    }
    return `spotify:${parts.slice(1).join(':')}`;
  }
  return cleaned;
}

export function sanitizeStation(station: string | undefined, audiopath: string): string {
  if (!station) return '';
  const trimmed = station.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (audiopath.startsWith('library:')) {
    return '';
  }
  if (normalizeSpotifyAudiopath(trimmed) === normalizeSpotifyAudiopath(audiopath)) {
    return '';
  }
  // A container audiopath is never a valid station label. The legacy Loxone form
  // (`spotify@bridge-...:playlist:...`) was blanked by the `spotify@` check; the
  // service-native form (`applemusic:playlist:...`, `soundcloud:playlist:...`)
  // must be blanked here too, else it surfaces as the client's source line.
  if (
    lower.startsWith('spotify:track') ||
    lower.startsWith('spotify@') ||
    parseServiceNativeAudiopath(trimmed) !== null ||
    /^[a-z0-9]{16,}$/i.test(trimmed)
  ) {
    return '';
  }
  return trimmed;
}

export function parseSpotifyUser(audiopath: string): string {
  const match = /^spotify@([^:]+):/i.exec(audiopath);
  return match?.[1] ?? 'nouser';
}

/**
 * Which Spotify account a track is to be played from.
 *
 * The account lives in the audiopath only until the queue takes it: every row is stored
 * normalized (`spotify:track:…`), and `spotify@AccountB:` is dropped on the way in — the row keeps
 * the account in `user` instead. So reading the prefix alone answers this for a request as it
 * arrives and for nothing afterwards, which is why a second account's track was played out of the
 * first account's Soloist store (#377): by playback time the prefix was gone and the input fell
 * back to its default account.
 *
 * `undefined` rather than `'nouser'` when neither says: the input reads that as "no account named"
 * and picks its default, whereas `'nouser'` would be taken for an account id.
 */
export function resolveSpotifyAccountId(audiopath: string, queueUser?: string | null): string | undefined {
  const fromUri = parseSpotifyUser(audiopath);
  if (fromUri && fromUri !== 'nouser') {
    return fromUri;
  }
  const fromQueue = queueUser?.trim();
  return fromQueue && fromQueue !== 'nouser' ? fromQueue : undefined;
}

import { generateQueueId } from '@/shared/utils/queueId';
export { generateQueueId };

export function createQueueItem(
  uri: string,
  zoneName: string,
  metadata?: PlaybackMetadata,
  audioType = 0,
  defaultSpotifyUserId?: string | null,
): QueueItem {
  const normalizedUri = normalizeSpotifyAudiopath(uri);
  const inferredType =
    audioType && audioType > 0
      ? audioType
      : normalizedUri.toLowerCase().includes('musicassistant')
        ? 5
        : inferAudiotype(normalizedUri);
  const providedTitle = (metadata?.title ?? '').trim();
  const title = providedTitle && !isUriLike(providedTitle) ? providedTitle : zoneName;
  const metaUser = (metadata as { user?: string } | undefined)?.user;
  const metaUnique = (metadata as { unique_id?: string } | undefined)?.unique_id;
  const normalizedUnique = metaUnique ? normalizeSpotifyAudiopath(metaUnique) : undefined;
  const userFromUri =
    uri.startsWith('spotify@')
      ? parseSpotifyUser(uri)
      : normalizedUri.startsWith('spotify@')
        ? parseSpotifyUser(normalizedUri)
        : null;
  const defaultSpotifyUser =
    normalizedUri.startsWith('spotify:') || normalizedUri.startsWith('spotify@')
      ? userFromUri || defaultSpotifyUserId || null
      : null;
  const user = metaUser && metaUser !== 'nouser' ? metaUser : defaultSpotifyUser ?? 'nouser';
  // 0 means "nobody has said yet", and it is left at 0 rather than filled with a guess. The guess used
  // to be 120, which is indistinguishable from a real two-minute track: the zone clock ends a track at
  // its duration, so every track whose metadata lookup missed was cut off at exactly 2:00 (#350). What
  // fills this in afterwards is ffmpeg's own read of the source — see `AudioManager.watchSourceDuration`.
  const duration =
    typeof metadata?.duration === 'number' && metadata.duration > 0
      ? Math.round(metadata.duration)
      : 0;
  const station = sanitizeStation(metadata?.station, normalizedUri);
  // First-class service identity for neutral consumers (own player, DLNA).
  const native = parseServiceNativeAudiopath(normalizedUri);
  return {
    album: metadata?.album ?? '',
    artist: metadata?.artist ?? '',
    audiopath: normalizedUri,
    audiotype: inferredType,
    coverurl: metadata?.coverurl ?? '',
    ...(metadata?.animatedCoverUrl ? { animatedCoverUrl: metadata.animatedCoverUrl } : {}),
    duration,
    qindex: 0,
    station,
    title: title || zoneName,
    unique_id:
      normalizedUnique && !normalizedUnique.startsWith('spotify@')
        ? normalizedUnique
        : generateQueueId(),
    user,
    ...(native ? { provider: native.service, kind: native.kind } : {}),
  };
}

export async function mapFolderItemsToQueue(
  items: ContentFolderItem[],
  zoneName: string,
  audioType: number,
  user: string,
  station?: string,
  defaultSpotifyUserId?: string | null,
): Promise<QueueItem[]> {
  return items.map((item) => ({
    album: item.album ?? item.owner ?? '',
    artist: item.artist ?? item.owner ?? '',
    audiopath: normalizeSpotifyAudiopath(item.audiopath ?? item.id ?? ''),
    audiotype: audioType,
    coverurl: item.coverurl ?? item.thumbnail ?? '',
    ...(item.animatedCoverUrl ? { animatedCoverUrl: item.animatedCoverUrl } : {}),
    // Left at 0 when the provider did not say, never guessed — see `createQueueItem` for what the
    // guess cost. A queue row with no length shows none, which is the truth, and the engine states
    // the real one once the track plays.
    duration: Math.round(Number(item.duration ?? 0) > 0 ? Number(item.duration ?? 0) : 0),
    qindex: 0,
    station: audioType === 1 || audioType === 4 ? station ?? '' : '',
    title: item.title ?? item.name ?? zoneName,
    unique_id: generateQueueId(),
    user:
      (() => {
        const ap = item.audiopath ?? item.id ?? '';
        if (ap.startsWith('library:')) {
          return 'nouser';
        }
        if (user && user !== 'nouser') {
          return user;
        }
        if (item.owner_id && item.owner_id !== 'nouser') {
          return item.owner_id;
        }
        return defaultSpotifyUserId ?? 'nouser';
      })(),
  }));
}

function isUriLike(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@') ||
    // Service-native audiopaths (applemusic:..., soundcloud:..., etc.) must not
    // pass as a title, so createQueueItem falls back to the zone name.
    parseServiceNativeAudiopath(value) !== null ||
    /^[A-Za-z0-9]{16,}$/.test(value.trim())
  );
}

// Local type import to avoid circular dependencies.
import type { QueueItem } from '@/application/zones/zoneManager';
