import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  providerTypeFromBridgeId,
  rootItemsForLoxone,
  serviceTypeFor,
  toProviderNode,
} from '../src/adapters/loxone/commands/utils/loxoneServiceFolders';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';
import { resetWebTokenCache } from '../src/adapters/content/providers/spotify/spotifyWebTokens';

const APPLE = 'bridge-applemusic-dgmv27';

/** Every bridged service reaches us as `spotify`; the bridge id names the real one. */
const slot = (user: string, folderId: string) => toProviderNode('spotify', user, folderId);

// These six mappings are what the Loxone app has always received. The provider used
// to decode the slot indices itself; moving that here must not change a single one,
// so they are pinned rather than described.
test('Loxone service-folder slots map onto the same Apple Music nodes as before', () => {
  const expected: Array<[string, string]> = [
    ['0', 'new-releases'],
    ['1', 'recommended-playlists'],
    ['2', 'recommended-albums'],
    ['3', 'playlists'],
    ['5', 'albums'],
    ['6', 'artists'],
  ];
  for (const [index, node] of expected) {
    assert.equal(slot(APPLE, index), node, `slot ${index}`);
  }
});

test('a node name passes through untouched, so other consumers address nodes directly', () => {
  for (const node of ['root', 'albums', 'recent', 'songs', 'applemusic:album:123']) {
    assert.equal(slot(APPLE, node), node);
  }
});

test('a service without a slot table keeps its folder ids, so providers migrate one at a time', () => {
  for (const folderId of ['0', '5', 'albums']) {
    assert.equal(slot('bridge-qobuz-abc123', folderId), folderId);
    assert.equal(toProviderNode('radioparadise', 'nouser', folderId), folderId);
  }
});

test('the root listing goes back to Loxone as its own slot indices', () => {
  const items = [
    { id: 'new-releases', name: 'New Releases' },
    { id: 'recommended-playlists', name: 'Recommended Playlists' },
    { id: 'recommended-albums', name: 'Recommended Albums' },
    { id: 'albums', name: 'Albums' },
    { id: 'artists', name: 'Artists' },
    { id: 'playlists', name: 'Playlists' },
  ];
  assert.deepEqual(
    rootItemsForLoxone('spotify', APPLE, items).map((item) => [item.id, item.name]),
    [
      ['0', 'New Releases'],
      ['1', 'Recommended Playlists'],
      ['2', 'Recommended Albums'],
      ['5', 'Albums'],
      ['6', 'Artists'],
      ['3', 'Playlists'],
    ],
  );
});

// The point of the whole exercise: a provider may publish nodes the Loxone app has
// no slot for. Those must not reach it — an unaddressable id in a fixed section
// would render the wrong content — while every other consumer sees them.
test('nodes without a Loxone slot are left out of the Loxone root', () => {
  const items = [
    { id: 'albums', name: 'Albums' },
    { id: 'recent', name: 'Recently Added' },
    { id: 'charts', name: 'Charts' },
  ];
  assert.deepEqual(
    rootItemsForLoxone('spotify', APPLE, items).map((item) => item.id),
    ['5'],
  );
});

test('providerTypeFromBridgeId reads the service out of a bridge id', () => {
  assert.equal(providerTypeFromBridgeId('bridge-applemusic-dgmv27'), 'applemusic');
  assert.equal(providerTypeFromBridgeId('bridge-tidal-abc'), 'tidal');
  assert.equal(providerTypeFromBridgeId('radioparadise'), '');
  assert.equal(providerTypeFromBridgeId(''), '');
});

// Each service fills the app's slots with its own sections, so every table is
// pinned separately: a wrong entry silently serves the wrong content in a section.
test('the YouTube services keep their own slot assignments', () => {
  const ytmusic: Array<[string, string]> = [
    ['0', 'popular'],
    ['1', 'new-releases'],
    ['2', 'genres'],
    ['3', 'playlists'],
    ['5', 'albums'],
    ['6', 'artists'],
  ];
  for (const [index, node] of ytmusic) {
    assert.equal(slot('bridge-ytmusic-x1', index), node, `ytmusic slot ${index}`);
  }

  const youtube: Array<[string, string]> = [
    ['0', 'trending'],
    ['1', 'new-releases'],
    ['2', 'genres'],
    ['3', 'playlists'],
  ];
  for (const [index, node] of youtube) {
    assert.equal(slot('bridge-youtube-y2', index), node, `youtube slot ${index}`);
  }
  // YouTube proper has no album/artist sections, so those slots stay unmapped.
  assert.equal(slot('bridge-youtube-y2', '5'), '5');
});

// Real Spotify is not bridged, so the service part of the command is the truth.
test('serviceTypeFor prefers the bridge id and falls back to the service', () => {
  assert.equal(serviceTypeFor('spotify', 'bridge-applemusic-dgmv27'), 'applemusic');
  assert.equal(serviceTypeFor('spotify', 'rudy@example.com'), 'spotify');
  assert.equal(serviceTypeFor('musicassistant', 'nouser'), 'musicassistant');
  assert.equal(serviceTypeFor('RadioParadise', 'nouser'), 'radioparadise');
});

// Spotify's own sections ARE the app's enum, in order — that is where the numbering
// came from. The provider publishes names now, so the order is pinned here instead.
test('Spotify itself maps the full enum onto its own section names', () => {
  const expected: Array<[string, string]> = [
    ['0', 'popular'],
    ['1', 'new'],
    ['2', 'genres'],
    ['3', 'playlists'],
    ['4', 'liked'],
    ['5', 'albums'],
    ['6', 'artists'],
    ['7', 'podcasts'],
  ];
  for (const [index, node] of expected) {
    assert.equal(toProviderNode('spotify', 'rudy@example.com', index), node, `slot ${index}`);
  }
  const items = expected.map(([, node]) => ({ id: node }));
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'rudy@example.com', items).map((item) => item.id),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  );
});

test('SoundCloud maps its four sections onto the slots it used to publish', () => {
  const expected: Array<[string, string]> = [
    ['0', 'trending'],
    ['1', 'top'],
    ['3', 'playlists'],
    ['4', 'likes'],
  ];
  for (const [index, node] of expected) {
    assert.equal(slot('bridge-soundcloud-sc1', index), node, `slot ${index}`);
  }
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'bridge-soundcloud-sc1', [
      { id: 'trending' },
      { id: 'playlists' },
    ]).map((item) => item.id),
    ['0', '3'],
  );
});

// Deezer and Music Assistant have always sent the app their node names rather than
// slot indices. Translating inbound is new; the outbound bytes must not move.
test('a service that publishes names keeps publishing them', () => {
  for (const user of ['bridge-deezer-dz1', 'bridge-musicassistant-ma1']) {
    const items = [{ id: 'playlists' }, { id: 'albums' }, { id: 'radios' }];
    assert.deepEqual(
      rootItemsForLoxone('spotify', user, items).map((item) => item.id),
      ['playlists', 'albums', 'radios'],
      user,
    );
  }
  assert.equal(slot('bridge-deezer-dz1', '1'), 'top-albums');
  assert.equal(slot('bridge-musicassistant-ma1', '5'), 'albums');
});

// Music Assistant hands its recommendation groups to the app under the slots its
// library sections do not claim. Translating one of those would steal it.
test('Music Assistant keeps the slots it fills with recommendations', () => {
  for (const index of ['0', '1', '2', '4']) {
    assert.equal(slot('bridge-musicassistant-ma1', index), index, `slot ${index}`);
  }
  assert.equal(slot('bridge-musicassistant-ma1', '3'), 'playlists');
  assert.equal(slot('bridge-musicassistant-ma1', '6'), 'artists');
});

// The eight sections the app has slots for, pinned in both directions: a section only
// reaches the app if the provider still publishes it under the name this table expects, so
// renaming one on either side has to be a deliberate edit here.
test('every Spotify section the app has a slot for keeps its name', () => {
  const expected: Array<[string, string]> = [
    ['0', 'popular'],
    ['1', 'new'],
    ['2', 'genres'],
    ['3', 'playlists'],
    ['4', 'liked'],
    ['5', 'albums'],
    ['6', 'artists'],
    ['7', 'podcasts'],
  ];
  for (const [index, node] of expected) {
    assert.equal(slot('rudy', index), node, `slot ${index}`);
  }
  assert.deepEqual(
    rootItemsForLoxone('spotify', 'rudy', expected.map(([, node]) => ({ id: node }))).map(
      (item) => item.id,
    ),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  );
});

// The table alone proves nothing: what the app receives is the provider's own root run
// through the projection. This is that pair, end to end — and it also pins which sections
// survive when the account can reach nothing, because that is the case a user meets when
// their stored credentials go stale.
test("Spotify's root reaches Loxone under the app's slot ids", async () => {
  // Everything upstream refused, so the listing is decided by the provider alone and this stays
  // a test of the projection rather than of the network. It is also the honest worst case: no
  // access token, no librespot session, and no scraped web tokens either.
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response('offline', { status: 503 })) as typeof fetch;
  resetWebTokenCache();
  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@rudy',
      // A refresh token gets past the "re-add this account" listing. With no pathfinder tokens
      // from either source the editorial sections are left out rather than published as tiles
      // that open onto nothing; Podcasts stays, because an unanswerable probe means "unknown".
      account: { id: 'rudy', refreshToken: 'stub' } as never,
      persistAccount: async () => null,
    });
    const root = await provider.getFolder('root', 0, 50);
    assert.deepEqual(
      rootItemsForLoxone('spotify', 'rudy', root?.items ?? []).map((i) => [i.id, i.name]),
      [
        ['1', 'New Releases'],
        ['3', 'My Playlists'],
        ['4', 'Liked Songs'],
        ['5', 'Albums'],
        ['6', 'Artists'],
        ['7', 'Podcasts'],
      ],
    );
    // The count has to match what is actually in the listing, not the full section list.
    assert.equal(root?.totalitems, root?.items?.length);
    // And every published section round-trips: the slot the app sends comes back as the node.
    for (const item of root?.items ?? []) {
      const projected = rootItemsForLoxone('spotify', 'rudy', [item])[0]!;
      assert.equal(toProviderNode('spotify', 'rudy', projected.id), item.id);
    }
  } finally {
    global.fetch = originalFetch;
    resetWebTokenCache();
  }
});

// A dropped node has to be dropped from the count too. Caught live: the provider
// published eight sections, the app got six items under a claim of eight, and a
// client that paginates on the total would ask for rows that are not there.
test('the projected root advertises the number of items it actually contains', () => {
  const items = [
    { id: 'albums', name: 'Albums' },
    { id: 'artists', name: 'Artists' },
    { id: 'songs', name: 'Songs' },
    { id: 'recent', name: 'Recently Added' },
  ];
  const projected = rootItemsForLoxone('spotify', APPLE, items);
  assert.equal(projected.length, 2);
  // What the handler builds from it (see audioCfgGetServiceFolder).
  const folder = { id: 'root', totalitems: items.length, items: projected };
  const forApp = { ...folder, totalitems: projected.length };
  assert.equal(forApp.totalitems, forApp.items.length);
});

// Tidal publishes its account sections by name; the app's slots reach the ones it has a place for.
test('Tidal maps the app slots onto its mixes, own playlists and favourites', () => {
  const tidal = 'bridge-tidal-t1';
  assert.equal(slot(tidal, '0'), 'mixes');
  assert.equal(slot(tidal, '3'), 'playlists');
  assert.equal(slot(tidal, '4'), 'collection-tracks');
  assert.equal(slot(tidal, '5'), 'collection-albums');
  assert.equal(slot(tidal, '6'), 'collection-artists');
  assert.equal(slot(tidal, 'collection-playlists'), 'collection-playlists');
  assert.deepEqual(
    rootItemsForLoxone('spotify', tidal, [{ id: 'collection' }, { id: 'playlists' }, { id: 'mixes' }]).map((item) => item.id),
    ['collection', 'playlists', 'mixes'],
  );
});
