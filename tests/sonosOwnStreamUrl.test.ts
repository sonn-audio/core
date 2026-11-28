import assert from 'node:assert/strict';
import { test } from './testHarness';
import { isOwnStreamUrl } from '../src/domain/outputs/sonosIdentity';

// An S1 speaker playing our radio stream over SOAP reported it back as
// `x-rincon-mp3radio://http://<host>:7090/…`; taken for someone else's stream, the zone gave the
// speaker up half a second after starting it (#444).

const BASE = 'http://192.168.1.10:7090';

test('our stream is recognised under a nested scheme (#444)', () => {
  for (const url of [
    'x-rincon-mp3radio://192.168.1.10:7090/streams/18/current.mp3',
    'x-rincon-mp3radio://http://192.168.1.10:7090/streams/18/current.mp3?prime=1',
    'http://192.168.1.10:7090/streams/18/current.mp3',
  ]) {
    assert.equal(isOwnStreamUrl(url, BASE), true, url);
  }
});

test('someone else\'s stream stays someone else\'s, nested or not', () => {
  assert.equal(isOwnStreamUrl('x-rincon-mp3radio://http://radio.example.com/streams/1/live', BASE), false);
  assert.equal(isOwnStreamUrl('x-rincon-mp3radio://192.168.1.11:7090/streams/18/current.mp3', BASE), false);
  assert.equal(isOwnStreamUrl('x-sonos-htastream:RINCON_123:spdif', BASE), false);
});
