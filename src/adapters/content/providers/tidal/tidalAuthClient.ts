import type { StreamingServiceConfig, TidalSession } from '@/domain/config/types';
import { JSONAPI_CONTENT_TYPE, TIDAL_OPENAPI_BASE } from '@/adapters/content/providers/tidal/tidalOpenApi';

/**
 * The calls Tidal's OAuth server answers, one request each.
 *
 * Two ways to sign in, both checked against TIDAL's own auth SDK (tidal-sdk-web, packages/auth):
 *
 * - Authorization code + PKCE (S256) at login.tidal.com — the flow TIDAL offers third-party apps
 *   registered on developer.tidal.com. The person signs in in a browser tab and is sent to a
 *   redirect URI registered on that app, with a code we exchange at the token endpoint.
 * - The device flow (RFC 8628): we ask for a code, a person approves it at link.tidal.com, and we
 *   poll until they have. TIDAL documents it as "only available for TIDAL internally developed
 *   applications", so any other client is refused at the first call with
 *   `Client is not a Limited Input Device client`. Kept for whoever has such a client.
 *
 * sonn ships no client of its own; it comes from the environment or the service's config — see
 * {@link resolveTidalClient}.
 */

export const TIDAL_AUTH_URL = 'https://auth.tidal.com/v1/oauth2';
export const TIDAL_LOGIN_URL = 'https://login.tidal.com/authorize';
export const TIDAL_API_BASE = 'https://api.tidal.com/v1';
export const TIDAL_SESSIONS_URL = `${TIDAL_API_BASE}/sessions`;
/** The device flow's scope: the legacy scopes TIDAL's own apps (and Music Assistant) ask for. */
export const TIDAL_SCOPE = 'r_usr w_usr w_sub';
/**
 * The scopes a third-party app may ask for at login.tidal.com, as TIDAL's API spec lists them for
 * the Authorization_Code_PKCE scheme (search.write and the legacy r_usr / w_usr left out).
 */
export const TIDAL_PKCE_SCOPES = [
  'user.read',
  'collection.read',
  'collection.write',
  'playlists.read',
  'playlists.write',
  'search.read',
  'recommendations.read',
  'entitlements.read',
  'playback',
] as const;
export const TIDAL_PKCE_SCOPE = TIDAL_PKCE_SCOPES.join(' ');

export type TidalFlow = NonNullable<TidalSession['flow']>;

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Where login.tidal.com sends the browser back to: a fixed public page, because a Tidal app only
 * accepts redirect URIs registered on it, and a self-hosted server's address varies. The page
 * forwards the browser to this server's callback, which travels in `state` (as for Spotify).
 */
export const TIDAL_PUBLIC_REDIRECT_URI = 'https://sonn-audio.github.io/callbacks/tidal/';

/**
 * The public client id of sonn's own app on developer.tidal.com. A PKCE client is public: the id
 * is not a secret, and no secret ships with it.
 */
export const TIDAL_DEFAULT_CLIENT_ID = 'dYPFOHF5tWY1VftL';

export const TIDAL_CLIENT_ID_ENV = 'SONN_TIDAL_CLIENT_ID';
export const TIDAL_CLIENT_SECRET_ENV = 'SONN_TIDAL_CLIENT_SECRET';

export type FetchFn = typeof fetch;

export type TidalClient = {
  clientId: string;
  clientSecret?: string;
  /** Where it came from: the environment, then the service's config, then sonn's own app. */
  source: 'env' | 'config' | 'default';
};

export type TidalDeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** The verification page with the code already filled in. */
  verificationUriComplete: string;
  /** Seconds the code stays valid. */
  expiresIn: number;
  /** Seconds to wait between polls. */
  interval: number;
};

export type TidalTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Seconds the access token stays valid. */
  expiresIn: number;
  userName?: string;
  userId?: string;
};

export type TidalDevicePoll =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  /** A gateway hiccup or a network error: nothing is decided, poll again. */
  | { status: 'retry' }
  | { status: 'approved'; tokens: TidalTokens };

/**
 * Tidal said no.
 *
 * `client-refused` is the one a person can act on: the client is not allowed the device flow (or
 * not known at all), so no amount of retrying helps — a different client does.
 */
export class TidalAuthError extends Error {
  constructor(
    message: string,
    public readonly code: 'client-refused' | 'invalid-grant' | 'failed',
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'TidalAuthError';
  }
}

/**
 * The client the sign-in and refresh run as: the environment first, then the service's config.
 * Null when neither names one; {@link tidalClientFor} adds sonn's own app as the last resort.
 */
export function resolveTidalClient(
  service?: Pick<StreamingServiceConfig, 'tidalClientId' | 'tidalClientSecret'> | null,
  env: Record<string, string | undefined> = process.env,
): TidalClient | null {
  const envId = env[TIDAL_CLIENT_ID_ENV]?.trim();
  if (envId) {
    return { clientId: envId, clientSecret: env[TIDAL_CLIENT_SECRET_ENV]?.trim() || undefined, source: 'env' };
  }
  const configId = service?.tidalClientId?.trim();
  if (configId) {
    return { clientId: configId, clientSecret: service?.tidalClientSecret?.trim() || undefined, source: 'config' };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Authorization code + PKCE                                                  */
/* -------------------------------------------------------------------------- */

export function buildAuthorizeUrl(input: {
  client: TidalClient;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.client.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope ?? TIDAL_PKCE_SCOPE,
    code_challenge_method: 'S256',
    code_challenge: input.codeChallenge,
    state: input.state,
  });
  return `${TIDAL_LOGIN_URL}?${params.toString()}`;
}

export async function exchangeAuthorizationCode(
  client: TidalClient,
  input: { code: string; redirectUri: string; codeVerifier: string },
  fetchFn: FetchFn = fetch,
): Promise<TidalTokens> {
  const res = await postForm(
    fetchFn,
    `${TIDAL_AUTH_URL}/token`,
    client,
    {
      client_id: client.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
      scope: TIDAL_PKCE_SCOPE,
    },
    'pkce',
  );
  const body = await readJson(res);
  if (!res.ok) throw authErrorFrom(res.status, body, 'Tidal did not accept the sign-in code');
  return tokensFrom(body);
}

/* -------------------------------------------------------------------------- */
/* Device flow                                                                */
/* -------------------------------------------------------------------------- */

/** {@link resolveTidalClient}, or sonn's own public app when nothing names a client. */
export function tidalClientFor(
  service?: Pick<StreamingServiceConfig, 'tidalClientId' | 'tidalClientSecret'> | null,
  env: Record<string, string | undefined> = process.env,
): TidalClient {
  return resolveTidalClient(service, env) ?? { clientId: TIDAL_DEFAULT_CLIENT_ID, source: 'default' };
}

export async function startDeviceAuthorization(
  client: TidalClient,
  fetchFn: FetchFn = fetch,
): Promise<TidalDeviceAuthorization> {
  const res = await postForm(fetchFn, `${TIDAL_AUTH_URL}/device_authorization`, client, {
    client_id: client.clientId,
    scope: TIDAL_SCOPE,
  });
  const body = await readJson(res);
  if (!res.ok) throw authErrorFrom(res.status, body, 'Tidal did not hand out a sign-in code');
  const deviceCode = str(body.deviceCode ?? body.device_code);
  const userCode = str(body.userCode ?? body.user_code);
  if (!deviceCode || !userCode) {
    throw new TidalAuthError('Tidal answered the sign-in request without a code.', 'failed', res.status);
  }
  const verificationUri = withScheme(str(body.verificationUri ?? body.verification_uri) || 'link.tidal.com');
  const complete = str(body.verificationUriComplete ?? body.verification_uri_complete);
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: complete ? withScheme(complete) : `${verificationUri.replace(/\/+$/, '')}/${userCode}`,
    expiresIn: positive(body.expiresIn ?? body.expires_in, 300),
    interval: positive(body.interval, 2),
  };
}

/** One poll of the token endpoint for a device code; see {@link TidalDevicePoll}. */
export async function pollDeviceToken(
  client: TidalClient,
  deviceCode: string,
  fetchFn: FetchFn = fetch,
): Promise<TidalDevicePoll> {
  let res: Response;
  try {
    res = await postForm(fetchFn, `${TIDAL_AUTH_URL}/token`, client, {
      client_id: client.clientId,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT,
      scope: TIDAL_SCOPE,
    });
  } catch {
    return { status: 'retry' };
  }
  // A gateway error must not abort a sign-in someone may be halfway through approving.
  if (res.status >= 500) return { status: 'retry' };
  const body = await readJson(res);
  if (res.ok) return { status: 'approved', tokens: tokensFrom(body) };
  const error = str(body.error);
  if (error === 'authorization_pending') return { status: 'pending' };
  if (error === 'slow_down') return { status: 'slow_down' };
  if (error === 'expired_token') return { status: 'expired' };
  throw authErrorFrom(res.status, body, 'Tidal refused the sign-in');
}

/* -------------------------------------------------------------------------- */
/* Either flow                                                                */
/* -------------------------------------------------------------------------- */

export async function refreshTidalTokens(
  client: TidalClient,
  refreshToken: string,
  flow: TidalFlow = 'device',
  fetchFn: FetchFn = fetch,
): Promise<TidalTokens> {
  const res = await postForm(
    fetchFn,
    `${TIDAL_AUTH_URL}/token`,
    client,
    {
      client_id: client.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: flow === 'pkce' ? TIDAL_PKCE_SCOPE : TIDAL_SCOPE,
    },
    flow,
  );
  const body = await readJson(res);
  if (!res.ok) throw authErrorFrom(res.status, body, 'Tidal refused to refresh the sign-in');
  return tokensFrom(body);
}

export type TidalIdentity = {
  userId?: string;
  countryCode?: string;
  userName?: string;
  /** `developerAccessTier` from users/me: `THIRD_PARTY` for an app from developer.tidal.com. */
  accessTier?: string;
};

/**
 * Who the token belongs to, and the country whose catalogue it sees.
 *
 * The official API's `users/me` answers any signed-in token with the country, user name and the
 * app's access tier; v1 `/sessions` is the fallback for a token it refuses (a device-flow client
 * with the legacy scopes). For a third-party token v1 answers too, but without a country.
 */
export async function fetchTidalIdentity(accessToken: string, fetchFn: FetchFn = fetch): Promise<TidalIdentity> {
  const me = await fetchFn(`${TIDAL_OPENAPI_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: JSONAPI_CONTENT_TYPE },
  });
  const meBody = await readJson(me);
  if (me.ok) {
    const data = meBody.data && typeof meBody.data === 'object' ? (meBody.data as Record<string, unknown>) : {};
    const attributes =
      data.attributes && typeof data.attributes === 'object' ? (data.attributes as Record<string, unknown>) : {};
    return {
      userId: data.id != null ? String(data.id) : undefined,
      countryCode: str(attributes.country).toUpperCase() || undefined,
      userName: str(attributes.username) || undefined,
      accessTier: str(attributes.developerAccessTier) || undefined,
    };
  }
  const v1 = await fetchFn(TIDAL_SESSIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const v1Body = await readJson(v1);
  if (!v1.ok) throw authErrorFrom(v1.status, v1Body, 'Tidal did not say who signed in');
  return {
    userId: v1Body.userId != null ? String(v1Body.userId) : undefined,
    countryCode: str(v1Body.countryCode).toUpperCase() || undefined,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The secret, when there is one, goes where each flow's reference client puts it: in the form for
 * the PKCE flow (TIDAL's web SDK), as HTTP Basic for the device flow (Music Assistant). A PKCE
 * client is usually public and has none.
 */
async function postForm(
  fetchFn: FetchFn,
  url: string,
  client: TidalClient,
  form: Record<string, string>,
  flow: TidalFlow = 'device',
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  const body = { ...form };
  if (client.clientSecret) {
    if (flow === 'pkce') body.client_secret = client.clientSecret;
    else headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`;
  }
  return fetchFn(url, { method: 'POST', headers, body: new URLSearchParams(body).toString() });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A proxy in between can answer with HTML; that is a failure with no detail, not a crash.
    return {};
  }
}

function tokensFrom(body: Record<string, unknown>): TidalTokens {
  const accessToken = str(body.access_token);
  if (!accessToken) throw new TidalAuthError('Tidal answered without an access token.', 'failed');
  const user = body.user && typeof body.user === 'object' ? (body.user as Record<string, unknown>) : {};
  return {
    accessToken,
    refreshToken: str(body.refresh_token) || undefined,
    expiresIn: positive(body.expires_in, 3600),
    userName: str(user.username) || str(user.email) || undefined,
    // The PKCE token response names the user at the top level; the device flow's in `user`.
    userId: body.user_id != null ? String(body.user_id) : user.userId != null ? String(user.userId) : undefined,
  };
}

/**
 * Tidal's error bodies are `{ status, error, sub_status, error_description }` from the auth server
 * and `{ status, subStatus, userMessage }` from the API. The description is the part worth showing.
 */
export function authErrorFrom(status: number, body: Record<string, unknown>, fallback: string): TidalAuthError {
  const error = str(body.error);
  const description = str(body.error_description) || str(body.userMessage) || str(body.message);
  const message = description || (error ? `${fallback} (${error})` : `${fallback} (HTTP ${status})`);
  if (error === 'unauthorized_client' || error === 'invalid_client' || /limited input device/i.test(description)) {
    return new TidalAuthError(message, 'client-refused', status);
  }
  if (error === 'invalid_grant') return new TidalAuthError(message, 'invalid-grant', status);
  return new TidalAuthError(message, 'failed', status);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positive(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function withScheme(uri: string): string {
  return /^https?:\/\//i.test(uri) ? uri : `https://${uri}`;
}
