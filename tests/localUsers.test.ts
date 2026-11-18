import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  findUser,
  rememberLoxoneUser,
  saveUser,
  hasAdminUser,
  hasUsers,
  isAdminLoginRequired,
  listUsers,
  storedPassword,
  verifyUser,
} from '../src/application/auth/localUsers';
import { buildUsersRoutes } from '../src/adapters/http/adminApi/users/usersHandlers';
import { decryptSecret, encryptSecret, isEncrypted } from '../src/application/auth/secretStore';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AudioServerConfig, UserAccount } from '../src/domain/config/types';

function makePort(users?: unknown, paired = false) {
  const cfg = {
    system: { audioserver: { paired }, users },
  } as unknown as AudioServerConfig;
  const port = {
    getConfig: () => cfg,
    updateConfig: async (mutator: (c: AudioServerConfig) => void) => mutator(cfg),
  } as unknown as ConfigPort;
  return { port, cfg };
}

// ── Store ───────────────────────────────────────────────────────────────────

test('local users: an absent or non-array list yields no users', () => {
  assert.deepEqual(listUsers(makePort(undefined).port), []);
  assert.deepEqual(listUsers(makePort('nonsense').port), []);
  assert.equal(hasUsers(makePort(undefined).port), false);
});

test('local users: entries missing a name or password are ignored', () => {
  // A half-written config must not look like a usable account.
  const { port } = makePort([
    { username: 'ok', password: 'pw' },
    { username: '', password: 'pw' },
    { username: '  ', password: 'pw' },
    { username: 'nopass', password: '' },
    { username: 'nopass2' },
    null,
  ]);
  assert.deepEqual(
    listUsers(port).map((u) => u.username),
    ['ok'],
  );
});

test('local users: admin defaults to false', () => {
  const { port } = makePort([
    { username: 'a', password: 'p' },
    { username: 'b', password: 'p', admin: true },
  ]);
  assert.deepEqual(listUsers(port), [
    { username: 'a', admin: false, source: 'local' },
    { username: 'b', admin: true, source: 'local' },
  ]);
  assert.equal(hasAdminUser(port), true);
  assert.equal(hasAdminUser(makePort([{ username: 'a', password: 'p' }]).port), false);
});

test('local users: a server connected to a Miniserver asks for a login without an admin account (#443)', () => {
  const connected = (users: unknown, loxoneEnabled: boolean) => {
    const { port, cfg } = makePort(users, true);
    (cfg.system.audioserver as { loxoneEnabled?: boolean }).loxoneEnabled = loxoneEnabled;
    return port;
  };
  // Its Loxone users log in with their Miniserver credentials.
  assert.equal(isAdminLoginRequired(connected([], true)), true);
  assert.equal(isAdminLoginRequired(connected(undefined, true)), true);
  // With Loxone off, nobody could log in that way, so the box stays open until an admin exists.
  assert.equal(isAdminLoginRequired(connected([], false)), false);
  // A fresh box stays open just long enough to create the first admin.
  assert.equal(isAdminLoginRequired(makePort([]).port), false);
  // Once an admin exists, always.
  assert.equal(isAdminLoginRequired(makePort([{ username: 'b', password: 'p', admin: true }]).port), true);
});

test('local users: verification accepts the right password and nothing else', () => {
  const { port } = makePort([{ username: 'gast', password: 'muziek', admin: true }]);
  assert.deepEqual(verifyUser(port, 'gast', 'muziek'), { username: 'gast', admin: true, source: 'local' });
  assert.equal(verifyUser(port, 'gast', 'fout'), null);
  // An unknown user is indistinguishable from a wrong password.
  assert.equal(verifyUser(port, 'niemand', 'muziek'), null);
  // Length differences must not throw in the constant-time compare.
  assert.equal(verifyUser(port, 'gast', 'veel-en-veel-langer-wachtwoord'), null);
  assert.equal(verifyUser(port, 'gast', ''), null);
});

test('local users: stored password is retrievable for the token digest only', () => {
  // Subsonic's salted-token login needs the original; nothing else reads this.
  const { port } = makePort([{ username: 'gast', password: 'muziek' }]);
  assert.equal(storedPassword(port, 'gast'), 'muziek');
  assert.equal(storedPassword(port, 'niemand'), null);
  // The public shape never carries it.
  assert.ok(!('password' in (listUsers(port)[0] as object)));
});

test('local users: surrounding whitespace in a stored name is tolerated', () => {
  const { port } = makePort([{ username: ' gast ', password: 'pw' }]);
  assert.equal(findUser(port, 'gast')?.password, 'pw');
  assert.deepEqual(verifyUser(port, 'gast', 'pw'), { username: 'gast', admin: false, source: 'local' });
});

// ── Admin CRUD ──────────────────────────────────────────────────────────────

type Captured = { status: number; body: any };

function makeRoutes(users?: UserAccount[], paired = false) {
  const { port, cfg } = makePort(users, paired);
  const captured: Captured = { status: 0, body: null };
  let jsonBody: unknown = null;
  const routes = buildUsersRoutes({
    log: { debug() {}, info() {}, warn() {}, error() {}, spam() {} } as never,
    configPort: port,
    readJsonBody: async () => jsonBody,
    sendJson: (_res, status, body) => {
      captured.status = status;
      captured.body = body;
    },
  });
  const call = async (method: string, path: string, body?: unknown): Promise<Captured> => {
    jsonBody = body ?? null;
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    assert.ok(route, `no route for ${method} ${path}`);
    await route.handler(
      {} as IncomingMessage,
      {} as ServerResponse,
      route.pattern.exec(path) as RegExpExecArray,
      path,
    );
    return { ...captured };
  };
  return { call, cfg };
}

test('users api: creating a user stores it and answers with the list', async () => {
  const { call, cfg } = makeRoutes([]);
  const { status, body } = await call('POST', '/users', {
    username: 'gast',
    password: 'muziek',
  });
  assert.equal(status, 200);
  assert.deepEqual(body.users, [{ username: 'gast', admin: false, source: 'local' }]);
  // Stored encrypted, never as the literal password.
  const stored = cfg.system.users?.[0]?.password ?? '';
  assert.ok(isEncrypted(stored), `expected ciphertext, got ${stored}`);
  assert.ok(!stored.includes('muziek'));
  assert.equal(decryptSecret(stored), 'muziek');
});

test('users api: a password is never echoed back', async () => {
  const { call } = makeRoutes([]);
  const { body } = await call('POST', '/users', { username: 'gast', password: 'muziek' });
  assert.ok(!JSON.stringify(body).includes('muziek'));
});

test('users api: updating without a password keeps the stored one', async () => {
  // The admin UI shows a masked field and must not round-trip the secret.
  const { call, cfg } = makeRoutes([{ username: 'gast', password: encryptSecret('origineel') }]);
  await call('POST', '/users', { username: 'gast', admin: true });
  assert.equal(decryptSecret(cfg.system.users?.[0]?.password ?? ''), 'origineel');
  assert.equal(cfg.system.users?.[0]?.admin, true);
  assert.equal(cfg.system.users?.length, 1, 'must update in place, not duplicate');
});

test('users api: a new user without a password is refused', async () => {
  const { call, cfg } = makeRoutes([]);
  const { status, body } = await call('POST', '/users', { username: 'gast' });
  assert.equal(status, 400);
  assert.equal(body.error, 'password-required');
  assert.deepEqual(cfg.system.users, []);
});

test('users api: usernames are constrained to what survives a URL', async () => {
  const { call } = makeRoutes([]);
  for (const username of ['', '   ', 'met spatie', 'slash/es', 'quote"', 'a'.repeat(65)]) {
    const { status, body } = await call('POST', '/users', { username, password: 'pw' });
    assert.equal(status, 400, `${JSON.stringify(username)} must be rejected`);
    assert.equal(body.error, 'invalid-username');
  }
  // These forms are fine and people really use them.
  for (const username of ['rudy', 'rudy.berends', 'rudy@example.com', 'rudy-1_2']) {
    const { status } = await call('POST', '/users', { username, password: 'pw' });
    assert.equal(status, 200, `${username} must be accepted`);
  }
});

test('users api: deleting an unknown user is a 404', async () => {
  const { call } = makeRoutes([{ username: 'gast', password: 'pw' }]);
  const { status, body } = await call('DELETE', '/users/niemand');
  assert.equal(status, 404);
  assert.equal(body.error, 'unknown-user');
});

test('users api: a stream-only user can always be deleted', async () => {
  const { call, cfg } = makeRoutes([
    { username: 'admin', password: 'pw', admin: true },
    { username: 'gast', password: 'pw' },
  ]);
  const { status } = await call('DELETE', '/users/gast');
  assert.equal(status, 200);
  assert.deepEqual(cfg.system.users?.map((u) => u.username), ['admin']);
});

test('users api: the last admin cannot be deleted without a Miniserver to fall back on', async () => {
  // Otherwise nothing could log into the admin UI again.
  const { call, cfg } = makeRoutes([{ username: 'admin', password: 'pw', admin: true }], false);
  const { status, body } = await call('DELETE', '/users/admin');
  assert.equal(status, 409);
  assert.equal(body.error, 'last-admin');
  assert.equal(cfg.system.users?.length, 1);
});

test('users api: the last admin may go when a Miniserver pairing exists', async () => {
  // Integrated mode still has Miniserver accounts to log in with.
  const { call, cfg } = makeRoutes([{ username: 'admin', password: 'pw', admin: true }], true);
  const { status } = await call('DELETE', '/users/admin');
  assert.equal(status, 200);
  assert.deepEqual(cfg.system.users, []);
});

test('users api: a non-object payload is refused', async () => {
  const { call } = makeRoutes([]);
  for (const payload of [null, ['a'], 'text']) {
    const { status, body } = await call('POST', '/users', payload);
    assert.equal(status, 400);
    assert.equal(body.error, 'invalid-user-payload');
  }
});

// ── Encryption at rest ──────────────────────────────────────────────────────

test('secret store: ciphertext round-trips and never contains the plaintext', () => {
  const cipher = encryptSecret('geheim-wachtwoord');
  assert.ok(isEncrypted(cipher));
  assert.ok(!cipher.includes('geheim'));
  assert.equal(decryptSecret(cipher), 'geheim-wachtwoord');
});

test('secret store: the same password encrypts differently every time', () => {
  // A fresh IV per write, so identical passwords are not recognisable as such
  // by anyone reading the config.
  assert.notEqual(encryptSecret('zelfde'), encryptSecret('zelfde'));
});

test('secret store: a plaintext value passes through unchanged', () => {
  // Hand-edited configs must keep working; they are upgraded on the next write.
  assert.equal(decryptSecret('gewoon-tekst'), 'gewoon-tekst');
  assert.equal(isEncrypted('gewoon-tekst'), false);
});

test('secret store: tampering is detected rather than silently accepted', () => {
  // GCM authenticates the ciphertext, so a flipped byte fails to open.
  const cipher = encryptSecret('geheim');
  const [prefix, iv, tag] = cipher.split(':');
  const flipped = `${prefix}:${iv}:${tag}:${Buffer.from('anders').toString('base64')}`;
  assert.equal(decryptSecret(flipped), null);
  assert.equal(decryptSecret('enc:v1:kapot'), null);
});

test('local users: an undecryptable password admits nobody', () => {
  // A replaced key must fail closed, never fall back to comparing ciphertext.
  const { port } = makePort([
    { username: 'gast', password: 'enc:v1:AAAA:AAAA:AAAA' },
  ]);
  assert.equal(verifyUser(port, 'gast', 'wat dan ook'), null);
  assert.equal(storedPassword(port, 'gast'), null);
});

test('local users: an encrypted password verifies like a plain one', () => {
  const { port } = makePort([{ username: 'gast', password: encryptSecret('muziek') }]);
  assert.deepEqual(verifyUser(port, 'gast', 'muziek'), { username: 'gast', admin: false, source: 'local' });
  assert.equal(verifyUser(port, 'gast', 'fout'), null);
  // The Subsonic token check needs the original back.
  assert.equal(storedPassword(port, 'gast'), 'muziek');
});

test('users api: a hand-edited plaintext password is upgraded on the next write', () => {
  const { call, cfg } = makeRoutes([{ username: 'gast', password: 'plat' }]);
  return call('POST', '/users', { username: 'gast', admin: true }).then(() => {
    const stored = cfg.system.users?.[0]?.password ?? '';
    assert.ok(isEncrypted(stored), 'must be encrypted after the write');
    assert.equal(decryptSecret(stored), 'plat', 'and still be the same password');
  });
});

// ── Capturing a verified Loxone account ─────────────────────────────────────
//
// A Miniserver login is the only moment the server holds that password in the
// clear — the Miniserver keeps a salted hash and can never hand it back. Storing
// it is what lets salted-token clients authenticate as that Loxone user.

test('loxone capture: an unknown account is created, encrypted and marked', async () => {
  const { port, cfg } = makePort([]);
  const outcome = await rememberLoxoneUser(port, 'anna', 'huis123', {
    admin: true,
    verifiedAt: '2026-07-25T20:00:00.000Z',
  });
  assert.equal(outcome, 'created');
  const stored = cfg.system.users?.[0];
  assert.equal(stored?.username, 'anna');
  assert.equal(stored?.source, 'loxone');
  assert.equal(stored?.admin, true);
  assert.equal(stored?.verifiedAt, '2026-07-25T20:00:00.000Z');
  assert.ok(isEncrypted(stored?.password ?? ''));
  assert.equal(decryptSecret(stored?.password ?? ''), 'huis123');
});

test('loxone capture: the account can then authenticate by token', async () => {
  // The whole point: token auth needs a recoverable password, and now there is one.
  const { port } = makePort([]);
  await rememberLoxoneUser(port, 'anna', 'huis123');
  assert.equal(storedPassword(port, 'anna'), 'huis123');
  assert.deepEqual(verifyUser(port, 'anna', 'huis123'), {
    username: 'anna',
    admin: false,
    source: 'loxone',
  });
});

test('loxone capture: an unchanged password is reported as such', async () => {
  const { port } = makePort([]);
  await rememberLoxoneUser(port, 'anna', 'huis123');
  assert.equal(await rememberLoxoneUser(port, 'anna', 'huis123'), 'unchanged');
});

test('loxone capture: a changed Loxone password refreshes the stored copy', async () => {
  // One web-UI login is enough to resync after a password change in Loxone.
  const { port } = makePort([]);
  await rememberLoxoneUser(port, 'anna', 'oud');
  assert.equal(await rememberLoxoneUser(port, 'anna', 'nieuw'), 'refreshed');
  assert.equal(storedPassword(port, 'anna'), 'nieuw');
  assert.equal(verifyUser(port, 'anna', 'oud'), null);
});

test('loxone capture: a hand-made local account is never overwritten', async () => {
  // Otherwise a Loxone login could silently replace a deliberately configured
  // credential that happens to share the username.
  const { port, cfg } = makePort([]);
  await saveUser(port, { username: 'anna', password: 'lokaal', source: 'local' });
  const outcome = await rememberLoxoneUser(port, 'anna', 'huis123');
  assert.equal(outcome, 'skipped-local');
  assert.equal(storedPassword(port, 'anna'), 'lokaal');
  assert.equal(cfg.system.users?.length, 1);
});

test('loxone capture: editing a captured account by hand makes it local', async () => {
  // After which further Loxone logins leave it alone.
  const { port, cfg } = makePort([]);
  await rememberLoxoneUser(port, 'anna', 'huis123');
  await saveUser(port, { username: 'anna', password: 'eigen', source: 'local' });
  assert.equal(cfg.system.users?.[0]?.source, undefined, 'local is the default, not stored');
  assert.equal(await rememberLoxoneUser(port, 'anna', 'huis123'), 'skipped-local');
  assert.equal(storedPassword(port, 'anna'), 'eigen');
});

test('loxone capture: a captured account keeps working after the store is re-read', async () => {
  const { port } = makePort([]);
  await rememberLoxoneUser(port, 'anna', 'huis123', { admin: true });
  assert.deepEqual(
    listUsers(port).map((u) => ({ username: u.username, admin: u.admin, source: u.source })),
    [{ username: 'anna', admin: true, source: 'loxone' }],
  );
});
