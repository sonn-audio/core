import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';

test('audio cfg roomfavs add returns created favorite id (not zone id)', async () => {
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => undefined,
      getQueue: () => ({ id: 7, items: [], shuffle: false, start: 0, totalitems: 0 }),
      handleCommand: () => {},
      queue: {
        setPendingShuffle: () => {},
        seekInQueue: () => false,
      },
      playContent: async () => {},
      getMetadata: () => ({}),
    } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({ items: [] }),
      add: async () => ({ id: 42 }),
    } as any,
    { resolveMetadata: async () => null } as any,
  );

  const result = await zoneHandlers.audioCfgRoomFavs(
    'audio/cfg/roomfavs/7/add/Test%20Favorite/https://example.com/stream',
  );
  const payload = result.payload as { id?: number; name?: string };
  assert.equal(payload.id, 42);
  assert.equal(payload.name, 'Test Favorite');
});
