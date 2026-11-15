import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import {
  removeCustomRadioCover,
  saveCustomRadioCover,
  sniffImageExtension,
} from '../src/adapters/content/providers/customRadioCovers';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { LoxoneRouter } from '../src/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '../src/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '../src/adapters/loxone/commands/responses';

// A picture for a custom radio station, uploaded from the Loxone app
// (`PUT audio/cfg/radios/coverurl/<id>`). It is kept under data/music, the tree the /music
// route already serves, so the station's coverurl can simply point at it.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

async function inTempData(run: (coverDir: string) => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-radio-cover-'));
  try {
    process.chdir(tempDir);
    await run(path.join(tempDir, 'data', 'music', 'customradio'));
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('a radio cover is recognised by its bytes, and nothing else is taken for one', () => {
  assert.equal(sniffImageExtension(PNG), 'png');
  assert.equal(sniffImageExtension(JPEG), 'jpg');
  assert.equal(sniffImageExtension(WEBP), 'webp');
  assert.equal(sniffImageExtension(Buffer.from('GIF89a....')), 'gif');
  // The upload is a bare body with no trustworthy type; anything else must not land in a
  // folder that is served over HTTP.
  assert.equal(sniffImageExtension(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(sniffImageExtension(Buffer.from('#!/bin/sh\nrm -rf /')), null);
  assert.equal(sniffImageExtension(Buffer.alloc(0)), null);
});

test('a radio cover is stored under the served music tree, one per station', async () => {
  await inTempData(async (coverDir) => {
    assert.equal(await saveCustomRadioCover('station-1', PNG), 'station-1.png');
    assert.deepEqual(await fs.readdir(coverDir), ['station-1.png']);
    // Replaced by a picture in another format: the old file goes.
    assert.equal(await saveCustomRadioCover('station-1', JPEG), 'station-1.jpg');
    assert.deepEqual(await fs.readdir(coverDir), ['station-1.jpg']);
    assert.deepEqual(await fs.readFile(path.join(coverDir, 'station-1.jpg')), JPEG);
    await removeCustomRadioCover('station-1');
    assert.deepEqual(await fs.readdir(coverDir), []);
  });
});

test('a radio cover never leaves its folder, whatever the station id says', async () => {
  await inTempData(async (coverDir) => {
    const fileName = await saveCustomRadioCover('../../etc/passwd', PNG);
    assert.equal(fileName, '______etc_passwd.png');
    assert.deepEqual(await fs.readdir(coverDir), [fileName]);
  });
});

test('a radio cover that is not an image, or is absurdly large, is refused', async () => {
  await inTempData(async (coverDir) => {
    assert.equal(await saveCustomRadioCover('station-1', Buffer.from('not an image')), null);
    assert.equal(await saveCustomRadioCover('station-1', Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)])), null);
    await assert.rejects(fs.readdir(coverDir), 'nothing was written, not even the folder');
  });
});

test('the upload command stores the picture, answers, and tells the apps', async () => {
  const stored: unknown[][] = [];
  const events: unknown[][] = [];
  const notifier = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => events.push([String(name), ...args]) });
  const handlers = createProviderHandlers(
    {
      setCustomRadioCover: async (id: string, data: Buffer) => {
        stored.push([id, data.length]);
        return id === 'known' ? 'http://10.0.0.5:7090/music/customradio/known.png?cb=1' : null;
      },
    } as any,
    notifier as any,
  );

  const ok = JSON.parse(serializeResult(await handlers.audioCfgRadiosCoverUrl('audio/cfg/radios/coverurl/known', PNG)));
  assert.equal(ok.radios_result.error, 0);
  assert.equal(ok.radios_result.coverurl, 'http://10.0.0.5:7090/music/customradio/known.png?cb=1');
  assert.deepEqual(stored, [['known', PNG.length]]);
  assert.deepEqual(events, [['notifyCustomUrlChanged', 'changed', 'known']]);

  const unknown = JSON.parse(serializeResult(await handlers.audioCfgRadiosCoverUrl('audio/cfg/radios/coverurl/gone', PNG)));
  assert.equal(unknown.radios_result.error, -3);
  const empty = JSON.parse(serializeResult(await handlers.audioCfgRadiosCoverUrl('audio/cfg/radios/coverurl/known')));
  assert.equal(empty.radios_result.error, -3, 'an upload without a body stores nothing');
  assert.equal(events.length, 1, 'and neither of those tells anyone anything changed');
});

test('the upload command has a route of its own and is handed the body', async () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === 'then' ? undefined : anything),
    apply: () => anything,
  });
  const router = new LoxoneRouter();
  registerRoutes(router, new Proxy({}, { get: () => anything }) as any);
  // The app's `putFile` resolves the path against the server root, so it arrives with a slash.
  const result = await router.dispatch('/audio/cfg/radios/coverurl/station-1', PNG);
  assert.equal(result.name, 'radios');
  assert.equal((result.payload as { action: string }).action, 'coverurl');
});
