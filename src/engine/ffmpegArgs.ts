import {
  audioResampler,
  pcmCodecFromBitDepth,
  pcmFormatFromBitDepth,
  type AudioOutputSettings,
} from '@/engine/audioFormat';
import { buildEqualizerFilterChain } from '@/domain/zones/equalizer';
import type { ProcessingChain } from '@/ports/EngineTypes';
import type { OutputProfile, PlaybackSource } from '@/engine/audioSession';

// All three flags are required for truly low-latency pipe/stream sources:
//   -fflags nobuffer      – disable ffmpeg's input read-ahead buffer
//   -probesize 32k        – limit format probing to 32 KB (default 5 MB)
//   -analyzeduration 0    – skip the stream analysis phase entirely
// Even when the input format is explicitly specified with -f, ffmpeg still runs an
// analyze phase that reads ~200 KB (~1.1 s of 44.1 kHz stereo PCM) before producing
// any output. -fflags nobuffer alone does NOT suppress this — analyzeduration=0 is
// required to reduce the startup delay to ~50 ms.
export const FFMPEG_LOW_LATENCY_ARGS: readonly string[] = [
  '-fflags', 'nobuffer', '-probesize', '32k', '-analyzeduration', '0',
];
/**
 * The same quick opening for a source that has a beginning worth hearing: a file or a stream.
 *
 * Without `-fflags nobuffer`, and that is the whole difference. The flag tells ffmpeg not to keep
 * the packets it reads while working out what the input is — which for a live feed sheds a moment
 * of latency, and for a track throws away its opening. Measured with the bundled ffmpeg 6.0 on a
 * three-second file: 104 ms gone from a FLAC, 186 ms from a WAV, and 1.28 s from a 192 kb/s MP3,
 * the full 32 KB probe. The probe limits alone give the same fast start and decode every sample.
 */
export const FFMPEG_FAST_OPEN_ARGS: readonly string[] = ['-probesize', '32k', '-analyzeduration', '0'];
export const FFMPEG_BUFFERED_ARGS: readonly string[] = [
  '-probesize', '256k', '-analyzeduration', '1M',
];

export type FadeInSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string; headers?: Record<string, string>; decryptionKey?: string };

/**
 * Native format of the source, either probed (local files) or declared by the
 * provider (stream URLs). Supplied only when the caller wants an untouched
 * passthrough path; when absent the builder behaves exactly as before (always
 * resample).
 */
export interface SourceNativeFormat {
  sampleRate: number;
  channels: number;
  /** Null when the source has no meaningful sample depth (lossy codecs). */
  bitDepth: number | null;
  /**
   * Whether the source codec preserves its input samples. Informational for
   * callers/logging — it does not gate passthrough, since not touching a lossy
   * stream is still not touching it.
   */
  lossless: boolean;
  codecName?: string;
}

/**
 * The dither applied at the one place samples lose width: the final conversion into a 16-bit
 * integer output. Without it that conversion is plain rounding, which turns quantisation error
 * into signal-correlated distortion instead of noise — audible on quiet passages and fades.
 *
 * Only at 16 bits. A 24-bit output quantises 8 bits lower than any playback chain's own noise
 * floor, so dither there would be noise for nothing.
 */
const DITHER_METHOD = 'triangular_hp';

/**
 * One stage of the output filter chain.
 *
 * The command line and the `ProcessingChain` description are both *rendered from this array*, which is
 * what makes the two impossible to disagree. They used to be two parallel computations over the same
 * fields — and they did diverge: the resampler was described as running with our soxr settings while
 * the filter that actually converted the rate was one ffmpeg auto-inserted behind our backs.
 */
type FilterStage =
  /** Run the DSP in float. Without it a 16-bit source makes ffmpeg negotiate s16p for the biquads. */
  | { kind: 'float' }
  | { kind: 'delay'; ms: number }
  | { kind: 'gain'; db: number; origin: 'source' | 'output' }
  | { kind: 'equalizer'; bands: number[]; chain: string }
  /**
   * The single terminal conversion: rate, layout and sample format in one soxr pass.
   *
   * `osr` is load-bearing and must always be set. Without it this filter is free to keep the input
   * rate — the EQ downstream accepts any — and ffmpeg then auto-inserts its *own* `aresample` with
   * default options to reach the output rate. The result was that switching on a single EQ band
   * silently swapped soxr at precision 28 for stock swr.
   */
  | { kind: 'resample'; osr: number; osf: string | null; dither: string | null; async: boolean };

type ResampleStage = Extract<FilterStage, { kind: 'resample' }>;

/**
 * Builds the ffmpeg command-line for an audio session. All state needed by the
 * various build* helpers (source, profile, output settings, alert flag,
 * pre-delay) is supplied in the constructor; only EQ bands vary per call.
 */
export class FfmpegArgBuilder {
  constructor(
    private readonly source: PlaybackSource,
    private readonly profile: OutputProfile,
    private readonly outputSettings: AudioOutputSettings,
    private readonly isAlertSource: boolean,
    private readonly sourcePreDelayMs: number | undefined,
    /**
     * Probed native format of the source. When it matches the output settings
     * exactly and no DSP is active, the soxr resampler is omitted so samples
     * reach the sink untouched. Undefined = legacy behaviour (always resample).
     */
    private readonly sourceNativeFormat?: SourceNativeFormat,
  ) {}

  /**
   * True when we do not touch the audio: the source reaches the player exactly as
   * the provider delivered it, with no rate conversion, no requantisation and no
   * filtering on our side.
   *
   * This is the project's definition of bit-perfect — "we don't come near it" —
   * and it deliberately says nothing about whether the *source* is lossless. A
   * 44.1 kHz AAC stream served at 44.1 kHz is bit-perfect by this definition: we
   * pass Apple's decode through untouched. That the encoder threw information away
   * upstream is their choice, not our alteration.
   *
   * Each condition is load-bearing:
   *  - rate/channels equal: any mismatch genuinely needs a converter.
   *  - depth: only enforced when the source declares one. A lossy source has no
   *    original sample depth to preserve, so whatever depth we carry it in cannot
   *    lose anything; a lossless source at a different depth *would* be requantised.
   *  - PCM or FLAC profile: the lossy encoders re-encode by definition.
   *  - no pre-delay, gain or EQ: each forces ffmpeg into filtered processing.
   */
  public isBitPerfect(equalizerBands: ReadonlyArray<number> | null): boolean {
    const native = this.sourceNativeFormat;
    if (!native) {
      return false;
    }
    if (this.profile !== 'pcm' && this.profile !== 'flac') {
      return false;
    }
    const { sampleRate, channels, pcmBitDepth, fixedGainDb } = this.outputSettings;
    if (native.sampleRate !== sampleRate || native.channels !== channels) {
      return false;
    }
    // A declared depth must match; an undeclared one (lossy source) cannot be lost.
    if (native.bitDepth !== null && native.bitDepth !== pcmBitDepth) {
      return false;
    }
    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      return false;
    }
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      return false;
    }
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    if (typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) && sourceGainDb !== 0) {
      return false;
    }
    if (buildEqualizerFilterChain(equalizerBands)) {
      return false;
    }
    return true;
  }

  /**
   * What this session does to the audio, stage by stage — derived from the chain that runs.
   *
   * `requantised` and `channelsRemapped` compare the source against the output rather than reading a
   * stage, because they are facts about the *material*: a 24-bit master carried in a 16-bit output lost
   * width no matter which filter did it.
   */
  public describeProcessing(equalizerBands: ReadonlyArray<number> | null): ProcessingChain {
    const native = this.sourceNativeFormat;
    const { channels, pcmBitDepth } = this.outputSettings;
    const stages = this.buildFilterChain(equalizerBands);
    const resample = stages.find((stage): stage is ResampleStage => stage.kind === 'resample');
    const equalizer = stages.find(
      (stage): stage is Extract<FilterStage, { kind: 'equalizer' }> => stage.kind === 'equalizer',
    );
    const delay = stages.find(
      (stage): stage is Extract<FilterStage, { kind: 'delay' }> => stage.kind === 'delay',
    );
    const gains = stages.filter(
      (stage): stage is Extract<FilterStage, { kind: 'gain' }> => stage.kind === 'gain',
    );
    const gainSource = gains.find((gain) => gain.origin === 'source')?.db ?? 0;
    const gainOutput = gains.find((gain) => gain.origin === 'output')?.db ?? 0;

    return {
      resampled: Boolean(resample),
      resampler: resample ? { ...audioResampler } : null,
      // Only a *declared* depth can be lost; a lossy source has no original depth to preserve.
      requantised: native?.bitDepth != null && native.bitDepth !== pcmBitDepth,
      channelsRemapped: native != null && native.channels !== channels,
      reencoded: this.profile === 'aac' || this.profile === 'mp3' || this.profile === 'opus',
      equalizer: equalizer ? { bands: [...equalizer.bands] } : null,
      gainDb: gains.length ? { source: gainSource, output: gainOutput } : null,
      delayMs: delay ? delay.ms : null,
      dither: resample?.dither ?? null,
      // Headroom is managed by our own DSP stage, so only a session running that topology can fill this
      // in; see AudioSession.getStats.
      headroomDb: null,
    };
  }

  public getLogLevel(): string {
    if (this.source.kind === 'url' && this.source.logLevel) {
      return this.source.logLevel;
    }
    /*
     * `info` when — and only when — nobody could tell us what the source is or how long it runs.
     *
     * A stream URL arrives with no native format unless its provider declares one, and Apple Music,
     * TuneIn and most radio do not: the API then reports "source not reported" for the whole track while
     * ffmpeg has printed the answer on its own stderr and we asked it not to. At `info` the input banner
     * is printed and `AudioSession` reads both facts out of it:
     *
     *   Duration: 00:04:00.00, start: 0.000000, bitrate: 256 kb/s
     *   Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 256 kb/s
     *
     * The duration half matters as much as the format half. Nothing downstream can end a track it has
     * no length for — the zone clock and the engine-exit path both need one to fire `ended` — and the
     * alternative to reading it here was inventing a placeholder, which is how a favourite whose
     * metadata lookup missed ended up being cut off at exactly 2:00 (#350).
     *
     * `-nostats` keeps the rest quiet, so this costs one banner rather than a progress line every half
     * second — see `sessionStarter`. Staying at `error` whenever both facts are already in hand is what
     * keeps an HLS source (which logs a line per segment at `info`) from burying its own real errors in
     * `lastStderr`.
     */
    const durationKnown =
      // A pipe carries raw PCM, so ffmpeg states `Duration: N/A` for it no matter the log level.
      // There is nothing to learn from the banner, and the input adapter driving the pipe (a Spotify run,
      // Soloist, line-in) reports the position and length itself.
      this.source.kind === 'pipe' ||
      (typeof this.source.knownDurationSec === 'number' && this.source.knownDurationSec > 0);
    return this.sourceNativeFormat && durationKnown ? 'error' : 'info';
  }

  /**
   * A speed limit for a file the caller asked *not* to pace, when nothing else will pace it.
   *
   * `realTime: false` on a file is deliberate — `AudioManager.startWithResolvedSource` forces it, so
   * playback can start without waiting on ffmpeg's clock — and the engine is meant to keep the
   * producer honest from the output side instead. That backpressure is computed from the output
   * bitrate, which a variable-bitrate codec does not have. The URL branch above already carves out
   * FLAC for exactly this reason; a *file* on a FLAC profile fell between the two and ran with no
   * pacing at all, which is not a small effect: ffmpeg hands over the entire track within a second
   * or two of the first byte.
   *
   * A finite source racing to EOF is the failure the URL branch warns about, and it makes "what is
   * playing now" meaningless anywhere downstream — an analysis tap on such a session measures a
   * burst and then silence, and a presentation timestamp has nothing to refer to.
   *
   * So: track the wall clock with 10% of headroom, after an opening burst that keeps the fast start
   * the flag was set for. Five seconds is enough for a pull renderer that wants to prebuffer before
   * it begins (measured for the same problem in Music Assistant, which uses these same two options).
   * Deliberately *not* plain `-re`, which would take that head start away.
   */
  private unpacedFileRateArgs(): string[] {
    if (this.profile !== 'flac') {
      return [];
    }
    return ['-readrate', '1.1', '-readrate_initial_burst', '5'];
  }

  /** Single-stage input args based on source kind. */
  public buildInputArgs(): string[] {
    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTlsVerifyHost = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTlsVerifyHost ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      // When URL input pacing is disabled (`realTime=false`), we rely on output backpressure to prevent
      // ffmpeg from running far ahead and exiting early on finite sources (e.g. Apple Music track MP4s).
      // That backpressure is computed using output bitrate; FLAC is variable so we can't pace it reliably
      // that way. For FLAC, force `-re` even when `realTime=false` to keep ffmpeg aligned with wall clock.
      const realtimeArgs =
        this.source.realTime === true || (this.source.realTime === false && this.profile === 'flac')
          ? ['-re']
          : [];
      return [
        ...(lowLatency ? FFMPEG_FAST_OPEN_ARGS : FFMPEG_BUFFERED_ARGS),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...tlsArgs, ...decryptionArgs, ...headerArgs, ...inputFormatArgs,
        ...realtimeArgs,
        ...buildSeekArgs(this.source.startAtSec),
        '-i', this.source.url,
      ];
    }

    if (this.source.kind === 'pipe') {
      const sampleRate = this.source.sampleRate ?? this.outputSettings.sampleRate;
      const channels = this.source.channels ?? this.outputSettings.channels;
      const format = this.source.format ?? 's16le';
      const paceInput = this.source.realTime !== false;
      return [
        ...FFMPEG_LOW_LATENCY_ARGS,
        ...(paceInput ? ['-re'] : []),
        '-f', format, '-ar', String(sampleRate), '-ac', String(channels),
        '-i', this.source.path,
      ];
    }

    const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
    const inputLatencyArgs = this.isAlertSource ? FFMPEG_BUFFERED_ARGS : FFMPEG_FAST_OPEN_ARGS;
    // Pace file sources in real-time so downstream outputs (e.g., Snapcast) don't get flooded.
    const paceInput = this.source.realTime !== false;
    return [
      ...inputLatencyArgs, ...loopArgs,
      ...(paceInput ? ['-re'] : this.unpacedFileRateArgs()),
      ...buildSeekArgs(this.source.startAtSec),
      '-i', this.source.path,
    ];
  }

  /** Single-stage output args with EQ + resample + pre-delay filters. */
  public buildOutputArgs(equalizerBands: ReadonlyArray<number> | null): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate } = this.outputSettings;
    const filterArgs = this.buildFilterArgs(equalizerBands);

    switch (this.profile) {
      case 'aac': {
        const bitrate = mp3Bitrate || '160k';
        return ['-vn', '-acodec', 'aac', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', bitrate, ...filterArgs, '-f', 'adts'];
      }
      case 'pcm': {
        return ['-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', pcmFormatFromBitDepth(pcmBitDepth)];
      }
      case 'opus': {
        const bitrate = mp3Bitrate || '160k';
        return ['-vn', '-acodec', 'libopus', '-application', 'audio', '-b:a', bitrate,
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', 'opus'];
      }
      case 'flac': {
        return ['-vn', '-acodec', 'flac', '-compression_level', '0', '-frame_size', '512',
          '-sample_fmt', sampleFormatForDepth(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels),
          ...filterArgs, '-f', 'flac'];
      }
      case 'mp3':
      default:
        return ['-vn', '-acodec', 'libmp3lame',
          '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', mp3Bitrate, ...filterArgs, '-f', 'mp3'];
    }
  }

  /**
   * Two-stage decoder args: source → PCM at the output sample-rate/channels/depth.
   *
   * The intermediate bus carries the *negotiated* depth, not a fixed s16le. It used
   * to be hardcoded to 16-bit while the stage-2 encoder happily emitted pcm_s24le,
   * which silently produced 16-bit samples padded into 24-bit containers while
   * advertising 24-bit downstream.
   *
   * Note the two-stage path exists for crossfade, and crossfade blending itself
   * requantises — so this path is never bit-perfect. It is merely no longer
   * truncating.
   *
   * The rate conversion into the bus happens *here*, so this is where soxr and the dither belong.
   * Without them the decoder reached the bus rate through ffmpeg's stock resampler and rounded into
   * the bus depth undithered, while the session reported soxr at precision 28.
   */
  public buildPcmDecoderArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth } = this.outputSettings;
    const pcmOut = [
      ...this.buildBusResampleArgs(),
      '-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', pcmFormatFromBitDepth(pcmBitDepth), 'pipe:1',
    ];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (this.source.kind === 'file') {
      const loopArgs = this.source.loop ? ['-stream_loop', '-1'] : [];
      const latencyArgs = this.isAlertSource ? FFMPEG_BUFFERED_ARGS : FFMPEG_FAST_OPEN_ARGS;
      // Paced exactly as the single process paces it (see `buildInputArgs`): the same source must
      // not run at a different speed for being decoded in a process of its own.
      const realTimeArgs = this.source.realTime !== false ? ['-re'] : this.unpacedFileRateArgs();
      return [...log, ...latencyArgs, ...loopArgs, ...realTimeArgs,
        ...buildSeekArgs(this.source.startAtSec), '-i', this.source.path, ...pcmOut];
    }

    if (this.source.kind === 'url') {
      const lowLatency = this.source.lowLatency !== false;
      const headerLines = this.source.headers ? formatHeaders(this.source.headers) : '';
      const headerArgs = headerLines ? ['-headers', headerLines] : [];
      const decryptionArgs = this.source.decryptionKey ? ['-decryption_key', this.source.decryptionKey] : [];
      const needsTls = Boolean(this.source.tlsVerifyHost && /^https:/i.test(this.source.url));
      const tlsArgs = needsTls ? ['-tls_verify', '0', '-verifyhost', this.source.tlsVerifyHost!] : [];
      const inputFormatArgs = this.source.inputFormat ? ['-f', this.source.inputFormat] : [];
      const realTimeArgs =
        this.source.realTime !== false || this.profile === 'flac' ? ['-re'] : [];
      return [
        ...log,
        ...(lowLatency ? FFMPEG_FAST_OPEN_ARGS : FFMPEG_BUFFERED_ARGS),
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...tlsArgs, ...decryptionArgs, ...headerArgs, ...inputFormatArgs,
        ...realTimeArgs, ...buildSeekArgs(this.source.startAtSec), '-i', this.source.url,
        ...pcmOut,
      ];
    }

    return [];
  }

  /** Decoder args for a fade-in source during an inline crossfade. */
  public buildPcmDecoderArgsForSource(source: FadeInSource): string[] {
    const { sampleRate, channels, pcmBitDepth } = this.outputSettings;
    const pcmOut = [...this.buildBusResampleArgs({ forOtherSource: true }),
      '-vn', '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels),
      '-f', pcmFormatFromBitDepth(pcmBitDepth), 'pipe:1'];
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];

    if (source.kind === 'file') {
      return [...log, ...FFMPEG_FAST_OPEN_ARGS, '-re', '-i', source.path, ...pcmOut];
    }

    const headerLines = source.headers ? formatHeaders(source.headers) : '';
    const headerArgs = headerLines ? ['-headers', headerLines] : [];
    const decryptionArgs = source.decryptionKey ? ['-decryption_key', source.decryptionKey] : [];
    return [
      ...log, ...FFMPEG_FAST_OPEN_ARGS,
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...decryptionArgs, ...headerArgs, '-re', '-i', source.url,
      ...pcmOut,
    ];
  }

  /**
   * Two-stage encoder args: PCM on stdin → output profile on stdout.
   *
   * Carries the *whole* DSP chain, because this is the only stage of the two-stage path that can. It
   * used to carry the pre-delay and the output trim and silently drop the rest: enabling crossfade
   * therefore turned off the zone's equalizer and the source's loudness normalisation, while
   * `describeProcessing` still listed both.
   */
  public buildPcmEncoderArgs(equalizerBands: ReadonlyArray<number> | null = null): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate } = this.outputSettings;
    // -fflags nobuffer / -analyzeduration 0: without these, FFmpeg buffers ~5 s of raw
    // PCM from pipe:0 before producing its first output frame (probing raw input).
    // Since we fully specify the format, probing is unnecessary and wastes startup time.
    // The input format must track buildPcmDecoderArgs' output depth exactly — these
    // two are the same pipe.
    const pcmIn = [
      ...this.busInputArgs(),
      '-f', pcmFormatFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
    ];

    const filterArgs = this.buildFilterArgs(equalizerBands, { fromBus: true });
    const log = ['-hide_banner', '-loglevel', this.getLogLevel()];
    const base = [...log, ...pcmIn, ...filterArgs];

    switch (this.profile) {
      case 'flac':
        return [...base, '-acodec', 'flac', '-compression_level', '0', '-frame_size', '512',
          '-sample_fmt', sampleFormatForDepth(pcmBitDepth),
          '-ar', String(sampleRate), '-ac', String(channels), '-f', 'flac', 'pipe:1'];
      case 'aac': {
        const br = mp3Bitrate || '160k';
        return [...base, '-acodec', 'aac', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', br, '-f', 'adts', 'pipe:1'];
      }
      case 'pcm': {
        const codec = pcmCodecFromBitDepth(pcmBitDepth);
        const fmt = pcmFormatFromBitDepth(pcmBitDepth);
        return [...base, '-acodec', codec, '-ar', String(sampleRate), '-ac', String(channels),
          '-f', fmt, 'pipe:1'];
      }
      case 'opus': {
        const br = mp3Bitrate || '160k';
        return [...base, '-acodec', 'libopus', '-application', 'audio', '-b:a', br,
          '-ar', String(sampleRate), '-ac', String(channels), '-f', 'opus', 'pipe:1'];
      }
      case 'mp3':
      default: {
        const br = mp3Bitrate || '320k';
        return [...base, '-acodec', 'libmp3lame', '-ar', String(sampleRate), '-ac', String(channels),
          '-b:a', br, '-f', 'mp3', 'pipe:1'];
      }
    }
  }

  /**
   * The output filter chain, as data. Single source of truth for both the `-af` argument and
   * `describeProcessing`.
   *
   * Order is deliberate: float first, then every DSP stage, then one terminal conversion. The DSP used
   * to sit *after* an `aresample` that was meant to do the rate conversion, which cost twice — the
   * biquads ran at whatever integer format the neighbouring links negotiated (s16p for the common
   * 16-bit source, measurably noisier than float), and the resample the args described never happened
   * because a filter downstream was free to keep the input rate.
   *
   * @param fromBus When true the input is our own intermediate PCM (two-stage encoder), already at the
   *   output rate and depth. There is then nothing to convert unless a DSP stage widened it to float.
   */
  private buildFilterChain(
    equalizerBands: ReadonlyArray<number> | null,
    { fromBus = false }: { fromBus?: boolean } = {},
  ): FilterStage[] {
    const { sampleRate, pcmBitDepth, fixedGainDb } = this.outputSettings;

    const dsp: FilterStage[] = [];
    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      dsp.push({ kind: 'delay', ms: Math.max(0, Math.round(this.sourcePreDelayMs)) });
    }
    // Source-level loudness gain (e.g. Spotify volume normalisation). Composes
    // with the per-output fixedGainDb rather than replacing it.
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    if (typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) && sourceGainDb !== 0) {
      dsp.push({ kind: 'gain', db: sourceGainDb, origin: 'source' });
    }
    if (Number.isFinite(fixedGainDb) && fixedGainDb !== 0) {
      dsp.push({ kind: 'gain', db: fixedGainDb, origin: 'output' });
    }
    const eqChain = buildEqualizerFilterChain(equalizerBands);
    if (eqChain) {
      dsp.push({ kind: 'equalizer', bands: [...(equalizerBands ?? [])], chain: eqChain });
    }

    // Nothing alters the audio and nothing needs converting: no filter at all. `isBitPerfect` holds
    // for lossy sources too (see its docstring); the pipe case covers a live feed that
    // already arrives in exactly the output format.
    if (!dsp.length && (fromBus || this.isBitPerfect(equalizerBands) || this.pipeMatchesOutput())) {
      return [];
    }

    const stages: FilterStage[] = [];
    if (dsp.length) {
      stages.push({ kind: 'float' });
      stages.push(...dsp);
    }
    // Integer profiles get their sample format pinned here so the requantisation happens once, in
    // soxr, with dither — rather than as an undithered afterthought in the encoder. Lossy encoders
    // take float natively, so pinning a format for them would only add a round trip.
    const integerOutput = this.profile === 'pcm' || this.profile === 'flac';
    const osf = integerOutput ? sampleFormatForDepth(pcmBitDepth) : null;
    stages.push({
      kind: 'resample',
      osr: sampleRate,
      osf,
      dither: osf === 's16' ? DITHER_METHOD : null,
      // For live pipe inputs, ffmpeg's async clock correction can build up
      // noticeable startup latency before the first output chunk.
      async: this.source.kind !== 'pipe',
    });
    return stages;
  }

  /**
   * What the engine-side DSP stage has to apply, or null when there is nothing for it to do.
   *
   * Gain and the equalizer move to our own PCM stage so they can change without respawning ffmpeg; the
   * pre-delay stays on the decoder's command line, since it is a fixed time shift that never changes
   * mid-session and needs no precision from us.
   */
  public engineDspSpec(
    equalizerBands: ReadonlyArray<number> | null,
  ): { gainDb: number; bands: ReadonlyArray<number> | null } | null {
    const { fixedGainDb } = this.outputSettings;
    const sourceGainDb = this.source.kind === 'url' ? this.source.gainDb : undefined;
    const gainSource =
      typeof sourceGainDb === 'number' && Number.isFinite(sourceGainDb) ? sourceGainDb : 0;
    const gainOutput = Number.isFinite(fixedGainDb) ? fixedGainDb : 0;
    const gainDb = gainSource + gainOutput;
    const bands = buildEqualizerFilterChain(equalizerBands) ? equalizerBands : null;
    if (gainDb === 0 && !bands) {
      return null;
    }
    return { gainDb, bands };
  }

  /**
   * Whether our DSP stage should hand this profile float rather than integers.
   *
   * The lossy encoders convert to float internally, so quantising for them — dither and all — would be
   * a requantisation that only adds noise. FLAC and PCM are integer formats and need the real thing.
   */
  public engineDspEmitsFloat(): boolean {
    return this.profile === 'mp3' || this.profile === 'aac' || this.profile === 'opus';
  }

  /**
   * Decoder for the engine-DSP topology: source → float PCM at the output rate and channel count.
   *
   * Float out, because every stage after this one is ours and works in float. The explicit soxr filter
   * is not optional even though `-ar` is set: without a filter that pins `osr`, ffmpeg reaches the
   * output rate through an auto-inserted resampler with default options.
   */
  public buildF32DecoderArgs(options: { fromStdin?: boolean } = {}): string[] {
    const { sampleRate, channels } = this.outputSettings;
    const filters: string[] = [];
    if (this.sourcePreDelayMs && this.sourcePreDelayMs > 0) {
      filters.push(renderFilterStage({ kind: 'delay', ms: Math.round(this.sourcePreDelayMs) }));
    }
    filters.push(
      renderFilterStage({
        kind: 'resample',
        osr: sampleRate,
        osf: null,
        dither: null,
        async: this.source.kind !== 'pipe',
      }),
    );
    // A live pipe source arrives as a stream on our side, so its input is stdin rather than the path
    // the source object carries (which names the producer, not a readable file).
    const inputArgs = options.fromStdin
      ? this.buildInputArgs().map((arg, index, all) => (all[index - 1] === '-i' ? 'pipe:0' : arg))
      : this.buildInputArgs();
    return [
      '-hide_banner', '-nostats', '-loglevel', this.getLogLevel(),
      ...inputArgs,
      '-af', filters.join(','),
      '-vn', '-acodec', 'pcm_f32le', '-ar', String(sampleRate), '-ac', String(channels),
      '-f', 'f32le', 'pipe:1',
    ];
  }

  /**
   * Encoder for the engine-DSP topology: our finished integer PCM in, the output profile out.
   *
   * No filters and no `-ar`/`-ac` conversion: the samples arriving here are already exactly what the
   * consumer negotiated, and re-stating a conversion is how a second resampler sneaks in. Only used for
   * the codec profiles — a PCM profile skips the process entirely.
   */
  public buildEngineDspEncoderArgs(): string[] {
    const { sampleRate, channels, pcmBitDepth, mp3Bitrate } = this.outputSettings;
    const args = [
      '-hide_banner', '-nostats', '-loglevel', this.getLogLevel(),
      ...this.busInputArgs(),
      '-f', this.engineDspEmitsFloat() ? 'f32le' : pcmFormatFromBitDepth(pcmBitDepth),
      '-ar', String(sampleRate), '-ac', String(channels), '-i', 'pipe:0',
    ];
    switch (this.profile) {
      case 'flac':
        return [...args, '-acodec', 'flac', '-compression_level', '0', '-frame_size', '512',
          '-sample_fmt', sampleFormatForDepth(pcmBitDepth), '-f', 'flac', 'pipe:1'];
      case 'aac':
        return [...args, '-acodec', 'aac', '-b:a', mp3Bitrate || '160k', '-f', 'adts', 'pipe:1'];
      case 'opus':
        return [...args, '-acodec', 'libopus', '-application', 'audio',
          '-b:a', mp3Bitrate || '160k', '-f', 'opus', 'pipe:1'];
      case 'mp3':
        return [...args, '-acodec', 'libmp3lame', '-b:a', mp3Bitrate || '320k', '-f', 'mp3', 'pipe:1'];
      case 'pcm':
      default:
        return [...args, '-acodec', pcmCodecFromBitDepth(pcmBitDepth),
          '-f', pcmFormatFromBitDepth(pcmBitDepth), 'pipe:1'];
    }
  }

  /**
   * The conversion into the two-stage intermediate bus: soxr at our settings, dithered when the bus
   * is 16-bit. No DSP — that runs in the encoder, which is the stage crossfade leaves attached.
   */
  private buildBusResampleArgs(options: { forOtherSource?: boolean } = {}): string[] {
    // A source that is already what the bus carries goes onto it as decoded. Converting it anyway
    // meant a 16-bit lossless track picked up a layer of dither on its way to an output that was
    // about to be told the stream was untouched — the two-stage path's one difference from the
    // single process, and not one anybody asked for. Only for the builder's own source: the format
    // of some other track handed in for a crossfade is not known here.
    if (!options.forOtherSource && this.sourceMatchesBus()) {
      return [];
    }
    const osf = sampleFormatForDepth(this.outputSettings.pcmBitDepth);
    return [
      '-af',
      renderFilterStage({
        kind: 'resample',
        osr: this.outputSettings.sampleRate,
        osf,
        dither: osf === 's16' ? DITHER_METHOD : null,
        async: this.source.kind !== 'pipe',
      }),
    ];
  }

  /** Whether the source's own rate, channels and (for lossless) depth are exactly the bus's. */
  private sourceMatchesBus(): boolean {
    const native = this.sourceNativeFormat;
    if (!native) {
      return false;
    }
    const { sampleRate, channels, pcmBitDepth } = this.outputSettings;
    if (native.sampleRate !== sampleRate || native.channels !== channels) {
      return false;
    }
    // As in `isBitPerfect`: a declared depth must match, an undeclared one cannot be lost.
    return native.bitDepth === null || native.bitDepth === pcmBitDepth;
  }

  /**
   * How an encoder opens our own PCM bus on its stdin.
   *
   * The format is stated outright, so there is nothing to probe. `nobuffer` goes with it only when
   * the session carries a live producer, where the block it discards is latency shed. Behind a file
   * or a stream that same block is the first 93 ms of the track (4096 frames, measured), on top of
   * whatever the decoder in front already lost.
   */
  private busInputArgs(): string[] {
    const quick = ['-probesize', '32', '-analyzeduration', '0'];
    return this.source.kind === 'pipe' ? ['-fflags', 'nobuffer', ...quick] : quick;
  }

  /** A pipe source that already arrives in exactly the output format needs no conversion. */
  private pipeMatchesOutput(): boolean {
    if (this.source.kind !== 'pipe') {
      return false;
    }
    if (this.profile !== 'pcm' && this.profile !== 'flac') {
      return false;
    }
    return (
      (this.source.format ?? 's16le') === 's16le' &&
      (this.source.sampleRate ?? this.outputSettings.sampleRate) === this.outputSettings.sampleRate &&
      (this.source.channels ?? this.outputSettings.channels) === this.outputSettings.channels &&
      this.outputSettings.pcmBitDepth === 16
    );
  }

  private buildFilterArgs(
    equalizerBands: ReadonlyArray<number> | null,
    options: { fromBus?: boolean } = {},
  ): string[] {
    const stages = this.buildFilterChain(equalizerBands, options);
    return stages.length ? ['-af', stages.map(renderFilterStage).join(',')] : [];
  }
}

function renderFilterStage(stage: FilterStage): string {
  switch (stage.kind) {
    case 'float':
      return 'aformat=sample_fmts=fltp';
    case 'delay':
      return `adelay=delays=${stage.ms}:all=1`;
    case 'gain':
      return `volume=${formatDb(stage.db)}dB`;
    case 'equalizer':
      return stage.chain;
    case 'resample': {
      const parts = [
        `aresample=resampler=${audioResampler.name}`,
        `precision=${audioResampler.precision}`,
        `cutoff=${audioResampler.cutoff}`,
        `osr=${stage.osr}`,
      ];
      if (stage.osf) {
        parts.push(`osf=${stage.osf}`);
      }
      if (stage.dither) {
        parts.push(`dither_method=${stage.dither}`);
      }
      if (stage.async) {
        parts.push('async=1');
      }
      return parts.join(':');
    }
  }
}

function formatDb(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * The ffmpeg *sample format* that carries a given output depth.
 *
 * There is no s24: 24-bit lives in an s32 container, both for the FLAC encoder and for pcm_s24le,
 * which take s16 or s32 only. The final 8-bit narrowing to a 24-bit container is left to the encoder —
 * it lands below any playback noise floor, which is also why it is not dithered.
 *
 * Pinning this matters for FLAC: without an explicit -sample_fmt the encoder negotiates the format
 * with the *decoder*, so a 24-bit source produced a 24-bit FLAC even when the client had negotiated
 * 16-bit. The STREAMINFO header we forward in stream/start would then disagree with the frames, and
 * the client decodes noise.
 */
function sampleFormatForDepth(bitDepth: number): string {
  return bitDepth === 16 ? 's16' : 's32';
}

function buildSeekArgs(startAtSec?: number): string[] {
  if (!Number.isFinite(startAtSec)) {
    return [];
  }
  const safe = Math.max(0, startAtSec ?? 0);
  if (safe <= 0) {
    return [];
  }
  return ['-ss', String(safe)];
}

function formatHeaders(headers: Record<string, string>): string {
  const lines = Object.entries(headers)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([key, value]) => `${key}: ${value}`);
  if (!lines.length) {
    return '';
  }
  return `${lines.join('\r\n')}\r\n`;
}
