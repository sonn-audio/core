import assert from 'node:assert/strict';
import { test } from './testHarness';
import { DlnaOutput } from '../src/adapters/outputs/dlna/dlnaOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';
import type {
  OutputStreamRequestEvent,
  OutputStreamRequestOptions,
} from '../src/ports/OutputStreamEventsPort';
import { makeOutputPortsFake } from './fakes/outputPorts';

/**
 * A renderer answers Play with a 200 whether or not it ever pulls a byte, which is how issue #343
 * hid: transport "playing", title on the display, volume live, silence. These pin the fetch — the
 * stream's own HTTP GET — as the readiness signal, and pin the ordering rule that follows from it.
 */

const configPortStub = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  getConfig: () => ({ system: { audioserver: { ip: '127.0.0.1' } }, zones: [] }),
  getZones: () => [],
} as unknown as ConfigPort;

type Deferred = {
  promise: Promise<OutputStreamRequestEvent | null>;
  settle: (value: OutputStreamRequestEvent | null) => void;
};

const deferred = (): Deferred => {
  let settle: (value: OutputStreamRequestEvent | null) => void = () => undefined;
  const promise = new Promise<OutputStreamRequestEvent | null>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

/** Let the fire-and-forget readiness chain run to its next await. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

type ControlPointStub = {
  setUriCalls: string[];
  metadataCalls: string[];
};

const makeOutput = (waits: Deferred[]): {
  output: DlnaOutput;
  cp: ControlPointStub;
  waitOptions: OutputStreamRequestOptions[];
} => {
  const waitOptions: OutputStreamRequestOptions[] = [];
  let waitIndex = 0;
  const ports: OutputPorts = {
    ...makeOutputPortsFake(configPortStub),
    outputStreamEvents: {
      waitForStreamRequest: (options: OutputStreamRequestOptions) => {
        waitOptions.push(options);
        const pending = waits[waitIndex];
        waitIndex += 1;
        return pending ? pending.promise : Promise.resolve(null);
      },
    },
  };
  // No host and no auto-discovery: nothing may reach the network from a test.
  const output = new DlnaOutput(4, 'Wohnzimmer', { autoDiscover: false }, ports);
  const cp: ControlPointStub = { setUriCalls: [], metadataCalls: [] };
  (output as unknown as { cp: unknown }).cp = {
    setUri: async (_uri: string, didl: string) => {
      cp.setUriCalls.push(didl);
      return true;
    },
    updateMetadata: async (_uri: string, didl: string) => {
      cp.metadataCalls.push(didl);
      return true;
    },
    subscribeEvents: async () => undefined,
    getSinkContentTypes: async () => null,
    play: async () => true,
    stop: async () => true,
    pause: async () => true,
    setVolume: async () => true,
    dispose: () => undefined,
  };
  return { output, cp, waitOptions };
};

const makeSession = (title: string, streamId = 'stream-1'): PlaybackSession =>
  ({
    source: 'tunein:station:abc',
    playbackSource: 'http://stream.example/antenne.mp3',
    stream: { id: streamId, url: `http://127.0.0.1:7090/streams/4/${streamId}.mp3` },
    duration: 0,
    metadata: { title, artist: '', album: '', duration: 0, isRadio: true },
  }) as unknown as PlaybackSession;

/** The same stream once a duration has resolved: a track with a timeline, not a live broadcast. */
const makeTrackSession = (title: string, duration = 317, streamId = 'stream-1'): PlaybackSession =>
  ({
    source: 'tunein:station:abc',
    playbackSource: 'http://stream.example/antenne.mp3',
    stream: { id: streamId, url: `http://127.0.0.1:7090/streams/4/${streamId}.mp3` },
    duration,
    metadata: { title, artist: '', album: '', duration, isRadio: false },
  }) as unknown as PlaybackSession;

test('a renderer that never fetches the stream is re-armed, carrying the title it was owed', async () => {
  // The failure this reproduces: SetAVTransportURI is abandoned on its short window, Play lands on
  // a transport that was never armed, and the metadata re-push then arms it with no Play to follow.
  // The re-arm is the missing Play, and it folds the held title in rather than sending a bare URI.
  const fetchNeverArrives = deferred();
  const { output, cp, waitOptions } = makeOutput([fetchNeverArrives]);

  await output.play(makeSession(''));
  assert.equal(cp.setUriCalls.length, 1, 'the initial push');
  assert.ok(waitOptions[0]?.notBefore, 'the wait is scoped to this push, not a remembered one');

  // The station title resolves while the renderer is still (supposedly) starting.
  await output.updateMetadata(makeSession('ANTENNE BAYERN'));
  assert.equal(cp.metadataCalls.length, 0, 'nothing may touch the transport before the fetch');
  assert.equal(cp.setUriCalls.length, 1);

  fetchNeverArrives.settle(null);
  await flush();

  assert.equal(cp.setUriCalls.length, 2, 'the renderer is re-armed once');
  assert.match(cp.setUriCalls[1] ?? '', /ANTENNE BAYERN/, 'the re-arm carries the held title');
  assert.equal(cp.metadataCalls.length, 0, 'the re-arm replaces the held update, not doubles it');
});

test('a station title never reaches the transport of a renderer that is playing', async () => {
  // Issue #343, second report: the held title was released the instant the DIR-3100 connected,
  // and that SetAVTransportURI dropped it off the stream 60ms later. A live broadcast's title
  // buys a display line and is not worth a transport command.
  const fetchArrives = deferred();
  const { output, cp } = makeOutput([fetchArrives]);

  await output.play(makeSession(''));
  await output.updateMetadata(makeSession('ANTENNE BAYERN'));
  assert.equal(cp.metadataCalls.length, 0, 'held until the renderer proves it is playing');

  fetchArrives.settle({ zoneId: 4, streamId: 'stream-1', url: '/streams/4/current.mp3' });
  await flush();

  assert.equal(cp.setUriCalls.length, 1, 'a playing renderer is never restarted');
  assert.equal(cp.metadataCalls.length, 0, 'and a live station title never disturbs it');

  // Every later ICY title is the same decision, not just the one that was held.
  await output.updateMetadata(makeSession('Mike & The Mechanics - Over my shoulder'));
  assert.equal(cp.metadataCalls.length, 0);
  assert.equal(cp.setUriCalls.length, 1);
});

test('a duration resolving mid-track still flips the item to a real track', async () => {
  // The update the re-push exists for: the item stops being a duration-less audioBroadcast and
  // becomes a musicTrack with a progress bar. One push, and only one.
  const fetchArrives = deferred();
  const { output, cp } = makeOutput([fetchArrives]);

  await output.play(makeSession(''));
  fetchArrives.settle({ zoneId: 4, streamId: 'stream-1', url: '/streams/4/current.mp3' });
  await flush();

  await output.updateMetadata(makeTrackSession('Control'));
  assert.equal(cp.setUriCalls.length, 1, 'a playing renderer is never restarted');
  assert.equal(cp.metadataCalls.length, 1, 'the broadcast-to-track flip is pushed');
  assert.match(cp.metadataCalls[0] ?? '', /musicTrack/);
  assert.match(cp.metadataCalls[0] ?? '', /duration="00:05:17"/);

  // Once it is a track, a later title change is display-only again.
  await output.updateMetadata(makeTrackSession('Control (remaster)'));
  assert.equal(cp.metadataCalls.length, 1, 'no second push for a title alone');
});

test('a track pushed with its duration already known is never re-pushed', async () => {
  // Radio Paradise: title, artist and duration all resolve before play(), so the item starts as a
  // musicTrack. Nothing that arrives later may touch the transport.
  const fetchArrives = deferred();
  const { output, cp } = makeOutput([fetchArrives]);

  await output.play(makeTrackSession('Control'));
  fetchArrives.settle({ zoneId: 4, streamId: 'stream-1', url: '/streams/4/current.mp3' });
  await flush();

  await output.updateMetadata(makeTrackSession('Control', 318));
  assert.equal(cp.setUriCalls.length, 1);
  assert.equal(cp.metadataCalls.length, 0);
});

test('a check left behind by the previous track re-arms nothing', async () => {
  // The readiness check outlives its own track by the length of the grace window; it must not
  // resurrect a URI the zone has already replaced.
  const firstFetch = deferred();
  const secondFetch = deferred();
  const { output, cp } = makeOutput([firstFetch, secondFetch]);

  await output.play(makeSession(''));
  await output.play(makeSession('next track', 'stream-2'));
  assert.equal(cp.setUriCalls.length, 2, 'each track pushes once');

  firstFetch.settle(null);
  await flush();
  assert.equal(cp.setUriCalls.length, 2, 'the stale check re-arms nothing');
});

// Pause is optional in AVTransport. A renderer that refused it kept playing while the zone
// showed paused.
test('a renderer that refuses pause is stopped instead', async () => {
  const { output } = makeOutput([]);
  const calls: string[] = [];
  const transport = (output as unknown as { cp: Record<string, unknown> }).cp;
  transport.pause = async () => {
    calls.push('pause');
    return false;
  };
  transport.stop = async () => {
    calls.push('stop');
    return true;
  };
  await output.pause({ playbackSource: { kind: 'pipe' } } as never);
  assert.deepEqual(calls, ['pause', 'stop']);

  calls.length = 0;
  transport.pause = async () => {
    calls.push('pause');
    return true;
  };
  await output.pause({ playbackSource: { kind: 'pipe' } } as never);
  assert.deepEqual(calls, ['pause'], 'a renderer that pauses is left paused');
});
