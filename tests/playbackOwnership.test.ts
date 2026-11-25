import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  captureOwnershipEpoch,
  localAdvanceBlocked,
  ownershipMoved,
  resumeLocalOwnership,
  yieldLocalOwnership,
} from '../src/application/zones/playback/playbackOwnership';
import { executePlaybackPlan } from '../src/application/playback/executePlaybackPlan';
import { handleEndOfTrack, stepQueueAsync } from '../src/application/zones/playback/queueTransitions';
import { QueueAdvanceController } from '../src/application/zones/playback/queueAdvanceController';

// A zone that follows an outside player keeps its queue but must not walk it: measured, a queue
// advance claimed a Sonos speaker two minutes after the zone had yielded to a Spotify session
// that had been started elsewhere. These pin the two halves of that - the queue held back, and
// work already in flight abandoned rather than landing on the speaker.

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  spam: () => undefined,
} as any;

const prefs = {
  setPreferredOutputSettings: () => undefined,
  setHttpPreferences: () => undefined,
  setInputPreferences: () => undefined,
} as any;

const spotifyPlan = {
  zoneId: 2,
  zoneName: 'Wohnzimmer',
  audiopath: 'spotify:track:5A5ptPyLHVFWPMXD7r38yP',
  kind: 'queue',
  isRadio: false,
  provider: null,
  playExternalLabel: 'spotify',
  needsStreamResolution: true,
  metadata: { title: 'A track', artist: 'An artist', album: '' },
  preferredSettings: {},
} as any;

test('yielding holds the queue back and invalidates work in flight', () => {
  const ctx: any = { playbackEpoch: 3 };

  const epoch = captureOwnershipEpoch(ctx);
  assert.equal(ownershipMoved(ctx, epoch), false, 'nothing moved yet');

  yieldLocalOwnership(ctx);
  assert.equal(localAdvanceBlocked(ctx), true, 'the queue is held back');
  assert.equal(ownershipMoved(ctx, epoch), true, 'work that began before the yield knows it is stale');

  resumeLocalOwnership(ctx);
  assert.equal(localAdvanceBlocked(ctx), false, 'an explicit command takes the queue back');
});

test('a held-back queue does not advance when a track ends', async () => {
  let started = 0;
  const controller = new QueueAdvanceController({
    log: silentLog,
    startQueuePlayback: async () => {
      started += 1;
      return null;
    },
  } as any);
  const ctx: any = {
    id: 2,
    queueSuspended: true,
    playbackEpoch: 1,
    queueController: { current: () => ({ audiopath: 'spotify:track:1' }) },
    state: { audiopath: 'spotify:track:1' },
    queue: { items: [{ audiopath: 'spotify:track:1' }], authority: 'local' },
  };

  await controller.advanceTrack(ctx);
  assert.equal(started, 0, 'nothing was started');
});

test('the end-of-track transition is refused while the queue is held back', async () => {
  let started = 0;
  const coordinator: any = {
    startQueuePlayback: async () => {
      started += 1;
      return null;
    },
    isLocalQueueAuthority: () => true,
  };
  const ctx: any = {
    id: 2,
    queueSuspended: true,
    queue: { items: [{ audiopath: 'spotify:track:1' }], authority: 'local' },
  };

  await handleEndOfTrack({ coordinator, ctx });
  assert.equal(started, 0, 'a queue nobody hears is not advanced');
});

test('an explicit queue step takes the queue back and plays it', async () => {
  const started: string[] = [];
  const ctx: any = {
    id: 2,
    queueSuspended: true,
    queue: { items: [{ audiopath: 'spotify:track:9', title: 'A track' }], authority: 'local' },
    queueController: {
      step: () => 0,
      current: () => ({ audiopath: 'spotify:track:9', title: 'A track', artist: '', album: '' }),
    },
  };
  const coordinator: any = {
    getZone: () => ctx,
    startQueuePlayback: async (_ctx: any, audiopath: string) => {
      started.push(audiopath);
      return null;
    },
    prefetchPlaybackSource: () => undefined,
    applyPatch: () => undefined,
    dispatchOutputs: () => undefined,
    recentsRecord: async () => undefined,
    audioHelpers: { isRadioAudiopath: () => false },
    isLocalQueueAuthority: () => true,
  };

  await stepQueueAsync({ coordinator, zoneId: 2, delta: 1 });
  assert.equal(ctx.queueSuspended, false, 'an explicit step resumes the queue');
  assert.deepEqual(started, ['spotify:track:9']);
});

function spotifyStartHarness(options: { handOverDuringResolve: boolean }) {
  const played: unknown[] = [];
  const stopped: string[] = [];
  const ctx: any = {
    id: 2,
    playbackEpoch: 0,
    queue: { items: [] },
    queueController: { currentIndex: () => 0, current: () => null },
    player: {
      playExternal: (...args: unknown[]) => {
        played.push(args);
        return null;
      },
    },
  };
  const inputs: any = {
    getPlaybackSourceForUri: async () => {
      if (options.handOverDuringResolve) {
        ctx.playbackEpoch += 1;
      }
      return { kind: 'pipe', path: '/run/soloist' };
    },
    stopSpotifySession: (_zoneId: number, reason: string) => stopped.push(reason),
  };
  const run = () =>
    executePlaybackPlan({
      ctx,
      plan: spotifyPlan,
      content: { resolvePlaybackSource: async () => ({ playbackSource: null }) } as any,
      inputs,
      log: silentLog,
      zoneAudioPrefs: prefs,
    });
  return { run, played, stopped };
}

test('a start handed to another player mid-resolve is abandoned', async () => {
  const { run, played, stopped } = spotifyStartHarness({ handOverDuringResolve: true });

  assert.equal(await run(), null);
  assert.deepEqual(played, [], 'nothing was handed to the speaker');
  assert.deepEqual(stopped, ['ownership_changed'], 'the run that had started was let go');
});

test('a start nobody interrupted is played, as before', async () => {
  const { run, played, stopped } = spotifyStartHarness({ handOverDuringResolve: false });

  assert.equal(await run(), null, 'the harness player returns no session');
  assert.equal(played.length, 1, 'the source reached the player');
  assert.deepEqual(stopped, []);
});
