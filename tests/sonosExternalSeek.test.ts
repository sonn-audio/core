import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';

// A zone whose speaker plays a Spotify session of its own follows that speaker, not this server.
// A position request must move the speaker's item; what it must never do is start a stream of
// our own, which is what the command layer would have done with it (and did: the Spotify session
// was replaced and the Spotify app switched to the room's Connect device).

const configPort = { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any;

type Call = { action: string; positionMs?: number };

function createController(options: {
  canSeek?: boolean;
  durationMs?: number;
} = {}) {
  const calls: Call[] = [];
  const group: any = {
    name: 'Wohnzimmer',
    playbackState: 'PLAYBACK_STATE_PLAYING',
    pause: async () => calls.push({ action: 'pause' }),
    stop: async () => calls.push({ action: 'stop' }),
    skipToNextTrack: async () => calls.push({ action: 'next' }),
    skipToPreviousTrack: async () => calls.push({ action: 'previous' }),
    seek: async (positionMs: number) => calls.push({ action: 'seek', positionMs }),
    playbackActionsWrapper: {
      canSkipForward: true,
      canSkipBackward: true,
      raw: { canSeek: options.canSeek ?? true },
    },
    playbackMetadataStatus: {
      currentItem: { track: { name: 'A track', durationMillis: options.durationMs } },
    },
  };
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' } } as any,
    configPort,
    onStatePatch: () => undefined,
  }) as any;
  controller.client = { player: { group, isCoordinator: true } };
  return { controller, calls };
}

/** The dispatch is fired and not awaited, so give its microtasks a turn before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a position request moves the speaker, in milliseconds', async () => {
  const { controller, calls } = createController();
  assert.equal(controller.handleCommand('position', '60'), true, 'consumed by the controller');
  await settle();
  assert.deepEqual(calls, [{ action: 'seek', positionMs: 60_000 }]);
});

test('a position past the end of the item is held inside it', async () => {
  const { controller, calls } = createController({ durationMs: 100_000 });
  controller.handleCommand('position', '250');
  await settle();
  assert.deepEqual(calls, [{ action: 'seek', positionMs: 99_000 }], 'one second short of the end');
});

test('a speaker that does not advertise seeking is left alone', async () => {
  const { controller, calls } = createController({ canSeek: false });
  assert.equal(controller.handleCommand('position', '30'), true, 'still consumed, so it cannot fall through');
  await settle();
  assert.deepEqual(calls, [], 'nothing was sent');
});

test('a position that is not a number is consumed and not forwarded', async () => {
  const { controller, calls } = createController();
  assert.equal(controller.handleCommand('position', 'halfway'), true);
  assert.equal(controller.handleCommand('position', '-5'), true);
  await settle();
  assert.deepEqual(calls, []);
});

test('shuffle and repeat are consumed, not forwarded and not left to the queue', () => {
  const { controller, calls } = createController();
  assert.equal(controller.handleCommand('shuffle', 'on'), true);
  assert.equal(controller.handleCommand('repeat', 'all'), true);
  assert.deepEqual(calls, [], 'nothing was sent to the speaker');
});

test('next and previous still reach the speaker', async () => {
  const { controller, calls } = createController();
  assert.equal(controller.handleCommand('queueplus'), true);
  assert.equal(controller.handleCommand('queueminus'), true);
  await settle();
  assert.deepEqual(calls, [{ action: 'next' }, { action: 'previous' }]);
});

test('commands this controller does not own are still declined', () => {
  const { controller } = createController();
  // Volume is the output's to apply; declining keeps it on the path it already had.
  assert.equal(controller.handleCommand('volume', '40'), false);
  assert.equal(controller.handleCommand('definitely-not-a-command'), false);
});

test('the advertised capabilities are the speaker\u2019s, in the mask\u2019s terms', () => {
  const { controller } = createController();
  assert.deepEqual(controller.getTransportCapabilities(), {
    skip: true,
    seek: true,
    shuffle: false,
    repeat: false,
  });
});

test('without a live speaker the capabilities are unknown rather than guessed', () => {
  const { controller } = createController();
  controller.client = null;
  assert.equal(controller.getTransportCapabilities(), null);
});
