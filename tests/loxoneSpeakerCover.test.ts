import assert from 'node:assert/strict';
import { test } from './testHarness';
import { loxoneCoverUrl } from '../src/adapters/loxone/ws/zoneStateProjection';

// The Loxone app showed no cover for a Sonos zone, whose art the speaker serves itself, while
// sonn's own web UI showed it (#449). Such art now reaches the client through sonn.

const ORIGIN = 'http://192.168.1.10:7090';
const SPEAKER_ART = 'http://192.168.20.34:1400/getaa?s=1&u=x-sonos-spotify%3Aspotify%3Atrack%3A1&cb=3';

test('a Sonos speaker\'s own art goes to Loxone through sonn\'s cover route (#449)', () => {
  const url = loxoneCoverUrl({ id: 5, coverurl: SPEAKER_ART }, ORIGIN);
  assert.match(url, /^http:\/\/192\.168\.1\.10:7090\/api\/v1\/zones\/5\/cover\?v=[0-9a-z]+$/);
  const next = loxoneCoverUrl({ id: 5, coverurl: SPEAKER_ART.replace('cb=3', 'cb=4') }, ORIGIN);
  assert.notEqual(next, url, 'the next track\'s art is a new url, so a cached cover moves on');
});

test('every other cover goes out as it is', () => {
  for (const coverurl of [
    'https://i.scdn.co/image/ab67616d0000b273',
    'http://192.168.1.10:7090/streams/5/abc/cover',
    'http://example.com:1400/other.jpg',
    '',
  ]) {
    assert.equal(loxoneCoverUrl({ id: 5, coverurl }, ORIGIN), coverurl);
  }
  assert.equal(loxoneCoverUrl({ id: 5, coverurl: SPEAKER_ART }, null), SPEAKER_ART, 'without an origin');
});
