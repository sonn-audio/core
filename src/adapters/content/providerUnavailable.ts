/**
 * A service that would not answer.
 *
 * A provider's HTTP helper returned `null` for anything that was not a 200, and every door built
 * on it turned that `null` into an empty list. So a Spotify account whose token had died, or an
 * app Spotify had put back in development mode, browsed as a library with nothing saved in it:
 * `Albums`, `Artists` and `Liked Songs` all answered `200 []`, the cache kept the lie for five
 * minutes, and a player could only say "nothing here" over a library of four hundred records.
 *
 * Empty and refused are different answers. A door that *asked and was turned away* throws this,
 * the public API answers `502 service-unavailable` with the service and the reason, and a client
 * can say what is actually wrong — re-link the account, wait out a rate limit — instead of showing
 * a shelf with nothing on it.
 */
export type ProviderUnavailableReason =
  /** No usable token, or the service answered 401 and a refresh did not help. */
  | 'auth'
  /** The service answered 403: the token is fine and the request is not allowed. */
  | 'denied'
  /** 429. */
  | 'rate-limited'
  /** No answer at all: a timeout or a connection error. */
  | 'unreachable'
  /** Anything else the service refused with. */
  | 'error';

export class ProviderUnavailableError extends Error {
  constructor(
    readonly service: string,
    readonly reason: ProviderUnavailableReason,
    readonly status?: number,
  ) {
    super(`${service} did not answer (${reason}${status ? `, ${status}` : ''})`);
    this.name = 'ProviderUnavailableError';
  }
}

export function unavailableReasonFor(status: number): ProviderUnavailableReason {
  if (status === 401) return 'auth';
  if (status === 403) return 'denied';
  if (status === 429) return 'rate-limited';
  if (status === 0) return 'unreachable';
  return 'error';
}
