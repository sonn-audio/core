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
  // `flushed` says, per stream handed over, whether the player's buffer was emptied first.
  const calls = { play: [] as string[], flushed: [] as boolean[], pause: 0, stop: 0, unpauseAt: 0 };
  const player = {
    playerId,
    name: playerId,
    connected: true,
    state: PlayerState.PLAYING as PlayerState,
    jiffies: 1000,
    elapsedMilliseconds: 0,
    clockSync: { rttMs: 4, jiffies: 1000, serverTimeMs: Date.now() },
    playUrl: async (...args: unknown[]) => {
      calls.play.push(String(args[0]));
      calls.flushed.push(args[7] !== false);
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
    fake.calls.flushed.length = 0;
    fake.calls.pause = 0;
    fake.calls.stop = 0;
    fake.calls.unpauseAt = 0;
  }
}

test('pausing one member of a squeezelite group leaves the leader playing', async () => {
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
    assert.equal(h.member.calls.pause, 1, 'the member paused');
    assert.equal(h.leader.calls.pause, 0, 'the leader did not');
    assert.equal(h.controller.isMemberHeld(MEMBER), true);
    assert.equal(h.memberOutput.memberPause().isHeld(), true);
  } finally {
    h.dispose();
  }
});

test('a member pause does not ask the leader session whether it plays', async () => {
  // Whether the leader plays is the zone's call. A leader session caught between states
  // made the output fall through to the group pause and silence every room.
  const h = harness();
  try {
    (h.leaderSession as { state: string }).state = 'stopped';
    await h.memberOutput.memberPause().hold();
    assert.equal(h.leader.calls.pause, 0, 'the leader plays on');
    assert.equal(h.member.calls.pause, 1);
    assert.equal(h.controller.isMemberHeld(MEMBER), true);
  } finally {
    h.dispose();
  }
});

test('the next track does not unpause a member that was paused on its own', async () => {
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
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
    await h.memberOutput.memberPause().hold();
    reset(h.leader, h.member);

    await h.memberOutput.memberPause().release(true);
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

const syncIdOf = (url: string) => new URL(url).searchParams.get('sync');

test('a member played again after the next track joins that track, not the one it was paused on', async () => {
  // The member's player still held the track it was paused on. The rejoin handed every
  // player the leader's stream without a flush, which queues it behind what a player
  // holds: the member played the old track out, minutes behind, and the shared stream
  // underran for both rooms (#409).
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
    // The leader moves on to the next track while the member sits it out.
    (h.leaderSession as { stream: { id: string } }).stream.id = 's2';
    await h.leaderOutput.play(h.leaderSession);
    await settle();
    reset(h.leader, h.member);

    await h.memberOutput.memberPause().release(true);
    await settle();

    assert.equal(h.member.calls.play.length, 1);
    assert.equal(syncIdOf(h.member.calls.play[0]!)?.startsWith(`${LEADER}-s2`), true, 'the current track');
    assert.deepEqual(h.member.calls.flushed, [true], 'the track it was paused on is dropped');
    assert.deepEqual(h.leader.calls.flushed, [true], 'and the leader starts with it from one byte');
    assert.equal(h.member.calls.play[0], h.leader.calls.play[0], 'on one stream');
    assert.equal(h.member.calls.unpauseAt, 1, 'started together');
    assert.equal(h.leader.calls.unpauseAt, 1);
  } finally {
    h.dispose();
  }
});

test('a member played again within the same track restarts the group on a sync stream of its own', async () => {
  // The sync id was the leader's stream. Rejoining before the track changed asked for the
  // sync stream the group was already playing, and the server let each player join it
  // late, at whatever byte it connected on, instead of starting them all from one (#409).
  const h = harness();
  try {
    await h.leaderOutput.play(h.leaderSession);
    await settle();
    const running = syncIdOf(h.leader.calls.play[0]!);
    assert.match(h.leader.calls.play[0]!, /expect=2/, 'the group plays one sync stream');

    await h.memberOutput.memberPause().hold();
    reset(h.leader, h.member);
    await h.memberOutput.memberPause().release(true);
    await settle();

    assert.equal(h.member.calls.play.length, 1);
    assert.notEqual(syncIdOf(h.member.calls.play[0]!), running, 'not the running sync stream');
    assert.equal(h.member.calls.play[0], h.leader.calls.play[0], 'one new stream for both');
  } finally {
    h.dispose();
  }
});

test('a held member released while the leader has no stream to join drops its stale buffer', async () => {
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
    (h.leaderSession as { state: string }).state = 'paused';
    reset(h.leader, h.member);

    await h.memberOutput.memberPause().release(true);

    assert.equal(h.controller.isMemberHeld(MEMBER), false);
    assert.equal(h.member.calls.stop, 1, 'its stale buffer is dropped');
    assert.equal(h.member.calls.play.length, 0);
    assert.equal(h.leader.calls.play.length, 0, 'the leader is left alone');
  } finally {
    h.dispose();
  }
});

test('a pause reaching a member output is the group pausing, not a hold', async () => {
  // A member stepping out goes through `memberPause`; the plain pause is the group's.
  const h = harness();
  try {
    await h.memberOutput.pause(null);
    assert.equal(h.controller.isMemberHeld(MEMBER), false);
    assert.equal(h.leader.calls.pause, 1, 'the whole group paused');
    assert.equal(h.member.calls.pause, 1);
  } finally {
    h.dispose();
  }
});

test('pausing the whole group ends the hold and the group play brings the member back', async () => {
  // A held member used to sit out the group's next play after a pause of the whole group.
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
    reset(h.leader, h.member);

    await h.leaderOutput.pause(h.leaderSession);
    assert.equal(h.controller.isMemberHeld(MEMBER), false, 'the hold ended with the group pause');
    assert.equal(h.leader.calls.pause, 1);
    assert.equal(h.member.calls.stop, 1, 'its stale buffer was dropped, not unpaused later');
    reset(h.leader, h.member);

    await h.leaderOutput.resume(h.leaderSession);
    await settle();
    assert.equal(h.member.calls.play.length, 1, 'the member is in the group play');
    assert.equal(h.leader.calls.play.length, 1, 'restarted together, from one byte');
    assert.match(h.leader.calls.play[0]!, /expect=2/);
    assert.equal(h.member.calls.unpauseAt, 1);
    assert.equal(h.leader.calls.unpauseAt, 1);
  } finally {
    h.dispose();
  }
});

test('stopping the whole group ends the hold and the next play includes the member', async () => {
  const h = harness();
  try {
    await h.memberOutput.memberPause().hold();
    await h.leaderOutput.stop(h.leaderSession);
    assert.equal(h.controller.isMemberHeld(MEMBER), false);
    assert.equal(h.member.player.state, PlayerState.STOPPED);
    reset(h.leader, h.member);

    await h.leaderOutput.play(h.leaderSession);
    await settle();
    assert.equal(h.member.calls.play.length, 1, 'the member plays with the group again');
    assert.match(h.leader.calls.play[0]!, /expect=2/);
  } finally {
    h.dispose();
  }
});
