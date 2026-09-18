import assert from 'node:assert/strict';
import { test } from './testHarness';
import { readAdvertisedLane } from '../src/adapters/outputs/airplay/laneSender';

// #386. Moving every AirPlay zone onto the AirPlay 2 sender left receivers that only ever spoke
// AirPlay 1 with nothing to answer: the handshake they cannot complete was the only one offered.
// These pin what the device's own advertisement is allowed to decide.

// Bit 38 (unified media control) and bit 48 (CoreUtils pairing) are the two an AirPlay 2 receiver
// claims; the words are `0xLOW,0xHIGH`, so both live in the high word.
const AIRPLAY2_FEATURES = '0x4A7FCA00,0x1C340';
// A third-party AirPlay 1 speaker: audio, metadata, no pairing, no unified control.
const AIRPLAY1_FEATURES = '0x5A7FFFF7,0x1E';

test('an AirPlay 1 only advertisement never opens an AirPlay 2 session', () => {
  const { lane } = readAdvertisedLane({ host: '10.0.0.5', features: AIRPLAY1_FEATURES });
  assert.equal(lane, 'raop');
});

test('an AirPlay 2 advertisement picks the AirPlay 2 lane', () => {
  const { lane } = readAdvertisedLane({ host: '10.0.0.6', features: AIRPLAY2_FEATURES });
  assert.equal(lane, 'ap2');
});

test('a third-party receiver may fall back to RAOP, an Apple one may not', () => {
  const thirdParty = readAdvertisedLane({
    host: '10.0.0.7',
    features: AIRPLAY2_FEATURES,
    model: 'BeoLab 50',
  });
  assert.equal(thirdParty.appleReceiver, false);

  const apple = readAdvertisedLane({
    host: '10.0.0.8',
    features: AIRPLAY2_FEATURES,
    model: 'AudioAccessory5,1',
  });
  assert.equal(apple.appleReceiver, true);
});

test('a config saved before capabilities were recorded still starts at AirPlay 2', () => {
  const { lane, appleReceiver } = readAdvertisedLane({ host: '10.0.0.9', et: '0,4' });
  assert.equal(lane, 'ap2');
  // ...and is allowed to fall through, which is what rescues a legacy AirPlay 1 zone.
  assert.equal(appleReceiver, false);
});
