import { randomUUID } from 'node:crypto';
import type { TidalSession } from '@/domain/config/types';
import type {
  TidalAdminPort,
  TidalLoginFailure,
  TidalLoginStart,
  TidalLoginStatus,
} from '@/ports/TidalAdminPort';
import { createLogger } from '@/shared/logging/logger';
import type { TidalSessionStore } from '@/adapters/content/providers/tidal/tidalAuth';
import {
  fetchTidalIdentity,
  pollDeviceToken,
  resolveTidalClient,
  startDeviceAuthorization,
  TidalAuthError,
  TIDAL_CLIENT_ID_ENV,
  type FetchFn,
  type TidalClient,
  type TidalTokens,
} from '@/adapters/content/providers/tidal/tidalAuthClient';

/**
 * A device login nobody has asked about for this long was abandoned (the dialog was closed): stop
 * polling Tidal for it. The screen asks every couple of seconds while it is open.
 */
export const TIDAL_LOGIN_ABANDON_MS = 2 * 60 * 1000;
/** How long a finished login waits to be collected by a save. */
export const TIDAL_LOGIN_TTL_MS = 30 * 60 * 1000;

type Entry = {
  id: string;
  serviceId?: string;
  client: TidalClient;
  createdAt: number;
  /** Past this, an unfinished sign-in is forgotten. */
  deadline: number;
  status: TidalLoginStatus;
  session?: TidalSession;
  cancelled: boolean;
  deviceCode: string;
  interval: number;
  lastSeen: number;
};

type Deps = {
  store: TidalSessionStore;
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  /** Told when a service signs out, so its refresh bookkeeping starts afresh. */
  onSignedOut?: (serviceId: string) => void;
};

export type TidalAdmin = TidalAdminPort & {
  /** Resolves when the background polling for a device login has stopped. For tests. */
  settled(loginId: string): Promise<void>;
};

const failure = (error: TidalLoginFailure, message: string): TidalLoginStatus => ({ state: 'error', error, message });

function clientRefusedMessage(message: string): string {
  return `TIDAL refused this client for the device sign-in: ${message}`;
}

const CLIENT_REQUIRED_MESSAGE =
  `No TIDAL client to sign in with. Enter a client id (and secret) allowed the device sign-in, or set ${TIDAL_CLIENT_ID_ENV} on the server.`;

export function createTidalAdmin(deps: Deps): TidalAdmin {
  const log = createLogger('Content', 'TidalAdmin');
  const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const env = deps.env ?? process.env;
  const logins = new Map<string, Entry>();
  const runs = new Map<string, Promise<void>>();

  const prune = (): void => {
    const t = now();
    for (const [id, entry] of logins) {
      const finished = entry.status.state !== 'pending';
      const stale = finished
        ? t - entry.createdAt > TIDAL_LOGIN_TTL_MS
        : t > entry.deadline || t - entry.lastSeen > TIDAL_LOGIN_ABANDON_MS;
      if (stale) {
        entry.cancelled = true;
        logins.delete(id);
      }
    }
  };

  /**
   * The client to sign in as: the environment wins; then what the form holds now (it may not be
   * saved yet); then what is saved. Null when none names one — there is no built-in client.
   */
  const resolveClient = (input: { serviceId?: string; clientId?: string; clientSecret?: string }): TidalClient | null => {
    const stored = input.serviceId ? deps.store.getService(input.serviceId) : undefined;
    return (
      resolveTidalClient(null, env) ??
      resolveTidalClient({ tidalClientId: input.clientId, tidalClientSecret: input.clientSecret }, {}) ??
      resolveTidalClient(stored, {})
    );
  };

  /** Turn fresh tokens into a session: who signed in and from which country. */
  const finish = async (entry: Entry, tokens: TidalTokens): Promise<TidalLoginStatus> => {
    if (!tokens.refreshToken) {
      entry.status = failure('failed', 'Tidal approved the sign-in but sent no refresh token.');
      return entry.status;
    }
    const who = await fetchTidalIdentity(tokens.accessToken, fetchFn);
    const userName = who.userName ?? tokens.userName;
    const userId = who.userId ?? tokens.userId;
    entry.session = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: now() + tokens.expiresIn * 1000,
      userId,
      countryCode: who.countryCode,
      userName,
    };
    entry.status = { state: 'done', userId, userName, countryCode: who.countryCode };
    log.info('tidal signed in', { loginId: entry.id, countryCode: who.countryCode });
    return entry.status;
  };

  const errorStatus = (err: unknown): TidalLoginStatus => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TidalAuthError && err.code === 'client-refused') {
      return failure('client-refused', clientRefusedMessage(message));
    }
    return failure('failed', message);
  };

  const poll = async (entry: Entry): Promise<void> => {
    let interval = entry.interval;
    while (!entry.cancelled && entry.status.state === 'pending') {
      await sleep(interval * 1000);
      if (entry.cancelled) return;
      if (now() - entry.lastSeen > TIDAL_LOGIN_ABANDON_MS) {
        log.info('tidal sign-in abandoned', { loginId: entry.id });
        entry.cancelled = true;
        logins.delete(entry.id);
        return;
      }
      if (now() > entry.deadline) {
        entry.status = failure('expired', 'The code expired before it was approved. Start the sign-in again for a new code.');
        return;
      }
      try {
        const result = await pollDeviceToken(entry.client, entry.deviceCode, fetchFn);
        if (entry.cancelled) return;
        switch (result.status) {
          case 'pending':
          case 'retry':
            break;
          case 'slow_down':
            // RFC 8628 §3.5: every slow_down adds five seconds to the interval, for good.
            interval += 5;
            break;
          case 'expired':
            entry.status = failure('expired', 'The code expired before it was approved. Start the sign-in again for a new code.');
            return;
          case 'approved':
            await finish(entry, result.tokens);
            return;
        }
      } catch (err) {
        log.warn('tidal device sign-in failed', { loginId: entry.id, message: err instanceof Error ? err.message : String(err) });
        entry.status = errorStatus(err);
        return;
      }
    }
  };

  const startDevice = async (client: TidalClient, serviceId?: string): Promise<TidalLoginStart> => {
    try {
      const device = await startDeviceAuthorization(client, fetchFn);
      const t = now();
      const entry: Entry = {
        id: randomUUID(),
        serviceId,
        client,
        deviceCode: device.deviceCode,
        deadline: t + device.expiresIn * 1000,
        interval: device.interval,
        createdAt: t,
        lastSeen: t,
        status: { state: 'pending' },
        cancelled: false,
      };
      logins.set(entry.id, entry);
      runs.set(entry.id, poll(entry).finally(() => runs.delete(entry.id)));
      log.info('tidal device sign-in started', { loginId: entry.id, client: client.source });
      return {
        ok: true,
        loginId: entry.id,
        mode: 'device',
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        verificationUriComplete: device.verificationUriComplete,
        expiresIn: device.expiresIn,
        interval: device.interval,
      };
    } catch (err) {
      log.warn('tidal device sign-in could not start', { message: err instanceof Error ? err.message : String(err) });
      const status = errorStatus(err);
      return status.state === 'error' ? { ok: false, error: status.error, message: status.message } : { ok: false, error: 'failed', message: '' };
    }
  };

  return {
    clientStatus: () => ({ envConfigured: resolveTidalClient(null, env)?.source === 'env' }),

    startLogin: async (input): Promise<TidalLoginStart> => {
      prune();
      const client = resolveClient(input);
      if (!client) {
        log.info('tidal device sign-in refused: no client configured');
        return { ok: false, error: 'client-required', message: CLIENT_REQUIRED_MESSAGE };
      }
      return startDevice(client, input.serviceId);
    },

    loginStatus: (loginId) => {
      prune();
      const entry = logins.get(loginId);
      if (!entry) return failure('expired', 'This sign-in is no longer running. Start it again.');
      entry.lastSeen = now();
      return entry.status;
    },

    takeSession: (loginId) => {
      const entry = logins.get(loginId);
      if (!entry?.session) return null;
      logins.delete(loginId);
      return entry.session;
    },

    logout: async ({ serviceId, loginId }) => {
      if (loginId) {
        const entry = logins.get(loginId);
        if (entry) entry.cancelled = true;
        logins.delete(loginId);
      }
      if (serviceId) {
        await deps.store.updateSession(serviceId, () => undefined);
        deps.onSignedOut?.(serviceId);
        log.info('tidal signed out', { serviceId });
      }
    },

    settled: (loginId) => runs.get(loginId) ?? Promise.resolve(),
  };
}
