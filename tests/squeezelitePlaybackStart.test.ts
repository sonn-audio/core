import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SqueezeliteOutput } from '../src/adapters/outputs/squeezelite/squeezeliteOutput';
import { EventType, PlayerState } from '@sonn-audio/node-slimproto';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

// A doorbell over music put a Squeezelite room at bell volume before the bell could be
// heard (#359). The player flushes, reconnects and refills its buffer before the alert
// plays, and the server cannot know how long that takes — but the player says when it
// has started. These cases pin that report down: the start of *this* stream, not
// anything the player said before it was handed over.

const PLAYER_ID = 'aa:bb:cc:dd:ee:01';
const ZONE = 4;

function harness() {
  let state = PlayerState.PLAYING;
  let listener: ((event: { type: EventType; playerId: string }) => void) | null = null;
  const fire = (type: EventType) => listener?.({ type, playerId: PLAYER_ID });

  const player = {
    playerId: PLAYER_ID,
    name: 'Kitchen',
    connected: true,
    supportedCodecs: ['flc'],
    get state() {
      return state;
    },
    playUrl: async () => {
      // As the SlimProto client does: it announces the new media while the player is
      // still on the old stream, and only then marks itself buffering.
      fire(EventType.PLAYER_UPDATED);
      state = PlayerState.BUFFERING;
    },
    stop: async () => undefined,
    pause: async () => undefined,
    volumeSet: async () => undefined,
    power: async () => undefined,
  };

  const session = {
    state: 'playing',
    playbackSource: { kind: 'file', path: '/tmp/bell.mp3' },
    source: 'alerts://bell.mp3',
    stream: { id: 's1', url: '/streams/4/s1.flac', coverUrl: '' },
    metadata: { title: 'bell', artist: '', album: '' },
  } as unknown as PlaybackSession;

  const ports = {
    audioManager: { getSession: () => session, getOutputSettings: () => null },
    groupTracker: { getGroupByZone: () => null, onGroupChanged: () => () => undefined },
    squeezeliteCore: {
      getPlayer: () => player,
      players: [player],
      subscribe: (fn: (event: { type: EventType; playerId: string }) => void) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    },
    squeezeliteGroup: {
      register: () => undefined,
      unregister: () => undefined,
      isSyncGroup: () => false,
      preparePlayback: () => ({ grouped: false, expectedCount: 1, leaderZoneId: ZONE }),
      notifyPlaybackTick: () => undefined,
      notifyBufferReady: () => undefined,
      isMemberHeld: () => false,
      joinAlertSync: () => null,
      leaveAlertSync: () => undefined,
    },
    zoneAudioPrefs: {
      getEffectiveOutputSettings: () => ({ sampleRate: 44100, channels: 2, pcmBitDepth: 16 }),
    },
    outputHandlers: {
      onOutputState: () => undefined,
      onOutputError: () => undefined,
      onOutputTrackEnded: () => undefined,
    },
    config: { getConfig: () => ({}), getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }) },
    zoneManager: { getZoneState: () => ({ id: ZONE, volume: 40 }) },
  } as unknown as OutputPorts;

  const output = new SqueezeliteOutput(ZONE, 'Kitchen', { playerId: PLAYER_ID }, ports);
  return {
    output,
    session,
    fire,
    setState: (next: PlayerState) => {
      state = next;
    },
  };
}

test('squeezelite says the new stream started only when the player reports it playing (#359)', async () => {
  const { output, session, fire, setState } = harness();

  let started: boolean | undefined;
  const playing = output.play(session);
  // Asked the moment play was dispatched, as the alert does.
  void output.waitForPlaybackStart(5000).then((value) => {
    started = value;
  });
  await playing;
  await new Promise((resolve) => setImmediate(resolve));
  // The "playing" the player was in before the flush is the outgoing track, not the alert.
  assert.equal(started, undefined);

  // Still filling its buffer.
  fire(EventType.PLAYER_UPDATED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, undefined);

  // STMs: the alert's first sample is going out.
  setState(PlayerState.PLAYING);
  fire(EventType.PLAYER_UPDATED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);

  output.dispose();
});

test('squeezelite cannot vouch for a start the player never reports (#359)', async () => {
  const { output, session } = harness();

  const playing = output.play(session);
  const started = output.waitForPlaybackStart(20);
  await playing;
  assert.equal(await started, false);

  // Nothing was played since, so there is nothing left to wait for.
  assert.equal(await output.waitForPlaybackStart(5000), false);
  output.dispose();
});
