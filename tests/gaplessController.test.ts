import assert from 'node:assert/strict';
import { test } from './testHarness';
import { GaplessController } from '../src/application/zones/playback/gaplessController';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import type { QueueItem, QueueState, ZoneContext } from '../src/application/zones/internal/zoneTypes';

// The end of a track stopped its session and started another, with every output told to play a
// new stream. Here the next track is lined up in the engine ahead of time and, when the zone
// clock says the current one is over, only the queue and what the clients show move on.

const item = (n: number): QueueItem => ({
  album: 'Album',
  artist: 'Artist',
  audiopath: `library:track:${n}`,
  audiotype: 2,
  coverurl: '',
  duration: 200,
  qindex: n - 1,
  station: '',
  title: `Track ${n}`,
  unique_id: `u${n}`,
  user: '',
});

function harness(options: { crossfadeSec?: number; gapless?: boolean; outputType?: string } = {}) {
  const calls: string[] = [];
  const zones = new ZoneRepository();
  const queue: QueueState = { items: [item(1), item(2), item(3)], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' };
  const navigator = new PlaybackQueueNavigator(queue);
  const session = { state: 'playing', playbackSource: { kind: 'file', path: '/m/1.flac' }, metadata: { isRadio: false } };
  const engine = { id: 100 as number | null };
  /** Resolves the engine's report of the join; left pending until the test settles it. */
  let settleJoin: (joined: boolean) => void = () => undefined;
  const patches: Array<Record<string, unknown>> = [];
  const ctx = {
    id: 1,
    name: 'Room',
    queue,
    queueController: navigator,
    outputs: [{ type: options.outputType ?? 'dlna' }],
    inputMode: 'queue',
    state: { title: 'Track 1' },
    metadata: {},
    player: { updateStateForCrossfade: () => calls.push('clock') },
  } as unknown as ZoneContext;
  zones.set(1, ctx);
  const controller = new GaplessController({
    zoneRepo: zones,
    audioManager: {
      getSession: () => session,
      armGapless: (_zone: number, source: { path: string }) => {
        calls.push(`arm:${source.path}`);
        return new Promise((resolve) => {
          settleJoin = (joined) =>
            resolve(joined ? { frames: 8_820_000, sampleRate: 44100, source, engineSession: engine.id } : null);
        });
      },
      adoptGaplessNext: (_zone: number, source: { path: string }, _meta: unknown, engineSession: number | null) => {
        if (engineSession !== engine.id) return null;
        calls.push(`adopt:${source.path}`);
        return { ...session, playbackSource: source };
      },
      disarmGapless: () => {
        calls.push('disarm');
        settleJoin(false);
      },
      isOnEngineSession: (_zone: number, id: number | null) => id === engine.id,
    } as never,
    audioHelpers: {
      isRadioAudiopath: () => false,
      isMusicAssistantAudiopath: () => false,
      isSpotifyAudiopath: () => false,
      providerForAudiopath: () => 'library',
      getStateAudiotype: () => 2,
      resolveSourceName: () => undefined,
      getStateFileType: () => 0,
    } as never,
    contentPort: {
      resolvePlaybackSource: async ({ audiopath }: { audiopath: string }) => ({
        playbackSource: { kind: 'file', path: `/m/${audiopath.split(':').pop()}.flac` },
      }),
    } as never,
    configPort: {
      getSystemConfig: () => ({ audioserver: { crossfadeSec: options.crossfadeSec ?? 0, gapless: options.gapless } }),
    } as never,
    recentsManager: { record: async () => undefined } as never,
    log: { debug: () => {}, info: () => {}, warn: () => {} } as never,
    applyPatch: (_zone, patch) => patches.push(patch as Record<string, unknown>),
    isLocalQueueAuthority: () => true,
  });
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  return { controller, ctx, calls, patches, navigator, queue, engine, join: (ok: boolean) => settleJoin(ok), tick };
}

test('gapless: the next track is lined up near the end and taken over without starting anything', async () => {
  const h = harness();
  h.controller.onPosition(1, 100, 200);
  await h.tick();
  assert.deepEqual(h.calls, [], 'not yet: the end is far off');

  h.controller.onPosition(1, 185, 200);
  h.controller.onPosition(1, 186, 200);
  await h.tick();
  assert.deepEqual(h.calls, ['arm:/m/2.flac'], 'lined up once');

  h.join(true);
  await h.tick();
  assert.equal(await h.controller.takeOver(h.ctx), true);
  assert.deepEqual(h.calls, ['arm:/m/2.flac', 'adopt:/m/2.flac', 'clock']);
  assert.equal(h.navigator.currentIndex(), 1);
  assert.equal(h.patches.at(-1)?.title, 'Track 2');
  assert.equal(h.patches.at(-1)?.time, 0);

  // And the one after it, the same way.
  h.controller.onPosition(1, 190, 200);
  await h.tick();
  h.join(true);
  await h.tick();
  assert.equal(await h.controller.takeOver(h.ctx), true);
  assert.equal(h.navigator.currentIndex(), 2);
});

test('gapless: the clock reaching the end first waits for the join to be reported', async () => {
  const h = harness();
  h.controller.onPosition(1, 195, 200);
  await h.tick();
  const taking = h.controller.takeOver(h.ctx);
  await h.tick();
  h.join(true);
  assert.equal(await taking, true);
  assert.equal(h.navigator.currentIndex(), 1);
});

test('gapless: a join that does not happen leaves the track to end the ordinary way', async () => {
  const h = harness();
  h.controller.onPosition(1, 195, 200);
  await h.tick();
  h.join(false);
  await h.tick();
  assert.equal(await h.controller.takeOver(h.ctx), false);
  assert.equal(h.navigator.currentIndex(), 0, 'the queue has not moved; the caller starts the next track');
});

test('gapless: a queue edited after the line-up is not overruled by it', async () => {
  const h = harness();
  h.controller.onPosition(1, 195, 200);
  await h.tick();
  h.join(true);
  await h.tick();
  // Track 2 is taken out of the queue: what follows track 1 is now track 3.
  h.navigator.setItems([item(1), item(3)], 0);
  assert.equal(await h.controller.takeOver(h.ctx), false);
  assert.ok(h.calls.includes('disarm'));
  assert.ok(!h.calls.some((call) => call.startsWith('adopt')));
});

test('gapless: a join made in a session that has since been replaced is not claimed', async () => {
  const h = harness();
  h.controller.onPosition(1, 195, 200);
  await h.tick();
  h.join(true);
  await h.tick();
  // A seek restarted the engine: another session, without the join.
  h.engine.id = 101;
  assert.equal(await h.controller.takeOver(h.ctx), false);
  // And the stale line-up does not stand in the way of a new one.
  h.controller.onPosition(1, 190, 200);
  await h.tick();
  assert.equal(h.calls.filter((call) => call.startsWith('arm')).length, 2);
});

test('gapless: off by setting, under crossfade, at the last track and on Squeezelite', async () => {
  for (const options of [{ gapless: false }, { crossfadeSec: 5 }, { outputType: 'squeezelite' }]) {
    const h = harness(options);
    h.controller.onPosition(1, 195, 200);
    await h.tick();
    assert.deepEqual(h.calls, [], JSON.stringify(options));
  }
  const last = harness();
  last.navigator.setCurrentIndex(2);
  last.controller.onPosition(1, 195, 200);
  await last.tick();
  assert.deepEqual(last.calls, [], 'nothing follows the last track');
});
