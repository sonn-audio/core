import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ffmpegBinary } from '@/engine/ffmpegProcess';
import type { AudioSession } from '@/engine/audioSession';
import { afterDrained } from '@/engine/twoStagePipeline';
import type { PlaybackSource } from '@/engine/playbackSource';

/** What a completed continuation says about the track it followed. */
export interface GaplessSplice {
  /** Frames of the outgoing track that went onto the bus: its length as it was actually decoded. */
  frames: number;
  sampleRate: number;
}

interface Armed {
  source: PlaybackSource;
  /** The decoder being followed. */
  outgoing: ChildProcessWithoutNullStreams;
  /** The decoder of the track to follow, started ahead of time and held at its first bytes. */
  incoming: ChildProcessWithoutNullStreams;
  /** Set once the incoming decoder has gone, with how it went. */
  incomingExit?: { code: number | null };
  resolve: (splice: GaplessSplice | null) => void;
}

function hasExited(proc: ChildProcessWithoutNullStreams): boolean {
  return proc.exitCode != null || proc.signalCode != null;
}

/**
 * Carries a session over into the next track without a gap.
 *
 * Between two tracks the server used to stop one session and start another, and every output was
 * told to play a new stream: a renderer stops, fetches, buffers and starts again, which is half a
 * second to several seconds of silence in the middle of a live album or between the movements of a
 * symphony. Nothing about the audio requires it. The tracks are decoded to the same PCM, and the
 * second one can simply follow the first into the encoder — the output keeps the stream it has and
 * never learns there was a boundary.
 *
 * So the next track's decoder is started while the current one is still playing, and waits: its
 * output pipe fills and ffmpeg blocks, opened and ready. The moment the current decoder has handed
 * over its last sample, the waiting one is connected in its place. The join is at the sample: no
 * blend, no trimmed tail, nothing added.
 *
 * Only for the decoder-and-encoder topology, where the decoder is a process that can be replaced.
 * A session without one answers `null`, and its track ends the way tracks always have.
 */
export class GaplessAppender {
  private armed: Armed | null = null;

  constructor(private readonly session: AudioSession) {}

  public arm(source: PlaybackSource): Promise<GaplessSplice | null> {
    const s = this.session;
    const outgoing = s.pipeline.decoder;
    if (
      this.armed ||
      s.ending ||
      s.crossfadeActive ||
      source.kind === 'pipe' ||
      !outgoing ||
      !s.pipeline.pcmPipe ||
      !s.pipeline.encoderInput ||
      hasExited(outgoing)
    ) {
      return Promise.resolve(null);
    }
    const args = s.buildBusDecoderArgs(source);
    s.log.debug('spawning ffmpeg (next track decoder)', { zoneId: s.zoneId, args, profile: s.profile });
    const incoming = spawn(ffmpegBinary(), args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    return new Promise((resolve) => {
      const armed: Armed = { source, outgoing, incoming, resolve };
      this.armed = armed;
      incoming.stderr.on('data', (chunk: Buffer) => {
        const message = chunk.toString().trim();
        if (!message) return;
        // Its banner describes the *next* track, so it only counts once that is the one playing.
        if (s.pipeline.decoder === incoming) {
          s.observeBanner(message);
        }
        s.log.debug('next decoder stderr', { zoneId: s.zoneId, message });
      });
      incoming.on('error', (error: NodeJS.ErrnoException) => {
        s.log.warn('next decoder error', { zoneId: s.zoneId, message: error.message });
        this.onIncomingGone(armed, null, true);
      });
      incoming.on('exit', (code) => this.onIncomingGone(armed, code, false));
    });
  }

  /** Drop whatever is lined up. The current track then ends as an ordinary last track. */
  public disarm(): void {
    const armed = this.armed;
    if (!armed) return;
    this.armed = null;
    armed.incoming.stdout.resume();
    armed.incoming.kill('SIGKILL');
    armed.resolve(null);
  }

  /**
   * The decoder `proc` has exited. True when a next track is lined up behind it and will take over,
   * so whoever asks must leave the encoder open.
   */
  public takeOverFrom(proc: ChildProcessWithoutNullStreams | null, code: number | null): boolean {
    const s = this.session;
    const armed = this.armed;
    if (!armed || !proc || armed.outgoing !== proc) {
      return false;
    }
    // A decoder that failed did not reach the end of its track; joining the next one on there
    // would pass a broken track off as a finished one.
    if (code !== 0 || s.ending) {
      this.disarm();
      return false;
    }
    // The process is gone, but what it wrote may not all have been read yet. The join waits for
    // the last of it, or the next track would start in the middle of this one's final moments.
    afterDrained(proc.stdout, () => this.splice(armed));
    return true;
  }

  private splice(armed: Armed): void {
    const s = this.session;
    if (this.armed !== armed) {
      return;
    }
    this.armed = null;
    const pcmPipe = s.pipeline.pcmPipe;
    const failed = armed.incomingExit !== undefined && armed.incomingExit.code !== 0;
    if (s.ending || !pcmPipe || failed) {
      armed.incoming.stdout.resume();
      armed.incoming.kill('SIGKILL');
      if (!s.ending) s.pipeline.encoderInput?.end();
      armed.resolve(null);
      return;
    }
    const { sampleRate, channels, pcmBitDepth } = s.outputSettings;
    const frameBytes = channels * (pcmBitDepth / 8);
    const decoded = s.pipeline.decodedBytes;
    const stray = decoded % frameBytes;
    if (stray !== 0) {
      // Never seen from ffmpeg, which writes whole frames — but a track that ended mid-frame would
      // shift every sample of the next one into the wrong channel, so it is squared off regardless.
      pcmPipe.write(Buffer.alloc(frameBytes - stray));
    }

    s.pipeline.decoder = armed.incoming;
    s.adoptSource(armed.source);
    s.pipeline.countDecoded(armed.incoming);
    armed.incoming.stdout.pipe(pcmPipe, { end: false });
    s.log.info('next track joined without a gap', {
      zoneId: s.zoneId,
      profile: s.profile,
      outgoingFrames: Math.floor(decoded / frameBytes),
    });
    if (armed.incomingExit) {
      // A track short enough to have been decoded whole while it waited.
      this.onCurrentGone(armed.incoming, armed.incomingExit.code);
    }
    armed.resolve({ frames: Math.floor(decoded / frameBytes), sampleRate });
  }

  private onIncomingGone(armed: Armed, code: number | null, spawnFailed: boolean): void {
    const s = this.session;
    if (this.armed === armed) {
      // Still waiting its turn.
      armed.incomingExit = { code: spawnFailed ? -1 : code };
      if (spawnFailed || code !== 0) {
        s.log.debug('next decoder failed before its turn', { zoneId: s.zoneId, code });
        // Unless the join is already under way, in which case `splice` reads the failure itself.
        if (!hasExited(armed.outgoing)) {
          this.disarm();
        }
      }
      return;
    }
    if (s.pipeline.decoder === armed.incoming) {
      this.onCurrentGone(armed.incoming, code);
    }
  }

  /** The decoder that was joined on has itself finished: the same question, one track further. */
  private onCurrentGone(proc: ChildProcessWithoutNullStreams, code: number | null): void {
    const s = this.session;
    s.log.debug('decoder exited (joined track)', { zoneId: s.zoneId, code });
    if (s.crossfadeActive || this.takeOverFrom(proc, code)) {
      return;
    }
    if (s.ending) {
      s.pipeline.encoderInput?.end();
      return;
    }
    // Last track: close the encoder only once every sample has gone into it.
    afterDrained(proc.stdout, () => {
      const pcmPipe = s.pipeline.pcmPipe;
      if (!pcmPipe || s.pipeline.decoder !== proc) {
        return;
      }
      pcmPipe.once('end', () => s.pipeline.encoderInput?.end());
      pcmPipe.end();
    });
  }
}
