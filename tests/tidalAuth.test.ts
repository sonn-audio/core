import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './testHarness';
import {
  bundledTidalClient,
  fetchTidalIdentity,
  resolveTidalClient,
  TIDAL_SCOPE,
  type FetchFn,
} from '../src/adapters/content/providers/tidal/tidalAuthClient';
import {
  albumFromResource,
  JsonApiDocument,
  parseIsoDuration,
  trackFromResource,
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
import { normalizeContent } from '../src/application/config/configRepository';
import type { AudioServerConfig, StreamingServiceConfig, TidalSession } from '../src/domain/config/types';
import type { TidalAdminPort } from '../src/ports/TidalAdminPort';

// Everything here runs against a scripted fetch: no request leaves the process. Each handler sees
// the URL and the request, and answers the way Tidal's auth server or API does — the shapes are
// those Music Assistant's provider reads.

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
});

// The client a release image is built with is the last resort: a client someone named on purpose,
// in the environment or the service, must never be hidden behind it.
test('the bundled Tidal client is used only when neither the environment nor the service names one', () => {
  const bundled = { clientId: 'image-client', clientSecret: 'image-secret' };
  assert.deepEqual(resolveTidalClient({}, NO_ENV, bundled), { ...bundled, source: 'bundled' });
  assert.equal(resolveTidalClient({ tidalClientId: 'cfg' }, NO_ENV, bundled)?.source, 'config');
  assert.equal(resolveTidalClient({}, CLIENT_ENV, bundled)?.source, 'env');
});

test('a build without a Tidal client reads as none', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'sonn-tidal-client-'));
  try {
    assert.equal(bundledTidalClient(empty), null);
    await writeFile(join(empty, 'client_id'), ' image-client\n');
    assert.deepEqual(bundledTidalClient(empty), { clientId: 'image-client', clientSecret: undefined });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

function silentLog() {
  return { info() {}, warn() {}, debug() {}, error() {} } as never;
}

/** The sign-in routes, answering into `sent`. */
function tidalRoutes(admin: TidalAdminPort, body: () => unknown) {
  const sent: Array<{ status: number; body: any }> = [];
  const routes = buildTidalRoutes({
    log: silentLog(),
    tidalAdmin: admin,
    readJsonBody: async () => body(),
    sendJson: (_res, status, payload) => sent.push({ status, body: payload }),
  });
  const call = async (method: string, path: string, url = path) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) return null;
    await route.handler({ url } as IncomingMessage, { writableEnded: false } as ServerResponse, [] as unknown as RegExpMatchArray, path);
    return sent[sent.length - 1]!;
  };
  return { routes, call };
}

test('the client route says whether the server provides a client, and where from', async () => {
  const none = createTidalAdmin({ store: memoryStore([]), env: NO_ENV, bundledClient: null });
  assert.deepEqual(none.clientStatus(), { envConfigured: false, source: null });
  const withEnv = createTidalAdmin({ store: memoryStore([]), env: CLIENT_ENV, bundledClient: null });
  assert.deepEqual((await tidalRoutes(withEnv, () => null).call('GET', '/tidal/client'))?.body, { envConfigured: true, source: 'env' });
  // envConfigured stays true for a bundled client, so a console that predates `source` still
  // lets the sign-in start without a client of its own.
  const withImage = createTidalAdmin({ store: memoryStore([]), env: NO_ENV, bundledClient: { clientId: 'image-client' } });
  assert.deepEqual(withImage.clientStatus(), { envConfigured: true, source: 'bundled' });
});

test('only the device sign-in is left: no callback, no paste-back, no browser mode', async () => {
  const admin = createTidalAdmin({ store: memoryStore([]), env: CLIENT_ENV, fetchFn: (() => assert.fail('no request')) as unknown as FetchFn });
  const { routes, call } = tidalRoutes(admin, () => ({ mode: 'browser' }));
  assert.equal(routes.some((r) => r.pattern.test('/tidal/auth/callback')), false);
  assert.equal(routes.some((r) => r.pattern.test('/tidal/login/finish')), false);
  const refused = await call('POST', '/tidal/login/start');
  assert.equal(refused?.status, 400);
  assert.equal(refused?.body.error, 'invalid-payload');
});

// ── device flow ────────────────────────────────────────────────────────────────

test('a device sign-in without any client answers tidal-client-required, and asks Tidal nothing', async () => {
  const { fetchFn, calls } = scriptedFetch([]);
  // A saved service without a client id, and none in the request or the environment.
  const store = memoryStore([{ id: 'bridge-tidal-1', label: 'Tidal', provider: 'tidal' }]);
  const admin = createTidalAdmin({ store, fetchFn, env: NO_ENV });
  const start = await admin.startLogin({ serviceId: 'bridge-tidal-1' });
  assert.ok(!start.ok);
  assert.equal(start.error, 'client-required');
  assert.match(start.message, /SONN_TIDAL_CLIENT_ID/);
  assert.equal(calls.length, 0);

  const answer = await tidalRoutes(admin, () => ({ mode: 'device' })).call('POST', '/tidal/login/start');
  assert.equal(answer?.status, 400);
  assert.deepEqual(answer?.body, { error: 'tidal-client-required', message: start.message });
});

test('a device sign-in takes the client from the request, else from the saved service', async () => {
  const authorize = () =>
    json(200, { deviceCode: 'DC', userCode: 'ABCDE', verificationUri: 'link.tidal.com', expiresIn: 300, interval: 2 });
  const { fetchFn, calls } = scriptedFetch([
    [/device_authorization$/, authorize],
    [/oauth2\/token$/, () => json(400, { error: 'authorization_pending' })],
  ]);
  const store = memoryStore([{ id: 'bridge-tidal-1', label: 'Tidal', provider: 'tidal', tidalClientId: 'saved-app' }]);
  const admin = createTidalAdmin({ store, fetchFn, env: NO_ENV, sleep: () => new Promise(() => {}) });
  assert.ok((await admin.startLogin({ clientId: 'form-app', serviceId: 'bridge-tidal-1' })).ok);
  assert.equal(calls[0]!.body.get('client_id'), 'form-app');
  assert.ok((await admin.startLogin({ serviceId: 'bridge-tidal-1' })).ok);
  assert.equal(calls[1]!.body.get('client_id'), 'saved-app');
  assert.equal(calls[1]!.body.get('scope'), TIDAL_SCOPE);
});

test('the identity comes from users/me, and from v1 sessions when users/me refuses the token', async () => {
  const me = scriptedFetch([
    [/openapi\.tidal\.com\/v2\/users\/me$/, () => json(200, { data: { id: '7', attributes: { country: 'se', username: 'anna' } } })],
  ]);
  assert.deepEqual(await fetchTidalIdentity('AT', me.fetchFn), { userId: '7', countryCode: 'SE', userName: 'anna' });
  assert.equal(me.calls[0]!.headers.get('Authorization'), 'Bearer AT');
  assert.equal(me.calls[0]!.headers.get('Accept'), 'application/vnd.api+json');

  const legacy = scriptedFetch([
    [/users\/me$/, () => json(403, { errors: [{ status: '403', detail: 'Insufficient scope' }] })],
    [/api\.tidal\.com\/v1\/sessions$/, () => json(200, { userId: 9, countryCode: 'nl', sessionId: 'x' })],
  ]);
  assert.deepEqual(await fetchTidalIdentity('DAT', legacy.fetchFn), { userId: '9', countryCode: 'NL' });
});

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
  const start = await admin.startLogin({});
  assert.ok(start.ok && start.mode === 'device');
  assert.equal(start.userCode, 'ABCDE');
  assert.equal(start.verificationUriComplete, 'https://link.tidal.com/ABCDE');
  await admin.settled(start.loginId);

  assert.deepEqual(sleeps, [2000, 2000, 7000, 7000], 'slow_down adds five seconds for good');
  assert.deepEqual(admin.loginStatus(start.loginId), { state: 'done', userId: '9', userName: 'dev-user', countryCode: 'NL' });
  const poll = calls.find((c) => c.url.endsWith('/token'))!;
  assert.equal(poll.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(poll.body.get('device_code'), 'DC');
  assert.equal(poll.headers.get('Authorization'), `Basic ${Buffer.from('env-client:env-secret').toString('base64')}`);
  const session = admin.takeSession(start.loginId)!;
  assert.deepEqual(
    { accessToken: session.accessToken, refreshToken: session.refreshToken, countryCode: session.countryCode },
    { accessToken: 'DAT', refreshToken: 'DRT', countryCode: 'NL' },
  );
  assert.equal(admin.takeSession(start.loginId), null, 'handed over once');
});

test('a client Tidal will not run the device flow for is reported as such', async () => {
  const { fetchFn } = scriptedFetch([
    [
      /device_authorization$/,
      () => json(400, { status: 400, error: 'unauthorized_client', sub_status: 1002, error_description: 'Client is not a Limited Input Device client' }),
    ],
  ]);
  const admin = createTidalAdmin({ store: memoryStore([]), fetchFn, env: CLIENT_ENV });
  const start = await admin.startLogin({});
  assert.equal(start.ok, false);
  assert.ok(!start.ok);
  assert.equal(start.error, 'client-refused');
  assert.equal(start.message, 'TIDAL refused this client for the device sign-in: Client is not a Limited Input Device client');
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
      ? { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 0, countryCode: 'NL', ...session }
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
  assert.equal(calls[0]!.body.get('scope'), TIDAL_SCOPE);
  assert.equal(calls[0]!.body.get('client_id'), 'my-app');
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

test('a session whose client is gone cannot refresh, and says so on the account', async () => {
  const t = 1_000_000;
  const service = { ...tidalService({ expiresAt: t }), tidalClientId: undefined };
  const store = memoryStore([service]);
  const auth = new TidalAuth({ store, fetchFn: (() => assert.fail('no request')) as unknown as FetchFn, now: () => t, env: NO_ENV });
  assert.equal(await auth.refresh('bridge-tidal-1'), false);
  assert.match(store.services[0]!.tidal!.refreshError ?? '', /sign in again/);
});

test('a stored session from the removed browser sign-in loads as signed out, without throwing', () => {
  const legacy = {
    id: 'bridge-tidal-old',
    label: 'Tidal',
    provider: 'tidal',
    tidalClientId: 'old-app',
    tidalAccessToken: 'PASTED',
    tidal: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, flow: 'pkce', accessTier: 'THIRD_PARTY', previewReason: 'FULL_REQUIRES_HIGHER_ACCESS_TIER' },
  };
  const device = {
    id: 'bridge-tidal-dev',
    label: 'Tidal',
    provider: 'tidal',
    tidal: { accessToken: 'DAT', refreshToken: 'DRT', expiresAt: 1, flow: 'device', accessTier: 'PARTNER' },
  };
  const cfg = {
    content: { radio: {}, spotify: { accounts: [] }, streamingServices: [legacy, device], tts: { provider: { type: 'internal' }, fallbackToInternal: true } },
  } as unknown as AudioServerConfig;

  assert.equal(normalizeContent(cfg), true, 'the change is saved, so it is said only once');
  const [old, dev] = cfg.content.streamingServices!;
  assert.equal(old!.tidal, undefined, 'signed out: a new device sign-in is needed');
  assert.equal(old!.tidalClientId, 'old-app');
  assert.equal(old!.tidalAccessToken, 'PASTED', 'a pasted token stays');
  assert.deepEqual(dev!.tidal, { accessToken: 'DAT', refreshToken: 'DRT', expiresAt: 1 }, 'a device session keeps working');
  assert.equal(normalizeContent(cfg), false, 'nothing to do the next time');
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
  service: StreamingServiceConfig = tidalService({ expiresAt: Date.now() + 3600_000 }),
) {
  service = { ...service, tidalQuality: quality };
  const config = { content: { streamingServices: [service] } };
  const errors: Array<{ zoneId: number; reason?: string }> = [];
  const { fetchFn, calls } = scriptedFetch([
    [/playbackinfopostpaywall/, (call) => answer(new URL(call.url).searchParams.get('audioquality')!)],
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

test('a pasted token plays through v1 playbackinfopostpaywall, with the manual country', async () => {
  const pasted: StreamingServiceConfig = { id: 'bridge-tidal-1', label: 'Tidal', provider: 'tidal', tidalAccessToken: 'PASTED', tidalCountryCode: 'de' };
  const { stream, calls, errors } = streamHarness('LOSSLESS', () => json(200, BTS), pasted);
  const result = await stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.deepEqual(result.playbackSource, { kind: 'url', url: 'https://sp-pr-cf.audio.tidal.com/x.flac' });
  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/v1/tracks/123/playbackinfopostpaywall');
  assert.equal(url.searchParams.get('countryCode'), 'DE');
  assert.equal(calls[0]!.headers.get('Authorization'), 'Bearer PASTED');
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
  const store = memoryStore([{ ...tidalService({ expiresAt: Date.now() + 3600_000 }), tidalQuality: 'LOSSLESS' }]);
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

test('the quality record compares against the configured quality, through a hi-res fallback', async () => {
  const hiRes = streamHarness('HI_RES_LOSSLESS', (q) => json(200, q === 'HI_RES_LOSSLESS' ? DASH_DRM : { ...BTS, audioQuality: 'LOSSLESS' }));
  await hiRes.stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(hiRes.store.services[0]!.tidal!.deliveredQuality, 'LOSSLESS');

  const asAsked = streamHarness('HIGH', () => json(200, BTS_AAC));
  await asAsked.stream.startStreamForAudiopath(1, 'tidal:track:123');
  assert.equal(asAsked.store.services[0]!.tidal!.deliveredQuality, undefined, 'HIGH asked, HIGH delivered');
});

test('a 403 from v1 playback is final: Tidal refused this app, and nothing else is tried', async () => {
  const { stream, calls, errors } = streamHarness('LOSSLESS', () => json(403, { status: 403, subStatus: 4005 }));
  const result = await stream.startStreamForAudiopath(3, 'tidal:track:123');
  assert.equal(result.playbackSource, null);
  assert.deepEqual(errors, [{ zoneId: 3, reason: TIDAL_PLAYBACK_REFUSED }]);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => !c.url.includes('openapi.tidal.com')));
});

test('a 401 from v1 playback refreshes once before giving up', async () => {
  const { stream, calls, errors } = streamHarness('LOSSLESS', () => json(401, {}));
  await stream.startStreamForAudiopath(3, 'tidal:track:123');
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname.split('/').pop()),
    ['playbackinfopostpaywall', 'token'],
    'one refresh, inside its cooldown afterwards',
  );
  assert.deepEqual(errors, [{ zoneId: 3, reason: TIDAL_PLAYBACK_REFUSED }]);
});

// ── openapi documents ──────────────────────────────────────────────────────────

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

test('openapi resources map onto the v1 shapes, with their artwork', () => {
  const doc = new JsonApiDocument(SEARCH_DOC);
  assert.deepEqual(trackFromResource(doc, doc.resolve({ id: '101', type: 'tracks' })!), {
    id: '101',
    title: 'Song (Live)',
    duration: 237,
    artist: { name: 'Band' },
    album: { title: 'Record' },
    coverUrl: 'https://resources.tidal.com/a/320.jpg',
  });
  assert.deepEqual(albumFromResource(doc, doc.resolve({ id: '201', type: 'albums' })!), {
    id: '201',
    title: 'Record',
    artist: { name: 'Band' },
    coverUrl: 'https://resources.tidal.com/a/320.jpg',
  });
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
});

function fakeAccess(routes: Array<[RegExp, Handler]>) {
  const { fetchFn, calls } = scriptedFetch(routes);
  return {
    calls,
    auth: {
      noteQuality: async () => {},
      fetch: async (_id: string, url: URL, init?: RequestInit) => fetchFn(url.toString(), init),
    },
  };
}

test('a 403 from the v1 catalogue stays on v1: the account is not moved to openapi', async () => {
  const { auth, calls } = fakeAccess([
    [/api\.tidal\.com\/v1\//, () => json(403, { status: 403, subStatus: 1002, userMessage: 'Required scopes: r_usr' })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const album = await provider.getFolder('tidal:album:201', 0, 2);
  assert.deepEqual(album?.items, []);
  const { result } = await provider.search('song', { track: 5 }, 10);
  assert.deepEqual(result.tracks, []);
  const favourites = await provider.getFolder('collection-albums', 0, 5);
  assert.deepEqual(favourites?.items, []);
  assert.ok(calls.length > 0 && calls.every((c) => c.url.includes('api.tidal.com/v1/')), 'nothing went to openapi');
});

// ── browsing the account ───────────────────────────────────────────────────────

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

test('the Tidal root offers the collection, the own playlists and the mixes', async () => {
  // The root asks for Home once, to know whether to offer the pages (tidalPages.test.ts).
  const { auth } = fakeAccess([[/tidal\.com\/v1\/pages\/home/, () => json(403, {})]]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const root = await provider.getFolder('start', 0, 50);
  assert.deepEqual(root?.items.map((i) => [i.id, i.name, i.kind]), [
    ['collection', 'My Collection', 'category'],
    ['playlists', 'My Playlists', 'category'],
    ['mixes', 'Mixes', 'category'],
  ]);
  assert.equal(root?.totalitems, 3);

  const collection = await provider.getFolder('tidal:collection', 0, 50);
  assert.deepEqual(collection?.items.map((i) => i.id), ['collection-tracks', 'collection-albums', 'collection-artists', 'collection-playlists']);
});

test('Mixes joins the daily, discovery and new-release mixes as playlists that open like any other', async () => {
  const mix = (id: string, name: string) => ({ id, type: 'playlists', attributes: { name, playlistType: 'MIX' }, relationships: { coverArt: { data: [{ id: `art-${id}`, type: 'artworks' }] } } });
  const page = (ids: string[], names: string[]): Handler => () =>
    json(200, {
      data: ids.map((id) => ({ id, type: 'playlists' })),
      links: { self: '/x' },
      included: [...ids.map((id, i) => mix(id, names[i]!)), ...ids.map((id) => artwork(`art-${id}`))],
    });
  const { auth, calls } = fakeAccess([
    // Pages this token does not read: only the official API's mix collections are listed.
    [/tidal\.com\/v1\/pages\//, () => json(403, {})],
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
  assert.equal(new URL(calls.find((c) => c.url.includes('userDailyMixes'))!.url).searchParams.get('include'), 'items.coverArt');
  const window = await provider.getFolder('mixes', 2, 1);
  assert.deepEqual(window?.items.map((i) => i.name), ['My Daily Discovery']);
  assert.equal(window?.totalitems, 4);
});

test('a device-flow account browses its favourites and playlists through v1, offset-paginated', async () => {
  const { auth, calls } = fakeAccess([
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

// ── saving the service ─────────────────────────────────────────────────────────

test('saving a Tidal service collects its sign-in, and re-saving keeps it', async () => {
  let config: any = { content: { streamingServices: [] as StreamingServiceConfig[] } };
  const pending: Record<string, TidalSession> = {
    login1: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 1, countryCode: 'NL' },
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
