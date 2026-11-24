import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildLoxoneCoverUrl, toLoxoneZoneState } from '../src/adapters/loxone/ws/zoneStateProjection';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { AudioType, FileType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';

// The native Loxone client GETs `coverurl` itself and caches the bytes. Our gateway answers
// with CORS headers; a Sonos speaker, a streaming CDN or a station logo does not, so the fetch
// is refused and the player shows no artwork even though our own web UI (a plain <img>) does.
// The projection therefore names the zone, not the artwork's host.

const HOST = '192.168.1.10';

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 5,
    name: 'Wohnzimmer',
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
    coverurl: 'http://10.64.1.26:1400/getaa?s=1&u=x-sonos-spotify%3aspotify%3atrack%3a1',
    station: '',
    sourceName: 'Spotify',
    audiopath: 'spotify:track:1',
    audiotype: AudioType.Spotify,
    type: FileType.File,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qindex: 0,
    ...overrides,
  } as ZoneState;
}

test('a cover hosted elsewhere is named by the zone, so the client can fetch it', () => {
  const url = buildLoxoneCoverUrl(zoneState(), HOST);
  assert.ok(
    url.startsWith(`http://${HOST}:7090/api/v1/zones/5/cover?v=`),
    `expected a gateway url, got ${url}`,
  );
});

test('a cover the gateway already serves is left alone', () => {
  for (const coverurl of [
    `http://${HOST}:7090/music/Song/cover.jpg?cb=12`,
    'http://192.168.1.99:7090/music/Other/cover.jpg',
  ]) {
    assert.equal(buildLoxoneCoverUrl(zoneState({ coverurl }), HOST), coverurl);
  }
});

test('no cover stays no cover', () => {
  assert.equal(buildLoxoneCoverUrl(zoneState({ coverurl: '' }), HOST), '');
  assert.equal(buildLoxoneCoverUrl(zoneState({ coverurl: '   ' }), HOST), '');
});

test('inline artwork goes through the gateway too', () => {
  // A data uri cannot be fetched as a url at all; the gateway knows how to serve one.
  const url = buildLoxoneCoverUrl(zoneState({ coverurl: 'data:image/png;base64,AAAA' }), HOST);
  assert.ok(url.includes('/api/v1/zones/5/cover?v='), url);
});

test('the revision follows the artwork and nothing else', () => {
  const first = buildLoxoneCoverUrl(zoneState(), HOST);
  assert.equal(buildLoxoneCoverUrl(zoneState(), HOST), first, 'the same cover keeps its url');
  const next = buildLoxoneCoverUrl(
    zoneState({ coverurl: 'http://10.64.1.26:1400/getaa?s=1&u=x-sonos-spotify%3aspotify%3atrack%3a2' }),
    HOST,
  );
  assert.notEqual(next, first, 'a new track gets a new url, so the client refetches');
});

test('the projection only rewrites the artwork url', () => {
  const state = zoneState();
  const out = toLoxoneZoneState(state, {
    group: null,
    leaderVolume: 0,
    audiopathToLoxone: (path) => path,
    coverUrlToLoxone: (zone) => buildLoxoneCoverUrl(zone, HOST),
  });
  assert.ok(out.coverurl.startsWith(`http://${HOST}:7090/api/v1/zones/5/cover`));
  assert.equal(out.title, 'Song');
  assert.equal(out.artist, 'Artist');
  assert.equal(out.album, 'Album');
  // Without the rewrite the provider's url is what the client has always been given.
  assert.equal(
    toLoxoneZoneState(state, { group: null, leaderVolume: 0, audiopathToLoxone: (path) => path }).coverurl,
    state.coverurl,
  );
});

test('the notifier applies the cover rewrite on the event and the connect snapshot', () => {
  const sent: string[] = [];
  const notifier = new LoxoneWsNotifier(
    {
      registerConnection: () => {},
      unregisterConnection: () => {},
      broadcastMessage: (message: string) => sent.push(message),
    } as any,
    { getGroupByZone: () => null } as any,
  );
  notifier.setCoverUrlLookup((state) => buildLoxoneCoverUrl(state, HOST));

  const state = zoneState();
  notifier.notifyZoneStateChanged(state);
  const event = JSON.parse(sent[0] ?? '{}') as { audio_event?: Array<{ coverurl?: string }> };
  assert.ok(event.audio_event?.[0]?.coverurl?.startsWith(`http://${HOST}:7090/api/v1/zones/5/cover`));

  // The connect snapshot has to agree with the event, or a client that reconnects would show
  // the artwork only until the next state change.
  assert.equal(notifier.projectForLoxone(state).coverurl, event.audio_event?.[0]?.coverurl);
});
