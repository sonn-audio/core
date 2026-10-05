import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { makeSoloistAdminFake } from './fakes/soloistAdmin';
import {
  buildAppleMusicRoutes,
  type AppleMusicHandlerDeps,
} from '../src/adapters/http/adminApi/applemusic/appleMusicHandlers';
import {
  handleSoloistStatus,
  type SoloistHandlerDeps,
} from '../src/adapters/http/adminApi/spotify/soloistHandlers';
import type { AppleMusicAdminPort } from '../src/ports/AppleMusicAdminPort';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { Route } from '../src/adapters/http/adminApi/routeTypes';

type Sent = { status: number; body: any };

const noLog = { warn() {}, info() {}, debug() {}, error() {} };
const req = (url: string) => ({ url, method: 'GET', headers: {} }) as IncomingMessage;

async function call(routes: Route[], method: string, path: string): Promise<void> {
  const found = routes.find((r) => r.method === method && r.pattern.test(path));
  assert.ok(found, `no ${method} route for ${path}`);
  await found!.handler(req(path), {} as ServerResponse, path.match(found!.pattern)!, path);
}

function appleHarness(admin: AppleMusicAdminPort) {
  const sent: Sent[] = [];
  const deps = {
    log: noLog,
    appleMusicAdmin: admin,
    readBinaryBody: async () => null,
    sendJson: (_res: ServerResponse, status: number, body: unknown) => sent.push({ status, body }),
    sendHtml: (_res: ServerResponse, status: number, body: string) => sent.push({ status, body }),
  } as unknown as AppleMusicHandlerDeps;
  return { routes: buildAppleMusicRoutes(deps), sent };
}

// Without a configured token the sign-in page used to run a scrape of its own, which went stale
// when Apple reordered the JWT header and the provider's copy was fixed (#401). It now asks the
// same scrape the provider uses.
test('sign-in falls back to the scraped token when none is configured', async () => {
  const h = appleHarness({
    configuredDeveloperToken: () => null,
    scrapedDeveloperToken: async () => 'eyJ0.scraped.token',
    verifyWidevineArtifacts: async () => ({ ok: true }),
  });
  await call(h.routes, 'GET', '/applemusic/auth');
  assert.equal(h.sent[0]!.status, 200);
  assert.match(h.sent[0]!.body, /eyJ0\.scraped\.token/);
});

test('sign-in prefers the configured token and does not scrape', async () => {
  let scraped = false;
  const h = appleHarness({
    configuredDeveloperToken: () => 'eyJ0.configured.token',
    scrapedDeveloperToken: async () => {
      scraped = true;
      return null;
    },
    verifyWidevineArtifacts: async () => ({ ok: true }),
  });
  await call(h.routes, 'GET', '/applemusic/auth');
  assert.equal(h.sent[0]!.status, 200);
  assert.match(h.sent[0]!.body, /eyJ0\.configured\.token/);
  assert.equal(scraped, false);
});

test('sign-in without any token says so', async () => {
  const h = appleHarness({
    configuredDeveloperToken: () => null,
    scrapedDeveloperToken: async () => null,
    verifyWidevineArtifacts: async () => ({ ok: true }),
  });
  await call(h.routes, 'GET', '/applemusic/auth');
  assert.equal(h.sent[0]!.status, 500);
  assert.match(h.sent[0]!.body, /token unavailable/);
});

// The CDM check used to be untestable twice over: it reads files off disk, and a bad set was
// signalled by a provider error class the route caught with `instanceof`.
test('a usable CDM set reports valid', async () => {
  const h = appleHarness({
    configuredDeveloperToken: () => null,
    scrapedDeveloperToken: async () => null,
    verifyWidevineArtifacts: async () => ({ ok: true }),
  });
  await call(h.routes, 'GET', '/applemusic/widevine/status');
  assert.equal(h.sent[0]!.status, 200);
  assert.equal(h.sent[0]!.body.ok, true);
  assert.equal(h.sent[0]!.body.status, 'valid');
});

// A verdict about the files is still a 200 — the request succeeded, the answer is "not usable".
// The code and the per-file details are what the screen shows, so they have to survive.
test('an unusable CDM set answers 200 with the code and the details', async () => {
  const h = appleHarness({
    configuredDeveloperToken: () => null,
    scrapedDeveloperToken: async () => null,
    verifyWidevineArtifacts: async () => ({
      ok: false,
      code: 'invalid',
      details: ['private_key.pem is not a PEM'],
    }),
  });
  await call(h.routes, 'GET', '/applemusic/widevine/status');
  assert.equal(h.sent[0]!.status, 200);
  assert.equal(h.sent[0]!.body.ok, false);
  assert.equal(h.sent[0]!.body.status, 'invalid');
  assert.deepEqual(h.sent[0]!.body.details, ['private_key.pem is not a PEM']);
});

// A failure that is not a verdict about the files must not be reported as one: an unreadable
// directory is 'error', never 'missing' or 'invalid'.
test('a failure that is not about the files is reported as an error, not a verdict', async () => {
  const h = appleHarness({
    configuredDeveloperToken: () => null,
    scrapedDeveloperToken: async () => null,
    verifyWidevineArtifacts: async () => {
      throw new Error('EACCES: permission denied');
    },
  });
  await call(h.routes, 'GET', '/applemusic/widevine/status');
  assert.equal(h.sent[0]!.body.status, 'error');
  assert.deepEqual(h.sent[0]!.body.details, ['EACCES: permission denied']);
});

// Soloist status: the screen's job is to name the step that is missing, and a build that has
// passed its ninety days is the one people hit. Previously this probed a real binary.
test('soloist status reports a missing binary and the accounts it has', async () => {
  const sent: Sent[] = [];
  const deps = {
    configPort: {
      getConfig: () => ({
        content: { spotify: { soloist: {}, accounts: [{ id: 'rudy', user: 'rudy' }] } },
      }),
    } as unknown as ConfigPort,
    soloistAdmin: makeSoloistAdminFake({
      binaryStatus: async () => ({ present: false, executable: false, error: 'not installed' }),
      autoUpdateUrl: () => 'https://example.invalid/soloist.tgz',
    }),
    spotifyInputService: {
      soloistAccounts: async () => [{ id: 'rudy', label: 'Rudy', paired: false }],
    } as never,
    sendJson: (_res: ServerResponse, status: number, body: unknown) => sent.push({ status, body }),
  } as unknown as SoloistHandlerDeps;

  await handleSoloistStatus({} as ServerResponse, deps);
  assert.equal(sent[0]!.status, 200);
  assert.equal(sent[0]!.body.binary.present, false);
  assert.equal(sent[0]!.body.autoUpdates, true, 'a published build for this host means updatable');
  // An account with no pairing reads as idle rather than as absent: the store exists, nobody has
  // picked it in a Spotify app yet.
  assert.deepEqual(
    sent[0]!.body.accounts.map((a: { id: string; pairing: { state: string } }) => [a.id, a.pairing.state]),
    [['rudy', 'idle']],
  );
});
