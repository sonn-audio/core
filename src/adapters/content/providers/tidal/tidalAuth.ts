import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig, TidalQuality, TidalSession } from '@/domain/config/types';
import { createLogger } from '@/shared/logging/logger';
import {
  refreshTidalTokens,
  resolveTidalClient,
  TidalAuthError,
  TIDAL_CLIENT_ID_ENV,
  type FetchFn,
} from '@/adapters/content/providers/tidal/tidalAuthClient';

/** Refresh this long before the access token runs out, so no request goes out with a dying one. */
export const TIDAL_REFRESH_BUFFER_MS = 7 * 60 * 1000;
/**
 * At most one refresh per account in this window. A burst of requests that all hit a 401 then
 * share the first one's outcome instead of each going to the token endpoint.
 */
export const TIDAL_REFRESH_COOLDOWN_MS = 30 * 1000;

export type TidalAccess = {
  accessToken: string;
  countryCode: string;
  /** From a signed-in session (refreshable), rather than a token pasted by hand. */
  fromSession: boolean;
};

/** What the catalogue and the stream service need: an authenticated request to api.tidal.com. */
export interface TidalApiAccess {
  /**
   * Fetch `url` as the service's account: a valid token, the account's country, and on a 401 one
   * refresh and one retry. Null when the service has no way to authenticate at all.
   */
  fetch(serviceId: string, url: URL, init?: RequestInit): Promise<Response | null>;
  /**
   * Remember the quality TIDAL delivered when it is lower than the one asked for (undefined when
   * it is not), for the admin UI. Said in the log once, when it changes.
   */
  noteQuality(serviceId: string, delivered: TidalQuality | undefined): Promise<void>;
}

/** Where the sessions live: the Tidal services in config. */
export interface TidalSessionStore {
  getService(serviceId: string): StreamingServiceConfig | undefined;
  updateSession(serviceId: string, update: (current: TidalSession | undefined) => TidalSession | undefined): Promise<void>;
}

type Deps = {
  store: TidalSessionStore;
  fetchFn?: FetchFn;
  now?: () => number;
  env?: Record<string, string | undefined>;
};

/**
 * Keeps each Tidal account's token valid.
 *
 * The session is read from config on every request rather than cached, so a sign-in, a sign-out
 * or a refresh by another caller takes effect on the next request without anything being rebuilt.
 */
export class TidalAuth implements TidalApiAccess {
  private readonly log = createLogger('Content', 'TidalAuth');
  private readonly store: TidalSessionStore;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly lastAttempt = new Map<string, { at: number; ok: boolean }>();

  constructor(deps: Deps) {
    this.store = deps.store;
    this.fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.env = deps.env ?? process.env;
  }

  /** A token to use now, refreshed first when it is about to run out. */
  public async getAccess(serviceId: string): Promise<TidalAccess | null> {
    const service = this.store.getService(serviceId);
    if (!service) return null;
    const fallbackCountry = service.tidalCountryCode?.trim().toUpperCase() || 'US';
    let session = service.tidal;
    if (session?.accessToken) {
      if (session.refreshToken && session.expiresAt - this.now() < TIDAL_REFRESH_BUFFER_MS) {
        await this.refresh(serviceId);
        session = this.store.getService(serviceId)?.tidal ?? session;
      }
      return { accessToken: session.accessToken, countryCode: session.countryCode || fallbackCountry, fromSession: true };
    }
    const manual = service.tidalAccessToken?.trim();
    if (manual) return { accessToken: manual, countryCode: fallbackCountry, fromSession: false };
    return null;
  }

  /**
   * Refresh the account's token: one refresh at a time per account, and none again within
   * {@link TIDAL_REFRESH_COOLDOWN_MS} of the last — callers in that window get its outcome.
   */
  public refresh(serviceId: string): Promise<boolean> {
    const running = this.inflight.get(serviceId);
    if (running) return running;
    const last = this.lastAttempt.get(serviceId);
    if (last && this.now() - last.at < TIDAL_REFRESH_COOLDOWN_MS) return Promise.resolve(last.ok);
    const attempt = this.performRefresh(serviceId)
      .then((ok) => {
        this.lastAttempt.set(serviceId, { at: this.now(), ok });
        return ok;
      })
      .finally(() => this.inflight.delete(serviceId));
    this.inflight.set(serviceId, attempt);
    return attempt;
  }

  public async fetch(serviceId: string, url: URL, init?: RequestInit): Promise<Response | null> {
    const access = await this.getAccess(serviceId);
    if (!access) return null;
    if (!url.searchParams.has('countryCode')) url.searchParams.set('countryCode', access.countryCode);
    const res = await this.fetchFn(url.toString(), withBearer(init, access.accessToken));
    if (res.status !== 401 || !access.fromSession) return res;
    // The token can die before its expiry (a password change, a sign-out elsewhere): refresh once
    // and try again, and leave it at that.
    if (!(await this.refresh(serviceId))) return res;
    const again = await this.getAccess(serviceId);
    if (!again) return res;
    return this.fetchFn(url.toString(), withBearer(init, again.accessToken));
  }

  public async noteQuality(serviceId: string, delivered: TidalQuality | undefined): Promise<void> {
    const service = this.store.getService(serviceId);
    const current = service?.tidal;
    if (!current || current.deliveredQuality === delivered) return;
    if (delivered) {
      this.log.info('tidal delivers a lower quality than asked for this client', {
        serviceId,
        asked: service?.tidalQuality ?? 'LOSSLESS',
        delivered,
      });
    }
    await this.store.updateSession(serviceId, (session) => (session ? { ...session, deliveredQuality: delivered } : session));
  }

  /** Forget the refresh bookkeeping for an account, e.g. after it signed in anew. */
  public reset(serviceId: string): void {
    this.lastAttempt.delete(serviceId);
  }

  private async performRefresh(serviceId: string): Promise<boolean> {
    const service = this.store.getService(serviceId);
    const refreshToken = service?.tidal?.refreshToken;
    if (!service || !refreshToken) return false;
    const client = resolveTidalClient(service, this.env);
    if (!client) {
      // The client the session signed in with is gone from the environment and the config: a
      // refresh token is bound to its client, so only a new sign-in helps.
      const message = `No TIDAL client to refresh the sign-in with; set ${TIDAL_CLIENT_ID_ENV} or the service's client id, then sign in again.`;
      this.log.warn('tidal token refresh impossible: no client configured', { serviceId });
      await this.store.updateSession(serviceId, (current) => (current ? { ...current, refreshError: message } : current));
      return false;
    }
    try {
      const tokens = await refreshTidalTokens(client, refreshToken, this.fetchFn);
      const expiresAt = this.now() + tokens.expiresIn * 1000;
      await this.store.updateSession(serviceId, (current) =>
        current
          ? {
              ...current,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken ?? current.refreshToken,
              expiresAt,
              refreshError: undefined,
            }
          : current,
      );
      this.log.debug('tidal token refreshed', { serviceId });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn('tidal token refresh failed', { serviceId, message });
      // A refused refresh token will not come back: say so on the account, so the admin UI can
      // ask for a new sign-in instead of the library just going quiet.
      if (err instanceof TidalAuthError && err.code !== 'failed') {
        await this.store.updateSession(serviceId, (current) => (current ? { ...current, refreshError: message } : current));
      }
      return false;
    }
  }
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/** Sessions kept in the Tidal services of the server's config. */
export function configSessionStore(configPort: ConfigPort): TidalSessionStore {
  const matches = (service: StreamingServiceConfig | undefined, id: string) =>
    typeof service?.id === 'string' && service.id.trim().toLowerCase() === id.trim().toLowerCase();
  return {
    getService: (serviceId) =>
      (configPort.getConfig().content?.streamingServices ?? []).find((s) => matches(s, serviceId)),
    updateSession: async (serviceId, update) => {
      await configPort.updateConfig((cfg) => {
        const service = (cfg.content?.streamingServices ?? []).find((s) => matches(s, serviceId));
        if (!service) return;
        const next = update(service.tidal);
        if (next) service.tidal = next;
        else delete service.tidal;
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The server's one instance                                                  */
/* -------------------------------------------------------------------------- */

let shared: TidalAuth | null = null;

/** Called once by the composition root, before any Tidal request. */
export function configureTidalAuth(configPort: ConfigPort): TidalAuth {
  shared = new TidalAuth({ store: configSessionStore(configPort) });
  return shared;
}

/** After a sign-out: the next session for this service starts with no refresh history. */
export function resetSharedTidalAuth(serviceId: string): void {
  shared?.reset(serviceId);
}

/**
 * The server's TidalAuth, for code built before (or without) the composition root: the catalogue
 * providers are constructed from a config entry alone.
 */
export const sharedTidalAuth: TidalApiAccess = {
  fetch: async (serviceId, url, init) => (shared ? shared.fetch(serviceId, url, init) : null),
  noteQuality: async (serviceId, delivered) => shared?.noteQuality(serviceId, delivered),
};
