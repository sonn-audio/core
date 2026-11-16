import assert from 'node:assert/strict';
import { test } from './testHarness';
import { declaredSourceRate, pickSessionRate } from '../src/application/playback/policies/sourceRatePolicy';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { computePreferredPlaybackSettings } from '../src/application/playback/policies/OutputFormatPolicy';
import { applyPreferredPlaybackSettings } from '../src/application/playback/PlaybackSettingsApplier';
import { audioOutputSettings } from '../src/ports/types/audioFormat';

// Every output named one rate and everything was converted to it, so a 48 kHz stream was
// resampled to 44.1 kHz on its way to a device that plays 48 kHz as it is.

const BASE = [44100, 48000];

test('session rate: a rate the output plays is left alone', () => {
  assert.equal(pickSessionRate(44100, BASE), 44100);
  assert.equal(pickSessionRate(48000, BASE), 48000);
});

test('session rate: a higher rate comes down within its own family', () => {
  assert.equal(pickSessionRate(96000, BASE), 48000);
  assert.equal(pickSessionRate(192000, BASE), 48000);
  assert.equal(pickSessionRate(88200, BASE), 44100);
  assert.equal(pickSessionRate(176400, BASE), 44100);
  assert.equal(pickSessionRate(96000, [44100, 48000, 96000, 192000]), 96000);
  assert.equal(pickSessionRate(192000, [44100, 48000, 96000]), 96000);
});

test('session rate: a lower rate goes up to a whole multiple where there is one', () => {
  assert.equal(pickSessionRate(22050, BASE), 44100);
  assert.equal(pickSessionRate(24000, BASE), 48000);
  assert.equal(pickSessionRate(16000, BASE), 48000);
  assert.equal(pickSessionRate(32000, BASE), 44100);
});

test('session rate: nothing to go on, nothing chosen', () => {
  assert.equal(pickSessionRate(48000, []), null);
  assert.equal(pickSessionRate(Number.NaN, BASE), null);
  assert.equal(declaredSourceRate(null), null);
  assert.equal(declaredSourceRate({ kind: 'url', url: 'http://x' } as never), null);
  assert.equal(
    declaredSourceRate({ kind: 'file', path: '/a.flac', nativeFormat: { sampleRate: 96000, channels: 2, lossless: true } } as never),
    96000,
  );
  assert.equal(declaredSourceRate({ kind: 'pipe', path: 'p', sampleRate: 48000 } as never), 48000);
});

function zoneWithOutput(preferred: Record<string, unknown>): ZoneAudioPreferences {
  const prefs = new ZoneAudioPreferences();
  const settings = computePreferredPlaybackSettings({
    zoneId: 1,
    zoneName: 'Room',
    audiopath: 'library:track:1',
    isRadio: false,
    outputs: [{ type: 'dlna', getPreferredOutput: () => preferred } as never],
    defaults: audioOutputSettings,
  });
  applyPreferredPlaybackSettings(prefs, 1, settings);
  return prefs;
}

test('an output that plays both base rates runs each source at its own', () => {
  const prefs = zoneWithOutput({ profile: 'flac', sampleRate: 44100, sampleRates: BASE, channels: 2 });
  assert.equal(prefs.getEffectiveOutputSettings(1).sampleRate, 44100, 'the default until a source says otherwise');
  prefs.matchSourceRate(1, 48000);
  assert.equal(prefs.getEffectiveOutputSettings(1).sampleRate, 48000);
  prefs.matchSourceRate(1, 96000);
  assert.equal(prefs.getEffectiveOutputSettings(1).sampleRate, 48000);
  // The next thing played does not state a rate: back to the default, not stuck on the last one.
  prefs.matchSourceRate(1, null);
  assert.equal(prefs.getEffectiveOutputSettings(1).sampleRate, 44100);
  assert.equal('sampleRates' in prefs.getEffectiveOutputSettings(1), false);
});

test('an output with one fixed rate keeps it whatever the source', () => {
  const prefs = zoneWithOutput({ profile: 'pcm', sampleRate: 44100, channels: 2 });
  prefs.matchSourceRate(1, 48000);
  assert.equal(prefs.getEffectiveOutputSettings(1).sampleRate, 44100);
});
