import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  buildAuthorizeUrl,
  fetchTidalIdentity,
  resolveTidalClient,
  tidalClientFor,
  TIDAL_DEFAULT_CLIENT_ID,
  TIDAL_PKCE_SCOPE,
  TIDAL_PUBLIC_REDIRECT_URI,
  type FetchFn,
} from '../src/adapters/content/providers/tidal/tidalAuthClient';
import { createPkcePair, pkceChallenge } from '../src/adapters/content/oauth/pkce';
import { parsePastedRedirect } from '../src/adapters/content/oauth/oauthRedirect';
import {
  decodeDataUri,
  JsonApiDocument,
  parseIsoDuration,
  parseTrackManifest,
  searchFromDocument,
  trackManifestUrl,
} from '../src/adapters/content/providers/tidal/tidalOpenApi';
import { TidalProvider } from '../src/adapters/content/providers/tidal/tidalProvider';
import {
  TidalAuth,
  TIDAL_REFRESH_BUFFER_MS,
  type TidalSessionStore,
} from '../src/adapters/content/providers/tidal/tidalAuth';
import { createTidalAdmin } from '../src/adapters/content/providers/tidal/tidalAdmin';
import { buildTidalRoutes } from '../src/adapters/http/adminApi/tidal/tidalHandlers';
import {
  TidalStreamService,
  TIDAL_PLAYBACK_REFUSED,
} from '../src/adapters/content/providers/tidal/tidalStreamService';
import { buildSpotifyRoutes, type SpotifyHandlerDeps } from '../src/adapters/http/adminApi/spotify/spotifyHandlers';
import type { StreamingServiceConfig, TidalSession } from '../src/domain/config/types';
import type { TidalAdminPort } from '../src/ports/TidalAdminPort';

// Everything here runs against a scripted fetch: no request leaves the process. Each handler sees
// the URL and the request, and answers the way Tidal's auth server or API does — the shapes are
// those TIDAL's web SDK and Music Assistant's provider read.

type Call = { url: string; method: string; headers: Headers; body: URLSearchParams };
type Handler = (call: Call) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function scriptedFetch(routes: Array<[RegExp, Handler]>): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route[1](call);
  }) as FetchFn;
  return { fetchFn, calls };
}

function memoryStore(services: StreamingServiceConfig[]): TidalSessionStore & { services: StreamingServiceConfig[] } {
  return {
    services,
    getService: (id) => services.find((s) => s.id === id),
    updateSession: async (id, update) => {
      const service = services.find((s) => s.id === id);
      if (!service) return;
      const next = update(service.tidal);
      if (next) service.tidal = next;
      else delete service.tidal;
    },
  };
}

const NO_ENV = {};
const CLIENT_ENV = { SONN_TIDAL_CLIENT_ID: 'env-client', SONN_TIDAL_CLIENT_SECRET: 'env-secret' };

// ── the client ─────────────────────────────────────────────────────────────────

test('the Tidal client comes from the environment first, then the service config, else none', () => {
  assert.deepEqual(resolveTidalClient({ tidalClientId: 'cfg' }, CLIENT_ENV), {
    clientId: 'env-client',
    clientSecret: 'env-secret',
    source: 'env',
  });
  assert.deepEqual(resolveTidalClient({ tidalClientId: ' cfg ' }, NO_ENV), {
    clientId: 'cfg',
    clientSecret: undefined,
    source: 'config',
  });
  assert.equal(resolveTidalClient({}, NO_ENV), null);
  // Nothing configured: sonn's own public app, with no secret.
  assert.deepEqual(tidalClientFor({}, NO_ENV), { clientId: TIDAL_DEFAULT_CLIENT_ID, source: 'default' });
});

// ── PKCE ───────────────────────────────────────────────────────────────────────

test('a PKCE verifier is 43–128 unreserved characters and its challenge is its S256', () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  // RFC 7636 appendix B's worked example.
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.notEqual(createPkcePair().verifier, verifier);
});

test('the authorize URL carries everything login.tidal.com needs', () => {
  const url = new URL(
    buildAuthorizeUrl({
      client: { clientId: 'abc', clientSecret: 'never-sent', source: 'config' },
      redirectUri: 'http://sonn.local:7091/admin/api/tidal/login/callback',
      codeChallenge: 'CHALLENGE',
      state: 'STATE',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://login.tidal.com/authorize');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), 'abc');
  assert.equal(p.get('redirect_uri'), 'http://sonn.local:7091/admin/api/tidal/login/callback');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), 'CHALLENGE');
  assert.equal(p.get('state'), 'STATE');
  assert.equal(p.get('scope'), TIDAL_PKCE_SCOPE);
  assert.ok(TIDAL_PKCE_SCOPE.split(' ').includes('playback'));
  assert.equal(p.has('client_secret'), false, 'the secret never goes to the browser');
});

test('a pasted redirect yields its code and state, whatever form it is pasted in', () => {
  const local = 'http://192.168.1.5:7090/admin/api/tidal/auth/callback?state=content:tidal:abc';
  // The public page, when it could not forward: state is the encoded local callback.
  const publicPage = `${TIDAL_PUBLIC_REDIRECT_URI}?${new URLSearchParams({ code: 'C1', state: encodeURIComponent(local) })}`;
  assert.deepEqual(parsePastedRedirect(publicPage), { code: 'C1', state: 'content:tidal:abc', error: undefined, errorDescription: undefined });
  // This server's own callback, unreachable from where the person signed in.
  assert.equal(parsePastedRedirect(`${local}&code=C2`)?.code, 'C2');
  assert.equal(parsePastedRedirect(`${local}&code=C2`)?.state, 'content:tidal:abc');
  // Just the query, or the code glued onto the state.
  assert.equal(parsePastedRedirect('code=C3&state=S3')?.state, 'S3');
  assert.equal(parsePastedRedirect('?state=S4?code=C4')?.code, 'C4');
  assert.equal(parsePastedRedirect('https://x/?error=access_denied&error_description=No&state=S')?.error, 'access_denied');
  assert.equal(parsePastedRedirect('https://sonn-audio.github.io/callbacks/tidal/'), null);
  assert.equal(parsePastedRedirect(''), null);
});

// ── browser sign-in ────────────────────────────────────────────────────────────

// The token response and users/me are the ones a real third-party app got from TIDAL.
function pkceHarness(services: StreamingServiceConfig[] = []) {
  const { fetchFn, calls } = scriptedFetch([
    [
      /auth\.tidal\.com\/v1\/oauth2\/token$/,
      () =>
        json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 14400, token_type: 'Bearer', scope: TIDAL_PKCE_SCOPE, user_id: 42 }),
    ],
    [
      /openapi\.tidal\.com\/v2\/users\/me$/,
      () =>
        json(200, {
          data: { id: '42', type: 'users', attributes: { country: 'NL', username: 'rudy', developerAccessTier: 'THIRD_PARTY' } },
        }),
    ],
  ]);
  const store = memoryStore(services);
  const admin = createTidalAdmin({ store, fetchFn, env: NO_ENV, audioServerHost: () => '192.168.1.5' });
  return { admin, calls, store };
}

/** What the public page would forward the browser to, given the state Tidal sent back. */
function forwardedCallback(authorizeUrl: string, code: string): string {
  const local = decodeURIComponent(new URL(authorizeUrl).searchParams.get('state')!);
  return `${local}&code=${code}`;
}

test('the sign-in goes through the public redirect page and carries this server\'s callback in state', async () => {
  const { admin } = pkceHarness();
  const start = await admin.startLogin({ mode: 'browser' });
  assert.ok(start.ok && start.mode === 'browser');
  const p = new URL(start.authorizeUrl).searchParams;
  assert.equal(p.get('client_id'), TIDAL_DEFAULT_CLIENT_ID, 'sonn\'s own app when nothing else is set');
  assert.equal(p.get('redirect_uri'), 'https://sonn-audio.github.io/callbacks/tidal/');
  assert.equal(start.redirectUri, TIDAL_PUBLIC_REDIRECT_URI);
  const local = new URL(decodeURIComponent(p.get('state')!));
  assert.equal(local.origin + local.pathname, 'http://192.168.1.5:7090/admin/api/tidal/auth/callback');
  assert.match(local.searchParams.get('state')!, /^content:tidal:[0-9a-f]{32}$/);
  assert.equal(start.callbackUrl, local.href);
});

test('a pasted redirect is exchanged with the verifier whose challenge went to login.tidal.com', async () => {
  const { admin, calls } = pkceHarness();
  const start = await admin.startLogin({ mode: 'browser', clientId: 'my-app' });
  assert.ok(start.ok && start.mode === 'browser');
  const authorize = new URL(start.authorizeUrl);

  // The public page could not reach this server (a sign-in on a phone): its address is pasted.
  const landed = `${TIDAL_PUBLIC_REDIRECT_URI}?${new URLSearchParams({ code: 'THECODE', state: authorize.searchParams.get('state')! })}`;
  const status = await admin.completePaste(start.loginId, landed);
  assert.deepEqual(status, { state: 'done', userId: '42', userName: 'rudy', countryCode: 'NL', accessTier: 'THIRD_PARTY' });

  const token = calls.find((c) => c.url.endsWith('/oauth2/token'))!;
  assert.equal(token.method, 'POST');
  assert.equal(token.body.get('grant_type'), 'authorization_code');
  assert.equal(token.body.get('client_id'), 'my-app');
  assert.equal(token.body.get('code'), 'THECODE');
  assert.equal(token.body.get('redirect_uri'), TIDAL_PUBLIC_REDIRECT_URI);
  assert.equal(token.body.has('client_secret'), false, 'a public client sends no secret');
  assert.equal(token.headers.has('Authorization'), false);
  assert.equal(pkceChallenge(token.body.get('code_verifier')!), authorize.searchParams.get('code_challenge'));

  const session = admin.takeSession(start.loginId)!;
  assert.equal(session.accessToken, 'AT');
  assert.equal(session.refreshToken, 'RT');
  assert.equal(session.countryCode, 'NL');
  assert.equal(session.accessTier, 'THIRD_PARTY');
  assert.equal(session.flow, 'pkce');
  assert.equal(admin.takeSession(start.loginId), null, 'handed over once');
});

test('a configured secret is sent in the form, only when there is one', async () => {
  const { admin, calls } = pkceHarness();
  const start = await admin.startLogin({ mode: 'browser', clientId: 'my-app', clientSecret: 's3cret' });
  assert.ok(start.ok && start.mode === 'browser');
  await admin.completePaste(start.loginId, forwardedCallback(start.authorizeUrl, 'C'));
  assert.equal(calls.find((c) => c.url.endsWith('/oauth2/token'))!.body.get('client_secret'), 's3cret');
});

test('a redirect with a foreign state is refused and the sign-in stays open', async () => {
  const { admin, calls } = pkceHarness();
  const start = await admin.startLogin({ mode: 'browser' });
  assert.ok(start.ok);
  const status = await admin.completePaste(
    start.loginId,
    'http://192.168.1.5:7090/admin/api/tidal/auth/callback?state=content:tidal:not-this-one&code=STOLEN',
  );
  assert.equal(status.state, 'error');
  assert.equal(status.state === 'error' && status.error, 'state-mismatch');
  assert.equal(calls.length, 0, 'no code was exchanged');
  assert.deepEqual(admin.loginStatus(start.loginId), { state: 'pending' });
});

test('signing in again on a saved service stores the new session at once', async () => {
  const saved: StreamingServiceConfig = { id: 'bridge-tidal-1', label: 'Tidal', provider: 'tidal' };
  const { admin, store } = pkceHarness([saved]);
  const start = await admin.startLogin({ mode: 'browser', serviceId: 'bridge-tidal-1' });
  assert.ok(start.ok && start.mode === 'browser');
  await admin.completePaste(start.loginId, forwardedCallback(start.authorizeUrl, 'C'));
  assert.equal(store.services[0]!.tidal?.accessToken, 'AT');
});

test('the callback route finishes a callback sign-in and the status reports it', async () => {
  const { admin } = pkceHarness();
  const sent: Array<{ status: number; body: unknown }> = [];
  const routes = buildTidalRoutes({
    log: { info() {}, warn() {}, debug() {}, error() {} } as never,
    tidalAdmin: admin,
    readJsonBody: async () => null,
    sendJson: (_res, status, body) => sent.push({ status, body }),
    sendHtml: (_res, status, body) => sent.push({ status, body }),
  });
  const start = await admin.startLogin({ mode: 'browser' });
  assert.ok(start.ok && start.mode === 'browser');

  // What the public page forwards the browser to.
  const forwarded = new URL(forwardedCallback(start.authorizeUrl, 'CB'));
  const callback = routes.find((r) => r.method === 'GET' && r.pattern.test('/tidal/auth/callback'))!;
  const req = { url: forwarded.pathname + forwarded.search } as IncomingMessage;
  await callback.handler(req, {} as ServerResponse, [] as unknown as RegExpMatchArray, '/tidal/auth/callback');
  assert.equal(sent[0]!.status, 200);
  assert.match(String(sent[0]!.body), /Signed in as rudy/);

  // A replayed or forged callback finds nothing to finish.
  await callback.handler({ url: '/admin/api/tidal/auth/callback?code=X&state=content:tidal:forged' } as IncomingMessage, {} as ServerResponse, [] as unknown as RegExpMatchArray, '');
  assert.equal(sent[1]!.status, 400);

  const status = routes.find((r) => r.method === 'GET' && r.pattern.test('/tidal/login/status'))!;
  await status.handler({ url: `/admin/api/tidal/login/status?loginId=${start.loginId}` } as IncomingMessage, {} as ServerResponse, [] as unknown as RegExpMatchArray, '');
  assert.deepEqual(sent[2]!.body, { state: 'done', userId: '42', userName: 'rudy', countryCode: 'NL', accessTier: 'THIRD_PARTY' });
});

test('the identity comes from users/me, and from v1 sessions when users/me refuses the token', async () => {
  const third = scriptedFetch([
    [/openapi\.tidal\.com\/v2\/users\/me$/, () => json(200, { data: { id: '7', attributes: { country: 'se', username: 'anna', developerAccessTier: 'THIRD_PARTY' } } })],
  ]);
  assert.deepEqual(await fetchTidalIdentity('AT', third.fetchFn), { userId: '7', countryCode: 'SE', userName: 'anna', accessTier: 'THIRD_PARTY' });
  assert.equal(third.calls[0]!.headers.get('Authorization'), 'Bearer AT');
  assert.equal(third.calls[0]!.headers.get('Accept'), 'application/vnd.api+json');

  const legacy = scriptedFetch([
    [/users\/me$/, () => json(403, { errors: [{ status: '403', detail: 'Insufficient scope' }] })],
    [/api\.tidal\.com\/v1\/sessions$/, () => json(200, { userId: 9, countryCode: 'nl', sessionId: 'x' })],
  ]);
  assert.deepEqual(await fetchTidalIdentity('DAT', legacy.fetchFn), { userId: '9', countryCode: 'NL' });
});

// ── device flow ────────────────────────────────────────────────────────────────

test('a device sign-in polls through pending and slow_down, then takes the country from the session', async () => {
  const answers = [
    () => json(400, { status: 400, error: 'authorization_pending', sub_status: 1002 }),
    () => json(400, { status: 400, error: 'slow_down' }),
    () => json(503, {}),
    () => json(200, { access_token: 'DAT', refresh_token: 'DRT', expires_in: 600, user: { username: 'dev-user' } }),
  ];
  const { fetchFn, calls } = scriptedFetch([
    [
      /device_authorization$/,
      () =>
        json(200, {
          deviceCode: 'DC',
          userCode: 'ABCDE',
          verificationUri: 'link.tidal.com',
          verificationUriComplete: 'link.tidal.com/ABCDE',
          expiresIn: 300,
          interval: 2,
        }),
    ],
    [/oauth2\/token$/, () => answers.shift()!()],
    [/users\/me$/, () => json(403, {})],
    [/v1\/sessions$/, () => json(200, { userId: 9, countryCode: 'NL' })],
  ]);
  const sleeps: number[] = [];
  const admin = createTidalAdmin({ store: memoryStore([]), fetchFn, env: CLIENT_ENV, sleep: async (ms) => void sleeps.push(ms) });
  const start = await admin.startLogin({ mode: 'device' });
  assert.ok(start.ok && start.mode === 'device');
  assert.equal(start.userCode, 'ABCDE');
  assert.equal(start.verificationUriComplete, 'https://link.tidal.com/ABCDE');
  await admin.settled(start.loginId);

  assert.deepEqual(sleeps, [2000, 2000, 7000, 7000], 'slow_down adds five seconds for good');
  assert.deepEqual(admin.loginStatus(start.loginId), { state: 'done', userId: '9', userName: 'dev-user', countryCode: 'NL', accessTier: undefined });
  const poll = calls.find((c) => c.url.endsWith('/token'))!;
  assert.equal(poll.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll.body.get('device_code'), 'DC');
  assert.equal(poll.headers.get('Authorization'), `Basic ${Buffer.from('env-client:env-secret').toString('base64')}`);
  assert.equal(admin.takeSession(start.loginId)?.flow, 'device');
});

test('a client Tidal will not run the device flow for is reported as such', async () => {
  const { fetchFn } = scriptedFetch([
    [
      /device_authorization$/,
      () => json(400, { status: 400, error: 'unauthorized_client', sub_status: 1002, error_description: 'Client is not a Limited Input Device client' }),
    ],
  ]);
  const admin = createTidalAdmin({ store: memoryStore([]), fetchFn, env: CLIENT_ENV });
  const start = await admin.startLogin({ mode: 'device' });
  assert.equal(start.ok, false);
  assert.ok(!start.ok);
  assert.equal(start.error, 'client-refused');
  assert.match(start.message, /Client is not a Limited Input Device client/);
});

// ── keeping the token valid ────────────────────────────────────────────────────

function tidalService(session?: Partial<TidalSession>): StreamingServiceConfig {
  return {
    id: 'bridge-tidal-1',
    label: 'Tidal',
    provider: 'tidal',
    tidalCountryCode: 'US',
    tidalClientId: 'my-app',
    tidal: session
      ? { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0, countryCode: 'NL', flow: 'pkce', ...session }
      : undefined,
  };
}

test('a token about to expire is refreshed before the request, and the new one is stored', async () => {
  const t = 1_000_000;
  const store = memoryStore([tidalService({ expiresAt: t + TIDAL_REFRESH_BUFFER_MS - 1000 })]);
  const { fetchFn, calls } = scriptedFetch([
    [/oauth2\/token$/, () => json(200, { access_token: 'NEW', expires_in: 3600 })],
    [/api\.tidal\.com\/v1\/tracks/, () => json(200, { id: 1 })],
  ]);
  const auth = new TidalAuth({ store, fetchFn, now: () => t, env: NO_ENV });
  const res = await auth.fetch('bridge-tidal-1', new URL('https://api.tidal.com/v1/tracks/1'));
  assert.equal(res?.status, 200);
  assert.equal(calls[0]!.body.get('grant_type'), 'refresh_token');
  assert.equal(calls[0]!.body.get('refresh_token'), 'RT');
  assert.equal(calls[0]!.body.get('scope'), TIDAL_PKCE_SCOPE, 'a PKCE session refreshes with its own scopes');
  assert.equal(calls[1]!.headers.get('Authorization'), 'Bearer NEW');
  // The country is the session's, not the manual fallback.
  assert.equal(new URL(calls[1]!.url).searchParams.get('countryCode'), 'NL');
  const stored = store.services[0]!.tidal!;
  assert.equal(stored.accessToken, 'NEW');
  assert.equal(stored.refreshToken, 'RT', 'kept when Tidal sends no new one');
  assert.equal(stored.expiresAt, t + 3600 * 1000);
});

test('a 401 refreshes once and retries once', async () => {
  const t = 1_000_000;
  const store = memoryStore([tidalService({ expiresAt: t + 3600 * 1000 })]);
  const { fetchFn, calls } = scriptedFetch([
    [/oauth2\/token$/, () => json(200, { access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 })],
    [/v1\/search/, (call) => (call.headers.get('Authorization') === 'Bearer NEW' ? json(200, { items: [] }) : json(401, {}))],
  ]);
  const auth = new TidalAuth({ store, fetchFn, now: () => t, env: NO_ENV });
  const res = await auth.fetch('bridge-tidal-1', new URL('https://api.tidal.com/v1/search/tracks'));
  assert.equal(res?.status, 200);
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ['/v1/search/tracks', '/v1/oauth2/token', '/v1/search/tracks']);
  assert.equal(store.services[0]!.tidal!.refreshToken, 'RT2');
});

test('concurrent refreshes share one request to the token endpoint, and a refused one is remembered', async () => {
  let t = 1_000_000;
  const store = memoryStore([tidalService({ expiresAt: t })]);
  let tokenCalls = 0;
  const { fetchFn } = scriptedFetch([
    [
      /oauth2\/token$/,
      async () => {
        tokenCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return tokenCalls === 1
          ? json(200, { access_token: 'NEW', expires_in: 3600 })
          : json(400, { error: 'invalid_grant', error_description: 'Refresh token expired' });
      },
    ],
  ]);
  const auth = new TidalAuth({ store, fetchFn, now: () => t, env: NO_ENV });
  const results = await Promise.all([auth.refresh('bridge-tidal-1'), auth.refresh('bridge-tidal-1'), auth.refresh('bridge-tidal-1')]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(tokenCalls, 1);
  // Inside the cooldown, a 401 burst does not go back to the token endpoint.
  assert.equal(await auth.refresh('bridge-tidal-1'), true);
  assert.equal(tokenCalls, 1);
  // After it, a refused refresh is recorded on the account for the admin UI.
  t += 31_000;
  assert.equal(await auth.refresh('bridge-tidal-1'), false);
  assert.equal(store.services[0]!.tidal!.refreshError, 'Refresh token expired');
});

test('a hand-pasted token still works, with the manual country', async () => {
  const store = memoryStore([{ id: 'bridge-tidal-1', label: 'Tidal', provider: 'tidal', tidalAccessToken: 'PASTED', tidalCountryCode: 'gb' }]);
  const { fetchFn, calls } = scriptedFetch([[/v1\/tracks/, () => json(401, {})]]);
  const auth = new TidalAuth({ store, fetchFn, env: NO_ENV });
  const res = await auth.fetch('bridge-tidal-1', new URL('https://api.tidal.com/v1/tracks/1'));
  assert.equal(res?.status, 401, 'nothing to refresh: the 401 stands');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.headers.get('Authorization'), 'Bearer PASTED');
  assert.equal(new URL(calls[0]!.url).searchParams.get('countryCode'), 'GB');
});

// ── playback ───────────────────────────────────────────────────────────────────

function b64(value: string): string {
  return Buffer.from(value).toString('base64');
}

const BTS = {
  manifestMimeType: 'application/vnd.tidal.bts',
  manifest: b64(JSON.stringify({ mimeType: 'audio/flac', codecs: 'flac', encryptionType: 'NONE', urls: ['https://sp-pr-cf.audio.tidal.com/x.flac'] })),
};
const DASH_XML = '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet/></Period></MPD>';
const DASH = { manifestMimeType: 'application/dash+xml', manifest: b64(DASH_XML) };
const DASH_DRM = {
  manifestMimeType: 'application/dash+xml',
  manifest: b64('<?xml version="1.0"?><MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9"/></AdaptationSet></Period></MPD>'),
};

function streamHarness(
  quality: StreamingServiceConfig['tidalQuality'],
  answer: (quality: string) => Response,
  options: { flow?: 'pkce' | 'device'; manifest?: (formats: string) => Response } = {},
) {
  const service: StreamingServiceConfig = {
    ...tidalService({ expiresAt: Date.now() + 3600_000, flow: options.flow ?? 'device' }),
    tidalQuality: quality,
  };
  const config = { content: { streamingServices: [service] } };
  const errors: Array<{ zoneId: number; reason?: string }> = [];
  const { fetchFn, calls } = scriptedFetch([
    [/playbackinfopostpaywall/, (call) => answer(new URL(call.url).searchParams.get('audioquality')!)],
    [/openapi\.tidal\.com\/v2\/trackManifests/, (call) => (options.manifest ?? (() => json(500, {})))(new URL(call.url).searchParams.getAll('formats').join(','))],
    [/oauth2\/token$/, () => json(400, { error: 'invalid_grant' })],
  ]);
  const store = memoryStore([service]);
  const auth = new TidalAuth({ store, fetchFn, env: NO_ENV });
  const configPort = { getConfig: () => config } as never;
  const stream = new TidalStreamService((zoneId, reason) => errors.push({ zoneId, reason }), configPort, auth);
  stream.configureFromConfig();
  return { stream, calls, errors, store };
}

test('a BTS manifest plays its file URL directly, at the configured quality', async () => {
  const { stream, calls } = streamHarness('HIGH', () => json(200, BTS));
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.deepEqual(result.playbackSource, { kind: 'url', url: 'https://sp-pr-cf.audio.tidal.com/x.flac' });
  const params = new URL(calls[0]!.url).searchParams;
  assert.equal(params.get('audioquality'), 'HIGH');
  assert.equal(params.get('countryCode'), 'NL');
});

test('a DASH manifest is served from the manifest route; lossless is the default quality', async () => {
  const { stream, calls } = streamHarness(undefined, () => json(200, DASH));
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(new URL(calls[0]!.url).searchParams.get('audioquality'), 'LOSSLESS');
  const source = result.playbackSource as { kind: string; url: string; inputFormat?: string };
  assert.equal(source.inputFormat, 'dash');
  const match = source.url.match(/\/tidal\/([^/]+)\/manifest\.mpd$/);
  assert.ok(match, source.url);

  let served = '';
  const res = { writeHead() {}, end: (body?: string) => void (served = body ?? '') } as unknown as ServerResponse;
  await stream.getProxyRoute().handle({ url: `/tidal/${match![1]}/manifest.mpd` } as IncomingMessage, res);
  assert.equal(served, DASH_XML);
});

test('hi-res that comes back DRM-protected falls back to lossless, once', async () => {
  const { stream, calls } = streamHarness('HI_RES_LOSSLESS', (q) => json(200, q === 'HI_RES_LOSSLESS' ? DASH_DRM : BTS));
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.deepEqual(result.playbackSource, { kind: 'url', url: 'https://sp-pr-cf.audio.tidal.com/x.flac' });
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('audioquality')), ['HI_RES_LOSSLESS', 'LOSSLESS']);
});

test('hi-res refused outright also falls back to lossless, but not further', async () => {
  const { stream, calls, errors } = streamHarness('HI_RES_LOSSLESS', () => json(400, { status: 400, subStatus: 4005 }));
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(result.playbackSource, null);
  assert.equal(calls.length, 2);
  assert.equal(errors[0]?.reason, 'tidal playback info unavailable');
});

// What a device-flow client TIDAL caps answers for LOSSLESS: AAC 320, said in `audioQuality`.
const BTS_AAC = {
  trackId: 123,
  assetPresentation: 'FULL',
  audioMode: 'STEREO',
  audioQuality: 'HIGH',
  manifestMimeType: 'application/vnd.tidal.bts',
  manifest: b64(JSON.stringify({ mimeType: 'audio/mp4', codecs: 'mp4a.40.2', encryptionType: 'NONE', urls: ['https://sp-ad-cf.audio.tidal.com/x.mp4'] })),
};

test('a lower quality than asked is played once, recorded on the account, and cleared when the asked one comes', async () => {
  let delivered = 'HIGH';
  const { stream, calls, store } = streamHarness('LOSSLESS', () => json(200, { ...BTS_AAC, audioQuality: delivered }));
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.deepEqual(result.playbackSource, { kind: 'url', url: 'https://sp-ad-cf.audio.tidal.com/x.mp4' });
  assert.equal(calls.length, 1, 'the downgrade is not retried');
  assert.equal(store.services[0]!.tidal!.deliveredQuality, 'HIGH');

  await stream.startStreamForAudiopath(1, 'tidal:track:124');
  assert.equal(calls.length, 2);
  assert.equal(store.services[0]!.tidal!.deliveredQuality, 'HIGH');

  delivered = 'LOSSLESS';
  await stream.startStreamForAudiopath(1, 'tidal:track:125');
  assert.equal(store.services[0]!.tidal!.deliveredQuality, undefined);
});

test('the delivered quality is written to the account only when it changes', async () => {
  const store = memoryStore([{ ...tidalService({ expiresAt: Date.now() + 3600_000, flow: 'device' }), tidalQuality: 'LOSSLESS' }]);
  let writes = 0;
  const counting = { ...store, updateSession: async (...args: Parameters<typeof store.updateSession>) => (writes++, store.updateSession(...args)) };
  const auth = new TidalAuth({ store: counting, fetchFn: (() => assert.fail('no request')) as unknown as FetchFn, env: NO_ENV });
  await auth.noteQuality('bridge-tidal-1', 'HIGH');
  await auth.noteQuality('bridge-tidal-1', 'HIGH');
  await auth.noteQuality('bridge-tidal-1', undefined);
  await auth.noteQuality('bridge-tidal-1', undefined);
  assert.equal(writes, 2);
  assert.equal('deliveredQuality' in store.services[0]!.tidal! && store.services[0]!.tidal!.deliveredQuality, undefined);
});

test('the quality record compares against the configured quality, through a hi-res fallback and on trackManifests', async () => {
  const hiRes = streamHarness('HI_RES_LOSSLESS', (q) => json(200, q === 'HI_RES_LOSSLESS' ? DASH_DRM : { ...BTS, audioQuality: 'LOSSLESS' }));
  await hiRes.stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(hiRes.store.services[0]!.tidal!.deliveredQuality, 'LOSSLESS');

  const asAsked = streamHarness('HIGH', () => json(200, BTS_AAC));
  await asAsked.stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(asAsked.store.services[0]!.tidal!.deliveredQuality, undefined, 'HIGH asked, HIGH delivered');

  const openapi = streamHarness('HI_RES_LOSSLESS', () => json(401, {}), {
    flow: 'pkce',
    manifest: (formats) => json(200, manifestDoc(formats === 'FLAC_HIRES' ? DRM_XML : DASH_XML, { formats: ['FLAC'] })),
  });
  await openapi.stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(openapi.store.services[0]!.tidal!.deliveredQuality, 'LOSSLESS');
});

test('a third-party sign-in plays from trackManifests, and a preview is played and recorded', async () => {
  const { stream, calls, errors, store } = streamHarness('LOSSLESS', () => json(401, {}), {
    flow: 'pkce',
    manifest: () => json(200, manifestDoc(DASH_XML, { trackPresentation: 'PREVIEW', previewReason: 'FULL_REQUIRES_HIGHER_ACCESS_TIER' })),
  });
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal((result.playbackSource as { inputFormat?: string }).inputFormat, 'dash');
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1, 'v1 is never asked for a third-party token');
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/v2/trackManifests/123');
  assert.equal(url.searchParams.get('formats'), 'FLAC');
  assert.equal(url.searchParams.get('uriScheme'), 'DATA');
  assert.equal(store.services[0]!.tidal!.previewReason, 'FULL_REQUIRES_HIGHER_ACCESS_TIER');
});

test('a 403 from v1 playback falls back to trackManifests once', async () => {
  const { stream, calls } = streamHarness('LOSSLESS', () => json(403, { status: 403, subStatus: 4005 }), {
    manifest: () => json(200, manifestDoc(DASH_XML, { trackPresentation: 'FULL' })),
  });
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal((result.playbackSource as { inputFormat?: string }).inputFormat, 'dash');
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname.split('/')[2]), ['tracks', 'trackManifests']);
});

test('refused by both APIs, playback says Tidal refused this app, without looping on refresh', async () => {
  const { stream, calls, errors } = streamHarness('LOSSLESS', () => json(403, { status: 403 }), {
    manifest: () => json(403, {}),
  });
  const result = await stream.startStreamForAudiopath(3, 'tidal:track:123');
  assert.equal(result.playbackSource, null);
  assert.deepEqual(errors, [{ zoneId: 3, reason: TIDAL_PLAYBACK_REFUSED }]);
  assert.equal(calls.length, 2);
});

test('a 401 from v1 playback refreshes once before giving up on it', async () => {
  const { stream, calls, errors } = streamHarness('LOSSLESS', () => json(401, {}), { manifest: () => json(401, {}) });
  await stream.startStreamForAudiopath(3, 'tidal:track:123');
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname.split('/').pop()),
    ['playbackinfopostpaywall', 'token', '123'],
    'one refresh, inside its cooldown afterwards',
  );
  assert.deepEqual(errors, [{ zoneId: 3, reason: TIDAL_PLAYBACK_REFUSED }]);
});

test('a protected hi-res manifest from trackManifests falls back to lossless', async () => {
  const { stream, calls } = streamHarness('HI_RES_LOSSLESS', () => json(401, {}), {
    flow: 'pkce',
    manifest: (formats) => json(200, manifestDoc(formats === 'FLAC_HIRES' ? DRM_XML : DASH_XML)),
  });
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal((result.playbackSource as { inputFormat?: string }).inputFormat, 'dash');
  assert.deepEqual(calls.map((c) => new URL(c.url).searchParams.get('formats')), ['FLAC_HIRES', 'FLAC']);
});

// ── openapi documents ──────────────────────────────────────────────────────────

const DRM_XML = '<?xml version="1.0"?><MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/></AdaptationSet></Period></MPD>';

function manifestDoc(mpd: string, attributes: Record<string, unknown> = {}) {
  return {
    data: {
      id: '123',
      type: 'trackManifests',
      attributes: { uri: `data:application/dash+xml;base64,${b64(mpd)}`, formats: ['FLAC'], hash: 'h', ...attributes },
    },
  };
}

test('a trackManifests document decodes its data: URI and says when it is a preview', () => {
  const parsed = parseTrackManifest(manifestDoc(DASH_XML, { trackPresentation: 'PREVIEW', previewReason: 'FULL_REQUIRES_HIGHER_ACCESS_TIER' }));
  assert.deepEqual(parsed, {
    kind: 'dash',
    manifest: DASH_XML,
    presentation: 'PREVIEW',
    previewReason: 'FULL_REQUIRES_HIGHER_ACCESS_TIER',
    formats: ['FLAC'],
  });
  assert.equal(parseTrackManifest(manifestDoc(DRM_XML)).kind, 'drm');
  assert.equal(parseTrackManifest({ data: { attributes: { uri: 'https://x/manifest.mpd' } } }).kind, 'unsupported');
  assert.equal(decodeDataUri('data:text/plain,a%20b'), 'a b');
  assert.equal(decodeDataUri('https://x'), null);
  assert.equal(trackManifestUrl('9', 'HIGH').searchParams.get('formats'), 'AACLC');
});

const SEARCH_DOC = {
  data: [
    {
      id: 'opaque',
      type: 'searchResults',
      relationships: {
        tracks: { data: [{ id: '101', type: 'tracks' }] },
        albums: { data: [{ id: '201', type: 'albums' }] },
        artists: { data: [{ id: '301', type: 'artists' }] },
        playlists: { data: [{ id: 'pl-1', type: 'playlists' }] },
      },
    },
  ],
  included: [
    {
      id: '101',
      type: 'tracks',
      attributes: { title: 'Song', version: 'Live', duration: 'PT3M57S' },
      relationships: { artists: { data: [{ id: '301', type: 'artists' }] }, albums: { data: [{ id: '201', type: 'albums' }] } },
    },
    {
      id: '201',
      type: 'albums',
      attributes: { title: 'Record' },
      relationships: { coverArt: { data: [{ id: 'art-1', type: 'artworks' }] }, artists: { data: [{ id: '301', type: 'artists' }] } },
    },
    { id: '301', type: 'artists', attributes: { name: 'Band' }, relationships: { profileArt: { data: [] } } },
    { id: 'pl-1', type: 'playlists', attributes: { name: 'Mix', playlistType: 'EDITORIAL' }, relationships: {} },
    {
      id: 'art-1',
      type: 'artworks',
      attributes: {
        files: [
          { href: 'https://resources.tidal.com/a/80.jpg', meta: { width: 80 } },
          { href: 'https://resources.tidal.com/a/640.jpg', meta: { width: 640 } },
          { href: 'https://resources.tidal.com/a/320.jpg', meta: { width: 320 } },
        ],
      },
    },
  ],
};

test('search results map onto tracks, albums, artists and playlists with their artwork', () => {
  const found = searchFromDocument(new JsonApiDocument(SEARCH_DOC));
  assert.deepEqual(found.tracks, [
    { id: '101', title: 'Song (Live)', duration: 237, artist: { name: 'Band' }, album: { title: 'Record' }, coverUrl: 'https://resources.tidal.com/a/320.jpg' },
  ]);
  assert.deepEqual(found.albums, [{ id: '201', title: 'Record', artist: { name: 'Band' }, coverUrl: 'https://resources.tidal.com/a/320.jpg' }]);
  assert.deepEqual(found.artists, [{ id: '301', name: 'Band', coverUrl: '' }]);
  assert.equal(found.playlists[0]!.uuid, 'pl-1');
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
});

function fakeAccess(api: 'openapi' | 'v1', routes: Array<[RegExp, Handler]>) {
  const { fetchFn, calls } = scriptedFetch(routes);
  return {
    calls,
    auth: {
      api: () => api,
      notePreview: async () => {},
      noteQuality: async () => {},
      fetch: async (_id: string, url: URL, init?: RequestInit) => fetchFn(url.toString(), init),
    },
  };
}

test('a third-party account searches through openapi and gets catalogue items back', async () => {
  const { auth, calls } = fakeAccess('openapi', [[/openapi\.tidal\.com\/v2\/searchResults/, () => json(200, SEARCH_DOC)]]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const { result } = await provider.search('song', { track: 5, album: 5 }, 10);
  assert.equal(result.tracks?.[0]?.audiopath, 'tidal:track:101');
  assert.equal(result.tracks?.[0]?.artist, 'Band');
  assert.equal(result.tracks?.[0]?.coverurl, 'https://resources.tidal.com/a/320.jpg');
  assert.equal(result.albums?.[0]?.audiopath, 'tidal:album:201');
  assert.equal(result.artists, undefined, 'only the kinds asked for');
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('filter[query]'), 'song');
  assert.equal(url.searchParams.get('include'), 'tracks.artists,tracks.albums.coverArt,albums.coverArt');
  assert.equal(calls[0]!.headers.get('Accept'), 'application/vnd.api+json');
});

test('when v1 refuses the token ("Required scopes: r_usr"), the provider moves to openapi', async () => {
  const { auth, calls } = fakeAccess('v1', [
    [/api\.tidal\.com\/v1\//, () => json(403, { status: 403, subStatus: 1002, userMessage: 'Required scopes: r_usr' })],
    [/openapi\.tidal\.com\/v2\/albums\/201\/relationships\/items/, (call) =>
      json(200, {
        data: [{ id: '101', type: 'tracks', meta: { trackNumber: 1 } }],
        included: SEARCH_DOC.included,
        links: new URL(call.url).searchParams.has('page[cursor]') ? {} : { next: '/albums/201/relationships/items?page%5Bcursor%5D=NEXT' },
      })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const folder = await provider.getFolder('tidal:album:201', 0, 2);
  assert.deepEqual(folder?.items.map((i) => i.audiopath), ['tidal:track:101', 'tidal:track:101']);
  assert.equal(new URL(calls[2]!.url).searchParams.get('page[cursor]'), 'NEXT');
  // From then on, v1 is not asked again.
  await provider.getFolder('tidal:album:201', 0, 1);
  assert.equal(calls.filter((c) => c.url.includes('api.tidal.com/v1')).length, 1);
});

// ── browsing the account ───────────────────────────────────────────────────────

// Shaped like openapi.tidal.com/v2's answers for a signed-in third-party app: relationship pages
// hold linkage (with `meta.addedAt`) and the resources in `included`; the next page is a cursor in
// `links.next` and `links.meta.nextCursor`. Ids, names and URLs are made up.

const artwork = (id: string) => ({
  id,
  type: 'artworks',
  attributes: {
    mediaType: 'IMAGE',
    files: [
      { href: `https://resources.tidal.com/images/${id}/160x160.jpg`, type: 'image/jpeg', meta: { width: 160, height: 160 } },
      { href: `https://resources.tidal.com/images/${id}/320x320.jpg`, type: 'image/jpeg', meta: { width: 320, height: 320 } },
    ],
  },
});
const cover = (id: string) => `https://resources.tidal.com/images/${id}/320x320.jpg`;

const COLLECTION_INCLUDED = [
  { id: '9001', type: 'tracks', attributes: { title: 'First', version: null, duration: 'PT3M18S' }, relationships: { albums: { data: [{ id: '8001', type: 'albums' }] }, artists: { data: [{ id: '7001', type: 'artists' }] } } },
  { id: '9002', type: 'tracks', attributes: { title: 'Second', version: null, duration: 'PT2M5S' }, relationships: { albums: { data: [{ id: '8001', type: 'albums' }] }, artists: { data: [{ id: '7001', type: 'artists' }] } } },
  { id: '8001', type: 'albums', attributes: { title: 'Record', albumType: 'ALBUM' }, relationships: { coverArt: { data: [{ id: 'art8001', type: 'artworks' }] }, artists: { data: [{ id: '7001', type: 'artists' }] } } },
  { id: '8002', type: 'albums', attributes: { title: 'Single', albumType: 'SINGLE' }, relationships: { coverArt: { data: [{ id: 'art8002', type: 'artworks' }] }, artists: { data: [{ id: '7001', type: 'artists' }] } } },
  { id: '7001', type: 'artists', attributes: { name: 'Band' }, relationships: { profileArt: { data: [{ id: 'art7001', type: 'artworks' }] } } },
  { id: '7002', type: 'artists', attributes: { name: 'Singer' }, relationships: { profileArt: { data: [] } } },
  { id: 'aaaa-1111', type: 'playlists', attributes: { name: 'Road Trip', playlistType: 'USER', numberOfItems: 12 }, relationships: { coverArt: { data: [{ id: 'artpl1', type: 'artworks' }] } } },
  { id: 'bbbb-2222', type: 'playlists', attributes: { name: 'Editors Pick', playlistType: 'EDITORIAL', numberOfItems: 50 }, relationships: { coverArt: { data: [] } } },
  artwork('art8001'),
  artwork('art8002'),
  artwork('art7001'),
  artwork('artpl1'),
];

/** A two-page relationship: the first identifier on the page without a cursor, the second after it. */
function pagedRelationship(path: string, pages: [Array<{ id: string; type: string }>, Array<{ id: string; type: string }>]): Handler {
  return (call) => {
    const second = new URL(call.url).searchParams.get('page[cursor]') === 'CURSOR2';
    const data = (second ? pages[1] : pages[0]).map((id) => ({ ...id, meta: { addedAt: '2026-10-01T12:00:00Z' } }));
    const links: Record<string, unknown> = { self: `/${path}?countryCode=NL` };
    if (!second) {
      links.next = `/${path}?countryCode=NL&page%5Bcursor%5D=CURSOR2`;
      links.meta = { nextCursor: 'CURSOR2' };
    }
    return json(200, { data, links, included: COLLECTION_INCLUDED });
  };
}

const COLLECTION_ROUTES: Array<[RegExp, Handler]> = [
  [/\/v2\/userCollectionTracks\/me\/relationships\/items/, pagedRelationship('userCollectionTracks/me/relationships/items', [[{ id: '9001', type: 'tracks' }], [{ id: '9002', type: 'tracks' }]])],
  [/\/v2\/userCollectionAlbums\/me\/relationships\/items/, pagedRelationship('userCollectionAlbums/me/relationships/items', [[{ id: '8001', type: 'albums' }], [{ id: '8002', type: 'albums' }]])],
  [/\/v2\/userCollectionArtists\/me\/relationships\/items/, pagedRelationship('userCollectionArtists/me/relationships/items', [[{ id: '7001', type: 'artists' }], [{ id: '7002', type: 'artists' }]])],
  [/\/v2\/userCollectionPlaylists\/me\/relationships\/items/, pagedRelationship('userCollectionPlaylists/me/relationships/items', [[{ id: 'aaaa-1111', type: 'playlists' }], [{ id: 'bbbb-2222', type: 'playlists' }]])],
];

test('the Tidal root offers the collection, the own playlists and the mixes', async () => {
  const openapi = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth: fakeAccess('openapi', []).auth });
  const root = await openapi.getFolder('root', 0, 50);
  assert.deepEqual(root?.items.map((i) => [i.id, i.name, i.kind]), [
    ['collection', 'My Collection', 'category'],
    ['playlists', 'My Playlists', 'category'],
    ['mixes', 'Mixes', 'category'],
  ]);
  assert.equal(root?.totalitems, 3);

  const collection = await openapi.getFolder('tidal:collection', 0, 50);
  assert.deepEqual(collection?.items.map((i) => i.id), ['collection-tracks', 'collection-albums', 'collection-artists', 'collection-playlists']);

  // A v1 account's root asks for Home once, to know whether to offer the pages (tidalPages.test.ts).
  const { auth } = fakeAccess('v1', [[/tidal\.com\/v1\/pages\/home/, () => json(403, {})]]);
  const v1 = await new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth }).getFolder('start', 0, 50);
  assert.deepEqual(v1?.items.map((i) => i.id), ['collection', 'playlists', 'mixes']);
});

test('each collection folder reads its v2 collection and pages across the cursor', async () => {
  const { auth, calls } = fakeAccess('openapi', COLLECTION_ROUTES);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });

  const tracks = await provider.getFolder('collection-tracks', 0, 2);
  assert.equal(tracks?.name, 'Tracks');
  assert.deepEqual(tracks?.items.map((i) => [i.audiopath, i.name, i.artist, i.album, i.duration, i.kind]), [
    ['tidal:track:9001', 'First', 'Band', 'Record', 198, 'track'],
    ['tidal:track:9002', 'Second', 'Band', 'Record', 125, 'track'],
  ]);
  assert.equal(tracks?.items[0]?.coverurl, cover('art8001'));
  assert.equal(tracks?.totalitems, 2);
  const first = new URL(calls[0]!.url);
  assert.equal(first.searchParams.get('include'), 'items.artists,items.albums.coverArt');
  assert.equal(first.searchParams.get('page[cursor]'), null);
  assert.equal(new URL(calls[1]!.url).searchParams.get('page[cursor]'), 'CURSOR2');

  // A window past the first page walks to it; a window inside it stops there and says there is more.
  const second = await provider.getFolder('collection-albums', 1, 1);
  assert.deepEqual(second?.items.map((i) => [i.audiopath, i.name, i.kind, i.coverurl]), [['tidal:album:8002', 'Single', 'album', cover('art8002')]]);
  calls.length = 0;
  const window = await provider.getFolder('collection-artists', 0, 1);
  assert.deepEqual(window?.items.map((i) => [i.audiopath, i.name, i.kind, i.coverurl]), [['tidal:artist:7001', 'Band', 'artist', cover('art7001')]]);
  assert.equal(calls.length, 1);
  assert.ok((window?.totalitems ?? 0) > 1, 'a client is told to page on');

  calls.length = 0;
  const playlists = await provider.getFolder('collection-playlists', 0, 10);
  assert.deepEqual(playlists?.items.map((i) => [i.audiopath, i.name, i.kind]), [
    ['tidal:playlist:aaaa-1111', 'Road Trip', 'playlist'],
    ['tidal:playlist:bbbb-2222', 'Editors Pick', 'playlist'],
  ]);
  assert.equal(new URL(calls[0]!.url).searchParams.get('collectionView'), 'FLAT', 'the playlists inside folders, not the folders');
  assert.equal(new URL(calls[1]!.url).searchParams.get('collectionView'), 'FLAT', 'the cursor keeps the view');
  assert.ok(calls.every((c) => c.headers.get('Accept') === 'application/vnd.api+json'));
});

test('My Playlists lists the playlists the account owns from the v2 playlists collection', async () => {
  // A collection, not a relationship: `data` holds the playlists themselves.
  const { auth, calls } = fakeAccess('openapi', [
    [/\/v2\/playlists\?/, () =>
      json(200, {
        data: [
          { id: 'cccc-3333', type: 'playlists', attributes: { name: 'Mine', playlistType: 'USER', numberOfItems: 3 }, relationships: { coverArt: { data: [{ id: 'artpl1', type: 'artworks' }] } } },
        ],
        links: { self: '/playlists?filter%5Bowners.id%5D=me&countryCode=NL' },
        included: [artwork('artpl1')],
      })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const folder = await provider.getFolder('playlists', 0, 50);
  assert.equal(folder?.name, 'My Playlists');
  assert.deepEqual(folder?.items.map((i) => [i.audiopath, i.name, i.coverurl, i.kind]), [['tidal:playlist:cccc-3333', 'Mine', cover('artpl1'), 'playlist']]);
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get('filter[owners.id]'), 'me');
  assert.equal(url.searchParams.get('include'), 'coverArt');
});

test('Mixes joins the daily, discovery and new-release mixes as playlists that open like any other', async () => {
  const mix = (id: string, name: string) => ({ id, type: 'playlists', attributes: { name, playlistType: 'MIX' }, relationships: { coverArt: { data: [{ id: `art-${id}`, type: 'artworks' }] } } });
  const page = (ids: string[], names: string[]): Handler => () =>
    json(200, {
      data: ids.map((id) => ({ id, type: 'playlists' })),
      links: { self: '/x' },
      included: [...ids.map((id, i) => mix(id, names[i]!)), ...ids.map((id) => artwork(`art-${id}`))],
    });
  const { auth, calls } = fakeAccess('openapi', [
    [/\/v2\/userDailyMixes\/me\/relationships\/items/, page(['0011aa', '0022bb'], ['My Mix 1', 'My Mix 2'])],
    [/\/v2\/userDiscoveryMixes\/me\/relationships\/items/, page(['0033cc'], ['My Daily Discovery'])],
    // The same mix twice is listed once.
    [/\/v2\/userNewReleaseMixes\/me\/relationships\/items/, page(['0044dd', '0011aa'], ['My New Arrivals', 'My Mix 1'])],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const all = await provider.getFolder('mixes', 0, 50);
  assert.deepEqual(all?.items.map((i) => [i.audiopath, i.name, i.owner]), [
    ['tidal:playlist:0011aa', 'My Mix 1', 'TIDAL'],
    ['tidal:playlist:0022bb', 'My Mix 2', 'TIDAL'],
    ['tidal:playlist:0033cc', 'My Daily Discovery', 'TIDAL'],
    ['tidal:playlist:0044dd', 'My New Arrivals', 'TIDAL'],
  ]);
  assert.equal(all?.items[0]?.coverurl, cover('art-0011aa'));
  assert.equal(all?.totalitems, 4);
  assert.equal(new URL(calls[0]!.url).searchParams.get('include'), 'items.coverArt');
  const window = await provider.getFolder('mixes', 2, 1);
  assert.deepEqual(window?.items.map((i) => i.name), ['My Daily Discovery']);
  assert.equal(window?.totalitems, 4);
});

test('a device-flow account browses its favourites and playlists through v1, offset-paginated', async () => {
  const { auth, calls } = fakeAccess('v1', [
    [/api\.tidal\.com\/v1\/sessions/, () => json(200, { sessionId: 's', userId: 4242, countryCode: 'NL' })],
    [/api\.tidal\.com\/v1\/users\/4242\/favorites\/tracks/, () =>
      json(200, {
        limit: 1,
        offset: 1,
        totalNumberOfItems: 3,
        items: [{ created: '2026-10-01T12:00:00.000+0000', item: { id: 55, title: 'Fav', duration: 200, artist: { name: 'Band' }, album: { title: 'Record', cover: 'ab-cd' } } }],
      })],
    [/api\.tidal\.com\/v1\/users\/4242\/playlists/, () =>
      json(200, { limit: 50, offset: 0, totalNumberOfItems: 1, items: [{ uuid: 'dddd-4444', title: 'Own', creator: { id: 4242 }, squareImage: 'ef-01' }] })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const tracks = await provider.getFolder('collection-tracks', 1, 1);
  assert.deepEqual(tracks?.items.map((i) => [i.audiopath, i.name, i.coverurl]), [['tidal:track:55', 'Fav', 'https://resources.tidal.com/images/ab/cd/320x320.jpg']]);
  assert.equal(tracks?.totalitems, 3);
  const favUrl = new URL(calls[1]!.url);
  assert.equal(favUrl.searchParams.get('offset'), '1');
  assert.equal(favUrl.searchParams.get('limit'), '1');
  assert.equal(favUrl.searchParams.get('order'), 'DATE');

  const playlists = await provider.getFolder('playlists', 0, 50);
  assert.deepEqual(playlists?.items.map((i) => i.audiopath), ['tidal:playlist:dddd-4444']);
  assert.equal(calls.filter((c) => c.url.includes('/sessions')).length, 1, 'the user id is asked once');
  assert.ok(calls.every((c) => c.url.includes('api.tidal.com/v1/')), 'nothing went to openapi');
});

test('a v1 account whose favourites v1 refuses reads them from openapi instead', async () => {
  const { auth, calls } = fakeAccess('v1', [
    [/api\.tidal\.com\/v1\/sessions/, () => json(200, { userId: 4242 })],
    [/api\.tidal\.com\/v1\/users\//, () => json(403, { status: 403, subStatus: 1002, userMessage: 'Required scopes: r_usr' })],
    ...COLLECTION_ROUTES,
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const albums = await provider.getFolder('collection-albums', 0, 5);
  assert.deepEqual(albums?.items.map((i) => i.audiopath), ['tidal:album:8001', 'tidal:album:8002']);
  assert.ok(calls.some((c) => c.url.includes('openapi.tidal.com/v2/userCollectionAlbums')));
  // Now on the official API, the root offers no pages.
  const root = await provider.getFolder('root', 0, 50);
  assert.deepEqual(root?.items.map((i) => i.id), ['collection', 'playlists', 'mixes']);
});

// ── saving the service ─────────────────────────────────────────────────────────

test('saving a Tidal service collects its sign-in, and re-saving keeps it', async () => {
  let config: any = { content: { streamingServices: [] as StreamingServiceConfig[] } };
  const pending: Record<string, TidalSession> = {
    login1: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, countryCode: 'NL', flow: 'pkce' },
  };
  const tidalAdmin = {
    takeSession: (id: string) => {
      const s = pending[id] ?? null;
      delete pending[id];
      return s;
    },
  } as unknown as TidalAdminPort;
  const sent: Array<{ status: number; body: any }> = [];
  let body: unknown = null;
  const deps = {
    log: { info() {}, warn() {}, debug() {}, error() {} },
    configPort: {
      getConfig: () => config,
      updateConfig: async (fn: (cfg: any) => void) => {
        const next = structuredClone(config);
        fn(next);
        config = next;
      },
    },
    ytMusicAdmin: { normalizePotServerUrl: () => '' },
    amazonMusicAdmin: { takeCredentials: () => null },
    tidalAdmin,
    contentManager: { refreshFromConfig() {} },
    zoneManager: { refreshContentProviders() {} },
    musicAssistantStreamService: { configureFromConfig() {}, registerZones: async () => {} },
    notifier: { notifyReloadMusicApp() {} },
    readJsonBody: async () => body,
    sendJson: (_res: ServerResponse, status: number, payload: unknown) => sent.push({ status, body: payload }),
  } as unknown as SpotifyHandlerDeps;
  const route = buildSpotifyRoutes(deps).find((r) => r.method === 'POST' && r.pattern.test('/content/services'))!;
  const save = async (payload: unknown) => {
    body = payload;
    await route.handler({} as IncomingMessage, { writableEnded: false } as ServerResponse, [] as unknown as RegExpMatchArray, '');
    return sent[sent.length - 1]!;
  };

  assert.equal((await save({ provider: 'tidal', id: 'bridge-tidal-a', tidalLoginId: 'login1', tidalQuality: 'HI_RES_LOSSLESS', tidalClientId: 'app' })).status, 200);
  let stored = config.content.streamingServices[0];
  assert.equal(stored.tidal.accessToken, 'AT');
  assert.equal(stored.tidalQuality, 'HI_RES_LOSSLESS');
  assert.equal(stored.tidalClientId, 'app');

  assert.equal((await save({ provider: 'tidal', id: 'bridge-tidal-a', label: 'Kitchen Tidal', tidalQuality: 'bogus' })).status, 200);
  stored = config.content.streamingServices[0];
  assert.equal(stored.label, 'Kitchen Tidal');
  assert.equal(stored.tidal.refreshToken, 'RT');
  assert.equal(stored.tidalQuality, undefined, 'an unknown quality is not stored');

  const expired = await save({ provider: 'tidal', id: 'bridge-tidal-a', tidalLoginId: 'login1' });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, 'tidal-login-required');
});
