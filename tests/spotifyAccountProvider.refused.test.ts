import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SpotifyAccountProvider } from '../src/adapters/content/providers/spotify/spotifyAccountProvider';
import { ProviderUnavailableError } from '../src/adapters/content/providerUnavailable';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function newProvider(): SpotifyAccountProvider {
  const provider = new SpotifyAccountProvider({
    providerId: 'spotify@Bianca',
    account: { id: 'Bianca', spotifyId: 'bianca', user: 'Bianca', refreshToken: 'unused-in-test' },
    persistAccount: async () => null,
  });
  (provider as any).accessToken = 'test-token';
  (provider as any).tokenExpiresAt = Date.now() + 60_000;
  return provider;
}

async function withFetch<T>(fetcher: (url: URL) => Response | Promise<Response>, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return fetcher(url);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

/*
 * The account's own library, when Spotify turns the request away. Every one of these doors
 * answered `[]` on a 403 and the player drew an empty shelf over a library of four hundred records.
 */
test('a refused library door throws with the reason rather than listing nothing', async () => {
  const provider = newProvider();
  await withFetch(
    (url) => (url.pathname === '/v1/me/albums' ? json({ error: { status: 403, message: 'forbidden' } }, 403) : json({}, 404)),
    async () => {
      await assert.rejects(
        provider.getFolder('albums', 0, 20),
        (error: unknown) =>
          error instanceof ProviderUnavailableError &&
          error.service === 'spotify@Bianca' &&
          error.reason === 'denied' &&
          error.status === 403,
      );
    },
  );
  await withFetch(
    (url) => (url.pathname === '/v1/me/tracks' ? json({}, 429) : json({}, 404)),
    async () => {
      await assert.rejects(
        provider.getFolder('liked', 0, 50),
        (error: unknown) => error instanceof ProviderUnavailableError && error.reason === 'rate-limited',
      );
    },
  );
});

test('a library door with nothing saved behind it is still an empty list', async () => {
  const provider = newProvider();
  await withFetch(
    (url) => (url.pathname === '/v1/me/albums' ? json({ items: [], total: 0 }) : json({}, 404)),
    async () => {
      const folder = await provider.getFolder('albums', 0, 20);
      assert.equal(folder?.items.length, 0);
      assert.equal(folder?.totalitems, 0);
    },
  );
});

test('an account without a token is an auth refusal, not an empty library', async () => {
  const provider = newProvider();
  (provider as any).accessToken = '';
  (provider as any).tokenExpiresAt = 0;
  (provider as any).refreshAccessToken = async () => null;
  await withFetch(
    () => json({}, 500),
    async () => {
      await assert.rejects(
        provider.getFolder('playlists', 0, 20),
        (error: unknown) => error instanceof ProviderUnavailableError && error.reason === 'auth',
      );
    },
  );
});
