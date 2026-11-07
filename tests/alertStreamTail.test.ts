import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import { AudioStreamHandler } from '../src/adapters/http/streams/audioStreamHandler';
import { attachPlayerListeners } from '../src/application/zones/playback/playerListeners';
import type { AudioOutputSettings } from '../src/ports/types/audioFormat';

// Issue #387, as a DLNA renderer (Frontier Silicon) heard it: a 1.87 s announcement on a cold
// zone, with 1 s of wake-up silence in front. The stream advertised 2 s × 256 kbit as its
// Content-Length, so we closed the response a second before the speech was over.

const OUTPUT: AudioOutputSettings = {
  sampleRate: 44100,
  channels: 2,
  pcmBitDepth: 16,
  mp3Bitrate: '256k',
  prebufferBytes: 0,
  httpProfile: 'forced_content_length',
  httpFallbackSeconds: 12 * 3600,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'test',
};

function contentLengthFor(session: unknown): number | null {
  const handler = new AudioStreamHandler({} as any, {} as any, {} as any, {} as any) as any;
  return handler.estimateContentLength(
    'mp3',
    handler.resolveDurationSeconds(session),
    'forced_content_length',
    OUTPUT,
  );
}

test('the stream length covers the wake-up silence the engine puts in front (#387)', () => {
  const length = contentLengthFor({
    duration: 2,
    metadata: { duration: 2 },
    playbackSource: { kind: 'file', path: '/tts.mp3', preDelayMs: 1000 },
  });
  // 1 s of silence + 2 s of clip at 32 000 bytes a second.
  assert.equal(length, 96_000);
});

test('the stream length takes the longer of the engine and the alert duration', () => {
  // The engine rounds a 2.4 s clip to 2 s; the alert's metadata carries its stop margin.
  const length = contentLengthFor({
    duration: 2,
    metadata: { duration: 3 },
    playbackSource: { kind: 'file', path: '/tts.mp3' },
  });
  assert.equal(length, 96_000);
});

test('a track with no wake-up silence keeps its own length', () => {
  const length = contentLengthFor({
    duration: 180,
    metadata: { duration: 180 },
    playbackSource: { kind: 'file', path: '/track.mp3' },
  });
  assert.equal(length, 180 * 32_000);
});

function harness(alert: Record<string, unknown> | undefined) {
  const stops: number[] = [];
  const ends: number[] = [];
  const ctx: any = { id: 4, alert };
  const player = new EventEmitter() as any;
  attachPlayerListeners({
    coordinator: {
      getZone: () => ctx,
      applyPatch: () => {},
      dispatchOutputs: () => {},
      dispatchVolume: () => {},
      buildAbsoluteCoverUrl: (p: string) => p,
      audioHelpers: {} as any,
      stopAlert: async (zoneId: number) => {
        stops.push(zoneId);
      },
      handleEndOfTrack: async () => {
        ends.push(ctx.id);
      },
      handlePlaybackError: () => {},
    },
    player,
    outputs: [],
    zoneId: 4,
    zoneName: 'Wohnzimmer',
    sourceMac: '00:00:00:00:00:00',
  });
  return { player, stops, ends };
}

test('the zone clock leaves an alert to its stop window (#387)', () => {
  const stopTimer = setTimeout(() => {}, 60_000);
  try {
    const { player, stops, ends } = harness({ type: 'tts', title: 't', url: 'u', stopTimer });
    player.emit('ended', null);
    assert.deepEqual(stops, []);
    assert.deepEqual(ends, []);
  } finally {
    clearTimeout(stopTimer);
  }
});

test('the zone clock still ends an alert that has no stop window', () => {
  const { player, stops } = harness({ type: 'bell', title: 'b', url: 'u' });
  player.emit('ended', null);
  assert.deepEqual(stops, [4]);
});

test('a sync stream starts primed only when its url asks for it (#359)', () => {
  const primed: Array<boolean | undefined> = [];
  const engine = {
    createStream: (_key: string, _profile: string, options: { primeWithBuffer?: boolean }) => {
      primed.push(options.primeWithBuffer);
      return new EventEmitter();
    },
  };
  const handler = new AudioStreamHandler(engine as any, {} as any, {} as any, {} as any) as any;
  const open = (url: string, syncId: string) => {
    const entry = handler.getOrCreateSyncEntry(
      syncId,
      4,
      'flac',
      OUTPUT,
      { playbackSource: { kind: 'file', path: '/alerts/bell.mp3' } },
      2,
      handler.requestsPrimedSync({ url }),
    );
    handler.cleanupSyncEntry(entry);
  };

  // An alert shared by several players is handed out from its first byte.
  open('/streams/4/a1.flac?prime=1&sync=alert-1&expect=2', 'alert-1');
  // A sync group's music, and anything that does not say, joins live as before.
  open('/streams/4/current.flac?prime=0&sync=4-s1&expect=2', '4-s1');
  open('/streams/4/current.flac?sync=4-s2&expect=2', '4-s2');
  assert.deepEqual(primed, [true, false, false]);
});
