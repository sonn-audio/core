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

test('roomfav plus resumes a paused zone instead of jumping to a favorite', async () => {
  const commands: Array<{ zoneId: number; command: string }> = [];
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => ({ id: 7, mode: 'pause', audiopath: 'spotify:track:abc' }),
      getQueue: () => ({ id: 7, items: [], shuffle: false, start: 0, totalitems: 0 }),
      handleCommand: (zoneId: number, command: string) => {
        commands.push({ zoneId, command });
      },
      queue: { setPendingShuffle: () => {}, seekInQueue: () => false },
      playContent: async () => {},
      getMetadata: () => ({}),
    } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({ items: [{ id: 1, audiopath: 'radio:one' }] }),
      getForPlayback: async () => ({ id: 1, audiopath: 'radio:one', title: 'One' }),
    } as any,
    { resolveMetadata: async () => null } as any,
  );

  await zoneHandlers.audioRoomFavPlus('audio/7/roomfav/plus');
  assert.deepEqual(commands, [{ zoneId: 7, command: 'play' }]);
});

test('roomfav plus still cycles favorites when the zone is already playing', async () => {
  const played: number[] = [];
  const metadata: Record<string, unknown> = {};
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => ({ id: 7, mode: 'play', audiopath: 'radio:one' }),
      getQueue: () => ({ id: 7, items: [], shuffle: false, start: 0, totalitems: 0 }),
      handleCommand: () => {
        throw new Error('should not resume while playing');
      },
      queue: { setPendingShuffle: () => {}, seekInQueue: () => false },
      playContent: async (zoneId: number) => {
        played.push(zoneId);
      },
      getMetadata: () => metadata,
    } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({
        items: [
          { id: 1, audiopath: 'radio:one' },
          { id: 2, audiopath: 'radio:two' },
        ],
      }),
      getForPlayback: async (_zoneId: number, id: number) => ({
        id,
        audiopath: id === 2 ? 'radio:two' : 'radio:one',
        title: 'Fav',
      }),
    } as any,
    { resolveMetadata: async () => null } as any,
  );

  await zoneHandlers.audioRoomFavPlus('audio/7/roomfav/plus');
  assert.equal(metadata.lastFavoriteId, 2);
  assert.deepEqual(played, [7]);
});

test('roomfav plus falls back to a favorite when a stopped zone has nothing to resume', async () => {
  const metadata: Record<string, unknown> = {};
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => ({ id: 7, mode: 'stop', audiopath: '' }),
      getQueue: () => ({ id: 7, items: [], shuffle: false, start: 0, totalitems: 0 }),
      handleCommand: () => {
        throw new Error('should not resume without an audiopath');
      },
      queue: { setPendingShuffle: () => {}, seekInQueue: () => false },
      playContent: async () => {},
      getMetadata: () => metadata,
    } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({ items: [{ id: 5, audiopath: 'radio:one' }] }),
      getForPlayback: async () => ({ id: 5, audiopath: 'radio:one', title: 'One' }),
    } as any,
    { resolveMetadata: async () => null } as any,
  );

  await zoneHandlers.audioRoomFavPlus('audio/7/roomfav/plus');
  assert.equal(metadata.lastFavoriteId, 5);
});
