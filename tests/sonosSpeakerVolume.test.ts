import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ZoneState } from '../src/domain/zones/zoneState';

// A volume set on the speaker itself, in the Sonos app or with its buttons, reaches the zone and
// so Loxone (#447). Before, the zone kept showing the last level sonn had sent.

const configPort = { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any;

const TRACK = {
  container: { name: 'Spotify', type: 'trackList', service: { name: 'Sonos', id: '9' } },
  currentItem: { track: { name: 'A track', mediaUrl: 'x-sonos-spotify:spotify:track:1' } },
};

function controllerFor(volumes = { maxVolume: 100, volstep: 1 }) {
  const patches: Array<Partial<ZoneState>> = [];
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' }, volumes } as unknown as ZoneConfig,
    configPort,
    onStatePatch: (_zoneId: number, patch: Partial<ZoneState>) => patches.push(patch),
  }) as any;
  const report = (player: Record<string, unknown>, group: Record<string, unknown> = {}): Partial<ZoneState> => {
    controller.client = {
      player: {
        ...player,
        group: {
          playbackState: 'PLAYBACK_STATE_PLAYING',
          positionSeconds: 0,
          name: 'Wohnzimmer',
          playbackMetadataStatus: TRACK,
          ...group,
        },
      },
    };
    controller.emitSnapshotPatch();
    return patches[patches.length - 1] ?? {};
  };
  return { report };
}

test('a volume set on a Sonos speaker reaches the zone (#447)', () => {
  const { report } = controllerFor();
  assert.equal(report({ volumeLevel: 42, volumeMuted: false }).volume, 42, 'S2 reports it per player');
  assert.equal(report({}, { volume: 37, muted: false }).volume, 37, 'S1 reports it on the group');
});

test('a muted Sonos speaker is a silent, muted zone', () => {
  const { report } = controllerFor();
  const patch = report({ volumeLevel: 31, volumeMuted: true });
  assert.equal(patch.volume, 0);
  assert.equal(patch.muted, true);
});

test('a Sonos level is held to the zone maximum', () => {
  const { report } = controllerFor({ maxVolume: 60, volstep: 1 });
  assert.equal(report({ volumeLevel: 80 }).volume, 60);
});

test('no level, a broken one or a fixed line level leaves the zone volume alone', () => {
  const { report } = controllerFor();
  assert.equal('volume' in report({}), false, 'not reported yet is not silence');
  for (const level of [Number.NaN, -5, 101]) {
    assert.equal('volume' in report({ volumeLevel: level }), false, `${level} is not a level`);
  }
  assert.equal('volume' in report({ volumeLevel: 100, hasFixedVolume: true }), false);
});
