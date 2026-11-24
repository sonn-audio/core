import assert from 'node:assert/strict';
import { test } from './testHarness';
import { RadioParadiseProvider } from '../src/adapters/content/providers/radioparadise/radioParadiseProvider';
import { localImageUrl } from '../src/shared/artworkOrigin';

/**
 * Radio Paradise ships its station logos with the server and points at `/assets/icons`.
 * With an HTTPS artwork origin configured, those are the urls the Loxone Web UI loads — an HTTP
 * one is blocked as mixed content, which left the radio menu without logos while the phone app
 * still drew them.
 */

const HOST = 'sonn.dts.home';

test('station icons follow the configured artwork origin', async () => {
  const iconBaseUrl = localImageUrl('/assets/icons', HOST, { protocol: 'https', port: 443 });
  const provider = new RadioParadiseProvider({ iconBaseUrl });

  assert.equal(
    provider.getMenuEntry().icon,
    `https://${HOST}/assets/icons/radioparadise-logo-main.png`,
  );

  const folder = await provider.getFolder('start', 0, 10);
  assert.ok(folder, 'the start folder is served');
  assert.ok(folder!.items.length > 0);
  for (const item of folder!.items) {
    assert.ok(
      (item.coverurl ?? '').startsWith(`https://${HOST}/assets/icons/`),
      `station ${item.name} should carry an https icon, got ${item.coverurl}`,
    );
    assert.equal(item.thumbnail, item.coverurl, 'the thumbnail is the same picture');
  }
});

test('without the setting the icons stay on the plain gateway', async () => {
  const iconBaseUrl = localImageUrl('/assets/icons', HOST);
  const provider = new RadioParadiseProvider({ iconBaseUrl });
  assert.equal(
    provider.getMenuEntry().icon,
    `http://${HOST}:7090/assets/icons/radioparadise-logo-main.png`,
  );
  const folder = await provider.getFolder('start', 0, 1);
  assert.ok((folder!.items[0]?.coverurl ?? '').startsWith(`http://${HOST}:7090/assets/icons/`));
});
