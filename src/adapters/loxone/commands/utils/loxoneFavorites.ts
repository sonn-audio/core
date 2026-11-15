import { toLoxoneAudiopath, type BridgeRegistry } from '@/domain/zones/bridgeIdentity';

/**
 * A room favourite, shaped so the Loxone app can open it.
 *
 * Playing a favourite needs nothing from the app but its slot. *Opening* one — a playlist, an
 * album, an artist — is different: the app has to fetch what is inside, and it works out where
 * from by itself (`getRepositoryForAudioItem`, shared-app.js). Two things decide it:
 *
 * - the **service** is the one whose command the audiopath starts with. Every streaming
 *   service we bridge reaches the app as Spotify, so the path has to start with `spotify` —
 *   a favourite held as `applemusic:playlist:…` belongs to no service the app knows;
 * - the **account** is the one whose id equals the favourite's `ownerId`
 *   (`getSpecificService`). Without it the app has a service and no account to ask.
 *
 * When either is missing the app shows the favourite's cover and title over a list that never
 * loads. Both are derived here from the audiopath: the Loxone form of a bridged path names
 * the account in it (`spotify@<account>:`).
 *
 * `owner_id` is the same value under the spelling one of the app's schemas insists on.
 */
/** A favourite as it goes out: what it was, with the account the app looks for. */
export type LoxoneFavorite<T> = Omit<T, 'ownerId' | 'owner_id'> & { ownerId?: string; owner_id?: string };

export function forLoxoneFavorite<T extends { audiopath?: unknown; owner?: unknown; ownerId?: unknown }>(
  item: T,
  registry: BridgeRegistry,
): LoxoneFavorite<T> {
  const unchanged = item as LoxoneFavorite<T>;
  if (typeof item.audiopath !== 'string' || !item.audiopath) {
    return unchanged;
  }
  const audiopath = toLoxoneAudiopath(item.audiopath, registry);
  if (!/^spotify/i.test(audiopath)) {
    return unchanged;
  }
  const account =
    /^spotify@([^:]+):/i.exec(audiopath)?.[1] ||
    (typeof item.ownerId === 'string' ? item.ownerId : '') ||
    (typeof item.owner === 'string' ? item.owner : '');
  if (!account) {
    return { ...unchanged, audiopath };
  }
  return { ...unchanged, audiopath, ownerId: account, owner_id: account };
}
