import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AudioManager } from '../src/application/playback/audioManager';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import type { EnginePort, EngineSessionStats } from '../src/ports/EnginePort';
import type { EngineStartOptions, PlaybackSource } from '../src/ports/EngineTypes';
import type { SessionKey } from '../src/ports/types/SessionKey';

class EngineSpy implements EnginePort {
  public lastStartOptions: EngineStartOptions | null = null;

  public start(...args: [EngineStartOptions] | [SessionKey, PlaybackSource, any?, any?]): void {
    if (typeof args[0] === 'object' && args[0] !== null && 'zoneId' in args[0]) {
      this.lastStartOptions = args[0] as EngineStartOptions;
      return;
    }
    throw new Error('unexpected start signature in test');
  }

  public startWithHandoff(...args: [EngineStartOptions] | [SessionKey, PlaybackSource, any?, any?, any?]): void {
    this.start(...(args as [EngineStartOptions]));
  }

  public stop(): void {}

  public createStream(): null {
    return null;
  }

  public createLocalSession(): any {
    return {
      start: () => {},
      stop: () => {},
      createSubscriber: () => null,
    };
  }

  public waitForFirstChunk(): Promise<boolean> {
    return Promise.resolve(false);
  }

  public hasSession(): boolean {
    return false;
  }

  public getSessionStats(): EngineSessionStats[] {
    return [];
  }

  public setSessionTerminationHandler(): void {}

  public restartZoneForEqualizer(): boolean {
    return false;
  }

  public async inlineCrossfade(): Promise<boolean> {
    return false;
  }
}

const outputNotifier = {
  notifyOutputError: () => {},
  notifyOutputState: () => {},
  notifySourceDuration: () => {},
};

test('audio manager applies zone playback pre-delay to external URL sources', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 1200);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 1200);
});

test('audio manager keeps larger source pre-delay over zone playback pre-delay', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 600);

  manager.startExternalPlayback(
    1,
    'custom',
    { kind: 'file', path: '/tmp/test.mp3', preDelayMs: 1500 },
    undefined,
    true,
  );

  assert.equal(engine.lastStartOptions?.input.kind, 'file');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 1500);
});

test('audio manager skips zone playback pre-delay when zone power is already on', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  prefs.setPlaybackPreDelayMs(1, 1200);
  prefs.setZonePowerStateResolver((zoneId) => zoneId === 1);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, undefined);
});

test('audio manager forces alert pre-delay floor even when zone power is already on', () => {
  const engine = new EngineSpy();
  const service = new PlaybackService(engine);
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(service, outputNotifier, prefs);
  // Amp is warm (would normally skip the delay), but a sibling cold zone forces
  // an alignment floor so this zone waits the same wake-up delay.
  prefs.setZonePowerStateResolver((zoneId) => zoneId === 1);
  prefs.setAlertPreDelayFloorMs(1, 2000);

  manager.startExternalPlayback(1, 'custom', { kind: 'url', url: 'https://example.com/stream.mp3' }, undefined, true);

  assert.equal(engine.lastStartOptions?.input.kind, 'url');
  assert.equal((engine.lastStartOptions?.input as any).preDelayMs, 2000);
});

// A station cannot say what rate it broadcasts at, so its first play runs at the output's default
// and is converted if that is not the station's own. What ffmpeg reads off it then settles the
// rate of the next play.
test('audio manager runs a source at the rate it turned out to have, the next time it plays', async () => {
  class ReportingEngine extends EngineSpy {
    public override hasSession(): boolean {
      return true;
    }

    public override getSessionStats(): EngineSessionStats[] {
      return [{ sourceFormat: { codec: 'aac', sampleRate: 48000, channels: 2, bitDepth: null, bitrate: null } } as EngineSessionStats];
    }
  }
  const engine = new ReportingEngine();
  const prefs = new ZoneAudioPreferences();
  const manager = new AudioManager(new PlaybackService(engine), outputNotifier, prefs);
  (manager as unknown as { sourceRateLearnDelayMs: number }).sourceRateLearnDelayMs = 5;
  prefs.setPreferredOutputSettings(1, { sampleRate: 44100, sampleRates: [44100, 48000] });
  const station = { kind: 'url', url: 'https://radio.example/live' } as const;
  const metadata = { title: '', artist: '', album: '', audiopath: 'radio:example', isRadio: true };

  manager.startExternalPlayback(1, 'radio', station, metadata, false);
  assert.equal(engine.lastStartOptions?.outputs[0]?.sampleRate, 44100, 'nothing known yet: the default');

  await new Promise((resolve) => setTimeout(resolve, 30));
  manager.stopPlayback(1);
  manager.startExternalPlayback(1, 'radio', station, metadata, false);
  assert.equal(engine.lastStartOptions?.outputs[0]?.sampleRate, 48000);

  // A source that states its own rate is believed over anything remembered.
  manager.stopPlayback(1);
  manager.startExternalPlayback(
    1,
    'radio',
    { ...station, nativeFormat: { sampleRate: 44100, channels: 2, lossless: false } },
    metadata,
    false,
  );
  assert.equal(engine.lastStartOptions?.outputs[0]?.sampleRate, 44100);
});
