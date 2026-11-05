import assert from 'node:assert/strict';
import { test } from './testHarness';
import { EventType, PlayerState } from '@sonn-audio/node-slimproto';
import { createSqueezeliteGroupController } from '../src/application/outputs/squeezeliteGroupController';
import { getGroupByZone, removeGroupByLeader, upsertGroup } from '../src/application/groups/groupTracker';
import { SqueezeliteOutput } from '../src/adapters/outputs/squeezelite/squeezeliteOutput';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

// Pausing one member of a squeezelite sync-group (#409). The member's pause used to ask
// the whole group to pause, which silenced the leader while its session ran on; and a
// member that did end up paused was unpaused again by the next coordinated start at the
// following track. A member paused on its own now stays paused, the rest play on, and it
// rejoins when it is played again.

const LEADER = 21;
const MEMBER = 22;

type FakePlayer = ReturnType<typeof fakePlayer>;

function fakePlayer(playerId: string) {
  const calls = { play: [] as string[], pause: 0, stop: 0, unpauseAt: 0 };
  const player = {
    playerId,
    name: playerId,
    connected: true,
    state: PlayerState.PLAYING as PlayerState,
    jiffies: 1000,
    elapsedMilliseconds: 0,
    clockSync: { rttMs: 4, jiffies: 1000, serverTimeMs: Date.now() },
    playUrl: async (url: string) => {
      calls.play.push(url);
      player.state = PlayerState.BUFFER_READY;
    },
    pause: async () => {
      calls.pause += 1;
      player.state = PlayerState.PAUSED;
    },
    stop: async () => {
      calls.stop += 1;
      player.state = PlayerState.STOPPED;
    },
    play: async () => undefined,
    requestClockSync: async () => true,
    estimateJiffiesAt: (ms: number) => ms,
    unpauseAt: async () => {
      calls.unpauseAt += 1;
      player.state = PlayerState.PLAYING;
    },
  };
  return { player, calls };
}

function harness() {
  const controller = createSqueezeliteGroupController();
  const leader = fakePlayer('aa:aa:aa:aa:aa:01');
  const member = fakePlayer('aa:aa:aa:aa:aa:02');
  const players = [leader.player, member.player];
  const leaderSession = {
    zoneId: LEADER,
    state: 'playing',
    playbackSource: { url: 'http://example/stream.flac' },
    source: 'spotify:track:1',
    stream: { id: 's1', coverUrl: '', url: `/streams/${LEADER}/current.flac` },
    metadata: { title: 'Song', artist: 'Artist', album: 'Album' },
  } as unknown as PlaybackSession & { state: string };

  upsertGroup({
    leader: LEADER,
    members: [LEADER, MEMBER],
    backend: 'Unknown',
    source: 'manual',
    externalId: 'grp-409',
  });

  const ports = {
    audioManager: {
      getSession: (zoneId: number) => (zoneId === LEADER ? leaderSession : undefined),
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
      subscribe: (_fn: (event: { type: EventType; playerId: string }) => void) => () => undefined,
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

  const leaderOutput = new SqueezeliteOutput(LEADER, 'Living', { playerId: leader.player.playerId }, ports);
  const memberOutput = new SqueezeliteOutput(MEMBER, 'Kitchen', { playerId: member.player.playerId }, ports);
  const dispose = () => {
    leaderOutput.dispose();
    memberOutput.dispose();
    removeGroupByLeader(LEADER);
  };
  return { controller, leader, member, leaderOutput, memberOutput, leaderSession, dispose };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function reset(...fakes: FakePlayer[]): void {
  for (const fake of fakes) {
    fake.calls.play.length = 0;
    fake.calls.pause = 0;
    fake.calls.stop = 0;
    fake.calls.unpauseAt = 0;
  }
}

test('pausing one member of a squeezelite group leaves the leader playing', async () => {
  const h = harness();
  try {
    await h.memberOutput.pause(null);
    assert.equal(h.member.calls.pause, 1, 'the member paused');
    assert.equal(h.leader.calls.pause, 0, 'the leader did not');
    assert.equal(h.controller.isMemberHeld(MEMBER), true);
  } finally {
    h.dispose();
  }
});

test('the next track does not unpause a member that was paused on its own', async () => {
  const h = harness();
  try {
    await h.memberOutput.pause(null);
    reset(h.leader, h.member);

    // Track change: only the leader gets the new session.
    await h.leaderOutput.play(h.leaderSession);
    await settle();

    assert.equal(h.member.calls.play.length, 0, 'no stream for the paused member');
    assert.equal(h.member.calls.unpauseAt, 0, 'and no coordinated unpause');
    assert.equal(h.member.player.state, PlayerState.PAUSED);
    assert.equal(h.leader.calls.play.length, 1, 'the leader plays the next track');
    assert.doesNotMatch(h.leader.calls.play[0]!, /expect=2/, 'without waiting for the member');
  } finally {
    h.dispose();
  }
});

test('playing the member again brings it back into the group', async () => {
  const h = harness();
  try {
    await h.memberOutput.pause(null);
    reset(h.leader, h.member);

    await h.memberOutput.resume(null);
    await settle();

    assert.equal(h.controller.isMemberHeld(MEMBER), false);
    assert.equal(h.member.calls.play.length, 1, 'the member opens the shared stream');
    assert.equal(h.leader.calls.play.length, 1, 'restarted with the leader, from one byte');
    assert.match(h.member.calls.play[0]!, /expect=2/);
    assert.equal(h.member.calls.unpauseAt, 1, 'started together');
    assert.equal(h.leader.calls.unpauseAt, 1);
  } finally {
    h.dispose();
  }
});

test('a member pause while the whole group is paused is not a hold', async () => {
  // The grouped pause sends pause to the leader first and then to each member. That is
  // the group pausing, not a member stepping out, so the group play brings all back.
  const h = harness();
  try {
    (h.leaderSession as { state: string }).state = 'paused';
    await h.memberOutput.pause(null);
    assert.equal(h.controller.isMemberHeld(MEMBER), false);
  } finally {
    h.dispose();
  }
});
