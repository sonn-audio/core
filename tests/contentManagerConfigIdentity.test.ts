import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ContentManager } from '../src/adapters/content/contentManager';
import type { ConfigPort } from '../src/ports/ConfigPort';

// The zones are registered on the loaded config's own zone objects, and a Miniserver volume change
// is written into whatever object the config port currently holds. A second load in between swaps
// that object, so Vbuzzer could be changed, saved and logged while the wake-up kept fading to the
// old level (#392).
test('content manager start-up keeps the config the zones were registered on', async () => {
  let current = { zones: [{ id: 10, volumes: { default: 10, buzzer: 25 } }], content: {} } as any;
  let loads = 0;
  const configPort = {
    load: async () => {
      loads += 1;
      current = structuredClone(current);
      return current;
    },
    getConfig: () => current,
  } as unknown as ConfigPort;

  const zoneConfig = current.zones[0];
  const manager = new ContentManager(
    {} as any,
    configPort,
    { get: () => ({}) } as any,
    {} as any,
  );
  (manager as any).library = { initialize: async () => {} };
  (manager as any).refreshFromConfig = () => {};

  await manager.reinitialize();

  assert.equal(loads, 0);
  assert.equal(configPort.getConfig().zones[0], zoneConfig);
});

test('content manager still loads the config when nothing has loaded it yet', async () => {
  let current: any = null;
  let loads = 0;
  const configPort = {
    load: async () => {
      loads += 1;
      current = { zones: [], content: {} };
      return current;
    },
    getConfig: () => {
      if (!current) {
        throw new Error('configuration not loaded');
      }
      return current;
    },
  } as unknown as ConfigPort;

  const manager = new ContentManager({} as any, configPort, { get: () => ({}) } as any, {} as any);
  (manager as any).library = { initialize: async () => {} };
  (manager as any).refreshFromConfig = () => {};

  await manager.initialize();

  assert.equal(loads, 1);
});
