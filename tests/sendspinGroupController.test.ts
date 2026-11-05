import assert from 'node:assert/strict';
import { test } from './testHarness';
import { PlaybackStateType, sendspinCore } from '@sonn-audio/node-sendspin';
import {
  sendspinGroupController,
  type SendspinDeclaredFormat,
  type SendspinGroupParticipant,
} from '../src/application/outputs/sendspinGroupController';
import { removeGroupByLeader, upsertGroup } from '../src/application/groups/groupTracker';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';

// Grouping here is leader-centric: the leader keeps producing PCM and the controller mirrors
// its stream, metadata and frames onto the Sendspin clients of the member zones. That makes
// the module almost entirely bookkeeping — which is why it is worth pinning, since nothing
// about a wrong answer is loud. A frame sent to the wrong client is a room playing the wrong
// thing, and a frame not sent is a room that is simply silent.

// High ids so the process-wide group tracker and the controller singleton cannot collide with
// another test file's zones.
const LEADER = 901;
const MEMBER_A = 902;
const MEMBER_B = 903;

sendspinGroupController.initOnce({
  zoneManager: {
    getZoneState: (zoneId: number) => ({ id: zoneId, name: `Zone ${zoneId}` }),
  } as unknown as ZoneManagerFacade,
});

/** Every call the controller makes into sendspin, in order, as one timeline. */
type Timeline = Array<[string, ...unknown[]]>;

const CORE_METHODS = [
  'sendStreamStart',
  'sendStreamEnd',
  'endPlaybackStreams',
  'sendStreamClear',
  'sendPcmFrameToClient',
  'setClientMetadata',
  'setClientControllerState',
  'setClientPlaybackState',
] as const;

function recordCore(): { timeline: Timeline; restore: () => void } {
  const timeline: Timeline = [];
  const core = sendspinCore as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of CORE_METHODS) {
    saved.set(name, Object.getOwnPropertyDescriptor(core, name) ? core[name] : undefined);
    core[name] = (...args: unknown[]) => {
      timeline.push([name, ...args]);
    };
  }
  return {
    timeline,
    restore: () => {
      for (const name of CORE_METHODS) {
        const had = saved.get(name);
        if (had === undefined) delete core[name];
        else core[name] = had;
      }
    },
  };
}

function participant(
  clientId: string,
  options: {
    connected?: boolean;
    declared?: SendspinDeclaredFormat[];
    future?: Array<{ data: Buffer; timestampUs: number }>;
    onEnsureReady?: () => void;
    onEnsureGroupFormat?: () => void;
    throwOnClientId?: boolean;
  } = {},
): SendspinGroupParticipant {
  return {
    getClientId: () => {
      if (options.throwOnClientId) throw new Error('client gone');
      return clientId;
    },
    isClientConnected: () => options.connected !== false,
    getDeclaredFormats: () => options.declared ?? [],
    getFutureFrames: () => options.future ?? [],
    ensureClientReady: () => options.onEnsureReady?.(),
    ensureGroupFormat: () => options.onEnsureGroupFormat?.(),
  };
}

const group = (members: number[]) =>
  upsertGroup({ leader: LEADER, members: [LEADER, ...members], backend: 'Unknown', source: 'manual', externalId: 'g901' });

/** Lets the listener's async `syncNewMembers` finish before assertions. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function cleanup(): void {
  removeGroupByLeader(LEADER);
  for (const id of [LEADER, MEMBER_A, MEMBER_B]) sendspinGroupController.unregister(id);
}

test('a frame goes to every connected member and never back to the leader', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A, MEMBER_B]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    sendspinGroupController.register(MEMBER_B, participant('b'));
    await settle();
    rec.timeline.length = 0;

    sendspinGroupController.broadcastFrame(LEADER, { data: Buffer.from('pcm'), timestampUs: 7 });

    assert.deepEqual(
      rec.timeline.map(([name, clientId]) => [name, clientId]),
      [
        ['sendPcmFrameToClient', 'a'],
        ['sendPcmFrameToClient', 'b'],
      ],
      'the leader plays its own stream and must not be fed a copy of it',
    );
  } finally {
    rec.restore();
    cleanup();
  }
});

test('a member asking to broadcast does nothing', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    await settle();
    rec.timeline.length = 0;

    // Only the leader drives a group. A member that thinks it is one would otherwise mirror
    // its own audio onto the leader, which is two rooms playing over each other.
    sendspinGroupController.broadcastFrame(MEMBER_A, { data: Buffer.from('x'), timestampUs: 1 });
    sendspinGroupController.notifyStreamStart(MEMBER_A, { codec: 'pcm' } as never);

    assert.deepEqual(rec.timeline, []);
  } finally {
    rec.restore();
    cleanup();
  }
});

test('a disconnected member is woken rather than written to', async () => {
  const rec = recordCore();
  let woken = 0;
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(
      MEMBER_A,
      participant('a', { connected: false, onEnsureReady: () => (woken += 1) }),
    );
    await settle();
    rec.timeline.length = 0;

    sendspinGroupController.broadcastFrame(LEADER, { data: Buffer.from('x'), timestampUs: 1 });

    assert.deepEqual(rec.timeline, [], 'nothing is sent to a client that is not there');
    assert.equal(woken, 1, 'a latent client (Cast) is asked to come up so it can join');
  } finally {
    rec.restore();
    cleanup();
  }
});

test('one failing member does not cost the others their audio', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A, MEMBER_B]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a', { throwOnClientId: true }));
    sendspinGroupController.register(MEMBER_B, participant('b'));
    await settle();
    rec.timeline.length = 0;

    sendspinGroupController.broadcastFrame(LEADER, { data: Buffer.from('x'), timestampUs: 1 });

    assert.deepEqual(
      rec.timeline.map(([, clientId]) => clientId),
      ['b'],
      'the throwing member is skipped and the next one still gets the frame',
    );
  } finally {
    rec.restore();
    cleanup();
  }
});

test('a partial stream format is merged over the one before it', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    await settle();
    rec.timeline.length = 0;

    sendspinGroupController.notifyStreamStart(LEADER, {
      codec: 'pcm',
      sample_rate: 44100,
      channels: 2,
    } as never);
    // A later call that names only the rate must not drop the codec: a member told a rate and
    // no codec has nothing to decode with.
    sendspinGroupController.notifyStreamStart(LEADER, { sample_rate: 48000 } as never);

    assert.deepEqual(rec.timeline[1], [
      'sendStreamStart',
      'a',
      { codec: 'pcm', sample_rate: 48000, channels: 2 },
    ]);
  } finally {
    rec.restore();
    cleanup();
  }
});

test('the end of a stream is forgotten, so a later joiner is not started on a dead format', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    await settle();

    sendspinGroupController.notifyStreamStart(LEADER, { codec: 'pcm' } as never);
    sendspinGroupController.notifyStreamEnd(LEADER);
    rec.timeline.length = 0;

    // Re-announcing the group is what a late joiner looks like from here.
    group([MEMBER_A, MEMBER_B]);
    sendspinGroupController.register(MEMBER_B, participant('b'));
    group([MEMBER_A, MEMBER_B]);
    await settle();

    assert.equal(
      rec.timeline.filter(([name]) => name === 'sendStreamStart').length,
      0,
      'there is no live format to hand out once the stream has ended',
    );
  } finally {
    rec.restore();
    cleanup();
  }
});

test('a paused leader ends its members\' playback but leaves their artwork up', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    await settle();
    rec.timeline.length = 0;

    sendspinGroupController.notifyStreamPause(LEADER);

    // A role-less stream/end would end the artwork stream too, and an rc1 display clears its
    // image when that ends; the cover is only re-sent when it changes.
    assert.deepEqual(rec.timeline, [
      ['endPlaybackStreams', 'a'],
      ['sendStreamClear', 'a', ['player']],
    ]);
  } finally {
    rec.restore();
    cleanup();
  }
});

test('the leader rebuilds the shared format before any member is fed', async () => {
  const rec = recordCore();
  const order: string[] = [];
  try {
    group([]);
    sendspinGroupController.register(
      LEADER,
      participant('leader', {
        onEnsureGroupFormat: () => order.push('ensureGroupFormat'),
        // The audio a joiner is caught up with comes out of the *leader's* buffer, not its own:
        // it has none yet, and the point is to hand it what the room is already playing.
        future: [{ data: Buffer.from('pcm'), timestampUs: 99 }],
      }),
    );
    sendspinGroupController.notifyStreamStart(LEADER, { codec: 'flac' } as never);
    sendspinGroupController.broadcastMetadata(LEADER, { title: 'Song' } as never);
    sendspinGroupController.broadcastControllerState(LEADER, { volume: 40 } as never);
    sendspinGroupController.broadcastPlaybackState(LEADER, PlaybackStateType.PLAYING, 'g901', 'Kitchen');
    await settle();
    rec.timeline.length = 0;

    // A member joining is exactly when the live stream may be a codec it cannot play: the
    // format was negotiated for the leader alone. Rebuilding after feeding it would mean the
    // member decoded the wrong thing first, which is the mixed-codec break this guards.
    sendspinGroupController.register(MEMBER_A, participant('a'));
    group([MEMBER_A]);
    await settle();
    for (const [name, clientId] of rec.timeline) order.push(`${name}:${String(clientId)}`);

    assert.equal(order[0], 'ensureGroupFormat', 'the format is settled first');
    // The whole snapshot, in the order a joining client can act on it: a format to decode
    // with, then what is playing, then the audio, then the state that says it is running.
    assert.deepEqual(order.slice(1), [
      'sendStreamStart:a',
      'setClientMetadata:a',
      'setClientControllerState:a',
      'sendPcmFrameToClient:a',
      'setClientPlaybackState:a',
    ]);
  } finally {
    rec.restore();
    cleanup();
  }
});

test('losing the group stops each member and tells it so', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    await settle();
    rec.timeline.length = 0;

    removeGroupByLeader(LEADER);
    await settle();

    assert.deepEqual(rec.timeline, [
      ['sendStreamEnd', 'a'],
      ['sendStreamClear', 'a', ['player']],
      ['setClientPlaybackState', 'a', PlaybackStateType.STOPPED, 'g901', 'Zone 902'],
    ]);
  } finally {
    rec.restore();
    cleanup();
  }
});

test('only connected members declare a format, and the leader is not one of them', async () => {
  try {
    group([MEMBER_A, MEMBER_B]);
    sendspinGroupController.register(
      LEADER,
      participant('leader', { declared: [{ codec: 'flac' }] }),
    );
    sendspinGroupController.register(
      MEMBER_A,
      participant('a', { declared: [{ codec: 'pcm', sample_rate: 44100 }] }),
    );
    sendspinGroupController.register(MEMBER_B, participant('b', { connected: false }));
    await settle();

    // One list per member that could answer. The leader is excluded because it is the one
    // choosing; a disconnected member cannot be honoured, so it does not get a vote.
    assert.deepEqual(sendspinGroupController.getMemberDeclaredFormats(LEADER), [
      [{ codec: 'pcm', sample_rate: 44100 }],
    ]);
    // A zone that leads nobody is free to please itself.
    assert.deepEqual(sendspinGroupController.getMemberDeclaredFormats(MEMBER_A), []);
  } finally {
    cleanup();
  }
});

test('unregistering a zone stops it being mirrored to', async () => {
  const rec = recordCore();
  try {
    group([MEMBER_A, MEMBER_B]);
    sendspinGroupController.register(LEADER, participant('leader'));
    sendspinGroupController.register(MEMBER_A, participant('a'));
    sendspinGroupController.register(MEMBER_B, participant('b'));
    await settle();

    sendspinGroupController.unregister(MEMBER_A);
    rec.timeline.length = 0;
    sendspinGroupController.broadcastFrame(LEADER, { data: Buffer.from('x'), timestampUs: 1 });

    assert.deepEqual(
      rec.timeline.map(([, clientId]) => clientId),
      ['b'],
    );
  } finally {
    rec.restore();
    cleanup();
  }
});
