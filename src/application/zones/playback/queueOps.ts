import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';
import type { QueueAuthority } from '@/application/zones/internal/zoneTypes';
import type { QueueItem } from '@/ports/types/queueTypes';

export function findQueueIndexByUri(items: QueueItem[], uri: string | undefined): number {
  if (!uri) {
    return -1;
  }
  const normalizedUri = normalizeSpotifyAudiopath(uri);
  return items.findIndex(
    (item) => normalizeSpotifyAudiopath(item.audiopath) === normalizedUri,
  );
}

/**
 * Services that keep the queue local even when the path also looks like Music
 * Assistant's — the two tests disagree (one reads the provider registry, the
 * other the audiopath prefix), and for these the registry wins.
 *
 * Note this is BRIDGE_QUEUE_SERVICES minus `ytmusic`. Whether that omission is
 * deliberate is not recorded anywhere; it is preserved here rather than quietly
 * changed, because it only bites a path that both tests claim.
 */
const FORCE_LOCAL_QUEUE_SERVICES: ReadonlySet<string> = new Set([
  'applemusic',
  'deezer',
  'tidal',
  'amazonmusic',
  'soundcloud',
]);

/**
 * Which side owns the queue for a play request. Spotify is absent on purpose: it
 * plays through our own Connect host, so we drive its queue like any local one.
 */
export function resolveQueueAuthority(args: {
  isMusicAssistant: boolean;
  provider: string | null;
}): QueueAuthority {
  const forceLocalQueue = args.provider != null && FORCE_LOCAL_QUEUE_SERVICES.has(args.provider);
  if (forceLocalQueue) {
    return 'local';
  }
  if (args.isMusicAssistant) {
    return 'musicassistant';
  }
  return 'local';
}
