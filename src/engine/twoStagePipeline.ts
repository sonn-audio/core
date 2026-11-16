import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { ffmpegBinary } from '@/engine/ffmpegProcess';

/** Run `fn` once everything `stream` will ever produce has been handed on. */
export function afterDrained(stream: Readable, fn: () => void): void {
  if (stream.readableEnded || stream.destroyed) {
    fn();
    return;
  }
  stream.once('end', fn);
}

export interface TwoStagePipelineLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Two-stage decode → encode pipeline used for file/URL sources.
 *
 *   decoder (source → s16le PCM) → pcmPipe → encoderInput → encoder (PCM → output)
 *
 * `encoderInput` is the permanent connection to encoder stdin; crossfade can swap
 * the decoder (and replace `pcmPipe`) without disconnecting the encoder, so
 * downstream HTTP clients (Squeezelite, Cast) never see a reconnect.
 *
 * Fields are public because crossfade orchestration on AudioSession needs to
 * read/write them directly (unpipe pcmPipe → encoderInput, replace pcmPipe with
 * a fresh PassThrough, rewire newDecoder.stdout → newPcmPipe → encoderInput).
 */
export class TwoStagePipeline {
  public decoder?: ChildProcessWithoutNullStreams;
  public pcmPipe?: PassThrough;
  public encoderInput?: PassThrough;

  constructor(
    private readonly log: TwoStagePipelineLogger,
    private readonly logContext: Record<string, unknown>,
    /**
     * Where the decoder's stderr goes besides the log.
     *
     * The decoder is a second ffmpeg reading the same source, so its banner states the source format
     * and the source duration exactly as the single-stage process's does. It used to go nowhere but
     * `log.debug`, which meant every two-stage topology — the DSP path included — learned nothing from
     * a banner we were already asking for and paying for.
     */
    private readonly onStderr?: (message: string) => void,
  ) {}

  /**
   * Spawn the decoder ffmpeg with the supplied args and wire decoder.stdout →
   * pcmPipe → encoderInput. `isCrossfadeActive` is consulted on decoder exit so
   * encoderInput is not closed mid-crossfade (crossfade will reattach a new decoder).
   */
  public startDecoder(
    args: string[],
    isCrossfadeActive: () => boolean,
    /**
     * Asked when the decoder is gone and no crossfade is running: true when something else is going
     * to keep feeding the encoder — a next track attached behind this one — so it must stay open.
     */
    keepsEncoderOpen: (code: number | null) => boolean = () => false,
  ): void {
    this.encoderInput = new PassThrough();
    this.pcmPipe = new PassThrough();

    const proc = this.spawnDecoder(args, {
      onEnded: (reason, code) => {
        if (isCrossfadeActive() || keepsEncoderOpen(code)) {
          return;
        }
        if (reason === 'error') {
          // Never started, so there is nothing of it left to wait for.
          this.encoderInput?.end();
          return;
        }
        // The process exiting is not its output having arrived: the kernel may still hold the last
        // of what it wrote. Closing the encoder on the exit itself cut that off — the final fraction
        // of a second of a track — so the close waits until the pipe has been read dry and the
        // bridge behind it has passed everything on.
        afterDrained(proc.stdout, () => {
          const bridge = this.pcmPipe;
          if (!bridge || (this.decoder !== undefined && this.decoder !== proc) || isCrossfadeActive()) {
            return;
          }
          bridge.once('end', () => this.encoderInput?.end());
          bridge.end();
        });
      },
    });

    this.countDecoded(proc);
    proc.stdout.pipe(this.pcmPipe, { end: false });
    this.pcmPipe.pipe(this.encoderInput, { end: false });
  }

  /** PCM bytes the current decoder has produced so far: how much of its track there has been. */
  public decodedBytes = 0;

  /** Start counting a decoder's output as the current track's. */
  public countDecoded(proc: ChildProcessWithoutNullStreams): void {
    this.decodedBytes = 0;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.decoder === proc) {
        this.decodedBytes += chunk.length;
      }
    });
  }

  /**
   * Spawn a decoder and own its lifecycle without wiring the crossfade bridge.
   *
   * The engine-DSP topology feeds our own PCM stage instead of `pcmPipe`, but it wants the same
   * ownership: stderr on the session log, one `onEnded` for both exit and spawn failure, and
   * {@link terminateDecoder} to reach it.
   */
  public spawnDecoder(
    args: string[],
    handlers: { onEnded: (reason: 'exit' | 'error', code: number | null) => void },
  ): ChildProcessWithoutNullStreams {
    const proc = spawn(ffmpegBinary(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.decoder = proc;

    proc.stderr?.on('data', (c: Buffer) => {
      const msg = c.toString().trim();
      if (!msg) return;
      this.onStderr?.(msg);
      this.log.debug('decoder stderr', { ...this.logContext, message: msg });
    });
    proc.on('exit', (code, signal) => {
      this.log.debug('decoder exited', { ...this.logContext, code, signal });
      handlers.onEnded('exit', code);
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      this.log.warn('decoder error', { ...this.logContext, message: err.message });
      handlers.onEnded('error', null);
    });
    return proc;
  }

  public terminateDecoder(): void {
    const proc = this.decoder;
    if (!proc) return;
    proc.stdout.removeAllListeners();
    // Drain stdout to nowhere, or an ffmpeg blocked in write() on a pipe nobody reads never reaches the
    // point where it acts on the signal below.
    proc.stdout.resume();
    // Close stdin for the same reason on the other side: a decoder fed by a live producer sits in a
    // blocking read() and only notices SIGTERM once that returns, so it would take the full SIGKILL
    // timeout to die. EOF lets it flush and exit at once — measured 2.5 s down to ~40 ms for a topology
    // swap that has to wait for this exit.
    if (!proc.stdin.destroyed) {
      proc.stdin.end();
    }
    this.decoder = undefined;
    proc.kill('SIGTERM');
    // Escalate to SIGKILL if it does not exit (e.g. wedged in an -reconnect loop
    // on a slow input). Gate on real exit, not proc.killed (which is already true
    // after the SIGTERM above), or a stuck decoder leaks.
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, 2000);
    proc.once('exit', () => clearTimeout(killTimer));
  }
}
