import assert from 'node:assert/strict';
import { test } from './testHarness';
import { handleZoneCommand } from '../src/application/zones/playback/commandHandlers';
import { applyZonePatch } from '../src/domain/zones/reducer';
import { buildInitialState, clampVolumeForZone } from '../src/application/zones/helpers/stateHelpers';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ZoneConfig } from '../src/domain/config/types';

// A volume step on a paused zone starts it playing again — verified against a real Loxone
// Audioserver, and what both the app's volume buttons and a T5 single click depend on (#381).
// The Miniserver sends nothing but the volume step, so the resume has to happen here or the
// room stays silent.

const zoneConfig = {
  id: 3,
  name: 'Kitchen',
  sourceMac: 'aa',
  volumes: { maxVolume: 100, default: 20, volstep: 1 },
} as unknown as ZoneConfig;

type Harness = {
  ctx: ZoneContext;
  resumes: number;
  dispatched: Array<'play' | 'pause' | 'resume' | 'stop'>;
  send: (command: string, payload?: string) => void;
};

function harness(overrides: Partial<ZoneState> = {}): Harness {
  let resumes = 0;
  const dispatched: Array<'play' | 'pause' | 'resume' | 'stop'> = [];

  const ctx = {
    id: 3,
    name: 'Kitchen',
    config: zoneConfig,
    state: {
      ...buildInitialState(zoneConfig),
      volume: 40,
      mode: 'pause',
      audiopath: 'library:track:1',
      ...overrides,
    },
    inputMode: 'queue',
    outputs: [],
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { current: () => null, currentIndex: () => -1 },
    player: {
      setVolume: (level: number) => {
        const clamped = clampVolumeForZone(zoneConfig, level);
        coordinator.applyPatch(3, { volume: clamped });
      },
      resume: () => {
        resumes += 1;
        return { id: 'session-1' };
      },
      getSession: () => ({ id: 'session-1' }),
    },
  } as unknown as ZoneContext;

  const coordinator = {
    log: { debug: () => undefined, spam: () => undefined, warn: () => undefined },
    applyPatch: (_zoneId: number, patch: Partial<ZoneState>) => {
      ctx.state = applyZonePatch(ctx.state, patch);
    },
    dispatchVolume: () => undefined,
    dispatchOutputs: (
      _ctx: ZoneContext,
      _outputs: unknown,
      action: 'play' | 'pause' | 'resume' | 'stop',
    ) => {
      dispatched.push(action);
    },
    playerCommand: async () => true,
    isLocalQueueAuthority: () => true,
  } as unknown as Parameters<typeof handleZoneCommand>[0]['coordinator'];

  return {
    ctx,
    get resumes() {
      return resumes;
    },
    dispatched,
    send: (command, payload) =>
      handleZoneCommand({ coordinator, ctx, zoneId: 3, command, payload }),
  };
}

test('a volume step on a paused zone raises the level and resumes playback', () => {
  const h = harness({ volume: 40 });

  h.send('volume', '+1');

  assert.equal(h.ctx.state.volume, 41);
  assert.equal(h.ctx.state.mode, 'play');
  assert.equal(h.resumes, 1);
  assert.deepEqual(h.dispatched, ['resume']);
});

test('a volume step down resumes just the same', () => {
  const h = harness({ volume: 40 });

  h.send('volume', '-1');

  assert.equal(h.ctx.state.volume, 39);
  assert.equal(h.ctx.state.mode, 'play');
  assert.equal(h.resumes, 1);
});

test('a volume step on a playing zone only moves the level', () => {
  const h = harness({ volume: 40, mode: 'play' });

  h.send('volume', '+1');

  assert.equal(h.ctx.state.volume, 41);
  assert.equal(h.resumes, 0);
  assert.deepEqual(h.dispatched, []);
});

test('a volume step on a stopped zone only moves the level', () => {
  const h = harness({ volume: 40, mode: 'stop' });

  h.send('volume', '+1');

  assert.equal(h.ctx.state.volume, 41);
  assert.equal(h.ctx.state.mode, 'stop');
  assert.equal(h.resumes, 0);
});

test('setting an absolute level on a paused zone leaves it paused', () => {
  const h = harness({ volume: 40 });

  h.send('volume', '55');

  assert.equal(h.ctx.state.volume, 55);
  assert.equal(h.ctx.state.mode, 'pause');
  assert.equal(h.resumes, 0);
});

test('a fade ramp never restarts the zone it is fading', () => {
  const h = harness({ volume: 40 });

  // The fade controller ramps with `volume_set`, including relative steps. A resume here would
  // make a fade-in fight the pause it was asked to fade into.
  h.send('volume_set', '+1');

  assert.equal(h.ctx.state.volume, 41);
  assert.equal(h.ctx.state.mode, 'pause');
  assert.equal(h.resumes, 0);
});
