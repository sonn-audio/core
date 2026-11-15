import type { ZoneConfig } from '@/domain/config/types';

/**
 * "Which account does this room use" — in the Loxone app's own terms.
 *
 * We keep the choice on the zone (`ZoneConfig.streamingAccount`). The app keeps it the other
 * way round: each service entry of `getservices` lists the players it is the default for, in
 * `asdefault`, and the app picks, for a player, the entry that lists it — or the first entry
 * when none does (`getDefaultSpotifyIdForPlayer`, shared-app.js). Every streaming service
 * reaches the app as a Spotify account, so this is what decides whether a room opens on
 * Apple Music or on Tidal.
 */
export function withDefaultPlayers<T extends Record<string, unknown>>(
  entries: readonly T[],
  zones: readonly Pick<ZoneConfig, 'id' | 'streamingAccount'>[],
): Array<T & { asdefault: number[] }> {
  return entries.map((entry) => ({
    ...entry,
    asdefault: zones.filter((zone) => zone.streamingAccount && zone.streamingAccount === entry.id).map((zone) => zone.id),
  }));
}

/** The player ids of a `…/asdefault/player/<id,id,…>` command. */
export function parsePlayerIds(segment: string | undefined): number[] {
  return (segment ?? '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
}
