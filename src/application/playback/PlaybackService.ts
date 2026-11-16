import type { EngineHandoffOptions, EnginePort } from '@/ports/EnginePort';
import type { EngineStartOptions, OutputProfile, PlaybackSource } from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { SessionKey } from '@/ports/types/SessionKey';

export class PlaybackService {
  private engine: EnginePort;

  constructor(engine: EnginePort) {
    this.engine = engine;
  }

  public start(options: EngineStartOptions): void;
  public start(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;

  public start(
    ...args: [EngineStartOptions] | [SessionKey, PlaybackSource, OutputProfile[]?, AudioOutputSettings?]
  ): void {
    (this.engine.start as (...args: any[]) => void)(...args);
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
    ...args: [EngineStartOptions] | [SessionKey, PlaybackSource, OutputProfile[]?, AudioOutputSettings?, EngineHandoffOptions?]
  ): void {
    (this.engine.startWithHandoff as (...args: any[]) => void)(...args);
  }

  public stop(...args: Parameters<EnginePort['stop']>): ReturnType<EnginePort['stop']> {
    return this.engine.stop(...args);
  }

  public restartZoneForEqualizer(
    ...args: Parameters<EnginePort['restartZoneForEqualizer']>
  ): ReturnType<EnginePort['restartZoneForEqualizer']> {
    return this.engine.restartZoneForEqualizer(...args);
  }

  public createStream(
    ...args: Parameters<EnginePort['createStream']>
  ): ReturnType<EnginePort['createStream']> {
    return this.engine.createStream(...args);
  }

  public createLocalSession(
    ...args: Parameters<EnginePort['createLocalSession']>
  ): ReturnType<EnginePort['createLocalSession']> {
    return this.engine.createLocalSession(...args);
  }

  public waitForFirstChunk(
    ...args: Parameters<EnginePort['waitForFirstChunk']>
  ): ReturnType<EnginePort['waitForFirstChunk']> {
    return this.engine.waitForFirstChunk(...args);
  }

  public inlineCrossfade(
    ...args: Parameters<EnginePort['inlineCrossfade']>
  ): ReturnType<EnginePort['inlineCrossfade']> {
    return this.engine.inlineCrossfade(...args);
  }

  public armNext(
    ...args: Parameters<NonNullable<EnginePort['armNext']>>
  ): ReturnType<NonNullable<EnginePort['armNext']>> {
    return this.engine.armNext?.(...args) ?? Promise.resolve(null);
  }

  public disarmNext(key: Parameters<NonNullable<EnginePort['disarmNext']>>[0]): void {
    this.engine.disarmNext?.(key);
  }

  public hasSession(
    ...args: Parameters<EnginePort['hasSession']>
  ): ReturnType<EnginePort['hasSession']> {
    return this.engine.hasSession(...args);
  }

  public getSessionStats(
    ...args: Parameters<EnginePort['getSessionStats']>
  ): ReturnType<EnginePort['getSessionStats']> {
    return this.engine.getSessionStats(...args);
  }

  public setSessionTerminationHandler(
    ...args: Parameters<EnginePort['setSessionTerminationHandler']>
  ): ReturnType<EnginePort['setSessionTerminationHandler']> {
    return this.engine.setSessionTerminationHandler(...args);
  }
}
