import type { AudioStreamEngine } from '@/engine/audioStreamEngine';
import { AudioSession } from '@/engine/audioSession';
import type { EngineHandoffOptions, EngineLocalSession, EnginePort } from '@/ports/EnginePort';
import type {
  EngineOutputSpec,
  EngineInputSpec,
  EngineStartOptions,
  PlaybackSource,
  OutputProfile,
} from '@/ports/EngineTypes';
import { audioOutputSettings, type AudioOutputSettings } from '@/ports/types/audioFormat';
import type { SessionKey } from '@/ports/types/SessionKey';
import { toPlaybackSource } from '@/ports/playbackSourceMapping';

export class EngineAdapter implements EnginePort {
  constructor(private readonly engine: AudioStreamEngine) {}

  public start(options: EngineStartOptions): void;
  public start(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;

  public start(
    keyOrOptions: SessionKey | EngineStartOptions,
    source?: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void {
    if (typeof keyOrOptions === 'number') {
      this.engine.start(keyOrOptions, source as PlaybackSource, profiles, outputSettings);
      return;
    }
    const { zoneId, input, outputs, equalizer } = keyOrOptions;
    const playbackSource = toPlaybackSource(input);
    const { profiles: resolvedProfiles, outputSettings: resolvedSettings } = this.resolveOutputSpecs(outputs);
    const eqBands = equalizer?.bands ?? null;
    this.engine.start(zoneId, playbackSource, resolvedProfiles, resolvedSettings, eqBands);
  }

  public startWithHandoff(options: EngineStartOptions): void;
  public startWithHandoff(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void;

  public startWithHandoff(
    keyOrOptions: SessionKey | EngineStartOptions,
    source?: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void {
    if (typeof keyOrOptions === 'number') {
      this.engine.startWithHandoff(
        keyOrOptions,
        source as PlaybackSource,
        profiles,
        outputSettings,
        options,
      );
      return;
    }
    const { zoneId, input, outputs, handoff, equalizer } = keyOrOptions;
    const playbackSource = toPlaybackSource(input);
    const { profiles: resolvedProfiles, outputSettings: resolvedSettings } = this.resolveOutputSpecs(outputs);
    const eqBands = equalizer?.bands ?? null;
    this.engine.startWithHandoff(
      zoneId,
      playbackSource,
      resolvedProfiles,
      resolvedSettings,
      handoff ?? undefined,
      eqBands,
    );
  }

  public stop(...args: Parameters<EnginePort['stop']>): void {
    this.engine.stop(...args);
  }

  public restartZoneForEqualizer(
    ...args: Parameters<EnginePort['restartZoneForEqualizer']>
  ): boolean {
    return this.engine.restartZoneForEqualizer(...args);
  }

  public createStream(...args: Parameters<EnginePort['createStream']>): ReturnType<EnginePort['createStream']> {
    return this.engine.createStream(...args);
  }

  public waitForFirstChunk(...args: Parameters<EnginePort['waitForFirstChunk']>): ReturnType<EnginePort['waitForFirstChunk']> {
    return this.engine.waitForFirstChunk(...args);
  }

  public inlineCrossfade(...args: Parameters<EnginePort['inlineCrossfade']>): ReturnType<EnginePort['inlineCrossfade']> {
    return this.engine.inlineCrossfade(...args);
  }

  public armNext(key: SessionKey, input: EngineInputSpec): ReturnType<NonNullable<EnginePort['armNext']>> {
    return this.engine.armNext(key, toPlaybackSource(input));
  }

  public disarmNext(key: SessionKey): void {
    this.engine.disarmNext(key);
  }

  public hasSession(...args: Parameters<EnginePort['hasSession']>): boolean {
    return this.engine.hasSession(...args);
  }

  public getSessionStats(...args: Parameters<EnginePort['getSessionStats']>): ReturnType<EnginePort['getSessionStats']> {
    return this.engine.getSessionStats(...args);
  }

  public setSessionTerminationHandler(...args: Parameters<EnginePort['setSessionTerminationHandler']>): void {
    this.engine.setSessionTerminationHandler(...args);
  }

  public createLocalSession(
    key: SessionKey,
    source: PlaybackSource,
    profile: OutputProfile,
    outputSettings: AudioOutputSettings,
    onTerminated: () => void,
  ): EngineLocalSession {
    return new AudioSession(key, source, profile, onTerminated, outputSettings);
  }


  private resolveOutputSpecs(
    outputs: EngineOutputSpec[] | undefined,
  ): { profiles?: OutputProfile[]; outputSettings?: AudioOutputSettings } {
    if (!outputs || outputs.length === 0) {
      return { profiles: undefined, outputSettings: undefined };
    }
    const profiles = outputs.map((output) => output.profile);
    const primary = outputs[0]!;
    const outputSettings: AudioOutputSettings = {
      ...audioOutputSettings,
      sampleRate: Number.isFinite(primary.sampleRate) ? primary.sampleRate : audioOutputSettings.sampleRate,
      channels: Number.isFinite(primary.channels) ? primary.channels : audioOutputSettings.channels,
      pcmBitDepth: primary.pcmBitDepth ?? audioOutputSettings.pcmBitDepth,
      prebufferBytes: Number.isFinite(primary.prebufferBytes)
        ? primary.prebufferBytes
        : audioOutputSettings.prebufferBytes,
      fixedGainDb: Number.isFinite(primary.fixedGainDb)
        ? (primary.fixedGainDb as number)
        : audioOutputSettings.fixedGainDb,
    };
    return { profiles, outputSettings };
  }
}
