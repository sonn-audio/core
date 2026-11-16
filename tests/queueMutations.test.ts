import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController } from '../src/application/zones/QueueController';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import type { QueueItem, QueueState, ZoneContext } from '../src/application/zones/internal/zoneTypes';

function makeItem(n: number): QueueItem {
  return {
    album: '',
    artist: '',
    audiopath: `library:track:${n}`,
    audiotype: 2,
    coverurl: '',
    duration: 120,
    qindex: n - 1,
    station: '',
    title: `Track ${n}`,
    unique_id: `u${n}`,
    user: '',
  };
}

function makeController(count: number, startIndex = 0) {
  const zones = new ZoneRepository();
  let queueEvents = 0;
  const qc = new QueueController(zones, {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, spam: () => {} } as any,
    contentPort: {} as any,
    applyPatch: () => {},
    isRadioAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    isMusicAssistantAudiopath: () => false,
    providerForAudiopath: () => null,
    resolveBridgeProvider: () => null,
    getMusicAssistantUserId: () => 'musicassistant',
    getStateAudiotype: () => null,
    getStateFileType: () => 0,
    resolveSourceName: () => undefined,
    notifier: { notifyQueueUpdated: () => { queueEvents += 1; }, notifyZoneStateChanged: () => {} } as any,
  });

  const queue: QueueState = {
    items: Array.from({ length: count }, (_, idx) => makeItem(idx + 1)),
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local',
  };
  const navigator = new PlaybackQueueNavigator(queue);
  navigator.setItems(queue.items, startIndex);
  const ctx = {
    id: 1,
    name: 'Zone 1',
    queue,
    queueController: navigator,
    metadata: {} as Record<string, unknown>,
  } as unknown as ZoneContext;
  zones.set(1, ctx);
  return { qc, ctx, events: () => queueEvents };
}

const uids = (ctx: ZoneContext) => ctx.queue.items.map((i) => i.unique_id);

test('removeByUniqueId removes item and keeps current track selected', () => {
  const { qc, ctx } = makeController(5, 1); // current = u2
  assert.equal(qc.removeByUniqueId(1, 'u4'), true);
  assert.deepEqual(uids(ctx), ['u1', 'u2', 'u3', 'u5']);
  assert.equal(ctx.queueController.current()?.unique_id, 'u2');
});

test('removeByUniqueId before current shifts current index back', () => {
  const { qc, ctx } = makeController(5, 2); // current = u3
  assert.equal(qc.removeByUniqueId(1, 'u1'), true);
  assert.equal(ctx.queueController.current()?.unique_id, 'u3');
});

test('removeByUniqueId returns false for unknown target', () => {
  const { qc } = makeController(3, 0);
  assert.equal(qc.removeByUniqueId(1, 'nope'), false);
});

test('moveBeforeUniqueId reorders and preserves current identity', () => {
  const { qc, ctx } = makeController(5, 1); // current = u2
  assert.equal(qc.moveBeforeUniqueId(1, 'u5', 'u2'), true);
  assert.deepEqual(uids(ctx), ['u1', 'u5', 'u2', 'u3', 'u4']);
  assert.equal(ctx.queueController.current()?.unique_id, 'u2');
});

test('moveBeforeUniqueId with end appends', () => {
  const { qc, ctx } = makeController(4, 0);
  assert.equal(qc.moveBeforeUniqueId(1, 'u1', 'end'), true);
  assert.deepEqual(uids(ctx), ['u2', 'u3', 'u4', 'u1']);
});

test('clear empties the queue', () => {
  const { qc, ctx } = makeController(3, 0);
  assert.equal(qc.clear(1), true);
  assert.equal(ctx.queue.items.length, 0);
  assert.equal(qc.clear(1), false); // already empty
});

test('undo restores the queue across multiple mutations (stack)', () => {
  const { qc, ctx } = makeController(4, 0);
  qc.removeByUniqueId(1, 'u2'); // u1 u3 u4
  qc.clear(1); // empty
  assert.equal(ctx.queue.items.length, 0);
  assert.equal(qc.undo(1), true); // back to u1 u3 u4
  assert.deepEqual(uids(ctx), ['u1', 'u3', 'u4']);
  assert.equal(qc.undo(1), true); // back to u1 u2 u3 u4
  assert.deepEqual(uids(ctx), ['u1', 'u2', 'u3', 'u4']);
  assert.equal(qc.undo(1), false); // nothing left
});

test('selectIndex moves the queue cursor', () => {
  const { qc, ctx } = makeController(5, 0);
  assert.equal(qc.selectIndex(1, 3), true);
  assert.equal(ctx.queueController.current()?.unique_id, 'u4');
});

test('mutations emit audio_queue_event', () => {
  const { qc, events } = makeController(3, 0);
  qc.removeByUniqueId(1, 'u1');
  qc.clear(1);
  qc.undo(1);
  assert.equal(events(), 3);
});

// Shuffle reorders the queue itself, so the shuffled list is the play order. Advancing used to
// pick a random row on top of that: what played next was not the row the client showed as
// next, a track could come round again before the others had played, and with repeat off the
// queue never reached its end.
test('a shuffled queue plays in the order it is shown, each track once, and then ends', () => {
  const { qc, ctx } = makeController(8, 0);
  qc.setShuffle(1, true);
  const shown = uids(ctx);
  const played = [ctx.queueController.current()?.unique_id];
  for (let guard = 0; guard < 50; guard += 1) {
    const next = ctx.queueController.nextIndex();
    if (next < 0) break;
    played.push(ctx.queueController.setCurrentIndex(next)?.unique_id);
  }
  assert.deepEqual(played, shown);
});

test('a shuffled queue on repeat-all wraps to its first row', () => {
  const { qc, ctx } = makeController(4, 0);
  qc.setShuffle(1, true);
  ctx.queue.repeat = 1;
  ctx.queueController.setCurrentIndex(3);
  assert.equal(ctx.queueController.nextIndex(), 0);
});
