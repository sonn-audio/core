import assert from 'node:assert/strict';
import { test } from './testHarness';
import { forLoxoneFavorite } from '../src/adapters/loxone/commands/utils/loxoneFavorites';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';

// Opening a room favourite that holds other things — a playlist, an album. The Loxone app
// then has to fetch what is inside, and decides where from by itself. When it cannot, it
// shows the favourite's cover and title over a list that never loads.

const REGISTRY = buildBridgeRegistry([
  { id: 'bridge-applemusic-za2e8h', label: 'Apple Music', provider: 'applemusic' },
  { id: 'bridge-tidal-nnnua5', label: 'Tidal', provider: 'tidal' },
]);

/** The service entries the app holds; each is one account of its Spotify repository. */
const ACCOUNTS = ['md123121', 'bridge-applemusic-za2e8h', 'bridge-tidal-nnnua5'];

/**
 * How the app finds the account to browse a favourite with (`getRepositoryForAudioItem` and
 * `getSpecificService`, shared-app.js), transcribed: the Spotify repository takes a path that
 * starts with its command, and within it the account whose id is the favourite's `ownerId`.
 */
function appCanOpen(favourite: { audiopath?: unknown; ownerId?: unknown }): string | null {
  if (typeof favourite.audiopath !== 'string' || !favourite.audiopath.startsWith('spotify')) {
    return null;
  }
  return ACCOUNTS.find((id) => id === favourite.ownerId) ?? null;
}

const PLAYLIST = 'applemusic:playlist:b64_cGwucG0tMjBlOWYzNzM5MTlkYTA4MDU3NmVmZDYzMGJhMWYyODQ=';

test('a playlist favourite of a bridged service is one the app can open', () => {
  // As it is kept, and as it used to be sent: no service the app knows, and no account.
  const kept = { id: 1, name: 'Op repeat', type: 'spotify_playlist', audiopath: PLAYLIST, owner: '', ownerId: '', owner_id: '' };
  assert.equal(appCanOpen(kept), null, 'the favourite as stored cannot be opened');

  const sent = forLoxoneFavorite(kept, REGISTRY);
  assert.equal(sent.audiopath, 'spotify@bridge-applemusic-za2e8h:playlist:b64_cGwucG0tMjBlOWYzNzM5MTlkYTA4MDU3NmVmZDYzMGJhMWYyODQ=');
  assert.equal(sent.ownerId, 'bridge-applemusic-za2e8h');
  assert.equal(sent.owner_id, 'bridge-applemusic-za2e8h');
  assert.equal(appCanOpen(sent), 'bridge-applemusic-za2e8h');
  assert.equal(sent.name, 'Op repeat', 'nothing else about it changes');
});

test('the account comes from the path, whichever form the favourite was saved in', () => {
  const native = forLoxoneFavorite({ audiopath: 'tidal:nnnua5:album:77646168' }, REGISTRY);
  assert.equal(native.audiopath, 'spotify@bridge-tidal-nnnua5:album:77646168');
  assert.equal(appCanOpen(native), 'bridge-tidal-nnnua5');

  const disguised = forLoxoneFavorite({ audiopath: 'spotify@bridge-tidal-nnnua5:album:77646168' }, REGISTRY);
  assert.equal(appCanOpen(disguised), 'bridge-tidal-nnnua5');

  // Real Spotify names its account in the path too.
  const spotify = forLoxoneFavorite({ audiopath: 'spotify@md123121:playlist:37i9dQZF1DXcBWIGoYBM5M' }, REGISTRY);
  assert.equal(appCanOpen(spotify), 'md123121');
});

test('a path that names no account keeps the owner the favourite was saved with', () => {
  const kept = { audiopath: 'spotify:track:b64_OTQ3MTQwNzQz', owner: 'bridge-applemusic-za2e8h' };
  const sent = forLoxoneFavorite(kept, REGISTRY);
  assert.equal(sent.audiopath, 'spotify:track:b64_OTQ3MTQwNzQz');
  assert.equal(sent.ownerId, 'bridge-applemusic-za2e8h');
  // And one with neither is passed on as it is: there is nothing to derive an account from.
  assert.deepEqual(forLoxoneFavorite({ audiopath: 'spotify:track:abc' }, REGISTRY), { audiopath: 'spotify:track:abc' });
});

test('favourites that are not streaming are left exactly as they were', () => {
  for (const kept of [
    { audiopath: 'library:local:track:b64_MTIz', type: 'library_track' },
    { audiopath: 'linein:504F94FF1BB4#1000001', type: 'linein' },
    { audiopath: 'tunein:station:s1234', type: 'tunein' },
    { audiopath: '', type: 'tunein' },
  ]) {
    assert.deepEqual(forLoxoneFavorite(kept, REGISTRY), kept);
  }
});

test('the list of favourites goes out in the form the app can open', async () => {
  const handlers = createZoneHandlers(
    {} as any,
    {} as any,
    {
      get: async () => ({
        id: 14,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [{ id: 1, slot: 1, plus: true, name: 'Op repeat', type: 'spotify_playlist', audiopath: PLAYLIST, owner: '', ownerId: '', owner_id: '' }],
      }),
    } as any,
    { getBridgeRegistry: () => REGISTRY } as any,
  );
  const frame = JSON.parse(serializeResult(await handlers.audioCfgGetRoomFavs('audio/cfg/getroomfavs/14/0/50')));
  const [favourite] = frame.getroomfavs_result[0].items;
  assert.equal(appCanOpen(favourite), 'bridge-applemusic-za2e8h');
  assert.equal(frame.getroomfavs_result[0].totalitems, 1, 'the envelope is untouched');
});
