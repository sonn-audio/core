import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ExternalStateRouter } from '../src/application/zones/state/ExternalStateRouter';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { createLogger } from '../src/shared/logging/logger';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { PlaybackSession } from '../src/ports/types/playback';

type RouterFakes = {
  zones: ZoneRepository;
  applied: Array<{ zoneId: number; patch: Partial<ZoneState>; force?: boolean }>;
  notifiedQueue: Array<{ zoneId: number; queueSize: number }>;
  sessions: Map<number, PlaybackSession>;
  activeLocal: Set<number>;
  stopCalls: number[];
  setItems: Array<{ zoneId: number; items: unknown[]; index: number }>;
};

function buildRouter(opts: { controller?: string } = {}): { router: ExternalStateRouter; fakes: RouterFakes } {
  const zones = new ZoneRepository();
  const fakes: RouterFakes = {
    zones,
    applied: [],
    notifiedQueue: [],
    sessions: new Map(),
    activeLocal: new Set(),
    stopCalls: [],
    setItems: [],
  };
  const ctx = {
    id: 1,
    config: { state: { controller: opts.controller } },
    queueController: {
      setItems: (items: unknown[], index: number) => {
        fakes.setItems.push({ zoneId: 1, items, index });
      },
    },
  } as unknown as ZoneContext;
  zones.set(1, ctx);
  const router = new ExternalStateRouter({
    zones,
    audioManager: {
      hasActiveLocalSession: (zoneId) => fakes.activeLocal.has(zoneId),
      getSession: (zoneId) => fakes.sessions.get(zoneId) ?? null,
      stopPlayback: (zoneId) => {
        fakes.stopCalls.push(zoneId);
        fakes.sessions.delete(zoneId);
        return null;
      },
    },
    applyPatch: (zoneId, patch, force) => {
      fakes.applied.push({ zoneId, patch, force });
    },
    notifyQueueUpdated: (zoneId, queueSize) => {
      fakes.notifiedQueue.push({ zoneId, queueSize });
    },
    yieldToExternalSource: () => false,
    log: createLogger('Test', 'ExternalStateRouter'),
  });
  return { router, fakes };
}

test('ExternalStateRouter onStatePatch ignores unknown zones', () => {
  const { router, fakes } = buildRouter();
  router.onStatePatch(999, { volume: 50 });
  assert.equal(fakes.applied.length, 0);
});

test('ExternalStateRouter onStatePatch applies internal-controller patches unfiltered', () => {
  const { router, fakes } = buildRouter({ controller: 'internal' });
  router.onStatePatch(1, { volume: 50, mode: 'play' });
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, { volume: 50, mode: 'play' });
});

test('ExternalStateRouter onStatePatch defaults to internal when controller is missing', () => {
  const { router, fakes } = buildRouter();
  router.onStatePatch(1, { volume: 33 });
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, { volume: 33 });
});

test('ExternalStateRouter onStatePatch strips only time/duration while local session active (beolink)', () => {
  // Post-43fb740 behaviour: state controllers are the source of truth for what
  // the speaker is doing, so patches flow through during a local session — with
  // the single exception of time/duration (some controllers, notably MA, report
  // jittery position for our own HTTP-stream content; the local ticker stays
  // authoritative there).
  const { router, fakes } = buildRouter({ controller: 'beolink' });
  fakes.activeLocal.add(1);
  router.onStatePatch(1, { volume: 42, mode: 'play', title: 'Foreign', time: 9, duration: 180 });
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, { volume: 42, mode: 'play', title: 'Foreign' });
});

test('ExternalStateRouter onStatePatch drops time-/duration-only patches while local session active', () => {
  // After stripping the only fields a local session owns, the patch is empty
  // and must not be applied at all (avoids no-op broadcasts).
  const { router, fakes } = buildRouter({ controller: 'beolink' });
  fakes.activeLocal.add(1);
  router.onStatePatch(1, { time: 9, duration: 180 });
  assert.equal(fakes.applied.length, 0);
});

test('ExternalStateRouter onStatePatch clears stale session before external authority takes over', () => {
  const { router, fakes } = buildRouter({ controller: 'beolink' });
  fakes.sessions.set(1, { state: 'stopped' } as PlaybackSession);
  router.onStatePatch(1, { volume: 70, mode: 'stop' });
  assert.deepEqual(fakes.stopCalls, [1]);
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, { volume: 70, mode: 'stop' });
});

test('ExternalStateRouter onStatePatch keeps a paused session when the speaker reports it stopped', () => {
  // Issue #345: Sonos does not pause our length-less HTTP stream, it drops it and reports
  // STOPPED. Treating that echo as a stale session tore down the engine, which left the zone
  // with nothing to resume and deflected the follow-up play to the state controller.
  const { router, fakes } = buildRouter({ controller: 'sonos' });
  fakes.sessions.set(1, { state: 'paused', playbackSource: { kind: 'file' } } as PlaybackSession);
  router.onStatePatch(1, { mode: 'stop', title: 'Our track', time: 0, duration: 296 });
  assert.deepEqual(fakes.stopCalls, [], 'the session is the resume point and must survive');
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(
    fakes.applied[0]?.patch,
    { title: 'Our track' },
    'local state stays authoritative for mode/time/duration of our own content',
  );
});

test('ExternalStateRouter onStatePatch drops a paused session once the speaker plays something else', () => {
  const { router, fakes } = buildRouter({ controller: 'sonos' });
  fakes.sessions.set(1, { state: 'paused', playbackSource: { kind: 'file' } } as PlaybackSession);
  router.onStatePatch(1, { mode: 'play', title: 'Foreign' });
  assert.deepEqual(fakes.stopCalls, [1], 'a real external takeover still clears the session');
  assert.deepEqual(fakes.applied[0]?.patch, { mode: 'play', title: 'Foreign' });
});

test('ExternalStateRouter onStatePatch still clears a paused output-only session', () => {
  // No playbackSource means no engine and no resume point, so there is nothing to protect.
  const { router, fakes } = buildRouter({ controller: 'sonos' });
  fakes.sessions.set(1, { state: 'paused', playbackSource: null } as PlaybackSession);
  router.onStatePatch(1, { mode: 'stop' });
  assert.deepEqual(fakes.stopCalls, [1]);
});

test('ExternalStateRouter onStatePatch drops mode-only echoes for a paused session', () => {
  const { router, fakes } = buildRouter({ controller: 'sonos' });
  fakes.sessions.set(1, { state: 'paused', playbackSource: { kind: 'file' } } as PlaybackSession);
  router.onStatePatch(1, { mode: 'stop' });
  assert.equal(fakes.applied.length, 0, 'nothing is left to apply, so no broadcast');
});

test('ExternalStateRouter onStatePatch applies fully when no local session and no stale session', () => {
  const { router, fakes } = buildRouter({ controller: 'beolink' });
  router.onStatePatch(1, { volume: 70, mode: 'play' });
  assert.deepEqual(fakes.stopCalls, []);
  assert.equal(fakes.applied.length, 1);
});

test('ExternalStateRouter onStatePatch lets MA metadata propagate during local session', () => {
  // Same rule for MA: title/album/cover changes from the external speaker
  // (e.g. an AirPlay takeover that MA mirrors back) must surface in Loxone.
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  fakes.activeLocal.add(1);
  router.onStatePatch(1, { volume: 25, mode: 'pause', title: 'External', time: 12 });
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, { volume: 25, mode: 'pause', title: 'External' });
});

test('ExternalStateRouter onQueueMirror skips unknown zones', () => {
  const { router, fakes } = buildRouter();
  router.onQueueMirror(999, [], 0);
  assert.equal(fakes.setItems.length, 0);
  assert.equal(fakes.notifiedQueue.length, 0);
});

test('ExternalStateRouter onQueueMirror skips when local session is active', () => {
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  fakes.activeLocal.add(1);
  router.onQueueMirror(1, [{ audiopath: 'x', unique_id: 'a' } as never], 0);
  assert.equal(fakes.setItems.length, 0);
  assert.equal(fakes.notifiedQueue.length, 0);
});

test('ExternalStateRouter onQueueMirror writes items, patches zone, notifies queue size', () => {
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  const items = [
    { audiopath: 'a', unique_id: 'u1' },
    { audiopath: 'b', unique_id: 'u2' },
  ];
  router.onQueueMirror(1, items as never, 1);
  assert.equal(fakes.setItems.length, 1);
  assert.equal(fakes.setItems[0]?.index, 1);
  assert.equal(fakes.applied.length, 1);
  assert.deepEqual(fakes.applied[0]?.patch, {
    audiopath: 'b',
    audiotype: 2,
    qindex: 1,
    qid: 'u2',
    queueAuthority: 'local',
  });
  assert.deepEqual(fakes.notifiedQueue, [{ zoneId: 1, queueSize: 2 }]);
});

test('ExternalStateRouter onQueueMirror clamps out-of-range index to last item', () => {
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  const items = [{ audiopath: 'only', unique_id: 'u' }];
  router.onQueueMirror(1, items as never, 99);
  assert.equal(fakes.setItems[0]?.index, 0);
  assert.equal(fakes.applied[0]?.patch.qindex, 0);
});

test('ExternalStateRouter onQueueMirror clamps negative index to zero', () => {
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  const items = [{ audiopath: 'a', unique_id: 'u' }];
  router.onQueueMirror(1, items as never, -5);
  assert.equal(fakes.setItems[0]?.index, 0);
});

test('ExternalStateRouter onQueueMirror notifies size 0 without applying state-patch when empty', () => {
  const { router, fakes } = buildRouter({ controller: 'musicassistant' });
  router.onQueueMirror(1, [], 0);
  assert.equal(fakes.applied.length, 0);
  assert.deepEqual(fakes.notifiedQueue, [{ zoneId: 1, queueSize: 0 }]);
});
