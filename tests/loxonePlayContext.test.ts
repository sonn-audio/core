import assert from 'node:assert/strict';
import { test } from './testHarness';
import { toLoxoneZoneState } from '../src/adapters/loxone/ws/zoneStateProjection';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import {
  forgetPlayContext,
  playContextPath,
  readPlayContext,
  rememberPlayContext,
  type PlayContextRequest,
} from '../src/application/zones/playback/playContext';
import { buildBridgeRegistry, toLoxoneAudiopath } from '../src/domain/zones/bridgeIdentity';
import { AudioType, FileType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';

// What a zone is playing *from*. The Loxone app shows it in three places: the album or playlist
// row in a browse list is marked as playing, the mini player names it, and the queue screen is
// titled with it. It reads all three from `parent` in the zone's audio_event.

const REGISTRY = buildBridgeRegistry([{ id: 'bridge-applemusic-p0gngd', label: 'Apple Music', provider: 'applemusic' }]);
const toLoxone = (path: string) => toLoxoneAudiopath(path, REGISTRY);

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 12,
    duration: 210,
    volume: 40,
    plrepeat: 0,
    plshuffle: 0,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://cover',
    station: '',
    // What the zone itself calls any streaming source.
    sourceName: 'Spotify',
    audiopath: 'applemusic:p0gngd:track:b64_MTIz',
    audiotype: AudioType.Spotify,
    type: FileType.File,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qindex: 0,
    ...overrides,
  } as ZoneState;
}

/** The service entries the app holds, as `getservices` hands them out. */
const SERVICES = [
  { id: 'md123121', user: 'Rudy', fake: false },
  { id: 'bridge-applemusic-p0gngd', user: 'Apple Music', fake: true },
];

const project = (
  playContext: { path: string; name: string } | null,
  state: Partial<ZoneState> = {},
  services: Array<{ id: string; user: string; fake?: boolean }> = SERVICES,
) =>
  toLoxoneZoneState(zoneState(state), {
    group: null,
    leaderVolume: 0,
    audiopathToLoxone: toLoxone,
    playContext,
    serviceAccounts: () => services,
  });

/**
 * The app's own test for "is this row playing" (`isItemPlaying`, shared-app.js:20768),
 * transcribed. `services` is its list of service entries, which it searches by `user`.
 */
function appMarksRowAsPlaying(
  event: { mode: string; audiopath: string; sourceName?: string; parent: { id: string } | null },
  rowAudioPath: string,
  services: Array<{ id: string; user: string }> = [],
): boolean {
  if (event.mode !== 'play' || !rowAudioPath) return false;
  const account = /spotify@([^:]+)/;
  if (event.parent) {
    if (event.parent.id === rowAudioPath) return true;
    const bare = rowAudioPath.replace(account, 'spotify');
    const rowAccount = rowAudioPath.match(account)?.[1];
    if (event.audiopath.startsWith('spotify')) {
      const playingAccount = services.find((entry) => entry.user === event.sourceName)?.id;
      if (!rowAccount || !playingAccount || rowAccount !== playingAccount) return false;
      if (event.parent.id === bare) return true;
    }
  }
  return event.audiopath === rowAudioPath || rowAudioPath.replace(account, 'spotify') === event.audiopath;
}

test('a zone with nothing behind its queue sends no parent', () => {
  assert.equal(project(null).parent, null);
  // A context we cannot name is not sent: the app shows the name in place of the album.
  assert.equal(project({ path: 'applemusic:p0gngd:album:b64_QUJD', name: '' }).parent, null);
});

test('the parent carries the container in the form the app holds for that row', () => {
  const parent = project({ path: 'applemusic:p0gngd:album:b64_QUJD', name: 'Abbey Road' }).parent;
  assert.deepEqual(parent, {
    id: 'spotify@bridge-applemusic-p0gngd:album:b64_QUJD',
    name: 'Abbey Road',
    audiopath: 'spotify@bridge-applemusic-p0gngd:album:b64_QUJD',
  });
});

test('the app marks the album row as playing, and still marks the track row', () => {
  const albumRow = toLoxone('applemusic:p0gngd:album:b64_QUJD');
  const trackRow = toLoxone('applemusic:p0gngd:track:b64_MTIz');
  const otherAlbumRow = toLoxone('applemusic:p0gngd:album:b64_WFla');

  const withParent = project({ path: 'applemusic:p0gngd:album:b64_QUJD', name: 'Abbey Road' });
  assert.equal(appMarksRowAsPlaying(withParent, albumRow, SERVICES), true, 'the album it plays from');
  assert.equal(appMarksRowAsPlaying(withParent, trackRow, SERVICES), true, 'the track itself');
  assert.equal(appMarksRowAsPlaying(withParent, otherAlbumRow, SERVICES), false, 'not some other album');

  // Without a parent only the track is marked — which is all the app could do before.
  const without = project(null);
  assert.equal(appMarksRowAsPlaying(without, albumRow, SERVICES), false);
  assert.equal(appMarksRowAsPlaying(without, trackRow, SERVICES), true);
});

test('a streaming zone reports the name of its account, which is how the app tells accounts apart', () => {
  // The app shows this under the Spotify logo and looks the service up by it.
  assert.equal(project(null).sourceName, 'Apple Music', 'a bridged service, by the account in its path');
  assert.equal(
    project(null, { audiopath: 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg' }).sourceName,
    'Rudy',
    'a real Spotify account named in the path',
  );
  assert.equal(
    project(null, { audiopath: 'spotify:track:2bJtJv5NGkYUFP6prU3WSg' }).sourceName,
    'Rudy',
    'a bare Spotify path, when there is only one real account it can be',
  );
});

test('a zone that is not streaming, or whose account cannot be told, keeps its own source name', () => {
  assert.equal(project(null, { audiopath: 'library:local:track:b64_MTIz', sourceName: 'Library' }).sourceName, 'Library');
  assert.equal(project(null, { audiopath: 'linein:1', sourceName: 'Turntable' }).sourceName, 'Turntable');
  // No accounts known at all — the lookup is not wired, or nothing is configured.
  assert.equal(project(null, {}, []).sourceName, 'Spotify');
  // Two real Spotify accounts and a path that names neither.
  const two = [...SERVICES, { id: 'other', user: 'Anna', fake: false }];
  assert.equal(project(null, { audiopath: 'spotify:track:abc' }, two).sourceName, 'Spotify');
  // An account the app would find under someone else's name: it takes the first match.
  const twins = [{ id: 'first', user: 'Apple Music', fake: true }, ...SERVICES];
  assert.equal(project(null, {}, twins).sourceName, 'Spotify');
});

test('a parent is withheld when it would cost the zone the marking it already has', () => {
  // The app's rule, once there is a parent and the track looks like Spotify to it: find the
  // account by the zone's sourceName, or mark nothing at all — not even the track.
  const context = { path: 'applemusic:p0gngd:album:b64_QUJD', name: 'Abbey Road' };
  const trackRow = toLoxone('applemusic:p0gngd:track:b64_MTIz');

  // What would happen if we sent it anyway: a zone whose source name the app cannot place.
  const unplaceable = { ...project(context), sourceName: 'Somewhere else' };
  assert.equal(appMarksRowAsPlaying(unplaceable, trackRow, SERVICES), false, 'the track row would go dark');

  // So without a known account it is not sent, and the track stays marked.
  const unknown = project(context, {}, []);
  assert.equal(unknown.parent, null);
  assert.equal(appMarksRowAsPlaying(unknown, trackRow, SERVICES), true);

  // The library is not Spotify to the app: no account to find, nothing to withhold.
  const library = project(
    { path: 'library:local:album:b64_QUJD', name: 'Local Album' },
    { audiopath: 'library:local:track:b64_MTIz', sourceName: 'Library' },
    [],
  );
  assert.equal(library.parent?.name, 'Local Album');
});

test('real Spotify: the album row is marked through the account the source name points at', () => {
  // The row carries the account, the playing path may not. The app strips the account off the
  // row and compares — but only after the source name led it to that same account.
  const event = project(
    { path: 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy', name: 'Global Warming' },
    { audiopath: 'spotify:track:2bJtJv5NGkYUFP6prU3WSg' },
  );
  assert.equal(event.sourceName, 'Rudy');
  assert.equal(appMarksRowAsPlaying(event, 'spotify@md123121:album:4aawyAB9vmqN3uQ7FjRGTy', SERVICES), true);
  assert.equal(appMarksRowAsPlaying(event, 'spotify@md123121:track:2bJtJv5NGkYUFP6prU3WSg', SERVICES), true);
  assert.equal(appMarksRowAsPlaying(event, 'spotify@other:album:4aawyAB9vmqN3uQ7FjRGTy', SERVICES), false, "not another account's row");
});

test('the notifier asks for the context of the zone it is projecting', () => {
  const notifier = new LoxoneWsNotifier({ broadcastMessage: () => {} } as any, { getGroupByZone: () => undefined } as any);
  notifier.setAudiopathToLoxone(toLoxone);
  notifier.setServiceAccountsLookup(() => SERVICES);
  assert.equal(notifier.projectForLoxone(zoneState()).parent, null, 'no lookup, no parent');
  const asked: number[] = [];
  notifier.setPlayContextLookup((zoneId) => {
    asked.push(zoneId);
    return zoneId === 3 ? { path: 'applemusic:p0gngd:playlist:b64_UExM', name: 'Morning' } : null;
  });
  assert.equal(notifier.projectForLoxone(zoneState()).parent?.name, 'Morning');
  assert.equal(notifier.projectForLoxone(zoneState({ id: 4 })).parent, null);
  assert.deepEqual(asked, [3, 4]);
});

// --- where the context comes from ----------------------------------------------------

const ALBUM = 'applemusic:p0gngd:album:b64_QUJD';
const PLAYLIST = 'applemusic:p0gngd:playlist:b64_UExM';
const TRACK = 'applemusic:p0gngd:track:b64_MTIz';
const TWO_TRACKS = [{ audiopath: TRACK }, { audiopath: 'applemusic:p0gngd:track:b64_NDU2' }];

const request = (over: Partial<PlayContextRequest>): PlayContextRequest => ({
  isRadio: false,
  isLineIn: false,
  parentContext: null,
  resolvedTarget: TRACK,
  provider: 'applemusic',
  nextInput: 'queue',
  ...over,
});

const zone = () => ({ metadata: {} as Record<string, unknown>, inputMode: 'queue' as const });
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a track picked out of an album plays from that album; an album played whole is its own context', () => {
  assert.equal(playContextPath(request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS), ALBUM);
  assert.equal(playContextPath(request({ resolvedTarget: ALBUM }), TWO_TRACKS), ALBUM);
});

test('a single track, a radio station and a line-in have no context', () => {
  assert.equal(playContextPath(request({ resolvedTarget: TRACK }), [{ audiopath: TRACK }]), null);
  assert.equal(playContextPath(request({ resolvedTarget: 'http://stream', isRadio: true }), TWO_TRACKS), null);
  assert.equal(playContextPath(request({ resolvedTarget: 'linein:1', isLineIn: true }), TWO_TRACKS), null);
});

test('the context is kept once it has a name, and the zone is announced with it', async () => {
  const kept = zone();
  const asked: string[] = [];
  let announced = 0;
  rememberPlayContext(kept, request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS, {
    resolveFolder: async (_service, _user, id) => {
      asked.push(id);
      return { id, name: 'Abbey Road' };
    },
    onRemembered: () => {
      announced += 1;
    },
  });
  assert.equal(readPlayContext(kept), null, 'not before it is named');
  await settle();
  assert.deepEqual(readPlayContext(kept), { path: ALBUM, name: 'Abbey Road' });
  assert.deepEqual(asked, [ALBUM]);
  assert.equal(announced, 1);
});

test('a container that cannot be named is not remembered, and nothing is looked up without one', async () => {
  const unnamed = zone();
  let announced = 0;
  rememberPlayContext(unnamed, request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS, {
    resolveFolder: async () => null,
    onRemembered: () => {
      announced += 1;
    },
  });
  await settle();
  assert.equal(readPlayContext(unnamed), null);
  assert.equal(announced, 0);

  const single = zone();
  let lookups = 0;
  rememberPlayContext(single, request({ resolvedTarget: TRACK }), [{ audiopath: TRACK }], {
    resolveFolder: async () => {
      lookups += 1;
      return { id: TRACK, name: 'Whatever' };
    },
    onRemembered: () => {},
  });
  await settle();
  assert.equal(lookups, 0);
});

test('a lookup that throws does not reach the play request it rides along with', async () => {
  const kept = zone();
  // A content port without the lookup at all — which is what half the fakes in this suite are.
  const broken = undefined as unknown as () => Promise<null>;
  assert.doesNotThrow(() =>
    rememberPlayContext(kept, request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS, {
      resolveFolder: broken,
      onRemembered: () => {},
    }),
  );
  await settle();
  assert.equal(readPlayContext(kept), null);
});

test('a play request that was overtaken does not name the zone it lost', async () => {
  const kept = zone();
  const answers: Array<(name: string) => void> = [];
  const deps = {
    resolveFolder: (_service: string, _user: string, id: string) =>
      new Promise<{ id: string; name: string }>((resolve) => answers.push((name) => resolve({ id, name }))),
    onRemembered: () => {},
  };
  rememberPlayContext(kept, request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS, deps);
  await settle();
  rememberPlayContext(kept, request({ resolvedTarget: PLAYLIST, parentContext: { parent: PLAYLIST } }), TWO_TRACKS, deps);
  await settle();
  // The first lookup answers last.
  answers[1]!('Morning');
  answers[0]!('Abbey Road');
  await settle();
  assert.deepEqual(readPlayContext(kept), { path: PLAYLIST, name: 'Morning' });
});

test('the context ends with a new play request, and when another input takes the zone over', async () => {
  const kept: { metadata: Record<string, unknown>; inputMode: string } = zone();
  rememberPlayContext(kept as any, request({ resolvedTarget: ALBUM, parentContext: { parent: ALBUM } }), TWO_TRACKS, {
    resolveFolder: async (_service, _user, id) => ({ id, name: 'Abbey Road' }),
    onRemembered: () => {},
  });
  await settle();
  assert.equal(readPlayContext(kept as any)?.name, 'Abbey Road');

  // AirPlay or a line-in never pass a play request, so nothing clears the context — the
  // input it was remembered with is what says it no longer applies.
  kept.inputMode = 'airplay';
  assert.equal(readPlayContext(kept as any), null);
  kept.inputMode = 'queue';
  assert.equal(readPlayContext(kept as any)?.name, 'Abbey Road', 'and it is back when the queue is');

  forgetPlayContext(kept as any);
  assert.equal(readPlayContext(kept as any), null);
  assert.equal(readPlayContext(undefined), null, 'an unknown zone has none');
});
