import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from './testHarness';
import { SoloistPlaybackService } from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * Connect playback is adopted, not started: the Spotify app takes a room and this server has to
 * notice and open a pipe for it. What is pinned here is the case where the labels are already
 * right and the audio is not — the room a listener sees playing the correct track, in silence.
 */

const ZONE = 5;
const URI = 'spotify:track:6tJCf88GUwcQzcSRu4gwfx';

function fakeConfigPort(): ConfigPort {
  return {
    getConfig: () => ({
      zones: [{ id: ZONE, name: 'Wohnzimmer' }],
      content: { spotify: { soloist: { apiKey: 'spak_test' } } },
    }),
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      mutate({});
    },
  } as unknown as ConfigPort;
}

type Internals = {
  runners: Map<number, Record<string, unknown>>;
  onEvent: (zoneId: number, event: Record<string, unknown>) => void;
  audio: { waitForSpec: (zoneId: number) => Promise<unknown> };
  openAudio: (zoneId: number) => { stream: Readable; source: unknown } | null;
  controller: Record<string, unknown>;
};

/**
 * A room the app owns, already labelled with the track it is meant to be playing. `stream` is what
 * says whether anything is actually carrying that track's audio.
 */
function connectedRunner(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: {},
    ws: { isActive: true, requestQueue: () => {} },
    owner: 'connect',
    track: null,
    currentUri: URI,
    currentTrack: { uri: URI },
    queue: { previous: [], upcoming: [] },
    stream: null,
    adopting: false,
    volume: null,
    volumeLatch: null,
    ...over,
  };
}

function serviceWithRunner(runner: Record<string, unknown>): {
  service: SoloistPlaybackService;
  internals: Internals;
  opened: () => number;
  started: () => number;
  releaseSpec: () => void;
} {
  const service = new SoloistPlaybackService(fakeConfigPort());
  const internals = service as unknown as Internals;
  internals.runners.set(ZONE, runner);

  let openedCount = 0;
  let startedCount = 0;
  let release = (): void => {};
  const specReached = new Promise<void>((resolve) => {
    release = resolve;
  });

  internals.audio = { waitForSpec: () => specReached };
  internals.openAudio = () => {
    openedCount += 1;
    return { stream: Readable.from([]), source: { kind: 'pipe' } };
  };
  internals.controller = {
    startPlayback: () => {
      startedCount += 1;
    },
    updateQueue: () => {},
    updateMetadata: () => {},
    updateTiming: () => {},
    pausePlayback: () => {},
    stopPlayback: () => {},
  };

  return {
    service,
    internals,
    opened: () => openedCount,
    started: () => startedCount,
    releaseSpec: release,
  };
}

const playing = { type: 'playback_state', status: 'playing', item: { uri: URI } };

test('a room told to play with nothing carrying it is taken over', async () => {
  // The uri never moves here — `track_changed` set it, or an adoption that has since lost its
  // stream did. Reading a repeat of the current track as "nothing to do" left the app with no way
  // to reach the room at all: pause was obeyed, every play, skip and seek came back as silence.
  const { internals, opened, started, releaseSpec } = serviceWithRunner(connectedRunner());

  internals.onEvent(ZONE, playing);
  releaseSpec();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(opened(), 1, 'the pipe is opened');
  assert.equal(started(), 1, 'and the zone is told to play');
});

test('a room already carrying its track is left alone', () => {
  // The ordinary case, and the reason the test above cannot simply adopt on every `playing`: the
  // app reports it for as long as the music runs, and a live stream must survive all of them.
  const stream = Readable.from([]);
  const { internals, opened } = serviceWithRunner(connectedRunner({ stream }));

  for (let i = 0; i < 5; i += 1) {
    internals.onEvent(ZONE, playing);
  }

  assert.equal(opened(), 0, 'nothing is reopened under a stream that is already there');
});

test('one takeover opens one stream, however many times it is announced', async () => {
  // Adoption waits for the player to say what it plays in, and `playing` keeps arriving while it
  // waits. Without a guard each one starts its own adoption and opens its own stream.
  const { internals, opened, started, releaseSpec } = serviceWithRunner(connectedRunner());

  for (let i = 0; i < 4; i += 1) {
    internals.onEvent(ZONE, playing);
  }
  releaseSpec();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(opened(), 1, 'one stream');
  assert.equal(started(), 1, 'one start');
});
