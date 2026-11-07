import assert from 'node:assert/strict';
import { test } from './testHarness';
import { EventType, PlayerState } from '@sonn-audio/node-slimproto';
import { createSqueezeliteGroupController } from '../src/application/outputs/squeezeliteGroupController';
import { getGroupByZone, removeGroupByLeader, upsertGroup } from '../src/application/groups/groupTracker';
import { SqueezeliteOutput } from '../src/adapters/outputs/squeezelite/squeezeliteOutput';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

// A doorbell rung in two Squeezelite rooms (#359) — the reporter's hall, which was playing
// music, and kitchen, which was off. Each room played the bell as a stream of its own, and
// two players never start their own streams together, so the rooms rang apart. They now
// share one stream and are unpaused together, the way a sync group plays music.

const HALL = 31;
const KITCHEN = 32;
const BATH = 33;

type Listener = (event: { type: EventType; playerId: string }) => void;

function fakePlayer(playerId: string, state: PlayerState) {
  const calls = {
    play: [] as Array<{ url: string; autostart: unknown; flush: unknown }>,
    stop: 0,
    unpauseAt: 0,
  };
  const player = {
    playerId,
    name: playerId,
    connected: true,
    supportedCodecs: ['flc'],
    state,
    jiffies: 1000,
    elapsedMilliseconds: 0,
    clockSync: { rttMs: 4, jiffies: 1000, serverTimeMs: Date.now() },
    playUrl: async (...args: unknown[]) => {
      calls.play.push({ url: String(args[0]), autostart: args[6], flush: args[7] });
      player.state = PlayerState.BUFFERING;
    },
    stop: async () => {
      calls.stop += 1;
      player.state = PlayerState.STOPPED;
    },
    pause: async () => {
      player.state = PlayerState.PAUSED;
    },
    volumeSet: async () => undefined,
    power: async () => undefined,
    requestClockSync: async () => true,
    estimateJiffiesAt: (ms: number) => ms,
    unpauseAt: async () => {
      calls.unpauseAt += 1;
    },
  };
  return { player, calls };
}

function alertSession(zoneId: number, extra: { duration?: number } = {}) {
  return {
    zoneId,
    state: 'playing',
    playbackSource: { kind: 'file', path: '/alerts/bell.mp3' },
    source: 'alerts://bell.mp3',
    stream: { id: `alert-${zoneId}`, coverUrl: '', url: `/streams/${zoneId}/alert-${zoneId}.flac` },
    metadata: {
      title: 'bell',
      artist: '',
      album: '',
      audiopath: 'alerts://bell.mp3',
      isAlert: true,
      duration: 'duration' in extra ? extra.duration : 5,
    },
  } as unknown as PlaybackSession;
}

function harness() {
  const controller = createSqueezeliteGroupController();
  const hall = fakePlayer('aa:aa:aa:aa:aa:31', PlayerState.PLAYING);
  const kitchen = fakePlayer('aa:aa:aa:aa:aa:32', PlayerState.STOPPED);
  const bath = fakePlayer('aa:aa:aa:aa:aa:33', PlayerState.STOPPED);
  const players = [hall.player, kitchen.player, bath.player];
  const listeners: Listener[] = [];
  const sessions = new Map<number, PlaybackSession>();

  const ports = {
    audioManager: {
      getSession: (zoneId: number) => sessions.get(zoneId) ?? null,
      getOutputSettings: () => null,
      startExternalPlayback: () => null,
    },
    groupTracker: {
      getGroupByZone: (zoneId: number) => getGroupByZone(zoneId),
      onGroupChanged: () => () => undefined,
      clearJoinedLeader: () => undefined,
    },
    squeezeliteCore: {
      getPlayer: (id: string) => players.find((p) => p.playerId === id) ?? null,
      players,
      waitForPlayer: async () => null,
      subscribe: (fn: Listener) => {
        listeners.push(fn);
        return () => undefined;
      },
    },
    squeezeliteGroup: controller,
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
      getSystemConfig: () => ({ audioserver: { ip: '10.0.0.2' } }),
    },
    zoneManager: { getZoneState: (zoneId: number) => ({ id: zoneId, volume: 40 }) },
  } as unknown as OutputPorts;

  const outputs = {
    hall: new SqueezeliteOutput(HALL, 'Hall', { playerId: hall.player.playerId }, ports),
    kitchen: new SqueezeliteOutput(KITCHEN, 'Kitchen', { playerId: kitchen.player.playerId }, ports),
    bath: new SqueezeliteOutput(BATH, 'Bath', { playerId: bath.player.playerId }, ports),
  };
  const fire = (playerId: string, type: EventType) => {
    for (const listener of listeners) listener({ type, playerId });
  };
  /** The player has filled its buffer, and says so. */
  const bufferReady = (fake: ReturnType<typeof fakePlayer>) => {
    fake.player.state = PlayerState.BUFFER_READY;
    fire(fake.player.playerId, EventType.PLAYER_BUFFER_READY);
  };
  /** The player has started, and says so. */
  const playing = (fake: ReturnType<typeof fakePlayer>) => {
    fake.player.state = PlayerState.PLAYING;
    fire(fake.player.playerId, EventType.PLAYER_UPDATED);
  };
  /** Start an alert on a zone, as the zone does: its session is current, then its output plays it. */
  const startAlert = (zoneId: number, output: SqueezeliteOutput, session = alertSession(zoneId)) => {
    sessions.set(zoneId, session);
    return { session, played: output.play(session) };
  };
  const dispose = () => {
    for (const output of Object.values(outputs)) output.dispose();
  };
  return { controller, hall, kitchen, bath, outputs, sessions, bufferReady, playing, startAlert, dispose };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('a bell rung in two squeezelite rooms plays as one stream they start together (#359)', async () => {
  const h = harness();
  try {
    assert.deepEqual(h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN]), [HALL, KITCHEN]);

    const hallAlert = h.startAlert(HALL, h.outputs.hall);
    const hallStarted = h.outputs.hall.waitForPlaybackStart(5000);
    await settle();
    // Nothing is handed out until the kitchen's alert has arrived as well.
    assert.equal(h.hall.calls.play.length, 0);

    const kitchenAlert = h.startAlert(KITCHEN, h.outputs.kitchen);
    const kitchenStarted = h.outputs.kitchen.waitForPlaybackStart(5000);
    await Promise.all([hallAlert.played, kitchenAlert.played]);

    // Both players get the hall's alert, from its first byte, and wait for the shared start.
    const [hallPlay] = h.hall.calls.play;
    const [kitchenPlay] = h.kitchen.calls.play;
    assert.ok(hallPlay && kitchenPlay);
    assert.equal(kitchenPlay.url, hallPlay.url, 'one stream for both rooms');
    const url = new URL(hallPlay.url);
    assert.equal(url.pathname, `/streams/${HALL}/alert-${HALL}.flac`);
    assert.equal(url.searchParams.get('expect'), '2');
    assert.equal(url.searchParams.get('prime'), '1');
    assert.match(url.searchParams.get('sync') ?? '', /^alert-/);
    assert.equal(hallPlay.autostart, false);
    assert.equal(kitchenPlay.autostart, false);
    assert.equal(hallPlay.flush, true, 'the hall drops its music first');

    // One full buffer is not enough: the rooms start together or not at all.
    h.bufferReady(h.hall);
    await settle();
    assert.equal(h.hall.calls.unpauseAt, 0);
    h.bufferReady(h.kitchen);
    await settle();
    assert.equal(h.hall.calls.unpauseAt, 1);
    assert.equal(h.kitchen.calls.unpauseAt, 1);

    // Each room reports its own start, which is what its bell volume waits for.
    h.playing(h.hall);
    h.playing(h.kitchen);
    assert.equal(await hallStarted, true);
    assert.equal(await kitchenStarted, true);
  } finally {
    h.dispose();
  }
});

test('an alert for one squeezelite room, or rooms of a sync group, plays as before (#359)', async () => {
  const h = harness();
  try {
    assert.deepEqual(h.outputs.hall.prepareSyncedAlert([HALL]), []);
    const { played } = h.startAlert(HALL, h.outputs.hall);
    await played;
    const url = new URL(h.hall.calls.play[0]!.url);
    assert.equal(url.searchParams.get('expect'), '1');
    assert.equal(h.hall.calls.play[0]!.autostart, true, 'it starts by itself as soon as it can');

    // The kitchen and bath are a group of the user's: its alert is the group's business, and
    // the hall alone has nobody to be in step with.
    upsertGroup({ leader: KITCHEN, members: [KITCHEN, BATH], backend: 'Unknown', source: 'manual', externalId: 'grp-359' });
    assert.deepEqual(h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN, BATH]), []);
  } finally {
    removeGroupByLeader(KITCHEN);
    h.dispose();
  }
});

test('a room whose alert stops early leaves the shared stream to the others (#359)', async () => {
  const h = harness();
  try {
    h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN, BATH]);
    const alerts = [
      h.startAlert(HALL, h.outputs.hall),
      h.startAlert(KITCHEN, h.outputs.kitchen),
      h.startAlert(BATH, h.outputs.bath),
    ];
    await Promise.all(alerts.map((alert) => alert.played));
    h.bufferReady(h.hall);
    h.bufferReady(h.kitchen);
    h.bufferReady(h.bath);
    await settle();
    assert.equal(h.kitchen.calls.unpauseAt, 1);

    // The kitchen is switched off mid-bell: only its own player stops.
    h.sessions.delete(KITCHEN);
    await h.outputs.kitchen.stop(null);
    assert.equal(h.kitchen.calls.stop, 1);
    assert.equal(h.hall.calls.stop, 0);
    assert.equal(h.bath.calls.stop, 0);

    // The hall, whose alert the stream is, ends its timed bell; the bath has it buffered
    // and ends on its own window, so it is not started over.
    h.sessions.delete(HALL);
    await h.outputs.hall.stop(null);
    await settle(400);
    assert.equal(h.bath.calls.play.length, 1);
    assert.equal(h.bath.calls.stop, 0);
  } finally {
    h.dispose();
  }
});

test('the others play the alarm by themselves when the room whose stream it is stops (#359)', async () => {
  const h = harness();
  try {
    h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN]);
    // A looping alarm has no end of its own.
    const hallAlert = h.startAlert(HALL, h.outputs.hall, alertSession(HALL, { duration: undefined }));
    const kitchenAlert = h.startAlert(KITCHEN, h.outputs.kitchen, alertSession(KITCHEN, { duration: undefined }));
    await Promise.all([hallAlert.played, kitchenAlert.played]);
    h.bufferReady(h.hall);
    h.bufferReady(h.kitchen);
    await settle();

    h.sessions.delete(HALL);
    await h.outputs.hall.stop(null);
    await settle(400);
    // The kitchen goes on with its own alarm, which has been running all along.
    assert.equal(h.kitchen.calls.play.length, 2);
    const url = new URL(h.kitchen.calls.play[1]!.url);
    assert.equal(url.pathname, `/streams/${KITCHEN}/alert-${KITCHEN}.flac`);
    assert.equal(url.searchParams.get('expect'), '1');
  } finally {
    h.dispose();
  }
});

test('a room switched off with the alert everywhere does not start the alarm by itself (#359)', async () => {
  const h = harness();
  try {
    h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN]);
    const hallAlert = h.startAlert(HALL, h.outputs.hall, alertSession(HALL, { duration: undefined }));
    const kitchenAlert = h.startAlert(KITCHEN, h.outputs.kitchen, alertSession(KITCHEN, { duration: undefined }));
    await Promise.all([hallAlert.played, kitchenAlert.played]);

    // Both stop a moment apart, the stream's own room first.
    h.sessions.delete(HALL);
    await h.outputs.hall.stop(null);
    h.sessions.delete(KITCHEN);
    await h.outputs.kitchen.stop(null);
    await settle(400);
    assert.equal(h.kitchen.calls.play.length, 1);
  } finally {
    h.dispose();
  }
});

test('a room whose bell had not started yet plays it by itself when the stream goes (#359)', async () => {
  const h = harness();
  try {
    h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN]);
    const hallAlert = h.startAlert(HALL, h.outputs.hall);
    const kitchenAlert = h.startAlert(KITCHEN, h.outputs.kitchen);
    await Promise.all([hallAlert.played, kitchenAlert.played]);

    // The hall is switched off before the players were ready: the kitchen has heard nothing.
    h.sessions.delete(HALL);
    await h.outputs.hall.stop(null);
    await settle(400);
    assert.equal(h.kitchen.calls.play.length, 2);
    assert.equal(new URL(h.kitchen.calls.play[1]!.url).pathname, `/streams/${KITCHEN}/alert-${KITCHEN}.flac`);
    h.bufferReady(h.kitchen);
    await settle();
    assert.equal(h.kitchen.calls.unpauseAt, 0, 'it starts by itself, not with a stream that is gone');
  } finally {
    h.dispose();
  }
});

test('a room left alone by a newer alert plays its alert by itself (#359)', async () => {
  const h = harness();
  try {
    h.outputs.hall.prepareSyncedAlert([HALL, KITCHEN]);
    // Before either arrived, the hall and bath are rung for something else.
    h.outputs.hall.prepareSyncedAlert([HALL, BATH]);
    const { played } = h.startAlert(KITCHEN, h.outputs.kitchen);
    await played;
    const url = new URL(h.kitchen.calls.play[0]!.url);
    assert.equal(url.pathname, `/streams/${KITCHEN}/alert-${KITCHEN}.flac`);
    assert.equal(url.searchParams.get('expect'), '1');
  } finally {
    h.dispose();
  }
});
