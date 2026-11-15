import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from './testHarness';
import { loudnessContour, loudnessContourChanges, withLoudness } from '../src/domain/zones/loudness';
import { bandsAreActive, equalizerPeakGainDb } from '../src/engine/pcmDsp';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import { buildLoxoneHttpConfig } from '../src/config/loxone';

// Loudness compensation: a bass and treble lift that follows the zone's volume, laid over the
// zone's own equalizer and applied by the same DSP stage.

test('loudness lifts the ends of the spectrum most when the zone is quiet', () => {
  const quiet = loudnessContour(10);
  const loud = loudnessContour(70);
  assert.ok(quiet[0]! > loud[0]!, 'more bass lift at low volume');
  assert.ok(quiet[9]! > loud[9]!, 'more treble lift at low volume');
  assert.ok(quiet[0]! > quiet[9]!, 'the bass gets more than the treble');
  assert.deepEqual(quiet.slice(4, 8), [0, 0, 0, 0], 'the midrange is left alone');
});

test('loudness fades out as the zone is turned up, but never goes exactly flat', () => {
  for (const volume of [80, 90, 100]) {
    const contour = loudnessContour(volume);
    assert.ok(Math.max(...contour) <= 0.1, `nothing audible left at volume ${volume}`);
    // Flat would let the stream drop back to its untouched path, and coming back from there
    // restarts the decoder — a hiccup for turning the volume down.
    assert.ok(bandsAreActive(contour), `the stage stays in place at volume ${volume}`);
  }
});

test('loudness adds to the equalizer the zone already has', () => {
  const own = [2, 0, 0, 0, 0, 0, 0, 0, 0, -3];
  const contour = loudnessContour(20);
  const combined = withLoudness(own, 20);
  assert.equal(combined.length, 10);
  assert.equal(combined[0], 2 + contour[0]!);
  assert.equal(combined[9], -3 + contour[9]!);
  assert.deepEqual(withLoudness(null, 20), contour, 'a zone without an equalizer gets the lift alone');
});

test('loudness never asks the DSP for more than the lift it was designed with', () => {
  // The DSP gives a boosting curve its headroom by attenuating first, so the peak of this curve
  // is how much level the switch costs at the quietest setting.
  const peak = equalizerPeakGainDb(loudnessContour(0), 48_000);
  assert.ok(peak > 5 && peak < 9, `peak of the full contour is ${peak.toFixed(2)} dB`);
});

test('a volume change only moves the curve when it crosses a step', () => {
  assert.equal(loudnessContourChanges(40, 40), false);
  // One notch of volume usually lands inside a step. Counted over the whole range rather than
  // asserted for one pair: which notches cross a boundary is arithmetic, not a promise.
  const crossings = Array.from({ length: 100 }, (_unused, volume) => loudnessContourChanges(volume, volume + 1));
  const moved = crossings.filter(Boolean).length;
  assert.ok(moved > 0 && moved < 50, `${moved} of 100 single notches move the curve`);
  assert.equal(loudnessContourChanges(40, 20), true);
  assert.equal(loudnessContourChanges(90, 100), false, 'above the reference there is nothing to move');
});

// --- the Loxone app's switch (shared-app.js 11672 GetLoudnessSchema, 17413 SetLoudnessSchema) ---

const LoudnessResponse = z.object({ command: z.string(), loudness_result: z.coerce.boolean() });

function loudnessHandlers(state: { on: boolean }, calls: unknown[][]) {
  return createZoneHandlers(
    {
      getLoudness: (zoneId: number) => (zoneId === 7 ? state.on : null),
      setLoudness: async (zoneId: number, enabled: boolean) => {
        calls.push([zoneId, enabled]);
        if (zoneId !== 7) return null;
        state.on = enabled;
        return enabled;
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
  );
}

function answer(result: unknown): boolean {
  const frame = JSON.parse(serializeResult(result as any));
  // `z.coerce.boolean()` turns any non-empty string into true, so the answer has to be a real
  // boolean for "off" to read as off.
  assert.equal(typeof frame.loudness_result, 'boolean');
  return LoudnessResponse.parse(frame).loudness_result;
}

test('the app reads and sets the loudness switch of a zone', async () => {
  const state = { on: false };
  const calls: unknown[][] = [];
  const handlers = loudnessHandlers(state, calls);
  assert.equal(answer(await handlers.audioLoudness('audio/7/loudness')), false);
  assert.equal(answer(await handlers.audioLoudness('audio/7/loudness/1')), true);
  assert.equal(answer(await handlers.audioLoudness('audio/7/loudness')), true);
  assert.equal(answer(await handlers.audioLoudness('audio/7/loudness/0')), false);
  assert.deepEqual(calls, [
    [7, true],
    [7, false],
  ]);
  assert.equal(answer(await handlers.audioLoudness('audio/99/loudness/1')), false, 'an unknown zone stays off');
});

test('the firmware we announce is one the app offers the loudness switch for', () => {
  // `LoudnessSwitch: { api: "1.6", firmware: "18.1.0.0" }` in the app's feature table; it
  // compares the four numbers one by one.
  const config = buildLoxoneHttpConfig({ appHttpPort: 7091, msHttpPort: 7095 } as any);
  const announced = config.firmwareVersionNumber.split('.').map(Number);
  const required = [18, 1, 0, 0];
  const first = announced.findIndex((part, index) => part !== required[index]);
  assert.ok(first === -1 || announced[first]! > required[first]!, `announced ${announced.join('.')}`);
});
