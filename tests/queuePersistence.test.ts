import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  QueuePersistence,
  type PersistableZone,
  type StoredQueueItems,
  type StoredQueueState,
} from '../src/application/zones/queue/queuePersistence';
import type { QueueItem } from '../src/ports/types/queueTypes';

// A zone's queue lived in memory only, so an update of the server left every room with nothing
// queued and no memory of where it was.

const item = (n: number): QueueItem => ({
  album: '',
  artist: '',
  audiopath: `library:track:${n}`,
  audiotype: 2,
  coverurl: '',
  duration: 200,
  qindex: n,
  station: '',
  title: `Track ${n}`,
  unique_id: `u${n}`,
  user: '',
});

function harness() {
  const disk = { items: new Map<number, StoredQueueItems>(), state: new Map<number, StoredQueueState>() };
  const writes = { items: 0, state: 0 };
  const zones = new Map<number, PersistableZone>();
  const persistence = new QueuePersistence(
    {
      readItems: async (id) => disk.items.get(id) ?? null,
      readState: async (id) => disk.state.get(id) ?? null,
      writeItems: async (id, data) => {
        writes.items += 1;
        disk.items.set(id, JSON.parse(JSON.stringify(data)));
      },
      writeState: async (id, data) => {
        writes.state += 1;
        disk.state.set(id, JSON.parse(JSON.stringify(data)));
      },
    },
    (id) => zones.get(id),
    () => undefined,
    () => 42,
    5,
  );
  const zone = (id: number, count: number): PersistableZone => {
    const z: PersistableZone = {
      id,
      queue: { items: Array.from({ length: count }, (_, i) => item(i)), currentIndex: 0, shuffle: false, repeat: 0, authority: 'local' },
      metadata: {},
      inputMode: 'queue',
      state: { time: 0 },
    };
    zones.set(id, z);
    return z;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  return { persistence, disk, writes, zones, zone, settle };
}

test('queue persistence: a queue and the place in it come back after a restart', async () => {
  const first = harness();
  const z = first.zone(1, 5);
  await first.persistence.load(1);
  z.queue.currentIndex = 3;
  z.queue.repeat = 1;
  z.state.time = 97;
  first.persistence.noteItems(1);
  await first.settle();

  const restored = await first.persistence.load(1);
  assert.equal(restored?.items.length, 5);
  assert.equal(restored?.currentIndex, 3);
  assert.equal(restored?.repeat, 1);
  assert.equal(restored?.positionSec, 90, 'position is kept to ten seconds while playing');
});

test('queue persistence: playback ticking along does not rewrite the list', async () => {
  const h = harness();
  const z = h.zone(1, 500);
  await h.persistence.load(1);
  h.persistence.noteItems(1);
  await h.settle();
  assert.deepEqual(h.writes, { items: 1, state: 1 });
  for (const time of [3, 6, 9, 12]) {
    z.state.time = time;
    h.persistence.noteState(1);
    await h.settle();
  }
  assert.equal(h.writes.items, 1, 'the list was not written again');
  assert.equal(h.writes.state, 2, 'the position only when it moved a step');
});

test('queue persistence: nothing is written before the stored queue has been read', async () => {
  const h = harness();
  h.disk.items.set(1, { items: [item(1), item(2)] });
  h.zone(1, 0);
  // A freshly registered zone is empty; a state patch arrives before its queue is restored.
  h.persistence.noteItems(1);
  await h.settle();
  assert.equal(h.disk.items.get(1)?.items.length, 2, 'the stored queue is still there to restore');
});

test('queue persistence: a phone streaming in does not replace the stored queue', async () => {
  const h = harness();
  const z = h.zone(1, 4);
  await h.persistence.load(1);
  h.persistence.noteItems(1);
  await h.settle();
  z.inputMode = 'airplay';
  z.queue.items = [item(99)];
  h.persistence.noteItems(1);
  await h.settle();
  assert.equal(h.disk.items.get(1)?.items.length, 4);
});

test('queue persistence: shutdown writes the exact position and takes nothing after it', async () => {
  const h = harness();
  const z = h.zone(1, 3);
  await h.persistence.load(1);
  z.state.time = 137;
  await h.persistence.close([1]);
  assert.equal(h.disk.state.get(1)?.positionSec, 137);
  // The players are stopped next, which rewinds the zone.
  z.state.time = 0;
  h.persistence.noteState(1);
  await h.settle();
  assert.equal(h.disk.state.get(1)?.positionSec, 137);
});

test('queue persistence: a damaged file restores nothing rather than a broken queue', async () => {
  const h = harness();
  h.disk.items.set(1, { items: [{ title: 'no path' } as unknown as QueueItem] });
  assert.equal(await h.persistence.load(1), null);
  h.disk.items.set(2, { items: [item(1)] });
  h.disk.state.set(2, { currentIndex: 7, shuffle: false, repeat: 0, shuffled: false, positionSec: -4, savedAt: 0 });
  const restored = await h.persistence.load(2);
  assert.equal(restored?.currentIndex, 0);
  assert.equal(restored?.positionSec, 0);
});
