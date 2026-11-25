import assert from 'node:assert/strict';
import { test } from './testHarness';
import { zoneTransportCapabilities } from '../src/application/zones/playback/transportCapabilities';
import { toLoxoneZoneState, type LoxoneTransport } from '../src/adapters/loxone/ws/zoneStateProjection';
import { AudioType, FileType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';

// Which transport controls a zone can act on, and how the Loxone app is told (`pbr`), so it
// does not offer a next, a shuffle or a seek bar that would be ignored.

/** The rule `QueueController.isLocalQueueAuthority` applies, for the authorities used here. */
const isLocal = (authority: unknown) => !authority || authority === 'local' || authority === 'applemusic';

const capabilities = (inputMode: string, authority?: string) =>
  zoneTransportCapabilities({ inputMode: inputMode as any, queue: { authority: authority as any } }, isLocal);

test('a zone playing from its own queue can do everything', () => {
  const all = { skip: true, seek: true, shuffle: true, repeat: true };
  assert.deepEqual(capabilities('queue', 'local'), all);
  assert.deepEqual(capabilities('queue'), all, 'no authority recorded is a queue of our own');
  // A bridged service is still walked by our queue controller.
  assert.deepEqual(capabilities('queue', 'applemusic'), all);
});

test('an input that brings its own order cannot be shuffled or repeated from here', () => {
  // Spotify Connect: the app holds the queue. Next and previous are passed on to it, and
  // reordering our mirror of it would change nothing.
  assert.deepEqual(capabilities('spotify', 'spotify'), { skip: true, seek: true, shuffle: false, repeat: false });
  assert.deepEqual(capabilities('musicassistant', 'musicassistant'), { skip: true, seek: true, shuffle: false, repeat: false });
  // AirPlay: the sender takes next and previous over its remote control, and nothing else.
  assert.deepEqual(capabilities('airplay'), { skip: true, seek: false, shuffle: false, repeat: false });
  assert.deepEqual(capabilities('linein'), { skip: true, seek: false, shuffle: false, repeat: false });
});

test('an input with nobody to pass a command to can do none of it', () => {
  const none = { skip: false, seek: false, shuffle: false, repeat: false };
  assert.deepEqual(capabilities('bluetooth'), none);
  assert.deepEqual(capabilities('dlna'), none);
  assert.deepEqual(capabilities('mixedgroup'), none);
});

// --- what the app is told ---------------------------------------------------------

const BIT = { TRACKSEEK: 32, PREV: 512, NEXT: 1024, SHUFFLE: 2048, REPEAT_ALL: 4096, REPEAT_ONE: 8192 };
const hasBit = (mask: number, bit: number) => (mask & bit) === bit;

/** The app's own rules for each control (shared-app.js module 935328 and :100915), transcribed. */
const app = {
  offersSkip(event: { audiotype: number; audiopath: string; pbr?: number }): boolean {
    if ([AudioType.Radio, 7, AudioType.LineIn].includes(event.audiotype)) return false;
    if (event.audiopath.startsWith('custom:station')) return false;
    if (!event.pbr) return true;
    return hasBit(event.pbr, BIT.NEXT) && hasBit(event.pbr, BIT.PREV);
  },
  offersRepeat: (event: { pbr?: number }) =>
    event.pbr !== undefined ? hasBit(event.pbr, BIT.REPEAT_ALL) || hasBit(event.pbr, BIT.REPEAT_ONE) : true,
  offersShuffle: (event: { pbr?: number }) => (event.pbr !== undefined ? hasBit(event.pbr, BIT.SHUFFLE) : true),
  blocksSeek: (event: { pbr?: number }) => !!event.pbr && !hasBit(event.pbr, BIT.TRACKSEEK),
};

function event(transport: LoxoneTransport | null, state: Partial<ZoneState> = {}) {
  return toLoxoneZoneState(
    {
      id: 3,
      name: 'Kitchen',
      mode: 'play',
      power: 'on',
      clientState: 'on',
      time: 0,
      duration: 0,
      volume: 40,
      plrepeat: 0,
      plshuffle: 0,
      title: 'Song',
      artist: '',
      album: '',
      coverurl: '',
      station: '',
      sourceName: 'Kitchen',
      audiopath: 'airplay://kitchen',
      audiotype: AudioType.AirPlay,
      type: FileType.File,
      eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      qindex: 0,
      ...state,
    } as ZoneState,
    { group: null, leaderVolume: 0, audiopathToLoxone: (path) => path, transport },
  );
}

test('a zone that can do everything carries no mask, as it never has', () => {
  const full = event({ skip: true, seek: true, shuffle: true, repeat: true });
  assert.equal('pbr' in JSON.parse(JSON.stringify(full)), false);
  assert.equal('pbr' in JSON.parse(JSON.stringify(event(null))), false, 'nor does a zone nothing is known about');
  // And with no mask the app offers all four.
  assert.equal(app.offersSkip(full), true);
  assert.equal(app.offersShuffle(full), true);
  assert.equal(app.offersRepeat(full), true);
  assert.equal(app.blocksSeek(full), false);
});

test('the app offers exactly what the zone can do', () => {
  const cases: LoxoneTransport[] = [
    { skip: true, seek: false, shuffle: false, repeat: false },
    { skip: true, seek: true, shuffle: false, repeat: false },
    { skip: false, seek: true, shuffle: true, repeat: true },
    { skip: true, seek: true, shuffle: true, repeat: false },
    { skip: false, seek: false, shuffle: false, repeat: false },
  ];
  for (const transport of cases) {
    const sent = event(transport);
    const label = JSON.stringify(transport);
    assert.equal(app.offersSkip(sent), transport.skip, `skip ${label}`);
    assert.equal(!app.blocksSeek(sent), transport.seek, `seek ${label}`);
    assert.equal(app.offersShuffle(sent), transport.shuffle, `shuffle ${label}`);
    assert.equal(app.offersRepeat(sent), transport.repeat, `repeat ${label}`);
  }
});

test('a zone that can do nothing still sends a mask the app does not read as "no mask"', () => {
  // The app treats a mask of zero as absent for next/previous and for seeking. Bluetooth can
  // do neither, so a bare zero would hand both controls back.
  const none = event({ skip: false, seek: false, shuffle: false, repeat: false });
  assert.ok(none.pbr, 'the mask is not zero');
  assert.equal(app.offersSkip({ ...none, pbr: 0 }), true, 'what a zero would have done');
  assert.equal(app.offersSkip(none), false);
  assert.equal(app.blocksSeek(none), true);
});

test('a zone following an external player is offered only what that player can do', () => {
  // The speaker owns the session: the mask is its answer, not this server's queue. Shuffle and
  // repeat are reported unsupported because they are not forwarded for a queue the speaker owns.
  const caps = (external: { skip: boolean; seek: boolean; shuffle: boolean; repeat: boolean } | null) =>
    zoneTransportCapabilities({ inputMode: null, queue: { authority: 'local' } }, isLocal, external);

  assert.deepEqual(
    caps({ skip: true, seek: true, shuffle: false, repeat: false }),
    { skip: true, seek: true, shuffle: false, repeat: false },
    'next, previous and seek survive; shuffle and repeat do not',
  );
  assert.deepEqual(
    caps({ skip: false, seek: false, shuffle: false, repeat: false }),
    { skip: false, seek: false, shuffle: false, repeat: false },
    'a player that can only pause offers nothing else',
  );
  // No external answer: the local queue decides, exactly as it did before this existed.
  assert.deepEqual(caps(null), { skip: true, seek: true, shuffle: true, repeat: true });
});
