import assert from 'node:assert/strict';
import { test } from './testHarness';
import { tidalNativeFormat } from '../src/adapters/content/providers/tidal/tidalStreamService';

test('tidal: the playback answer states the rate and depth of a lossless stream', () => {
  assert.deepEqual(tidalNativeFormat({ sampleRate: 96000, bitDepth: 24, audioQuality: 'HI_RES_LOSSLESS' }), {
    sampleRate: 96000,
    channels: 2,
    lossless: true,
    bitDepth: 24,
    codecName: 'flac',
  });
});

test('tidal: a DASH manifest states the rate when the answer does not', () => {
  const manifest = '<MPD><Representation id="0" codecs="flac" audioSamplingRate="48000"/></MPD>';
  assert.equal(tidalNativeFormat({ audioQuality: 'HI_RES_LOSSLESS' }, manifest)?.sampleRate, 48000);
});

test('tidal: a lossy stream declares its rate and no depth', () => {
  assert.deepEqual(tidalNativeFormat({ sampleRate: 44100, bitDepth: 16, audioQuality: 'HIGH' }), {
    sampleRate: 44100,
    channels: 2,
    lossless: false,
  });
});

test('tidal: with no rate anywhere nothing is declared', () => {
  assert.equal(tidalNativeFormat({ audioQuality: 'LOSSLESS' }), undefined);
  assert.equal(tidalNativeFormat({ sampleRate: 'x' }, '<MPD/>'), undefined);
});
