import assert from 'node:assert/strict';
import { test } from './testHarness';
import { executePlaybackPlan } from '../src/application/playback/executePlaybackPlan';
import { QueueAdvanceController } from '../src/application/zones/playback/queueAdvanceController';
import type { PlaybackPlan } from '../src/application/playback/types/PlaybackPlan';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ContentPort } from '../src/ports/ContentPort';
import type { InputsPort } from '../src/ports/InputsPort';

// After a Sonos went to a source of its own (Spotify from the app, Alexa), sonn took it back
// minutes later with the next item of its queue (#452).

const log = { debug: () => undefined, info: () => undefined, warn: () => undefined } as never;
const prefs = {
  setPreferredOutputSettings: () => undefined,
  setHttpPreferences: () => undefined,
  setInputPreferences: () => undefined,
} as never;

test('a held queue does not advance at the end of a track (#452)', async () => {
  const controller = new QueueAdvanceController({ log } as never);
  const ctx = { id: 7, queueHeld: true } as unknown as ZoneContext;
  // Any further step would need the deps this test does not give; returning is the point.
  await controller.advanceTrack(ctx);
});

test('a start that was resolving when the speaker went elsewhere does not take it back (#452)', async () => {
  const played: string[] = [];
  const stopped: string[] = [];
  const ctx = {
    id: 7,
    name: 'Kitchen',
    yieldCount: 0,
    queue: { items: [] },
    queueController: { current: () => null, currentIndex: () => 0 },
    player: { playExternal: (label: string) => void played.push(label) },
  } as unknown as ZoneContext;
  const inputs = {
    getPlaybackSourceForUri: async () => {
      ctx.yieldCount = 1; // the speaker went to the Spotify app while the run was starting
      return { kind: 'pipe' };
    },
    stopSpotifySession: (zoneId: number, reason: string) => void stopped.push(`${zoneId}:${reason}`),
  } as unknown as InputsPort;
  const plan: PlaybackPlan = {
    zoneId: 7,
    zoneName: 'Kitchen',
    audiopath: 'spotify:track:abc',
    kind: 'queue',
    isRadio: false,
    provider: null,
    playExternalLabel: 'spotify',
    needsStreamResolution: true,
    metadata: { title: 'Track', artist: '', album: '' },
    preferredSettings: { outputOverride: null },
  } as PlaybackPlan;
  const session = await executePlaybackPlan({ ctx, plan, content: {} as ContentPort, inputs, log, zoneAudioPrefs: prefs });
  assert.equal(session, null);
  assert.deepEqual(played, [], 'nothing reaches the speaker');
  assert.deepEqual(stopped, ['7:switch_to_external'], 'the run that came up late is let go of');
});
