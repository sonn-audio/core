import { randomBytes, randomUUID } from 'node:crypto';
import type { TidalSession } from '@/domain/config/types';
import type {
  TidalAdminPort,
  TidalLoginFailure,
  TidalLoginStart,
  TidalLoginStatus,
} from '@/ports/TidalAdminPort';
import { createLogger } from '@/shared/logging/logger';
import type { TidalSessionStore } from '@/adapters/content/providers/tidal/tidalAuth';
import { createPkcePair } from '@/adapters/content/oauth/pkce';
import { extractCodeAndState, parsePastedRedirect } from '@/adapters/content/oauth/oauthRedirect';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchTidalIdentity,
  pollDeviceToken,
  resolveTidalClient,
  startDeviceAuthorization,
  tidalClientFor,
  TidalAuthError,
  TIDAL_DEFAULT_CLIENT_ID,
  TIDAL_PUBLIC_REDIRECT_URI,
  type FetchFn,
  type TidalClient,
  type TidalFlow,
  type TidalTokens,
} from '@/adapters/content/providers/tidal/tidalAuthClient';

/** How long a browser sign-in may take before its state and verifier are forgotten. */
export const TIDAL_PKCE_TTL_MS = 10 * 60 * 1000;
/**
 * A device login nobody has asked about for this long was abandoned (the dialog was closed): stop
 * polling Tidal for it. The screen asks every couple of seconds while it is open.
 */
export const TIDAL_LOGIN_ABANDON_MS = 2 * 60 * 1000;
/** How long a finished login waits to be collected by a save. */
export const TIDAL_LOGIN_TTL_MS = 30 * 60 * 1000;

const EXPIRED_MESSAGE = 'This sign-in has expired. Start it again.';

type Base = {
  id: string;
  serviceId?: string;
  client: TidalClient;
  createdAt: number;
  /** Past this, an unfinished sign-in is forgotten. */
  deadline: number;
  status: TidalLoginStatus;
  session?: TidalSession;
  cancelled: boolean;
  /** Set once a code has been handed in, so a second redirect cannot exchange it again. */
  exchanging?: boolean;
};
type PkceEntry = Base & { mode: 'browser'; stateKey: string; verifier: string };
type DeviceEntry = Base & { mode: 'device'; deviceCode: string; interval: number; lastSeen: number };
type Entry = PkceEntry | DeviceEntry;

type Deps = {
  store: TidalSessionStore;
  fetchFn?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  /** The address the browser reaches this server on, for the callback the public page forwards to. */
  audioServerHost?: () => string;
  /** Told when a service signs out, so its refresh bookkeeping starts afresh. */
  onSignedOut?: (serviceId: string) => void;
};

export type TidalAdmin = TidalAdminPort & {
  /** Resolves when the background polling for a device login has stopped. For tests. */
  settled(loginId: string): Promise<void>;
};

const failure = (error: TidalLoginFailure, message: string): TidalLoginStatus => ({ state: 'error', error, message });

function clientRefusedMessage(message: string, mode: 'pkce' | 'device'): string {
  return mode === 'device'
    ? `Tidal refused this client for the device sign-in: ${message}. TIDAL only allows that flow for its own apps; use the browser sign-in instead.`
    : `Tidal refused this client: ${message}. Check the client id (and secret) of the app on developer.tidal.com.`;
}

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
        : t > entry.deadline || (entry.mode === 'device' && t - entry.lastSeen > TIDAL_LOGIN_ABANDON_MS);
      if (stale) {
        entry.cancelled = true;
        logins.delete(id);
      }
    }
  };

  const resolveClient = (input: { serviceId?: string; clientId?: string; clientSecret?: string }): TidalClient => {
    const stored = input.serviceId ? deps.store.getService(input.serviceId) : undefined;
    // The environment wins; then what the form holds now (it may not be saved yet); then what is
    // saved; then sonn's own app.
    return (
      resolveTidalClient(null, env) ??
      resolveTidalClient({ tidalClientId: input.clientId, tidalClientSecret: input.clientSecret }, {}) ??
      tidalClientFor(stored, {})
    );
  };
  const host = deps.audioServerHost ?? (() => '127.0.0.1');

  /** Turn fresh tokens into a session: who signed in and from which country. */
  const finish = async (entry: Entry, tokens: TidalTokens, flow: TidalFlow): Promise<TidalLoginStatus> => {
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
      flow,
      accessTier: who.accessTier,
    };
    entry.status = { state: 'done', userId, userName, countryCode: who.countryCode, accessTier: who.accessTier };
    log.info('tidal signed in', { loginId: entry.id, flow, countryCode: who.countryCode, accessTier: who.accessTier });
    return entry.status;
  };

  const errorStatus = (err: unknown, flow: 'pkce' | 'device'): TidalLoginStatus => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TidalAuthError && err.code === 'client-refused') {
      return failure('client-refused', clientRefusedMessage(message, flow));
    }
    return failure('failed', message);
  };

  /** Exchange the code a redirect carried, once, after checking it belongs to this sign-in. */
  const redeem = async (
    entry: PkceEntry,
    redirect: NonNullable<ReturnType<typeof parsePastedRedirect>>,
  ): Promise<TidalLoginStatus> => {
    if (entry.status.state !== 'pending') return entry.status;
    if (now() > entry.deadline) {
      entry.status = failure('expired', EXPIRED_MESSAGE);
      return entry.status;
    }
    if (redirect.state !== entry.stateKey) {
      // Not this sign-in's redirect: refuse it without ending the sign-in, so the right one can still come.
      log.warn('tidal sign-in redirect with a foreign state refused', { loginId: entry.id });
      return failure('state-mismatch', 'This address belongs to a different sign-in. Use the address from the tab this sign-in opened.');
    }
    if (redirect.error) {
      entry.status = failure('denied', redirect.errorDescription || `Tidal did not complete the sign-in (${redirect.error}).`);
      return entry.status;
    }
    if (!redirect.code) return failure('no-code', 'That address carries no sign-in code.');
    if (entry.exchanging) return { state: 'pending' };
    entry.exchanging = true;
    try {
      const tokens = await exchangeAuthorizationCode(
        entry.client,
        { code: redirect.code, redirectUri: TIDAL_PUBLIC_REDIRECT_URI, codeVerifier: entry.verifier },
        fetchFn,
      );
      const status = await finish(entry, tokens, 'pkce');
      // Signing in again on a saved service takes effect at once, as Spotify's does; the save
      // that follows collects the same session by login id.
      if (status.state === 'done' && entry.serviceId && entry.session && deps.store.getService(entry.serviceId)) {
        const session = entry.session;
        await deps.store.updateSession(entry.serviceId, () => session);
      }
      return status;
    } catch (err) {
      log.warn('tidal sign-in code exchange failed', { loginId: entry.id, message: err instanceof Error ? err.message : String(err) });
      // A code is single-use: whatever went wrong, this sign-in cannot be finished again.
      entry.status = errorStatus(err, 'pkce');
      return entry.status;
    }
  };

  const poll = async (entry: DeviceEntry): Promise<void> => {
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
            await finish(entry, result.tokens, 'device');
            return;
        }
      } catch (err) {
        log.warn('tidal device sign-in failed', { loginId: entry.id, message: err instanceof Error ? err.message : String(err) });
        entry.status = errorStatus(err, 'device');
        return;
      }
    }
  };

  const startDevice = async (client: TidalClient, serviceId?: string): Promise<TidalLoginStart> => {
    try {
      const device = await startDeviceAuthorization(client, fetchFn);
      const t = now();
      const entry: DeviceEntry = {
        id: randomUUID(),
        mode: 'device',
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
      const status = errorStatus(err, 'device');
      return status.state === 'error' ? { ok: false, error: status.error, message: status.message } : { ok: false, error: 'failed', message: '' };
    }
  };

  return {
    clientStatus: () => ({
      envConfigured: resolveTidalClient(null, env)?.source === 'env',
      defaultClientId: TIDAL_DEFAULT_CLIENT_ID,
      redirectUri: TIDAL_PUBLIC_REDIRECT_URI,
    }),

    startLogin: async (input): Promise<TidalLoginStart> => {
      prune();
      const client = resolveClient(input);
      if (input.mode === 'device') return startDevice(client, input.serviceId);

      const { verifier, challenge } = createPkcePair();
      const t = now();
      const stateKey = `content:tidal:${randomBytes(16).toString('hex')}`;
      const entry: PkceEntry = {
        id: randomUUID(),
        mode: 'browser',
        serviceId: input.serviceId,
        client,
        stateKey,
        verifier,
        createdAt: t,
        deadline: t + TIDAL_PKCE_TTL_MS,
        status: { state: 'pending' },
        cancelled: false,
      };
      logins.set(entry.id, entry);
      // As for Spotify: `state` carries this server's own callback, which the public redirect page
      // forwards the browser to with the code; the state key in it finds this sign-in again.
      const callbackUrl = `http://${host()}:7090/admin/api/tidal/auth/callback?state=${stateKey}`;
      log.info('tidal sign-in started', { loginId: entry.id, client: client.source });
      return {
        ok: true,
        loginId: entry.id,
        mode: 'browser',
        authorizeUrl: buildAuthorizeUrl({
          client,
          redirectUri: TIDAL_PUBLIC_REDIRECT_URI,
          codeChallenge: challenge,
          state: encodeURIComponent(callbackUrl),
        }),
        redirectUri: TIDAL_PUBLIC_REDIRECT_URI,
        callbackUrl,
        expiresIn: TIDAL_PKCE_TTL_MS / 1000,
      };
    },

    completeCallback: async (query) => {
      prune();
      const { code, state } = extractCodeAndState(query.get('code') ?? '', query.get('state') ?? '');
      const error = query.get('error')?.trim() || undefined;
      const entry = [...logins.values()].find(
        (e): e is PkceEntry => e.mode === 'browser' && state !== '' && e.stateKey === state,
      );
      if (!entry) {
        return failure(state ? 'expired' : 'state-mismatch', state ? EXPIRED_MESSAGE : 'The redirect carries no sign-in state.');
      }
      if (!code && !error) return failure('no-code', 'Tidal redirected back without a sign-in code.');
      return redeem(entry, {
        code: code || undefined,
        state,
        error,
        errorDescription: query.get('error_description') ?? undefined,
      });
    },

    completePaste: async (loginId, pastedUrl) => {
      prune();
      const entry = logins.get(loginId);
      if (!entry || entry.mode === 'device') return failure('expired', EXPIRED_MESSAGE);
      const redirect = parsePastedRedirect(pastedUrl);
      if (!redirect) {
        return failure('no-code', 'That address carries no sign-in code. Copy the full address of the page Tidal sent you to after signing in.');
      }
      return redeem(entry, redirect);
    },

    loginStatus: (loginId) => {
      prune();
      const entry = logins.get(loginId);
      if (!entry) return failure('expired', 'This sign-in is no longer running. Start it again.');
      if (entry.mode === 'device') entry.lastSeen = now();
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
