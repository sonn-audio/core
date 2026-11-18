import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildMiscRoutes } from '../src/adapters/http/adminApi/misc/miscHandlers';
import { isPublicAdminApiRoute } from '../src/adapters/http/adminApi/auth/adminSessionStore';

// /info answers without a session because the Admin UI has to know whether to show a
// login form or a create-admin welcome before it can authenticate. That bootstrap needs
// three flags; the rest of the payload used to be readable by anyone on the network.

const MAC = '000C290E5497';
const MINISERVER_IP = '192.168.1.200';
const MINISERVER_SERIAL = '504F9411157A';

function fetchInfo(authenticated: boolean, req: Partial<IncomingMessage> = { headers: {} }): { status?: number; body?: any } {
  const sent: { status?: number; body?: any } = {};
  const deps = {
    isAuthenticated: () => authenticated,
    log: { error: () => {}, warn: () => {} },
    configPort: {
      getConfig: () => ({
        system: {
          audioserver: {
            name: 'Test Audioserver',
            macId: MAC,
            paired: true,
            setupComplete: true,
            loxoneEnabled: true,
            extensions: [],
          },
          miniserver: { ip: MINISERVER_IP, serial: MINISERVER_SERIAL },
          // hasAdminUser reads system.users, and needs a usable account: both a
          // username and a password, with admin set.
          users: [{ username: 'admin', password: 'secret', admin: true }],
        },
        zones: [{ id: 1 }],
      }),
    },
    groupManager: {},
    snapcastCore: {},
    sonnCorePeers: {},
    runtimeConfig: {
      loxone: { firmwareVersion: 'f', apiVersion: 'a' },
      http: { publicDir: '/tmp' },
    },
    readJsonBody: async () => null,
    sendJson: (_res: ServerResponse, status: number, body: unknown) => {
      sent.status = status;
      sent.body = body;
    },
  } as any;

  const route = buildMiscRoutes(deps).find((r) => r.pattern.source === /^\/info$/.source);
  assert.ok(route, '/info route exists');
  route!.handler(req as IncomingMessage, {} as ServerResponse, [] as any, '/info');
  return sent;
}

test('info answers without a session, so the UI can pick login or first-run', () => {
  const sent = fetchInfo(false);
  assert.equal(sent.status, 200, 'never 401 — a 401 cannot say which screen to show');
  assert.equal(sent.body.hasAdminUser, true);
  assert.equal(sent.body.paired, true);
  assert.equal(sent.body.setupComplete, true);
});

test('info sends a UI whose session ran out back to the login (#443)', () => {
  // It still sends the session it had. The bootstrap answer kept it on screen as if signed in,
  // with no version, no uptime and nothing installed.
  const expired = fetchInfo(false, { headers: { authorization: 'Bearer expired-session' } });
  assert.equal(expired.status, 401);
  assert.deepEqual(expired.body, { error: 'auth-required' });

  const cookie = fetchInfo(false, { headers: { cookie: 'lox_admin_session=expired-session' } });
  assert.equal(cookie.status, 401);
});

test('info tells an anonymous caller nothing beyond those three flags', () => {
  const sent = fetchInfo(false);
  assert.deepEqual(
    Object.keys(sent.body).sort(),
    ['hasAdminUser', 'paired', 'setupComplete'],
    'anything else is only interesting once you are in',
  );

  const json = JSON.stringify(sent.body);
  assert.ok(!json.includes(MAC), 'no serial/MAC');
  assert.ok(!json.includes(MINISERVER_IP), "no Miniserver's address");
  assert.ok(!json.includes(MINISERVER_SERIAL), "no Miniserver's serial");
  assert.ok(!json.includes('Test Audioserver'), 'not even the server name');
});

test('info still reports everything to an authenticated caller', () => {
  const sent = fetchInfo(true);
  assert.equal(sent.status, 200);
  for (const field of [
    'hasAdminUser',
    'paired',
    'setupComplete',
    'version',
    'name',
    'serial',
    'miniserverIp',
    'miniserverSerial',
    'zones',
    'packages',
    'player',
    'loxoneEnabled',
    'containerized',
    'restartSupervised',
  ]) {
    assert.ok(field in sent.body, `${field} is still reported once logged in`);
  }
  assert.equal(sent.body.serial, MAC);
  assert.equal(sent.body.miniserverIp, MINISERVER_IP);
});

// The admin API is authenticated by default; anything reachable without a session is
// an exemption, and each one needs a reason. This pins the list so a route cannot be
// added to it without the test being changed too.

test('only the routes that must answer before login are exempt from auth', () => {
  const exempt: Array<[string, string]> = [
    // Says whether to show a login form or a create-admin welcome. Answers with the
    // three flags that decide only that; the rest of the payload needs a session.
    ['/info', 'GET'],
    // Self-guarding: refuses once an admin exists.
    ['/auth/setup', 'POST'],
    ['/auth/login', 'POST'],
    ['/auth/logout', 'POST'],
    ['/auth/me', 'GET'],
    // Spotify redirects the browser here.
    ['/spotify/auth/callback', 'GET'],
    // The admin UI's server switcher reads this from the origin server, so it keeps a
    // way back when pointed at a peer where the session does not apply.
    ['/audioservers', 'GET'],
  ];
  for (const [pathname, method] of exempt) {
    assert.equal(isPublicAdminApiRoute(pathname, method), true, `${method} ${pathname} is exempt`);
  }
});

test('nothing that reads config or secrets is reachable without a session', () => {
  for (const [pathname, method] of [
    ['/config', 'GET'],
    ['/users', 'GET'],
    ['/zones/states', 'GET'],
    ['/logs', 'GET'],
    ['/groups', 'GET'],
    // Returned a Spotify account's librespot credentials in plaintext to anyone on
    // the network. Nothing reads it over HTTP — the inputs load them straight from
    // config — so the exemption bought nothing.
    ['/spotify/librespot/credentials', 'GET'],
    ['/spotify/librespot/status', 'GET'],
  ] as Array<[string, string]>) {
    assert.equal(
      isPublicAdminApiRoute(pathname, method),
      false,
      `${method} ${pathname} requires a session`,
    );
  }
});

test('no exemption may mutate state', () => {
  // A write reachable without a session is a different class of hole than a read.
  for (const pathname of ['/config', '/config/clear', '/zones/1/equalizer', '/server/update', '/users']) {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal(
        isPublicAdminApiRoute(pathname, method),
        false,
        `${method} ${pathname} must not be exempt`,
      );
    }
  }
  // The only exempt POSTs are the auth bootstrap.
  assert.equal(isPublicAdminApiRoute('/config/clear', 'POST'), false);
  assert.equal(isPublicAdminApiRoute('/server/update', 'POST'), false);
});
