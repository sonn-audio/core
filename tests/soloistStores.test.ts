import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import {
  accountPairingStore,
  accountStore,
  applyPreferences,
  hasStoredSession,
  promotePairedStore,
  signedInSpotifyId,
  zoneStore,
} from '../src/adapters/inputs/spotify/soloist/soloistProcess';

/**
 * A Soloist is its data directory: the lock in it is what makes two of them two, and the prefs in
 * it are the only way to tell the engine what to fetch. Both of those are now split two ways — a
 * room's Connect device against an account's playback store — so what lands where is worth pinning.
 */

async function tempStore(): Promise<{ data: string; cache: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'soloist-store-'));
  return { data: path.join(root, 'data'), cache: path.join(root, 'cache') };
}

const prefsOf = async (file: string): Promise<Map<string, string>> => {
  const text = await fsp.readFile(file, 'utf8');
  return new Map(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)] as [string, string];
      }),
  );
};

test('a room and an account never share a store', () => {
  // They hold different things — a room's is whatever the listener who picked it left behind, an
  // account's is a session this server signs in on purpose — and a shared lock would let only one
  // of them run at a time.
  assert.notEqual(zoneStore(1).data, accountStore('1').data);
  assert.notEqual(accountStore('a').data, accountStore('b').data);
});

test('an account id cannot walk out of its own directory', () => {
  // Account ids come from config and carry Spotify usernames; a path is not the place to trust one.
  // Everything that could make a separator becomes part of the name instead, so the id stays one
  // directory under the soloist root however it is spelled.
  const store = accountStore('../../etc/spotify');
  const root = path.dirname(path.dirname(store.data));
  assert.equal(path.dirname(store.data), path.join(root, 'account-.._.._etc_spotify'));
  assert.equal(path.basename(root), 'soloist');
});

test('the quality tier is stated in all three places the engine reads it', async () => {
  // The measurement this exists for: the engine derives the non-metered tier from the metered one
  // and ignores what we wrote unless the "migrated" marker is there — silently, since nothing
  // reports the tier. Lossless would then be a claim on the screen and about 160 kbps in the room.
  const store = await tempStore();
  await applyPreferences(store, { lossless: true, normalize: true });
  const prefs = await prefsOf(path.join(store.data, 'settings', 'prefs'));
  assert.equal(prefs.get('audio.play_bitrate_enumeration'), '5');
  assert.equal(prefs.get('audio.play_bitrate_non_metered_enumeration'), '5');
  assert.equal(prefs.get('audio.play_bitrate_non_metered_migrated'), 'true');
});

test('crossfade is turned off rather than left to whatever was there', async () => {
  // This server mixes its own, so a track has to arrive whole and start on its first sample.
  const store = await tempStore();
  await applyPreferences(store, { lossless: false, normalize: false });
  const prefs = await prefsOf(path.join(store.data, 'settings', 'prefs'));
  assert.equal(prefs.get('audio.crossfade_v2'), 'false');
  assert.equal(prefs.get('audio.normalize_v2'), 'false');
  assert.equal(prefs.get('audio.play_bitrate_non_metered_enumeration'), '4');
});

test('every store that can decide it is written, not just the global one', async () => {
  // A per-user file overrides the global one key by key, so a stale tier in one of those would win
  // over everything written here.
  const store = await tempStore();
  const userPrefs = path.join(store.data, 'settings', 'Users', 'someone', 'prefs');
  await fsp.mkdir(path.dirname(userPrefs), { recursive: true });
  await fsp.writeFile(
    userPrefs,
    'audio.play_bitrate_non_metered_enumeration=2\nengine.own.key=keep-me\n',
    'utf8',
  );

  await applyPreferences(store, { lossless: true, normalize: true });

  const prefs = await prefsOf(userPrefs);
  assert.equal(prefs.get('audio.play_bitrate_non_metered_enumeration'), '5');
  // The store also holds keys that belong to the engine; rewriting ours must not cost those.
  assert.equal(prefs.get('engine.own.key'), 'keep-me');
});

test('a stale crossfade time does not survive crossfade being switched off', async () => {
  const store = await tempStore();
  const global = path.join(store.data, 'settings', 'prefs');
  await fsp.mkdir(path.dirname(global), { recursive: true });
  await fsp.writeFile(global, 'audio.crossfade_v2=true\naudio.crossfade.time_v2=12000\n', 'utf8');

  await applyPreferences(store, { lossless: true, normalize: true });

  const prefs = await prefsOf(global);
  assert.equal(prefs.get('audio.crossfade_v2'), 'false');
  assert.equal(prefs.has('audio.crossfade.time_v2'), false);
});

test('a store is only signed in once an account is actually in it', async () => {
  // Said before a run is started, because a run on a store with no session does not fail: it
  // advertises itself and waits for somebody who is never coming.
  const store = await tempStore();
  assert.equal(await hasStoredSession(store), false);

  await fsp.mkdir(path.join(store.data, 'settings'), { recursive: true });
  assert.equal(await hasStoredSession(store), false, 'settings alone appears before a login');

  await fsp.mkdir(path.join(store.data, 'settings', 'Users', 'someone'), { recursive: true });
  assert.equal(await hasStoredSession(store), true);
});

test('a store is signed in as the Spotify id itself, not as its directory name', async () => {
  // Soloist percent-encodes the id it names the directory after. Read as it stands, an account
  // with an umlaut in it was turned away at pairing for being signed in as somebody else (#399).
  const store = await tempStore();
  assert.equal(await signedInSpotifyId(store), undefined);

  const users = path.join(store.data, 'settings', 'Users');
  await fsp.mkdir(path.join(users, 'xxxx_d%C3%BCthxxx-user'), { recursive: true });
  assert.equal(await signedInSpotifyId(store), 'xxxx_d\u00fcthxxx');

  await fsp.rm(users, { recursive: true });
  await fsp.mkdir(path.join(users, 'plain_100%-user'), { recursive: true });
  assert.equal(await signedInSpotifyId(store), 'plain_100%', 'a bare % is kept, not thrown on');
});

test('a cleared token store is not signed in, however signed in it looks', async () => {
  // The two come apart: the user directory is what a login leaves behind, but what a run restores
  // from is the refresh token. Measured — a run on a store like this refuses outright with
  // "requires stored credentials", so it must never be handed a track to play.
  const store = await tempStore();
  await fsp.mkdir(path.join(store.data, 'settings', 'Users', 'someone'), { recursive: true });
  await fsp.mkdir(path.join(store.data, 'cache'), { recursive: true });
  const token = path.join(store.data, 'cache', 'dbrts');
  await fsp.writeFile(token, '', 'utf8');
  assert.equal(await hasStoredSession(store), false);

  await fsp.writeFile(token, 'a-token', 'utf8');
  assert.equal(await hasStoredSession(store), true);
});


/**
 * Signing an account in again must not be able to sign it out.
 *
 * `--pair` throws away whatever session it finds before it starts advertising — it says so itself:
 * "cleared existing session before pairing". Pointed at the store that plays, a re-pairing nobody
 * completes would leave the account signed out, and a room stopped playing because somebody
 * pressed a button and changed their mind. Measured, on a real account.
 */

test('a pairing is signed in beside the store that plays, never into it', () => {
  const account = 'someone';
  assert.notEqual(accountPairingStore(account).data, accountStore(account).data);
  // Still under the same account, so nothing else has to know where a pairing goes.
  assert.equal(
    path.dirname(path.dirname(accountPairingStore(account).data)),
    path.dirname(accountStore(account).data),
  );
});

test('a completed pairing replaces the store, and the old one does not linger', async () => {
  const account = `promote-${process.pid}`;
  const canonical = accountStore(account);
  const staged = accountPairingStore(account);
  try {
    await fsp.mkdir(path.join(canonical.data, 'settings'), { recursive: true });
    await fsp.writeFile(path.join(canonical.data, 'marker'), 'old', 'utf8');
    await fsp.mkdir(path.join(staged.data, 'settings'), { recursive: true });
    await fsp.writeFile(path.join(staged.data, 'marker'), 'new', 'utf8');

    await promotePairedStore(account);

    assert.equal(await fsp.readFile(path.join(canonical.data, 'marker'), 'utf8'), 'new');
    // Nothing kept aside, and no staging directory left holding a device identity of its own.
    assert.equal(await exists(`${canonical.data}.previous`), false);
    assert.equal(await exists(path.dirname(staged.data)), false);
  } finally {
    await fsp.rm(path.dirname(canonical.data), { recursive: true, force: true });
  }
});

const exists = async (target: string): Promise<boolean> => {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
};
