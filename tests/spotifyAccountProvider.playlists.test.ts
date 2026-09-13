import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The web-player bundle pathfinder scrapes its persisted-query hash from. Stubbed so the
 * pathfinder path is genuinely exercised offline — without it the query would die at the hash
 * step and these tests would "pass" for the wrong reason.
 */
function hashScrapeStub(url: URL): Response {
  if (url.host === 'open.spotify.com' && url.pathname === '/') {
    return new Response(
      '<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.abc12345.js"></script>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );
  }
  if (url.pathname.endsWith('.js')) {
    return new Response(`x=["fetchPlaylist","query","${'a'.repeat(64)}"];`, {
      status: 200,
      headers: { 'Content-Type': 'application/javascript' },
    });
  }
  return json({ error: 'unexpected-url', url: url.toString() }, 404);
}

/**
 * A provider whose pathfinder session is its own object rather than the shared
 * `webPathfinderSession`.
 *
 * That singleton is cached two layers deep — the token cache inside `spotifyWebTokens`, and
 * pathfinder's own `WeakMap` keyed on the session identity — so a test that mints against it
 * leaves its stub tokens behind for whichever test runs next.
 */
function newProvider(): SpotifyAccountProvider {
  const provider = new SpotifyAccountProvider({
    providerId: 'spotify@Bianca',
    account: { id: 'Bianca', spotifyId: 'bianca', user: 'Bianca', refreshToken: 'unused-in-test' },
    persistAccount: async () => null,
  });
  (provider as any).accessToken = 'test-token';
  (provider as any).tokenExpiresAt = Date.now() + 60_000;
  (provider as any).pathfinderSession = {
    getTokens: async () => ({
      accessToken: 'test-web-bearer',
      tokenType: 'Bearer',
      clientToken: 'test-client-token',
      expiresInMs: 3_600_000,
    }),
  };
  return provider;
}

test('spotify account provider keeps playlists visible and loads playlist tracks', async () => {
  const originalFetch = global.fetch;
  const playlistId = '1MQmPhKcSH2XoZPnRo8EHE';

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === '/v1/me/playlists') {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: playlistId,
              name: 'My Playlist',
              owner: { id: 'bianca' },
              tracks: { total: 1 },
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (path === `/v1/playlists/${playlistId}/items`) {
      return new Response(
        JSON.stringify({
          total: 1,
          items: [
            {
              track: {
                id: 'track-1',
                name: 'Track One',
                duration_ms: 180000,
                artists: [{ name: 'Artist One' }],
                album: { name: 'Album One', images: [] },
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const playlistsBefore = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlistsBefore);
    assert.equal(playlistsBefore?.items?.length, 1);
    assert.equal(playlistsBefore?.items?.[0]?.name, 'My Playlist');

    const tracksFolder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);
    assert.ok(tracksFolder);
    assert.equal(tracksFolder?.items?.length, 1);
    assert.equal(tracksFolder?.items?.[0]?.name, 'Track One');

    const playlistsAfter = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlistsAfter);
    assert.equal(playlistsAfter?.items?.length, 1);
    assert.equal(playlistsAfter?.items?.[0]?.name, 'My Playlist');
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider paginates playlist tracks beyond offset 50 (issue #200)', async () => {
  const originalFetch = global.fetch;
  const playlistId = '3CEIZD3u8XdpjR5Y3X6kZw';
  const seenRequests: Array<{ offset: string | null; limit: string | null }> = [];

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === `/v1/playlists/${playlistId}/items`) {
      const offset = url.searchParams.get('offset');
      const limit = url.searchParams.get('limit');
      seenRequests.push({ offset, limit });
      const start = Number(offset) || 0;
      const count = Math.min(Number(limit) || 50, 200 - start);
      const items = Array.from({ length: Math.max(0, count) }, (_, i) => ({
        track: {
          id: `track-${start + i}`,
          name: `Track ${start + i}`,
          duration_ms: 180000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      }));
      return new Response(JSON.stringify({ total: 200, items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const firstPage = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);
    assert.ok(firstPage);
    assert.equal(firstPage?.items?.length, 50);
    assert.equal(firstPage?.totalitems, 200);
    assert.equal(firstPage?.items?.[0]?.name, 'Track 0');

    const secondPage = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 50, 50);
    assert.ok(secondPage);
    assert.equal(secondPage?.items?.length, 50);
    assert.equal(secondPage?.items?.[0]?.name, 'Track 50');
    assert.equal(secondPage?.items?.[49]?.name, 'Track 99');

    assert.deepEqual(seenRequests, [
      { offset: '0', limit: '50' },
      { offset: '50', limit: '50' },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider chunks playlist tracks above the 50-item Spotify cap', async () => {
  const originalFetch = global.fetch;
  const playlistId = 'big-playlist';
  const seenRequests: Array<{ offset: number; limit: number }> = [];

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === `/v1/playlists/${playlistId}/items`) {
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 0;
      seenRequests.push({ offset, limit });
      const count = Math.min(limit, 300 - offset);
      const items = Array.from({ length: Math.max(0, count) }, (_, i) => ({
        track: {
          id: `track-${offset + i}`,
          name: `Track ${offset + i}`,
          duration_ms: 180000,
          artists: [{ name: 'Artist' }],
          album: { name: 'Album', images: [] },
        },
      }));
      return new Response(JSON.stringify({ total: 300, items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const folder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 130);
    assert.ok(folder);
    assert.equal(folder?.items?.length, 130);
    assert.equal(folder?.totalitems, 300);
    assert.equal(folder?.items?.[0]?.name, 'Track 0');
    assert.equal(folder?.items?.[50]?.name, 'Track 50');
    assert.equal(folder?.items?.[129]?.name, 'Track 129');

    assert.deepEqual(seenRequests, [
      { offset: 0, limit: 50 },
      { offset: 50, limit: 50 },
      { offset: 100, limit: 30 },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider keeps followed and public playlists from /me/playlists', async () => {
  const originalFetch = global.fetch;

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname;

    if (path === '/v1/me/playlists') {
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'own-1',
              name: 'Own Playlist',
              owner: { id: 'bianca' },
              tracks: { total: 1 },
            },
            {
              id: 'public-1',
              name: 'Public Playlist',
              owner: { id: 'spotify' },
              tracks: { total: 200 },
            },
          ],
          total: 2,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ error: 'unexpected-url', url: url.toString() }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const provider = new SpotifyAccountProvider({
      providerId: 'spotify@Bianca',
      account: {
        id: 'Bianca',
        spotifyId: 'bianca',
        user: 'Bianca',
        refreshToken: 'unused-in-test',
      },
      persistAccount: async () => null,
    });

    (provider as any).accessToken = 'test-token';
    (provider as any).tokenExpiresAt = Date.now() + 60_000;

    const playlists = await provider.getFolder('playlists', 0, 20);
    assert.ok(playlists);
    assert.equal(playlists?.items?.length, 2);
    assert.equal(playlists?.totalitems, 2);
    assert.deepEqual(
      playlists?.items?.map((item) => item.name),
      ['Own Playlist', 'Public Playlist'],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

/**
 * #365: a playlist the anonymous pathfinder cannot read must fall through to the Web API.
 *
 * Pathfinder is queried with a bearer scraped from the public web player, so it is nobody — and
 * every private playlist answers `NotFound`. That is a different fact from "this playlist has no
 * tracks", and conflating the two returned an empty folder for the owner's own private playlists
 * while the Web API, which holds their token and the `playlist-read-private` scope, could read
 * them all along.
 */
test('spotify account provider falls back to the Web API when pathfinder cannot read the playlist (issue #365)', async () => {
  const originalFetch = global.fetch;
  const playlistId = '5wHNzVkRjD5Cq5RIMPauQv';
  let pathfinderCalls = 0;
  let webApiItemCalls = 0;

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.host === 'api-partner.spotify.com') {
      pathfinderCalls += 1;
      // Verbatim shape measured against the live API for a playlist the token cannot see.
      return json({
        data: {
          playlistV2: {
            __typename: 'NotFound',
            message: `Object with uri 'spotify:playlist:${playlistId}' not found`,
          },
        },
      });
    }

    if (url.pathname === `/v1/playlists/${playlistId}/items`) {
      webApiItemCalls += 1;
      return json({
        total: 1,
        items: [
          {
            track: {
              id: 'track-private',
              name: 'Everloving',
              duration_ms: 200000,
              artists: [{ name: 'Moby' }],
              album: { name: 'Play', images: [] },
            },
          },
        ],
      });
    }

    return hashScrapeStub(url);
  }) as typeof fetch;

  try {
    const provider = newProvider();
    const folder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);

    assert.ok(pathfinderCalls > 0, 'pathfinder should still be tried first');
    assert.equal(webApiItemCalls, 1, 'NotFound must fall through to the Web API');
    assert.equal(folder?.items?.length, 1);
    assert.equal(folder?.items?.[0]?.name, 'Everloving');
  } finally {
    global.fetch = originalFetch;
  }
});

/**
 * The other half of the same distinction: a playlist pathfinder *can* read but which happens to
 * hold no tracks is a real answer, and must not cost a second round trip to the Web API.
 */
test('spotify account provider trusts an empty page pathfinder could actually read (issue #365)', async () => {
  const originalFetch = global.fetch;
  const playlistId = '2EmptyButReadable00000';
  let webApiItemCalls = 0;

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());

    if (url.host === 'api-partner.spotify.com') {
      return json({
        data: { playlistV2: { __typename: 'Playlist', content: { totalCount: 0, items: [] } } },
      });
    }

    if (url.pathname === `/v1/playlists/${playlistId}/items`) {
      webApiItemCalls += 1;
      return json({ total: 0, items: [] });
    }

    return hashScrapeStub(url);
  }) as typeof fetch;

  try {
    const provider = newProvider();
    const folder = await provider.getFolder(`spotify@Bianca:playlist:${playlistId}`, 0, 50);

    assert.equal(webApiItemCalls, 0, 'a readable empty playlist should not trigger the fallback');
    assert.equal(folder?.items?.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('spotify account provider pages a 120-row playlist window past the API limit (issue #380)', async () => {
  const originalFetch = global.fetch;
  const seenLimits: string[] = [];

  global.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    if (url.pathname !== '/v1/me/playlists') {
      return json({ error: 'unexpected-url', url: url.toString() }, 404);
    }

    const offset = Number(url.searchParams.get('offset')) || 0;
    const limit = Number(url.searchParams.get('limit')) || 0;
    seenLimits.push(String(limit));
    // Spotify's own behaviour: anything above 50 is refused outright.
    if (limit > 50) {
      return json({ error: { status: 400, message: 'Invalid limit' } }, 400);
    }

    const count = Math.max(0, Math.min(limit, 120 - offset));
    return json({
      total: 120,
      items: Array.from({ length: count }, (_, i) => ({
        id: `playlist-${offset + i}`,
        name: `Playlist ${offset + i}`,
        owner: { id: 'bianca' },
        tracks: { total: 1 },
      })),
    });
  }) as typeof fetch;

  try {
    const provider = newProvider();
    const folder = await provider.getFolder('playlists', 0, 120);

    assert.deepEqual(seenLimits, ['50', '50', '20'], 'the window is split into accepted pages');
    assert.equal(folder?.items?.length, 120);
    assert.equal(folder?.totalitems, 120);
    assert.equal(folder?.items?.[0]?.name, 'Playlist 0');
    assert.equal(folder?.items?.[119]?.name, 'Playlist 119');
  } finally {
    global.fetch = originalFetch;
  }
});
