import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import type { ZoneState } from '../src/domain/zones/zoneState';

// The bar jumped at a track change because the position and the item it belongs to were published
// by two different channels: a one second ticker that carried only `time`, and event driven
// snapshots that carried the metadata too. Recorded from a real zone at 06:23:43 on 2026-11-26:
//
//   06:23:42.830  dur=225 t=224  Don't Worry
//   06:23:43.819  dur=203 t=225  Only Love (feat. Pa Salieu)   <- new item, old position
//   06:23:43.823  dur=203 t=29   Only Love (feat. Pa Salieu)
//   06:23:44.068  dur=203 t=0    Only Love (feat. Pa Salieu)
//
// and earlier that evening `dur=225 t=315`, a position 90 seconds past the end of the track.
// These pin what the controller publishes for those same inputs.

type Track = {
  mediaUrl?: string;
  name?: string;
  artist?: { name?: string };
  album?: { name?: string };
  durationMillis?: number;
  images?: unknown[];
};

function makeController() {
  const patches: Array<Partial<ZoneState>> = [];
  const zone = {
    id: 2,
    name: 'Wohnzimmer',
    output: { id: 'sonos', host: '127.0.0.1' },
    state: { controller: 'sonos' },
    volumes: { default: 25, maxVolume: 100, volstep: 1 },
  } as any;
  const configPort = {
    getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  } as any;
  const controller = new SonosStateController({
    zone,
    configPort,
    onStatePatch: (_zoneId, patch) => patches.push(patch),
  });

  const group = {
    name: 'Wohnzimmer',
    playbackState: 'PLAYING',
    positionSeconds: 0,
    volume: 20,
    muted: false,
    playbackMetadataStatus: {
      currentItem: { track: { name: 'Track', mediaUrl: 'x-sonos-spotify:one' } as Track },
    },
  };
  (controller as any).client = { player: { group, isCoordinator: true } };
  return { controller, patches, group };
}

function playingItem(group: any, track: Track, positionSeconds: number, state = 'PLAYING') {
  group.playbackMetadataStatus = { currentItem: { track } };
  group.playbackState = state;
  group.positionSeconds = positionSeconds;
}

const snapshot = (controller: any) => controller.emitSnapshotPatch();
const tick = (controller: any) => controller.emitTimeTick();

test('a position never runs past the duration of the item it belongs to', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Don\'t Worry', mediaUrl: 'x-sonos-spotify:a', durationMillis: 225_000 }, 224);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Don\'t Worry', mediaUrl: 'x-sonos-spotify:a', durationMillis: 225_000 }, 315);
  snapshot(controller);

  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.duration, 225);
  assert.equal(patches[0]!.time, 225, 'the position is held to the end of the item');
});

test('a ticker tick cannot carry the previous item position onto the next item', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Don\'t Worry', mediaUrl: 'x-sonos-spotify:a', durationMillis: 225_000 }, 224);
  snapshot(controller);
  patches.length = 0;

  // The speaker has already moved on, but no snapshot has published the new item yet.
  playingItem(group, { name: 'Only Love', mediaUrl: 'x-sonos-spotify:b', durationMillis: 203_000 }, 225);
  tick(controller);

  assert.deepEqual(patches, [], 'the tick is withheld until the item it belongs to is published');
});

test('a change of item starts its progress at zero and keeps the new duration', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Don\'t Worry', mediaUrl: 'x-sonos-spotify:a', durationMillis: 225_000 }, 224);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Only Love', mediaUrl: 'x-sonos-spotify:b', durationMillis: 203_000 }, 225);
  snapshot(controller);

  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.title, 'Only Love');
  assert.equal(patches[0]!.duration, 203);
  assert.equal(patches[0]!.time, 0, 'the previous item position is not carried over');
});

test('ticks resume once the new item has been published', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Only Love', mediaUrl: 'x-sonos-spotify:b', durationMillis: 203_000 }, 4);
  snapshot(controller);
  patches.length = 0;

  tick(controller);
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.time, 4);
});

test('a session adopted while it is already playing keeps its real position', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Half Way', mediaUrl: 'x-sonos-spotify:c', durationMillis: 300_000 }, 150);
  snapshot(controller);

  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.time, 150, 'the first look at a speaker is not a change of item');
});

test('a pause keeps position and duration, and resuming continues from there', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Paused', mediaUrl: 'x-sonos-spotify:d', durationMillis: 240_000 }, 90);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Paused', mediaUrl: 'x-sonos-spotify:d', durationMillis: 240_000 }, 90, 'PAUSED_PLAYBACK');
  snapshot(controller);
  assert.equal(patches[0]!.mode, 'pause');
  assert.equal(patches[0]!.time, 90);
  assert.equal(patches[0]!.duration, 240);

  patches.length = 0;
  playingItem(group, { name: 'Paused', mediaUrl: 'x-sonos-spotify:d', durationMillis: 240_000 }, 91);
  snapshot(controller);
  assert.equal(patches[0]!.mode, 'play');
  assert.equal(patches[0]!.time, 91);
});

test('a new item that has not reported a length is not held to the previous one', () => {
  const { controller, patches, group } = makeController();
  // A short track first, so a wrong clamp would be obvious.
  playingItem(group, { name: 'Short', mediaUrl: 'x-sonos-spotify:f', durationMillis: 60_000 }, 59);
  snapshot(controller);
  patches.length = 0;

  // The next item starts with no duration in its metadata, as a stream or a not yet enriched
  // item does, and the speaker is already well past the previous length.
  playingItem(group, { name: 'Long', mediaUrl: 'x-sonos-spotify:g' }, 600);
  snapshot(controller);
  assert.equal(patches[0]!.time, 0, 'a new item starts at zero');

  patches.length = 0;
  playingItem(group, { name: 'Long', mediaUrl: 'x-sonos-spotify:g' }, 640);
  snapshot(controller);
  assert.equal(patches[0]!.time, 640, 'and is not frozen at the previous item length');

  patches.length = 0;
  tick(controller);
  assert.equal(patches[0]!.time, 640, 'the ticker does not clamp it either');
});

test('a seek inside the same item is published as it is', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Seeked', mediaUrl: 'x-sonos-spotify:e', durationMillis: 600_000 }, 20);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Seeked', mediaUrl: 'x-sonos-spotify:e', durationMillis: 600_000 }, 300);
  snapshot(controller);

  assert.equal(patches[0]!.time, 300, 'moving inside the item is not a change of item');
});
// Identity is the name, not the url. A Sonos media url carries a sequence number that changes on
// every seek and again when the speaker loads the next item, so keying on it made a seek look
// like a track change and made a real change arrive as two frames. Recorded on 2026-11-26 at
// 13:33:37 while a playlist played:
//
//     13:33:36  t=217 dur=219  'Come As You Are'
//     13:33:37  t=218 dur=219  'Come As You Are'
//     13:33:37  t=0   dur=219  'Come As You Are'      <- new url, old name
//     13:33:37  t=0   dur=270  'House of the Rising Sun'
//
// The middle frame is the one a client can render as a jump: the finished item, reset to zero,
// with its old length. And a seek published one such frame of its own, which is the zero the
// Loxone bar showed briefly after the first seek.

test('a seek that only changes the media url is not a change of item', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Seeked', mediaUrl: 'x-sonos-spotify:e?sn=1', durationMillis: 600_000 }, 20);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Seeked', mediaUrl: 'x-sonos-spotify:e?sn=2', durationMillis: 600_000 }, 300);
  snapshot(controller);

  assert.equal(patches[0]!.time, 300, 'a seek is published as the position it moved to');
  assert.notEqual(patches[0]!.time, 0, 'and never as the start of the item');

  patches.length = 0;
  tick(controller);
  assert.equal(patches.length, 1, 'the ticker keeps running through a seek');
  assert.equal(patches[0]!.time, 300);
});

test('a transition is published once, when the new name arrives with its length', () => {
  const { controller, patches, group } = makeController();
  playingItem(group, { name: 'Come As You Are', mediaUrl: 'x-sonos-spotify:c?sn=1', durationMillis: 219_000 }, 218);
  snapshot(controller);
  patches.length = 0;

  // The speaker has loaded the next item and still names the old one, which is what it does for
  // a moment at every change.
  playingItem(group, { name: 'Come As You Are', mediaUrl: 'x-sonos-spotify:h?sn=1' }, 219);
  snapshot(controller);
  assert.notEqual(patches[0]?.time, 0, 'the finished item is not reset to zero while it is still named');

  patches.length = 0;
  playingItem(group, { name: 'House of the Rising Sun', mediaUrl: 'x-sonos-spotify:h?sn=1', durationMillis: 270_000 }, 0);
  snapshot(controller);

  assert.equal(patches.length, 1, 'one frame carries the whole transition');
  assert.equal(patches[0]!.title, 'House of the Rising Sun');
  assert.equal(patches[0]!.duration, 270, 'the new length travels with the new name');
  assert.equal(patches[0]!.time, 0, 'and the position starts at the beginning of that item');
});
test('a song changing inside a radio stream is not a change of item', () => {
  const { controller, patches, group } = makeController();
  // A station keeps its name and reports the song it is playing as the artist.
  playingItem(group, { name: 'Radio Paradise', artist: { name: 'Dave Matthews Band - All Along the Watchtower' } }, 110);
  snapshot(controller);
  patches.length = 0;

  playingItem(group, { name: 'Radio Paradise', artist: { name: 'Nirvana - Come As You Are' } }, 120);
  snapshot(controller);

  assert.equal(patches[0]!.time, 120, 'the stream keeps its position');
  assert.notEqual(patches[0]!.time, 0, 'and is not reset when the song inside it changes');
});
