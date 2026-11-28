import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ZoneState } from '../src/domain/zones/zoneState';

// A Sonos position belongs to the item it was read for (#462). At a change of item the speaker
// reports the old item's position for a moment, and the bar jumped: 225 s against a 203 s track.

const configPort = { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any;

function speaker() {
  const patches: Array<Partial<ZoneState>> = [];
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' } } as unknown as ZoneConfig,
    configPort,
    onStatePatch: (_zoneId: number, patch: Partial<ZoneState>) => patches.push(patch),
  }) as any;
  const group: any = { playbackState: 'PLAYBACK_STATE_PLAYING', positionSeconds: 0, name: 'Wohnzimmer' };
  controller.client = { player: { group } };
  const at = (name: string, durationSec: number | null, positionSeconds: number, extra: Record<string, unknown> = {}) => {
    group.positionSeconds = positionSeconds;
    group.playbackMetadataStatus = {
      container: { name: 'Spotify', type: 'trackList', service: { name: 'Sonos', id: '9' } },
      currentItem: {
        track: {
          name,
          mediaUrl: `x-sonos-spotify:spotify:track:${name}?sn=${Math.random()}`,
          ...(durationSec === null ? {} : { durationMillis: durationSec * 1000 }),
          ...extra,
        },
      },
    };
  };
  const snapshot = () => {
    controller.emitSnapshotPatch();
    return patches[patches.length - 1] ?? {};
  };
  const tick = (): Partial<ZoneState> | undefined => {
    const before = patches.length;
    controller.emitTimeTick();
    return patches.length > before ? patches[patches.length - 1] : undefined;
  };
  return { at, snapshot, tick };
}

test('a Sonos position never runs past the length of its track (#462)', () => {
  const { at, snapshot, tick } = speaker();
  at('A', 225, 315);
  assert.equal(snapshot().time, 225);
  assert.equal(tick()?.time, 225);
});

test('a new Sonos track starts at 0, and the old position is not ticked onto it', () => {
  const { at, snapshot, tick } = speaker();
  at('A', 225, 200);
  snapshot();
  at('B', 203, 224); // the speaker still reports where A was
  assert.equal(tick(), undefined, 'no tick before the new track is shown');
  const patch = snapshot();
  assert.equal(patch.title, 'B');
  assert.equal(patch.duration, 203);
  assert.equal(patch.time, 0);
  at('B', 203, 3);
  assert.equal(tick()?.time, 3);
});

test('a track picked up on connecting keeps its position, and a seek is not a new track', () => {
  const { at, snapshot } = speaker();
  at('A', 225, 120);
  assert.equal(snapshot().time, 120, 'first look at the speaker');
  at('A', 225, 40); // new media URL sequence number, same track
  assert.equal(snapshot().time, 40);
});

test('a radio stream changing song under the same station is not a new item', () => {
  const { at, snapshot } = speaker();
  at('Radio Paradise', null, 300, { artist: { name: 'Song one' } });
  snapshot();
  at('Radio Paradise', null, 305, { artist: { name: 'Song two' } });
  assert.equal(snapshot().time, 305);
});
