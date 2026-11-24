import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { buildConfigRoutes, defaultConfig } from '../src/adapters/http/adminApi/config/configHandlers';
import type { AudioServerConfig } from '../src/domain/config/types';

/** Drives POST /config/system with a body, returning the status/payload it answered
 *  with plus the config that survived the update. */
async function postSystem(
  body: unknown,
  seed: AudioServerConfig = defaultConfig(),
): Promise<{ status: number; payload: unknown; cfg: AudioServerConfig }> {
  const cfg = seed;
  let status = 0;
  let payload: unknown = null;
  const routes = buildConfigRoutes({
    readJsonBody: async () => body,
    sendJson: (_res: ServerResponse, code: number, value: unknown) => {
      status = code;
      payload = value;
    },
    configPort: {
      updateConfig: async (mutate: (draft: AudioServerConfig) => void) => {
        mutate(cfg);
      },
    },
  } as never);
  const route = routes.find((entry) => entry.method === 'POST' && entry.pattern.test('/config/system'));
  assert.ok(route, 'POST /config/system route missing');
  await route!.handler(
    {} as IncomingMessage,
    { writableEnded: false } as ServerResponse,
    [] as unknown as RegExpMatchArray,
    '/config/system',
  );
  return { status, payload, cfg };
}

test('system update persists crossfadeSec on its own', async () => {
  // The admin UI posts nothing but this field, so it has to satisfy the
  // "at least one known field" guard by itself (issue #346).
  const accepted = await postSystem({ audioserver: { crossfadeSec: 6 } });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.cfg.system.audioserver.crossfadeSec, 6);

  const disabled = await postSystem({ audioserver: { crossfadeSec: 0 } }, accepted.cfg);
  assert.equal(disabled.status, 204);
  assert.equal(disabled.cfg.system.audioserver.crossfadeSec, 0);
});

test('system update rejects an out-of-range crossfadeSec', async () => {
  for (const value of [-1, 21, Number.NaN]) {
    const result = await postSystem({ audioserver: { crossfadeSec: value } });
    assert.equal(result.status, 400, `crossfadeSec ${value} should be refused`);
    assert.deepEqual(result.payload, { error: 'invalid-crossfade-sec' });
    assert.equal(result.cfg.system.audioserver.crossfadeSec, undefined);
  }
});

test('system update still refuses a body with no known field', async () => {
  const result = await postSystem({ audioserver: { nonsense: true } });
  assert.equal(result.status, 400);
  assert.deepEqual(result.payload, { error: 'invalid-system-payload' });
});

test('system update stores the artwork protocol and port', async () => {
  const result = await postSystem({ audioserver: { artworkProtocol: 'HTTPS', artworkPort: 443 } });
  assert.equal(result.status, 204);
  assert.equal(result.cfg.system.audioserver.artworkProtocol, 'https');
  assert.equal(result.cfg.system.audioserver.artworkPort, 443);
});

test('artwork settings survive an unrelated system save', async () => {
  const configured = await postSystem({ audioserver: { artworkProtocol: 'https', artworkPort: 443 } });
  const unrelated = await postSystem({ audioserver: { crossfadeSec: 4 } }, configured.cfg);
  assert.equal(unrelated.status, 204);
  assert.equal(unrelated.cfg.system.audioserver.artworkProtocol, 'https');
  assert.equal(unrelated.cfg.system.audioserver.artworkPort, 443);
  assert.equal(unrelated.cfg.system.audioserver.crossfadeSec, 4);
});

test('an unsupported artwork protocol is refused', async () => {
  for (const value of ['ftp', 'HTTPS2', '']) {
    const result = await postSystem({ audioserver: { artworkProtocol: value } });
    assert.equal(result.status, 400, `protocol ${JSON.stringify(value)} should be refused`);
    assert.deepEqual(result.payload, { error: 'invalid-artwork-protocol' });
    assert.equal(result.cfg.system.audioserver.artworkProtocol, undefined);
  }
  const wrongType = await postSystem({ audioserver: { artworkProtocol: 5 } });
  assert.equal(wrongType.status, 400);
  assert.deepEqual(wrongType.payload, { error: 'invalid-artwork-protocol' });
});

test('an invalid artwork port is refused', async () => {
  for (const value of [0, -1, 65536, 1.5, Number.NaN]) {
    const result = await postSystem({ audioserver: { artworkPort: value } });
    assert.equal(result.status, 400, `port ${value} should be refused`);
    assert.deepEqual(result.payload, { error: 'invalid-artwork-port' });
    assert.equal(result.cfg.system.audioserver.artworkPort, undefined);
  }
});

test('null resets the artwork origin to the defaults', async () => {
  const configured = await postSystem({ audioserver: { artworkProtocol: 'https', artworkPort: 8443 } });
  const reset = await postSystem(
    { audioserver: { artworkProtocol: null, artworkPort: null } },
    configured.cfg,
  );
  assert.equal(reset.status, 204);
  assert.equal(reset.cfg.system.audioserver.artworkProtocol, undefined);
  assert.equal(reset.cfg.system.audioserver.artworkPort, undefined);
});
