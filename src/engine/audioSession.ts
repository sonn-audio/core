import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { serverClockUs } from '@/shared/audio/serverClock';
import { ffmpegBinary, FfmpegProcess } from '@/engine/ffmpegProcess';
import {
  mp3BitrateToBps,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import { pcmBitDepthFromFormat } from '@/ports/types/audioFormat';
import { RollingBuffer } from '@/engine/rollingBuffer';
import { SubscriberFanout } from '@/engine/subscriberFanout';
import { OutputPacer } from '@/engine/outputPacer';
import { PcmFrameAligner } from '@/engine/pcmFrameAligner';
import { codecPolicyForProfile, type CodecPolicy } from '@/engine/codecPolicy';
import type { OutputProfile } from '@/ports/EngineTypes';
import type { EngineSessionStats } from '@/ports/EnginePort';
import type { SessionKey } from '@/ports/types/SessionKey';
import { FfmpegArgBuilder, type SourceNativeFormat } from '@/engine/ffmpegArgs';
import { getCachedSourceFormat } from '@/engine/sourceProbe';
import { PipeSourceAdapter } from '@/engine/pipeSourceAdapter';
import { PcmDspStage } from '@/engine/pcmDsp';
import { TwoStagePipeline } from '@/engine/twoStagePipeline';
import { FirstChunkBarrier } from '@/engine/firstChunkBarrier';
import { SessionStarter } from '@/engine/sessionStarter';
import { Crossfader } from '@/engine/crossfader';

export type { OutputProfile };

import type { PlaybackSource } from '@/engine/playbackSource';
export type { PlaybackSource };

// Internal restart-on-failure backoff. The counter tracks *consecutive* failed
// restarts and is reset to 0 once the restarted ffmpeg produces its first chunk
// (i.e. it actually recovered). Without that reset a transient failure would
// permanently consume the budget; without the cap a persistently failing source
// would hot-loop forever.
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_STEP_MS = 100;
const RESTART_BACKOFF_MAX_MS = 500;
/**
 * How long a finished session keeps its buffer for an output that has not fetched it yet.
 *
 * Outputs that pull over HTTP (Squeezelite, Music Assistant) run their file input unpaced — see
 * `OutputFormatPolicy` — so ffmpeg reaches EOF in tens of milliseconds while the player is still
 * being told which URL to fetch. Tearing the session down on that exit made every short alert and
 * TTS clip answer the player's GET with a 404 (#331): the audio existed, complete, in the buffer,
 * and was thrown away a few milliseconds before anyone asked for it.
 *
 * Only sessions nobody has subscribed to wait; once an output is attached it has been primed with
 * the whole buffer, so a normal track end still tears down at once and the queue advances as before.
 */
const LATE_SUBSCRIBER_GRACE_MS = 5000;

/** How long a session may produce audio with no subscriber before the log says so. */
const UNHEARD_WARN_MS = 60_000;

function sourceFormatFor(
  source: PlaybackSource,
  nativeFormat: SourceNativeFormat | undefined,
): EngineSessionStats['sourceFormat'] {
  // A declaring pipe is described from its own spec rather than from the native format derived
  // out of it: both carry the same numbers, but raw PCM's bitrate follows from them exactly and
  // is worth stating. Everything else is described by whatever declared or probed it.
  if (source.kind === 'pipe' && source.sampleRate && source.channels && source.format) {
    // What is in the samples outranks what the words could hold: a pipe is declared wide enough
    // for the worst case it may carry, so the container alone would overstate a narrower master.
    const bitDepth = source.bitDepth ?? pcmBitDepthFromFormat(source.format);
    return {
      codec: 'pcm',
      sampleRate: source.sampleRate,
      channels: source.channels,
      bitDepth,
      bitrate: source.sampleRate * source.channels * bitDepth,
    };
  }
  if (nativeFormat) {
    return {
      codec: nativeFormat.codecName ?? 'unknown',
      sampleRate: nativeFormat.sampleRate,
      channels: nativeFormat.channels,
      bitDepth: nativeFormat.bitDepth,
      bitrate: null,
    };
  }
  return null;
}

export class AudioSession {
  // ─── Internals exposed for SessionStarter and Crossfader ─────────────────
  // The fields and helpers below carry `@internal` semantics: they are public
  // for cross-module orchestration (sessionStarter.ts, crossfader.ts) but are
  // NOT part of the EnginePort surface — external consumers should only use
  // start/stop/createSubscriber/etc. on this class.

  /** @internal */ public readonly log = createLogger('Audio', 'Session');
  /** @internal */ public readonly fanout: SubscriberFanout;
  /** @internal */ public process?: FfmpegProcess;
  /** @internal */ public ending = false;
  /** @internal */ public readonly ffmpegPath = ffmpegBinary();

  /** @internal */ public readonly buffer: RollingBuffer;
  /** @internal */ public readonly firstChunk = new FirstChunkBarrier();
  private bytesSinceLog = 0;
  private lastLogTs = 0;
  /** Since when audio has been produced with no subscriber, while that lasts. */
  private unheardSince: number | null = null;
  private unheardWarned = false;
  private totalBytes = 0;
  private lastBps = 0;
  private lastBpsTs = 0;
  // Consecutive failed restarts (backoff budget); reset to 0 on first chunk after recovery.
  private restartAttempts = 0;
  // Lifetime restart count for stats; never reset on recovery (unlike restartAttempts).
  private totalRestarts = 0;
  private readonly targetLeadMs: number;
  private lastStderrLine: string | null = null;
  private lastStderrAt: number | null = null;
  private lastErrorMessage: string | null = null;
  private lastErrorAt: number | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastExitAt: number | null = null;
  /** @internal */ public startTs: number | null = null;
  /**
   * When this session object was created.
   *
   * Not the same as `startTs` (when ffmpeg was last spawned, which a restart moves): this is the identity
   * of the session, and it is what lets a consumer tell a *replacement* from the session it replaced.
   * Starting a track with a new output format briefly leaves both alive — the manager starts one with the
   * zone's stored format and the output restarts it with the negotiated one — and a reader that cannot
   * order them describes whichever the map yields first.
   */
  private readonly createdAt = Date.now();
  private readonly sourcePreDelayMs?: number;
  private sourceFormat: EngineSessionStats['sourceFormat'];
  /** Length of the source as ffmpeg reported it, or null while nobody has said (see `observeSourceDuration`). */
  private sourceDurationSec: number | null = null;
  private readonly bitPerfect: boolean;
  private readonly dspApplied: boolean;
  private debugTapStream?: fs.WriteStream;
  /** @internal */ public readonly pipeSource = new PipeSourceAdapter();
  /** @internal */ public directPipeMode = false;
  /**
   * @internal Our own DSP stage, when this session runs the engine-DSP topology. Present means the
   * gain and the equalizer are ours, and an EQ change is a coefficient swap rather than a respawn.
   */
  public dsp?: PcmDspStage;
  /** @internal True while the engine-DSP topology owns the pipeline. */
  public engineDspMode = false;
  /**
   * @internal The readable whose backpressure throttles the producer when no encoder process sits at
   * the end (PCM profile in engine-DSP mode). Pausing it propagates up the pipe chain to the decoder.
   */
  public outputReadable?: NodeJS.ReadableStream;
  /**
   * @internal Where a live pipe source is currently piped, so cleanup can unpipe it. Leaving a source
   * piped into a dead ffmpeg stdin looks like a working stream and delivers nothing: the readable stays
   * flowing into a destroyed destination, and the next topology never sees a byte.
   */
  public pipeTarget?: NodeJS.WritableStream;
  // Two-stage PCM pipeline (decoder → pcmPipe → encoderInput → encoder).
  // Public fields on the pipeline object since crossfade orchestration needs to
  // unpipe/replace them mid-blend; see twoStagePipeline.ts for the contract.
  /** @internal */ public readonly pipeline: TwoStagePipeline;
  /** @internal */ public crossfadeActive = false;
  private discardSubscribersOnStop = false;
  private restartingForEq = false;
  /** Set while the producer is done but the buffer is being held for an output that has yet to ask. */
  private awaitingLateSubscriber: NodeJS.Timeout | null = null;
  /** @internal */ public stdoutPaused = false;
  private readonly pacer: OutputPacer;
  // When streaming raw PCM, ensure we only emit full audio frames.
  // Otherwise, a subscriber that attaches mid-stream can start at an arbitrary byte offset,
  // which results in loud noise (misaligned sample boundaries).
  /** @internal */ public readonly pcmAligner: PcmFrameAligner | null;
  /** @internal */ public readonly codec: CodecPolicy;
  /**
   * @internal Rebuilt (not mutated) whenever a restart has to resume somewhere other than the
   * source's original offset — see {@link restartForEqualizer}.
   */
  public args: FfmpegArgBuilder;
  private readonly isAlertSource: boolean;
  private readonly nativeFormat: SourceNativeFormat | undefined;
  // For codec streams (FLAC, etc.), store the initial header so new subscribers
  // joining mid-stream can initialize their decoders correctly.
  /** @internal */ public codecHeader: Buffer | null = null;
  private readonly starter: SessionStarter;
  private readonly crossfader: Crossfader;

  constructor(
    /**
     * @internal Engine session key. For zone playback this equals the zoneId;
     * for a non-zone consumer it is an ephemeral key. Used only as a log/label
     * value here — the session carries no zone semantics.
     */
    public readonly zoneId: SessionKey,
    /** @internal */ public readonly source: PlaybackSource,
    /** @internal */ public readonly profile: OutputProfile,
    private readonly onTerminated: () => void,
    /** @internal */ public readonly outputSettings: AudioOutputSettings,
    /** @internal */ public equalizerBands: ReadonlyArray<number> | null = null,
    /**
     * When true (default), file/URL sources use the two-stage pipeline
     * (decoder + encoder) so inlineCrossfade can blend PCM mid-stream. When
     * false, file/URL run a single ffmpeg — half the process count and no
     * encoderInput/pcmPipe state. Set by AudioStreamEngine based on the
     * system-wide `audioserver.crossfadeSec` config.
     */
    public readonly crossfadeEnabled: boolean = true,
    /** Receives aligned PCM frames for protocol-neutral realtime analysis. */
    private readonly onPcmFrame?: (zoneId: SessionKey, pcm: Buffer, timestampUs: number) => void,
  ) {
    const candidate = outputSettings.prebufferBytes;
    const hardMax = 1024 * 1024 * 4;
    const hardMin = 1024 * 8; // keep a small guard when enabled
    this.sourcePreDelayMs =
      'preDelayMs' in this.source && typeof this.source.preDelayMs === 'number'
        ? this.source.preDelayMs
        : undefined;
    // Fixed lead to reduce startup latency across outputs.
    this.targetLeadMs = 1000;
    const alertPrebufferMs = 6000;
    const isAlertSource =
      this.source.kind === 'file' &&
      typeof this.source.path === 'string' &&
      this.source.path.includes('/alerts/');
    const alertBufferBytes = isAlertSource
      ? Math.round(
          (alertPrebufferMs / 1000) *
            (outputSettings.sampleRate * outputSettings.channels * (outputSettings.pcmBitDepth / 8)),
        )
      : 0;
    let maxBufferBytes: number;
    if (!Number.isFinite(candidate) || candidate <= 0) {
      // Allow disabling the rolling buffer; we still stream live without caching chunks.
      maxBufferBytes = 0;
    } else {
      // Allow larger prebuffer when upstream requests it (e.g., Sendspin wants ~5s).
      // Keep a safety cap to avoid unbounded memory; 4MB is still modest.
      const requested = Math.min(candidate, hardMax);
      maxBufferBytes = Math.max(requested, hardMin);
    }
    if (alertBufferBytes > 0) {
      const clampedAlert = Math.min(hardMax, Math.max(alertBufferBytes, hardMin));
      maxBufferBytes = Math.max(maxBufferBytes, clampedAlert);
    }
    this.buffer = new RollingBuffer(maxBufferBytes, isAlertSource);
    this.fanout = new SubscriberFanout(
      {
        pause: () => this.pauseStdout(),
        resume: () => this.resumeStdout(),
      },
      this.log,
      1024 * 1024,
    );

    // When URL input pacing is explicitly disabled (realTime=false), ffmpeg may process finite
    // sources (e.g. Apple Music track MP4s) far ahead of wall clock time and then exit,
    // terminating the session while pull-based outputs (Cast) still expect a live stream.
    // We prevent that by backpressuring ffmpeg stdout to keep a bounded lead buffer.
    const pacingBps = this.computePacingBps() ?? 0;
    const minLeadBytes =
      pacingBps > 0 && this.targetLeadMs > 0
        ? Math.round((pacingBps * this.targetLeadMs) / 1000)
        : 0;
    const pacingMaxAheadBytes = Math.max(minLeadBytes, maxBufferBytes, 0);
    this.pacer = new OutputPacer(
      pacingBps,
      pacingMaxAheadBytes,
      {
        hasBackpressure: () => this.fanout.hasBackpressure(),
        subscriberCount: () => this.fanout.size,
      },
      {
        pause: () => this.pauseStdout(),
        resume: () => this.resumeStdout(),
      },
      this.log,
      { zoneId: this.zoneId, profile: this.profile },
    );

    this.pcmAligner =
      this.profile === 'pcm'
        ? new PcmFrameAligner(this.outputSettings.channels, this.outputSettings.pcmBitDepth)
        : null;
    this.codec = codecPolicyForProfile(this.profile);
    // Bit-perfect passthrough needs the source's native format. The probe is async
    // and this constructor is not, so we only read the cache that the caller
    // (e.g. sendspinOutput before engine.start) populated. A cache miss simply
    // means "resample as before" — never a stall.
    // URL sources carry a provider-declared format (no probing — see sourceProbe);
    // local files use the cache that the caller populated before engine.start.
    const nativeFormat = ((): SourceNativeFormat | undefined => {
      if (this.source.kind === 'url') {
        const declared = this.source.nativeFormat;
        if (!declared) {
          return undefined;
        }
        return {
          sampleRate: declared.sampleRate,
          channels: declared.channels,
          bitDepth: declared.bitDepth ?? null,
          lossless: declared.lossless,
          codecName: declared.codecName,
        };
      }
      if (this.source.kind === 'file') {
        // A declaration beats the cache: the library records the format during its scan, so a track
        // that has been scanned needs no probe at all. The cache remains the answer for a file
        // nothing has declared — an alert, or a track a caller probed itself before starting.
        const declared = this.source.nativeFormat;
        if (declared) {
          return {
            sampleRate: declared.sampleRate,
            channels: declared.channels,
            bitDepth: declared.bitDepth ?? null,
            lossless: declared.lossless,
            codecName: declared.codecName,
          };
        }
        return getCachedSourceFormat(this.source.path) ?? undefined;
      }
      if (this.source.kind === 'pipe') {
        /*
         * A pipe's spec *is* its probe: these are the very numbers this builder hands ffmpeg as
         * `-f s24le -ar 44100 -ac 2`, so nothing here is being taken on trust that the decode does
         * not already depend on.
         *
         * Without this a pipe had no native format, and `isBitPerfect` says no to a source it
         * cannot see — so a 44.1 kHz/24-bit feed matched by a 44.1 kHz/24-bit output still got the
         * terminal soxr stage, converting samples into the format they were already in. Spotify via
         * Soloist is that feed. `pipeMatchesOutput` stays below as the fallback for a pipe that
         * declares nothing; it only ever recognised a fixed 16-bit shape.
         *
         * `lossless` is a claim about these samples and not their origin: raw PCM arrives as-is, so
         * the declared depth is the real one and there is no encoder between us and it.
         */
        const { sampleRate, channels, format } = this.source;
        if (!sampleRate || !channels || !format) {
          return undefined;
        }
        return {
          sampleRate,
          channels,
          bitDepth: pcmBitDepthFromFormat(format),
          lossless: true,
          codecName: 'pcm',
        };
      }
      return undefined;
    })();
    this.sourceFormat = sourceFormatFor(this.source, nativeFormat);
    this.isAlertSource = isAlertSource;
    this.nativeFormat = nativeFormat;
    this.args = this.buildArgBuilder();
    const losslessSource = nativeFormat?.lossless === true ||
      (this.sourceFormat?.codec.startsWith('pcm_') === true || this.sourceFormat?.codec === 'flac');
    this.bitPerfect = losslessSource && this.args.isBitPerfect(this.equalizerBands);
    this.dspApplied = !this.args.isBitPerfect(this.equalizerBands);
    this.pipeline = new TwoStagePipeline(
      this.log,
      { zoneId: this.zoneId, profile: this.profile },
      // The decoder reads *this* session's source, so its banner describes this track. The crossfade
      // decoders in `Crossfader` deliberately do not report here: those read the *next* track, and
      // their duration would overwrite the playing one.
      (message) => this.observeBanner(message),
    );
    this.starter = new SessionStarter(this);
    this.crossfader = new Crossfader(this);
  }

  /**
   * Command-line builder for this session, optionally seeking somewhere other than the source's own
   * `startAtSec`. Only file and URL sources can be positioned; a live pipe has no offset to seek to
   * and simply continues where it is.
   */
  private buildArgBuilder(resumeAtSec?: number): FfmpegArgBuilder {
    const seekable = this.source.kind === 'file' || this.source.kind === 'url';
    const source =
      seekable && typeof resumeAtSec === 'number' && Number.isFinite(resumeAtSec) && resumeAtSec > 0
        ? ({ ...this.source, startAtSec: resumeAtSec } as PlaybackSource)
        : this.source;
    return new FfmpegArgBuilder(
      source,
      this.profile,
      this.outputSettings,
      this.isAlertSource,
      this.sourcePreDelayMs,
      this.nativeFormat,
    );
  }

  /** @internal */ public alignPcmChunk(chunk: Buffer): Buffer | null {
    return this.pcmAligner ? this.pcmAligner.align(chunk) : chunk;
  }

  /**
   * The one way audio leaves this session, whoever produced it: an ffmpeg stdout, a direct pipe or our
   * own DSP stage. Alignment, the first-chunk barrier, the codec header, the rolling buffer, the
   * analysis tap, the subscribers and the pacer all hang off this single point — they used to be
   * copied per topology, which is how the direct-pipe path ended up with its own subtly different one.
   *
   * @param firstChunkLabel Log line for the first chunk, or null to stay quiet (the caller logs it).
   */
  /** @internal */ public emitOutputChunk(
    chunk: Buffer,
    options: { firstChunkLabel?: string | null } = {},
  ): void {
    if (!chunk?.length) {
      return;
    }
    const aligned = this.profile === 'pcm' ? this.alignPcmChunk(chunk) : chunk;
    if (!aligned?.length) {
      // Hold until we have a full PCM frame so new subscribers don't start mid-sample.
      this.recordBytes(chunk.length);
      this.maybeApplyOutputPacing();
      return;
    }
    if (this.firstChunk.signal()) {
      // A restarted producer reached output → it recovered; reset the backoff budget.
      this.restartAttempts = 0;
      const label = options.firstChunkLabel;
      if (label) {
        this.log.info(label, {
          zoneId: this.zoneId,
          profile: this.profile,
          bytes: aligned.length,
          spawnToFirstChunkMs: this.startTs ? Math.max(0, Date.now() - this.startTs) : null,
        });
      }
      this.codecHeader = this.codec.captureHeader(aligned);
    }
    this.buffer.push(aligned);
    this.recordBytes(chunk.length);
    if (this.profile === 'pcm') {
      // The audio timeline, not wall time — see serverClockUs. Sendspin's frame timestamps are
      // on this clock, and analysis consumers cannot mix the two.
      this.onPcmFrame?.(this.zoneId, aligned, serverClockUs());
    }
    this.writeToSubscribers(aligned);
    this.maybeApplyOutputPacing();
  }

  private bufferedChunkStartsWithCodecHeader(): boolean {
    const firstBufferedChunk = this.buffer.firstChunk();
    return Boolean(firstBufferedChunk && this.codec.startsWithHeader(firstBufferedChunk));
  }

  /**
   * True when this session's DSP belongs on our own PCM stage rather than on ffmpeg's command line.
   *
   * Every source kind qualifies — ffmpeg decodes to float first either way — except under crossfade,
   * whose blender splices the integer bus and would have to learn the new shape. That path keeps its
   * DSP in the encoder.
   */
  private usesEngineDsp(): boolean {
    if (this.crossfadeEnabled) {
      return false;
    }
    return this.args.engineDspSpec(this.equalizerBands) !== null;
  }

  public start(): void {
    if (this.process || this.engineDspMode) {
      return;
    }
    if (this.awaitingLateSubscriber) {
      // A new source supersedes whatever we were holding the old buffer for.
      clearTimeout(this.awaitingLateSubscriber);
      this.awaitingLateSubscriber = null;
    }
    this.buffer.clear();
    this.pcmAligner?.reset();
    this.codecHeader = null;
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.totalBytes = 0;
    this.firstChunk.arm();
    this.log.info('audio session buffer config', {
      zoneId: this.zoneId,
      maxBufferBytes: this.buffer.capacity,
      targetLeadMs: this.targetLeadMs,
      outputSampleRate: this.outputSettings.sampleRate,
      outputChannels: this.outputSettings.channels,
      outputBitDepth: this.outputSettings.pcmBitDepth,
      profile: this.profile,
    });

    if (this.source.kind === 'pipe' && this.source.stream) {
      const pipeSource = this.source as typeof this.source & { stream: NodeJS.ReadableStream };
      const fmt = this.source.format ?? 's16le';
      const sr = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const ch = this.source.channels ?? 2;
      const canDirectPassthrough =
        this.profile === 'pcm' &&
        fmt === 's16le' &&
        sr === this.outputSettings.sampleRate &&
        ch === this.outputSettings.channels &&
        this.outputSettings.pcmBitDepth === 16 &&
        (!Number.isFinite(this.outputSettings.fixedGainDb) || this.outputSettings.fixedGainDb === 0) &&
        !this.sourcePreDelayMs;

      // DSP first: `canDirectPassthrough` only compares *formats*, so a matching pipe with an
      // equalizer set used to take the passthrough and drop the equalizer on the floor without a word.
      // Same split as for file/URL — ffmpeg reaches the output rate, we own the DSP — so an EQ change on
      // a Spotify or line-in zone no longer respawns anything either.
      if (this.usesEngineDsp()) {
        this.starter.startEngineDsp(pipeSource.stream);
      } else if (canDirectPassthrough) {
        this.starter.startDirectPipe(pipeSource.stream, fmt, sr, ch);
      } else {
        this.starter.startPipeWithFfmpeg(pipeSource.stream, fmt, sr, ch);
      }
      return;
    }

    // File and URL sources use the two-stage PCM pipeline so crossfade can be
    // performed by blending raw PCM without switching the HTTP stream — but
    // only when crossfade is enabled. With crossfade off we save one ffmpeg
    // process per zone by running single-stage.
    if (this.source.kind === 'file' || this.source.kind === 'url') {
      if (this.crossfadeEnabled) {
        this.starter.startTwoStage();
      } else if (this.usesEngineDsp()) {
        // ffmpeg decodes and resamples, we own the gain, the equalizer and the requantisation. A PCM
        // profile needs no second process at all; a codec profile gets an encoder that only encodes.
        this.starter.startEngineDsp();
      } else {
        this.starter.startSingleStage();
      }
      return;
    }

    this.starter.startSingleStage();
  }


  /** @internal */ public spawnFfmpeg(
    args: string[],
    options: {
      restartOnFailure?: boolean;
      logFirstChunk?: boolean;
      stdinStream?: NodeJS.ReadableStream;
      onExit?: () => void;
    } = {},
  ): FfmpegProcess {
    const proc = new FfmpegProcess(
      args,
      {
        onStdout: (chunk: Buffer) => {
          this.emitOutputChunk(chunk, {
            firstChunkLabel: options.logFirstChunk === false ? null : 'ffmpeg first chunk',
          });
        },
        onStderr: (message: string) => {
          this.lastStderrLine = message;
          this.lastStderrAt = Date.now();
          this.observeBanner(message);
          this.log.debug('ffmpeg stderr', { zoneId: this.zoneId, message });
        },
        onExit: (code, signal) => {
          this.lastExitAt = Date.now();
          const runMs =
            this.startTs != null && this.lastExitAt != null ? this.lastExitAt - this.startTs : null;
          // Treat very short runs as suspicious, but don't flag short finite files (e.g. alert MP3s)
          // just because they naturally produce <200KB of output.
          const smallOutputIsSuspicious =
            this.source.kind !== 'file' && this.totalBytes < 200 * 1024;
          const earlyExit = runMs !== null && (runMs < 1000 || smallOutputIsSuspicious);
          this.lastExitCode = typeof code === 'number' ? code : null;
          this.lastExitSignal = signal ?? null;
          this.log.info('ffmpeg exited', {
            zoneId: this.zoneId,
            profile: this.profile,
            code,
            signal,
            stderr: this.lastStderrLine ?? undefined,
            stderrAt: this.lastStderrAt ?? undefined,
            totalBytes: this.totalBytes,
            bufferedBytes: this.buffer.bytes,
            subscribers: this.fanout.size,
            runMs,
            earlyExit,
          });
          options.onExit?.();
          const shouldRestartForEq = this.restartingForEq && !this.ending;
          const wantsRestart =
            !shouldRestartForEq && options.restartOnFailure === true && !this.ending && code !== 0;
          const restartBudgetExhausted = this.restartAttempts >= MAX_RESTART_ATTEMPTS;
          const shouldRestart = wantsRestart && !restartBudgetExhausted;
          if (!shouldRestart && !shouldRestartForEq && this.shouldHoldForLateSubscriber(code, signal)) {
            this.holdForLateSubscriber();
            return;
          }
          // When we give up (budget exhausted), suppressTermination=false so cleanup
          // fully tears the session down instead of leaving it in limbo.
          this.cleanup({ suppressTermination: shouldRestart || shouldRestartForEq });
          if (shouldRestartForEq) {
            this.restartingForEq = false;
            setTimeout(() => this.start(), 0);
            return;
          }
          if (shouldRestart) {
            this.restartAttempts += 1;
            this.totalRestarts += 1;
            const delayMs = Math.min(
              RESTART_BACKOFF_MAX_MS,
              RESTART_BACKOFF_STEP_MS * this.restartAttempts,
            );
            setTimeout(() => this.start(), delayMs);
            return;
          }
          if (wantsRestart && restartBudgetExhausted) {
            this.log.error('ffmpeg restart budget exhausted; giving up', {
              zoneId: this.zoneId,
              profile: this.profile,
              attempts: this.restartAttempts,
            });
          }
        },
        onError: (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            this.log.error('ffmpeg binary not found', {
              zoneId: this.zoneId,
              path: this.ffmpegPath,
              hint: 'Install ffmpeg with libmp3lame, libopus and libsoxr',
            });
          } else {
            this.log.error('ffmpeg error', { zoneId: this.zoneId, message: error.message });
          }
          this.lastErrorMessage = error.message;
          this.lastErrorAt = Date.now();
          this.cleanup();
        },
      },
      this.log,
      { logContext: { zoneId: this.zoneId, profile: this.profile } },
    );

    if (options.stdinStream) {
      options.stdinStream.pipe(proc.stdin);
      this.pipeSource.adopt(options.stdinStream);
      this.pipeSource.onError((err: unknown) => {
        this.log.warn('pipe source error', {
          zoneId: this.zoneId,
          message: (err as { message?: string } | null)?.message || String(err),
        });
        proc.stdin.destroy();
      });
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        const e = err as { code?: string; message?: string } | null;
        if (e?.code === 'EPIPE') {
          this.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: this.zoneId });
        } else {
          this.log.warn('ffmpeg stdin error', {
            zoneId: this.zoneId,
            message: e?.message || String(err),
          });
        }
      });
    }

    return proc;
  }

  /**
   * PCM crossfade between the currently-playing source and a fade-in source.
   * Dispatches to one of three topologies (two-stage decoder, pipe-with-ffmpeg,
   * direct passthrough) implemented in {@link Crossfader}.
   */
  public inlineCrossfade(
    fadeIn:
      | { kind: 'file'; path: string }
      | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string }
      | { kind: 'pipe'; stream: NodeJS.ReadableStream; sampleRate: number; channels: number },
    durationSec: number,
  ): Promise<boolean> {
    return this.crossfader.inlineCrossfade(fadeIn, durationSec);
  }

  private pauseStdout(): void {
    // Never pause the encoder during an active PCM crossfade blend — the blend loop
    // writes directly to encoderInput and must not be blocked by subscriber backpressure.
    if (this.crossfadeActive) {
      return;
    }
    if (this.stdoutPaused) {
      return;
    }
    if (this.directPipeMode && this.pipeSource.pause()) {
      this.stdoutPaused = true;
      return;
    }
    // Engine-DSP with a PCM profile has no encoder process: throttling the DSP stage's readable side
    // propagates back through the pipe chain to the decoder's stdout.
    if (this.outputReadable) {
      this.outputReadable.pause();
      this.stdoutPaused = true;
      return;
    }
    if (!this.process?.stdout) {
      return;
    }
    this.process.stdout.pause();
    this.stdoutPaused = true;
  }

  /** @internal */ public resumeStdout(): void {
    if (!this.stdoutPaused || this.fanout.hasBackpressure()) {
      return;
    }
    if (this.directPipeMode && this.pipeSource.resume()) {
      this.stdoutPaused = false;
      return;
    }
    if (this.outputReadable) {
      this.outputReadable.resume();
      this.stdoutPaused = false;
      return;
    }
    if (!this.process?.stdout) {
      return;
    }
    this.process.stdout.resume();
    this.stdoutPaused = false;
  }

  private computePacingBps(): number | null {
    if (this.source.kind !== 'url') {
      return null;
    }
    // Only pace when -re has been explicitly disabled.
    if (this.source.realTime !== false) {
      return null;
    }
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate } = this.outputSettings;
    switch (this.profile) {
      case 'mp3':
      case 'aac':
      case 'opus': {
        // Bitrate is stored as "k" bits/sec; convert to bytes/sec.
        const bytesPerSec = Math.round(mp3BitrateToBps(mp3Bitrate || '160k') / 8);
        return bytesPerSec > 0 ? bytesPerSec : null;
      }
      case 'pcm': {
        const bytesPerSec = Math.round(sampleRate * channels * (pcmBitDepth / 8));
        return bytesPerSec > 0 ? bytesPerSec : null;
      }
      case 'flac':
      default:
        return null;
    }
  }

  private maybeApplyOutputPacing(): void {
    if (!this.process && !this.engineDspMode) return;
    this.pacer.tick(this.totalBytes, this.startTs);
  }

  public stop(discardSubscribers = false): void {
    if (this.ending) {
      return;
    }
    this.ending = true;
    this.discardSubscribersOnStop = discardSubscribers;
    // In two-stage mode also kill the decoder; the encoder (this.process) is killed below.
    this.pipeline.terminateDecoder();
    if (this.process) {
      this.process.terminate();
    } else {
      this.cleanup();
    }
  }

  /**
   * Apply new EQ bands — on the running stream when our own DSP stage owns them, otherwise by
   * respawning ffmpeg.
   *
   * With the engine-DSP topology the coefficients are ours, so a slider move is a coefficient swap
   * with a 12 ms fade: no gap, no re-seek, no process boundary crossed. A respawn is still needed when
   * the *topology* has to change — switching the EQ on for the first time (a passthrough session has no
   * DSP stage) or back off entirely (so passthrough can be regained).
   *
   * The standard restart path (PlaybackService.start) does
   * stop({ discardSubscribers: true }), which destroys the output adapters'
   * PassThrough streams and stops audible playback until the user re-presses
   * Play. For an EQ change we want to keep those subscribers attached and
   * just swap the running ffmpeg process — there's an expected brief audio
   * hikje, but playback auto-resumes.
   *
   * Mechanism mirrors the existing internal restartOnFailure path: SIGTERM
   * the process, then in the exit handler call cleanup with
   * suppressTermination=true (preserves subscribers) and call start() again,
   * which spawns a fresh ffmpeg using the now-updated equalizerBands.
   *
   * @param resumeAtSec Where the restarted ffmpeg should pick the source up, in seconds. Without it a
   *   respawn re-runs the *original* command line — including its original `-ss` — so a file or URL
   *   track jumped back to its start on every EQ change. The caller supplies the current position; it
   *   is ignored for sources that cannot be positioned.
   */
  public restartForEqualizer(bands: ReadonlyArray<number> | null, resumeAtSec?: number): void {
    // Live path: our stage is running and the new curve still needs it. Nothing else to do — no
    // respawn, so also no resume position to compute.
    if (this.dsp && !this.ending && this.args.engineDspSpec(bands) !== null) {
      this.equalizerBands = bands;
      const changed = this.dsp.setBands(bands);
      this.log.info('equalizer applied on the running stream', {
        zoneId: this.zoneId,
        profile: this.profile,
        changed,
      });
      return;
    }
    this.equalizerBands = bands;
    if (typeof resumeAtSec === 'number' && Number.isFinite(resumeAtSec) && resumeAtSec > 0) {
      this.args = this.buildArgBuilder(resumeAtSec);
    }
    if (!this.process && !this.engineDspMode && !this.directPipeMode) {
      // Nothing is running yet; the next start() will pick up the new bands.
      return;
    }
    if (this.ending || this.restartingForEq) {
      return;
    }
    this.restartingForEq = true;
    if (this.process) {
      this.process.terminate();
      return;
    }
    if (this.pipeline.decoder) {
      // Engine-DSP with a PCM profile: the decoder is the only process, so its exit drives the same
      // cleanup-and-start cycle an encoder's exit would (see handleProducerEnded).
      this.pipeline.terminateDecoder();
      return;
    }
    // Direct pipe passthrough: no child process exists to wait for, so cycle the reader in place.
    // Without this, switching the equalizer on for a zone playing a format-matched live source did
    // nothing at all until the next track — the passthrough has no filter to change and nothing to kill.
    this.restartingForEq = false;
    this.cleanup({ suppressTermination: true });
    setTimeout(() => this.start(), 0);
  }

  /**
   * The producer of a process-less topology ended (engine-DSP with a PCM profile).
   *
   * Mirrors what {@link spawnFfmpeg}'s exit handler does for the topologies that own an ffmpeg on the
   * output side: honour a pending EQ-driven restart, otherwise tear the session down.
   */
  /** @internal */ public handleProducerEnded(): void {
    if (this.restartingForEq && !this.ending) {
      this.restartingForEq = false;
      this.cleanup({ suppressTermination: true });
      setTimeout(() => this.start(), 0);
      return;
    }
    if (!this.ending) {
      if (this.shouldHoldForLateSubscriber(0, null)) {
        this.holdForLateSubscriber();
        return;
      }
      this.cleanup();
    }
  }

  /**
   * Did the producer finish cleanly with audio nobody has collected?
   *
   * `fanout.size === 0` is the whole test for "nobody collected it": a subscriber that attached was
   * primed with the entire buffer at attach time, so there is nothing left to wait for and the
   * teardown must stay immediate — delaying it would delay the next track in a queue.
   */
  private shouldHoldForLateSubscriber(code: number | null, signal: string | null): boolean {
    return (
      !this.ending &&
      !this.awaitingLateSubscriber &&
      (code === 0 || code === null) &&
      !signal &&
      this.fanout.size === 0 &&
      this.buffer.bytes > 0
    );
  }

  /** Keep the finished session (and its buffer) reachable until an output asks for it, or time is up. */
  private holdForLateSubscriber(): void {
    if (this.process) {
      // The process is gone; drop our handle so nothing tries to write to or signal it, while the
      // buffer and the fanout stay alive for whoever still has to connect.
      this.process.detach();
      this.process = undefined;
    }
    this.log.info('producer finished before any output attached; holding buffer', {
      zoneId: this.zoneId,
      profile: this.profile,
      bufferedBytes: this.buffer.bytes,
      graceMs: LATE_SUBSCRIBER_GRACE_MS,
    });
    this.awaitingLateSubscriber = setTimeout(() => {
      this.awaitingLateSubscriber = null;
      this.log.debug('buffer hold expired', {
        zoneId: this.zoneId,
        profile: this.profile,
        subscribers: this.fanout.size,
      });
      this.cleanup();
    }, LATE_SUBSCRIBER_GRACE_MS);
    this.awaitingLateSubscriber.unref?.();
  }

  public waitForFirstChunk(timeoutMs = 2000): Promise<boolean> {
    return this.firstChunk.wait(timeoutMs);
  }

  public hasFirstChunk(): boolean {
    return this.firstChunk.hasFired();
  }

  public createSubscriber(options: { primeWithBuffer?: boolean; label?: string } = {}): PassThrough | null {
    // A held session has no process left, but it is exactly the case this exists for: the buffer is
    // complete and the output arriving now is the one it was kept for.
    if (!this.process && !this.directPipeMode && !this.engineDspMode && !this.awaitingLateSubscriber) {
      return null;
    }
    const primeWithBuffer = options.primeWithBuffer !== false;
    // For codec streams (FLAC), prepend the saved header so the subscriber's
    // decoder can initialize correctly even when joining mid-stream.
    const includeCodecHeader =
      this.codecHeader && (!primeWithBuffer || !this.bufferedChunkStartsWithCodecHeader());
    return this.fanout.attach({
      zoneId: this.zoneId,
      profile: this.profile,
      primeWithBuffer,
      label: options.label,
      codecHeader: includeCodecHeader ? this.codecHeader : null,
      primingChunks: primeWithBuffer ? this.buffer.snapshot() : undefined,
      pcmFrameRate:
        this.profile === 'pcm'
          ? {
              sampleRate: this.outputSettings.sampleRate,
              channels: this.outputSettings.channels,
              bitDepth: this.outputSettings.pcmBitDepth,
            }
          : null,
      sessionBufferedBytes: this.buffer.bytes,
    });
  }

  /**
   * Fill in the source format from ffmpeg's own probe, when nobody could tell us.
   *
   * A stream URL arrives with a native format only if its provider declares one. Apple Music does;
   * TuneIn and most radio do not — so the API reported "source not reported" for the whole track while
   * ffmpeg had already printed the answer on stderr and we had asked it not to (see `getLogLevel`, which
   * raises the level to `info` for exactly this case).
   *
   * The line looks like:
   *   `Stream #0:0: Audio: aac (LC) ([mp4a / 0x6134706D]), 44100 Hz, stereo, fltp, 256 kb/s`
   *
   * **It cannot change the passthrough decision.** `bitPerfect`/`dspApplied` were settled when the
   * command line was built, and ffmpeg is already running it: a resampler that is in the args stays in
   * the args, so learning the rate afterwards must not start claiming a bypass that did not happen. This
   * only fills in what is *reported*. A provider that declares its format up front is still the only way
   * to actually skip the resampler — which is why the declaration matters and this is the fallback.
   */
  private observeSourceFormat(message: string): void {
    if (this.sourceFormat) {
      return;
    }
    // The trailing `(?:\s+\([a-z][a-z ]*\))*` is ffmpeg's disposition list — `(default)`, sometimes
    // `(default) (forced)`. Every stream inside an mp4/m4a container carries one, so anchoring straight
    // at `$` meant this reader missed exactly the sources it exists for: the Apple Music segments and
    // m4a files whose format nobody declares. Verified against real ffmpeg output for aac, alac, mp3,
    // flac and opus.
    const match = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([A-Za-z0-9_]+)[^,]*, (\d+) Hz, ([^,]+?)(?:, ([a-z0-9]+)(?: \((\d+) bit\))?)?(?:, (\d+) kb\/s)?(?:\s+\([a-z][a-z ]*\))*$/.exec(
      message.trim(),
    );
    if (!match) {
      return;
    }
    const [, codec, rate, layout, sampleFmt, rawBits, kbps] = match;
    const sampleRate = Number(rate);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      return;
    }
    const channels = layout?.includes('mono')
      ? 1
      : layout?.includes('stereo')
        ? 2
        : Number(/^(\d+)/.exec(layout ?? '')?.[1] ?? 2);
    /*
     * Depth: only what ffmpeg actually states about the *recording*.
     *
     * The decoder's sample format is not the file's depth. FLAC has no 24-bit sample format, so a 24-bit
     * file decodes to `s32` — reading that as 32 bits is the padding mistake in a new place, and it made
     * a 24-bit master report "32-bit → 24-bit, depth reduced". When ffmpeg knows the real width it says so
     * in parentheses (`s32 (24 bit)`); otherwise only `s16` is unambiguous, and anything else stays null.
     * A lossy codec has no original depth at all — `fltp` describes ffmpeg's float pipeline, not the
     * recording.
     */
    const lossless = ['flac', 'alac', 'pcm', 'wav', 'aiff'].some((name) => codec?.startsWith(name));
    const statedBits = rawBits ? Number(rawBits) : null;
    const bitDepth = !lossless
      ? null
      : statedBits && Number.isFinite(statedBits)
        ? statedBits
        : sampleFmt === 's16' || sampleFmt === 's16p'
          ? 16
          : null;
    this.sourceFormat = {
      codec: codec ?? 'unknown',
      sampleRate,
      channels: Number.isFinite(channels) && channels > 0 ? channels : 2,
      bitDepth,
      bitrate: kbps ? Number(kbps) * 1000 : null,
    };
    this.log.debug('source format read from ffmpeg', {
      zoneId: this.zoneId,
      format: this.sourceFormat,
    });
  }

  /**
   * Read whatever ffmpeg's input banner states about the source.
   *
   * One entry point for both halves of the banner, and the one the decoder in {@link TwoStagePipeline}
   * feeds too: that process is a second ffmpeg on the same source, and until it reported here the
   * two-stage topologies learned nothing from a banner we were already paying for.
   */
  /** @internal */ public observeBanner(chunk: string): void {
    // Split first: ffmpeg writes the whole banner in one go, so `Duration:` and `Stream #0:0` usually
    // arrive in a single chunk. Both readers match against one line, and the format reader anchors its
    // pattern at the end of the string — which a multi-line chunk never satisfies, so it was quietly
    // missing exactly the banners it exists to read.
    for (const line of chunk.split('\n')) {
      const message = line.trim();
      if (!message) {
        continue;
      }
      this.observeSourceFormat(message);
      this.observeSourceDuration(message);
    }
  }

  /**
   * How long the source runs, from ffmpeg's own read of it.
   *
   * The last line of defence for a track whose provider never said. Everything that ends a track needs
   * a length — `ZonePlayer`'s clock and the engine-exit path both refuse to fire `ended` without one —
   * and the alternative used to be a hardcoded 2:00 placeholder that truncated any track it was wrong
   * about (#350). This states the real number instead, without a second HTTP request or an ffprobe
   * (which `ffmpeg-static` does not ship).
   *
   * The line looks like:
   *   `Duration: 00:04:00.00, start: 0.000000, bitrate: 256 kb/s`
   *
   * **How soon it arrives is a property of the source, not of us.** A seekable HTTP source — every real
   * CDN — or one whose index sits at the front answers within the first tens of kilobytes. A
   * non-seekable stream whose index sits at the *end* only answers once ffmpeg has read the whole
   * thing, i.e. as the track finishes, which is why the engine-exit path must be able to end a track
   * that still has no length at all. Live sources say `N/A` and are left at null, which is the truth.
   */
  private observeSourceDuration(message: string): void {
    if (this.sourceDurationSec !== null) {
      return;
    }
    const match = /^\s*Duration:\s*(\d+):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(message);
    if (!match) {
      return;
    }
    const [, h, m, sec, frac] = match;
    const seconds =
      Number(h) * 3600 + Number(m) * 60 + Number(sec) + (frac ? Number(`0.${frac}`) : 0);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    this.sourceDurationSec = Math.round(seconds);
    this.log.debug('source duration read from ffmpeg', {
      zoneId: this.zoneId,
      durationSec: this.sourceDurationSec,
    });
  }

  public getStats(): EngineSessionStats {
    const drops = this.fanout.drops;
    return {
      startedAt: this.createdAt,
      profile: this.profile,
      sampleRate: this.outputSettings.sampleRate,
      channels: this.outputSettings.channels,
      pcmBitDepth: this.outputSettings.pcmBitDepth,
      bps: this.lastBpsTs ? this.lastBps : null,
      bitPerfect: this.bitPerfect,
      dspApplied: this.dspApplied,
      // Described from the live equalizer bands rather than from the ones this session started with: on
      // the ffmpeg paths a band moved mid-track respawns, and until it does the chain in the args is
      // still the old one. The headroom comes from the stage that actually applies it, so a readout
      // never claims a trim that no filter is performing.
      processing: {
        ...this.args.describeProcessing(this.equalizerBands),
        headroomDb: this.dsp && this.dsp.headroomDb !== 0 ? this.dsp.headroomDb : null,
      },
      crossfading: this.crossfadeActive,
      sourceFormat: this.sourceFormat,
      sourceDurationSec: this.sourceDurationSec,
      bufferedBytes: this.buffer.bytes,
      totalBytes: this.totalBytes,
      lastUpdated: this.lastBpsTs || null,
      subscribers: this.fanout.size,
      restarts: this.totalRestarts,
      lastError: this.lastErrorMessage,
      lastErrorAt: this.lastErrorAt,
      lastStderr: this.lastStderrLine,
      lastStderrAt: this.lastStderrAt,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
      lastExitAt: this.lastExitAt,
      subscriberDrops: drops.count,
      lastSubscriberDropAt: drops.lastAt,
    };
  }

  /** @internal */ public cleanup(options: { suppressTermination?: boolean } = {}): void {
    const suppressTermination = options.suppressTermination === true;
    if (this.awaitingLateSubscriber) {
      clearTimeout(this.awaitingLateSubscriber);
      this.awaitingLateSubscriber = null;
    }
    this.bytesSinceLog = 0;
    this.lastLogTs = 0;
    this.pacer.reset();
    this.pipeSource.detach(this.pipeTarget ?? this.pipeline.pcmPipe);
    this.pipeTarget = undefined;
    this.directPipeMode = false;
    if (this.dsp) {
      this.dsp.removeAllListeners();
      this.dsp.destroy();
      this.dsp = undefined;
    }
    this.engineDspMode = false;
    this.outputReadable = undefined;
    if (suppressTermination) {
      // ffmpeg is restarting; chain existing waiters to the next arm() cycle so the
      // position ticker does not start prematurely before the restarted process produces output.
      this.firstChunk.chainRestart();
    } else {
      this.firstChunk.abort();
    }
    if (this.process) {
      this.process.detach();
      this.process = undefined;
    }
    this.fanout.clearAllBackpressure();
    this.stdoutPaused = false;
    // When suppressTermination is true, ffmpeg is restarting internally (restartOnFailure).
    // Keep subscribers alive so the sync stream and downstream clients (e.g. Squeezelite)
    // stay connected and receive audio from the new ffmpeg process without interruption.
    if (!suppressTermination) {
      this.fanout.endAll(this.discardSubscribersOnStop);
      this.discardSubscribersOnStop = false;
    }
    if (this.debugTapStream) {
      try {
        this.debugTapStream.end();
      } catch {
        /* ignore */
      }
      this.debugTapStream = undefined;
    }
    if (!suppressTermination) {
      this.onTerminated();
    }
  }

  /** @internal */ public writeToSubscribers(chunk: Buffer): void {
    this.fanout.write(chunk);
  }

  private maybeLogThroughput(): void {
    const now = Date.now();
    if (!this.lastLogTs) {
      this.lastLogTs = now;
      return;
    }
    const elapsed = now - this.lastLogTs;
    if (elapsed < 1000) {
      return;
    }
    const bytesPerSec = Math.round((this.bytesSinceLog / elapsed) * 1000);
    this.lastBps = bytesPerSec;
    this.lastBpsTs = now;
    this.log.spam('pipe throughput', {
      zoneId: this.zoneId,
      profile: this.profile,
      bytesPerSec,
      bufferBytes: this.buffer.bytes,
      subscribers: this.fanout.size,
      labels: this.fanout.labels(),
    });
    this.lastLogTs = now;
    this.bytesSinceLog = 0;
    this.checkUnheard(now);
  }

  /**
   * Say so, once, when audio has been produced for a while with nobody to take it.
   *
   * A zone whose output never really connected — a client that opens a socket and is then refused,
   * say — still reads as playing, and the only trace is `subscribers=0` in the exit line after the
   * fact. Live sources keep encoding at real time for as long as that lasts.
   */
  private checkUnheard(now: number): void {
    if (this.fanout.size > 0) {
      this.unheardSince = null;
      this.unheardWarned = false;
      return;
    }
    this.unheardSince ??= now;
    if (this.unheardWarned || now - this.unheardSince < UNHEARD_WARN_MS) {
      return;
    }
    this.unheardWarned = true;
    this.log.warn('audio is being produced but no output is taking it', {
      zoneId: this.zoneId,
      profile: this.profile,
      forMs: now - this.unheardSince,
      totalBytes: this.totalBytes,
    });
  }

  /** @internal */ public recordBytes(length: number): void {
    this.bytesSinceLog += length;
    this.totalBytes += length;
    this.maybeLogThroughput();
  }

}
