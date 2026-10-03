import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildSpotifyRoutes, type SpotifyHandlerDeps } from '../src/adapters/http/adminApi/spotify/spotifyHandlers';
import type { AmazonMusicCredentials, StreamingServiceConfig } from '../src/domain/config/types';
import type { AmazonMusicAdminPort } from '../src/ports/AmazonMusicAdminPort';

// An Amazon Music account is its device registration, and that registration is the device's
// private key — so the sign-in flow keeps it server-side and the save route collects it by login
// id. These pin the three ways that hand-over can go: collected, missing, and kept on a re-save.

const CREDENTIALS: AmazonMusicCredentials = {
  country: 'NL',
  deviceSerial: 'PIXEL5TEST',
  adpToken: '{enc:token}',
  devicePrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----',
  websiteCookies: { 'session-id': '1' },
  customerId: 'A1CUSTOMER',
  tier: 'unlimited',
};

function harness(pending: Record<string, AmazonMusicCredentials>) {
  let config: any = { content: { streamingServices: [] as StreamingServiceConfig[] } };
  const sent: Array<{ status: number; body: any }> = [];
  let body: unknown = null;
  const amazonMusicAdmin: AmazonMusicAdminPort = {
    storefronts: () => [],
    startLogin: () => ({ loginId: '', url: '' }),
    finishLogin: async () => ({ ok: false, error: 'expired', message: '' }),
    takeCredentials: (loginId) => {
      const credentials = pending[loginId] ?? null;
      delete pending[loginId];
      return credentials;
    },
  };
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
    amazonMusicAdmin,
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
    await route.handler({} as IncomingMessage, { writableEnded: false } as ServerResponse, [] as unknown as RegExpMatchArray, '/content/services');
    return sent[sent.length - 1]!;
  };
  return { save, config: () => config };
}

test('saving an Amazon Music account collects the registration its sign-in produced', async () => {
  const h = harness({ login1: CREDENTIALS });
  const res = await h.save({ provider: 'amazonmusic', id: 'bridge-amazonmusic-abc', amazonMusicLoginId: 'login1' });
  assert.equal(res.status, 200);
  const stored = h.config().content.streamingServices[0];
  assert.equal(stored.provider, 'amazonmusic');
  assert.equal(stored.label, 'Amazon Music');
  assert.deepEqual(stored.amazonMusic, CREDENTIALS);
});

test('an Amazon Music account without a finished sign-in is refused', async () => {
  const h = harness({});
  const res = await h.save({ provider: 'amazonmusic', amazonMusicLoginId: 'never-finished' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'amazonmusic-login-required');
  assert.equal(h.config().content.streamingServices.length, 0);
});

test('re-saving an Amazon Music account under a new name keeps its registration', async () => {
  const h = harness({ login1: CREDENTIALS });
  await h.save({ provider: 'amazonmusic', id: 'bridge-amazonmusic-abc', amazonMusicLoginId: 'login1' });
  const res = await h.save({ provider: 'amazonmusic', id: 'bridge-amazonmusic-abc', label: 'Living room Amazon' });
  assert.equal(res.status, 200);
  const stored = h.config().content.streamingServices;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].label, 'Living room Amazon');
  assert.deepEqual(stored[0].amazonMusic, CREDENTIALS);
});
