import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SqueezeliteOutput } from '../src/adapters/outputs/squeezelite/squeezeliteOutput';
import { EventType, PlayerState } from '@sonn-audio/node-slimproto';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

// A squeezelite client that drops and comes back left the server streaming into a socket
// nobody read: the session stayed alive, the zone still said `play`, and the returning
// client was never told to open a new stream — HELO carries no `strm s`, and one is only
// ever sent from playUrl. So the zone looked like it was playing and was silent.
//
// The LoxBerry Squeezelite Multi-Room plugin carries ~400 lines of "Save & Resume" to poke
// off → on → play for exactly this. sendspin already re-arms itself on reconnect
// (sendspinOutput.onIdentified); squeezelite only did so for grouped members, which is why
// it looked intermittent.

const PLAYER_ID = 'aa:bb:cc:dd:ee:ff';
const ZONE = 3;

type Harness = {
  output: SqueezeliteOutput;
  /** Fires the events a reconnect produces. */
  connect: () => void;
  disconnect: () => void;
  playCalls: string[];
  setPlayerState: (state: PlayerState) => void;
};

function harness(
  options: {
    sessionState?: 'playing' | 'paused' | 'stopped';
    hasSession?: boolean;
    hasSource?: boolean;
    group?: { leader: number; members: number[] } | null;
    playerState?: PlayerState;
  } = {},
): Harness {
  const {
    sessionState = 'playing',
    hasSession = true,
    hasSource = true,
    group = null,
    playerState = PlayerState.STOPPED,
  } = options;

  const playCalls: string[] = [];
  let currentPlayerState = playerState;
  let listener: ((event: { type: EventType; playerId: string }) => void) | null = null;

  const player = {
    playerId: PLAYER_ID,
    name: 'Kitchen',
    connected: true,
    get state() {
      return currentPlayerState;
    },
    playUrl: async (url: string) => {
      playCalls.push(url);
    },
    stop: async () => undefined,
    pause: async () => undefined,
    unpause: async () => undefined,
    volumeSet: async () => undefined,
    power: async () => undefined,
  };

  const session = hasSession
    ? ({
        state: sessionState,
        playbackSource: hasSource ? { url: 'http://example/stream.flac' } : null,
        source: 'library://track/9',
        stream: { coverUrl: '', url: 'http://example/stream.flac' },
        metadata: { title: 'Song', artist: 'Artist', album: 'Album' },
      } as unknown as PlaybackSession)
    : null;

  const ports = {
    audioManager: {
      getSession: () => session,
      getOutputSettings: () => null,
      startExternalPlayback: () => null,
    },
    groupTracker: {
      getGroupByZone: () => group,
      onGroupChanged: () => () => undefined,
    },
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
      // Every group in these cases is a plain squeezelite one.
      isSyncGroup: () => Boolean(group),
      preparePlayback: () => ({ grouped: false, expectedCount: 1, leaderZoneId: ZONE }),
      notifyPlaybackTick: () => undefined,
      orchestrateGroupPlayback: async () => true,
      orchestrateGroupEnqueue: async () => true,
      isMemberHeld: () => false,
    },
    zoneAudioPrefs: {
      getEffectiveOutputSettings: () => ({ sampleRate: 44100, channels: 2, pcmBitDepth: 16 }),
    },
    outputHandlers: {
      onOutputState: () => undefined,
      onOutputError: () => undefined,
      onOutputTrackEnded: () => undefined,
    },
    config: {
      getConfig: () => ({}),
      getSystemConfig: () => ({ audioserver: {} }),
    },
    zoneManager: { getZoneState: () => ({ id: ZONE, volume: 40 }) },
  } as unknown as OutputPorts;

  const output = new SqueezeliteOutput(ZONE, 'Kitchen', { playerId: PLAYER_ID }, ports);

  const fire = (type: EventType) => listener?.({ type, playerId: PLAYER_ID });
  return {
    output,
    // A reconnect really does surface as two events, which is what the debounce is for.
    connect: () => {
      fire(EventType.PLAYER_CONNECTED);
      fire(EventType.PLAYER_NAME_RECEIVED);
    },
    disconnect: () => fire(EventType.PLAYER_DISCONNECTED),
    playCalls,
    setPlayerState: (state) => {
      currentPlayerState = state;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a player that reconnects while its zone is playing gets the stream back', async () => {
  const h = harness({ sessionState: 'playing' });
  h.disconnect();
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 1, 'exactly one stream started');
  assert.match(h.playCalls[0]!, /^http/, 'a real stream url');
});

test('several events from one reconnect start only one stream', async () => {
  // PLAYER_CONNECTED plus a name arrive together, and a flapping client sends more. Without
  // debouncing, each one would start another stream on the same player.
  const h = harness();
  h.connect();
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 1);
});

test('a zone that was not playing is left alone', async () => {
  // The whole point is to restore what was interrupted, not to start music nobody asked for.
  for (const state of ['paused', 'stopped'] as const) {
    const h = harness({ sessionState: state });
    h.connect();
    await settle();
    assert.equal(h.playCalls.length, 0, state);
  }
});

test('a zone with no session at all is left alone', async () => {
  const h = harness({ hasSession: false });
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 0);
});

test('a session without a playback source is not restarted', async () => {
  // play() would reject it anyway and report an output error; not worth the noise.
  const h = harness({ hasSource: false });
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 0);
});

test('a client that resumed on its own is not restarted underneath it', async () => {
  const h = harness({ playerState: PlayerState.PLAYING });
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 0, 'already playing; leave it');
});

test('a grouped member is left to rejoin its leader instead', async () => {
  // Group members must rejoin the leader's byte stream rather than start their own, which
  // is maybeJoinLeader's job — doing both would fight over the same player.
  const h = harness({ group: { leader: 7, members: [7, ZONE] } });
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 0);
});

test('a group leader still restarts its own stream', async () => {
  // The leader is not a member rejoining anything: if it went away while playing, the
  // group has no source at all until it comes back.
  const h = harness({ group: { leader: ZONE, members: [ZONE, 7] } });
  h.connect();
  await settle();
  assert.equal(h.playCalls.length, 1);
});
