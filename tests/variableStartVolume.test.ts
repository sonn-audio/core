import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import { attachPlayerListeners } from '../src/application/zones/playback/playerListeners';
import {
  buildInitialState,
  getZoneDefaultVolume,
  getZoneStartVolume,
} from '../src/application/zones/helpers/stateHelpers';
import type { ZoneConfig } from '../src/domain/config/types';

/**
 * Loxone's "variable startup volume" arrives as `default: -1` in `audio/cfg/volumes` (and as
 * `audio/cfg/defaultvolume/<zone>/-1`): the Loxone app sends -1 when its switch is on. Read as a
 * level it clamped to 0, so such a zone started every play muted.
 */

function zone(defaultVolume: number): ZoneConfig {
  return {
    id: 4,
    name: 'Werkkamer',
    sourceMac: 'aa',
    volumes: { default: defaultVolume, maxVolume: 100, volstep: 1 },
  } as unknown as ZoneConfig;
}

test('variable start volume: -1 is not a level of 0', () => {
  assert.equal(getZoneDefaultVolume(zone(-1)), 25);
  assert.equal(buildInitialState(zone(-1)).volume, 25);
});

test('variable start volume: a fresh play starts where the zone was left', () => {
  assert.equal(getZoneStartVolume(zone(-1), 40), 40);
  // A fixed default still wins over the current level.
  assert.equal(getZoneStartVolume(zone(20), 40), 20);
});

function startStoppedZone(config: ZoneConfig, volume: number): number[] {
  const dispatched: number[] = [];
  const ctx: any = {
    id: 4,
    name: 'Werkkamer',
    sourceMac: 'aa',
    config,
    state: { ...buildInitialState(config), mode: 'stop', volume },
    queue: { authority: 'local', items: [] },
    queueController: { current: () => null, currentIndex: () => 0 },
    metadata: {},
  };
  const coordinator: any = {
    getZone: () => ctx,
    applyPatch: (_zoneId: number, patch: any) => {
      ctx.state = { ...ctx.state, ...patch };
    },
    dispatchOutputs: () => undefined,
    dispatchVolume: (_ctx: unknown, _outputs: unknown, level: number) => dispatched.push(level),
    audioHelpers: {},
  };
  const player = new EventEmitter() as any;
  attachPlayerListeners({ coordinator, player, outputs: [], zoneId: 4, zoneName: 'Werkkamer', sourceMac: 'aa' });
  player.emit('started', { metadata: { title: 'Track' } });
  assert.equal(ctx.state.volume, dispatched[0]);
  return dispatched;
}

test('variable start volume: a stopped zone starts at its last level, not silent', () => {
  assert.deepEqual(startStoppedZone(zone(-1), 40), [40]);
});

test('fixed start volume: a stopped zone starts at its default', () => {
  assert.deepEqual(startStoppedZone(zone(20), 40), [20]);
});
