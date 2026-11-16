import type { PassThrough } from 'node:stream';
import type {
  EngineHandoffSpec,
  EngineInputSpec,
  EngineStartOptions,
  OutputProfile,
  PlaybackSource,
  ProcessingChain,
} from '@/ports/EngineTypes';
import type { AudioOutputSettings } from '@/ports/types/audioFormat';
import type { SessionKey } from '@/ports/types/SessionKey';

export type EngineSessionStats = {
  /**
   * When the session was created, as epoch ms.
   *
   * Lets a consumer order overlapping sessions. Starting a track whose format differs from the zone's
   * stored one leaves two alive for a moment — see `AudioSession.createdAt` — and without this the API
   * described whichever came first out of the map, which was the one being torn down.
   */
  startedAt: number;
  profile: OutputProfile;
  /**
   * The format this session actually encodes at. Callers must compare this — not
   * just `profile` — before reusing a session: a 48 kHz FLAC session matches the
   * 'flac' profile of a 96 kHz request, and reusing it would stream 48 kHz frames
   * under a stream/start that announced 96 kHz, which makes clients fail to decode.
   */
  sampleRate: number;
  channels: number;
  pcmBitDepth: number;
  bps: number | null;
  /** True only when a lossless source reaches the output without DSP or conversion. */
  bitPerfect: boolean;
  /** True when this server performs conversion, filtering, gain, delay or re-encoding. */
  dspApplied: boolean;
  /**
   * *What* it performs, stage by stage — see `ProcessingChain`.
   *
   * `dspApplied` answers "did anything touch this"; a listener with good speakers wants the next
   * question answered too, and the session already knows every part of it.
   */
  processing?: ProcessingChain | null;
  /** True while the two-stage crossfade path is blending, which requantises by definition. */
  crossfading?: boolean;
  /** Native source format when declared or successfully probed. */
  sourceFormat?: {
    codec: string;
    sampleRate: number;
    channels: number;
    bitDepth: number | null;
    bitrate: number | null;
  } | null;
  /**
   * Length of the source in seconds, once ffmpeg has stated it, else null.
   *
   * Read off the input banner rather than probed — see `AudioSession.observeSourceDuration`. Null means
   * "nobody has said yet", which for a live source is permanent and correct.
   */
  sourceDurationSec?: number | null;
  bufferedBytes: number;
  totalBytes: number;
  lastUpdated: number | null;
  subscribers: number;
  restarts: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastStderr: string | null;
  lastStderrAt: number | null;
  lastExitCode: number | null;
  lastExitSignal: string | null;
  lastExitAt: number | null;
  subscriberDrops: number;
  lastSubscriberDropAt: number | null;
};

export type EngineHandoffOptions = EngineHandoffSpec;

export type EngineLocalSession = {
  start: () => void;
  stop: () => void;
  createSubscriber: (options?: { primeWithBuffer?: boolean; label?: string }) => PassThrough | null;
};

export type EngineStopOptions = {
  discardSubscribers?: boolean;
};

export type EngineStreamOptions = {
  primeWithBuffer?: boolean;
  label?: string;
};

export type EngineSessionTerminationHandler = (
  key: SessionKey,
  stats: EngineSessionStats | null,
  reason?: string,
) => void;

export interface EnginePort {
  start(options: EngineStartOptions): void;
  start(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
  ): void;
  startWithHandoff(options: EngineStartOptions): void;
  startWithHandoff(
    key: SessionKey,
    source: PlaybackSource,
    profiles?: OutputProfile[],
    outputSettings?: AudioOutputSettings,
    options?: EngineHandoffOptions,
  ): void;
  stop(key: SessionKey, reason?: string, options?: EngineStopOptions): void;
  /**
   * @param resumeAtSec Playback position the respawned session should continue from. Omit for sources
   *   that carry no position (live input); a positioned source restarted without it replays from its
   *   original offset.
   */
  restartZoneForEqualizer(
    key: SessionKey,
    bands: ReadonlyArray<number> | null,
    resumeAtSec?: number,
  ): boolean;
  createStream(key: SessionKey, profile?: OutputProfile, options?: EngineStreamOptions): PassThrough | null;
  createLocalSession(
    key: SessionKey,
    source: PlaybackSource,
    profile: OutputProfile,
    outputSettings: AudioOutputSettings,
    onTerminated: () => void,
  ): EngineLocalSession;
  waitForFirstChunk(key: SessionKey, profile?: OutputProfile, timeoutMs?: number): Promise<boolean>;
  inlineCrossfade(
    key: SessionKey,
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean>;
  /**
   * Line `input` up to follow the session's current track without a gap.
   *
   * Resolves when the next track has taken over — with how many frames the outgoing one turned out
   * to have — or with null when it could not be done, in which case nothing changed and the current
   * track ends as it would have. Optional: an engine without it simply never joins tracks.
   */
  armNext?(key: SessionKey, input: EngineInputSpec): Promise<{ frames: number; sampleRate: number } | null>;
  /** Drop a track lined up with `armNext`. */
  disarmNext?(key: SessionKey): void;
  hasSession(key: SessionKey): boolean;
  getSessionStats(key: SessionKey): EngineSessionStats[];
  setSessionTerminationHandler(handler: EngineSessionTerminationHandler): void;
}
