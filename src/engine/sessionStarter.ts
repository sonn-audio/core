import { PassThrough } from 'node:stream';
import { FFMPEG_LOW_LATENCY_ARGS } from '@/engine/ffmpegArgs';
import { PcmDspStage } from '@/engine/pcmDsp';
import type { AudioSession } from '@/engine/audioSession';

/**
 * Strategy class that owns the four "how to start an AudioSession" paths.
 * Each method assumes the session has already done its common pre-init
 * (buffer.clear, pcmAligner.reset, firstChunk.arm, etc.) — this class
 * just wires up the source-specific pipeline.
 */
export class SessionStarter {
  constructor(private readonly session: AudioSession) {}

  /**
   * Pipe source, profile=pcm, format/rate/channels already match output settings, no
   * filter chain needed. Stream bytes straight to subscribers without an ffmpeg hop.
   */
  public startDirectPipe(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    const s = this.session;
    s.pipeSource.adopt(stream);
    s.directPipeMode = true;
    s.startTs = Date.now();
    s.log.info('using direct pipe passthrough', {
      zoneId: s.zoneId,
      profile: s.profile,
      format: fmt,
      sampleRate: sr,
      channels: ch,
    });

    let sourceBytesSinceLog = 0;
    let sourceLastLogTs = 0;
    let sourceFirstChunkLogged = false;
    s.pipeSource.onData((chunk: Buffer) => {
      if (!chunk?.length) {
        return;
      }
      sourceBytesSinceLog += chunk.length;
      if (!sourceFirstChunkLogged) {
        sourceFirstChunkLogged = true;
        s.log.info('pipe source first chunk', {
          zoneId: s.zoneId,
          bytes: chunk.length,
          format: fmt,
          sampleRate: sr,
          channels: ch,
        });
      }
      const now = Date.now();
      if (!sourceLastLogTs) {
        sourceLastLogTs = now;
      } else {
        const elapsed = now - sourceLastLogTs;
        if (elapsed >= 1000) {
          const bps = Math.round((sourceBytesSinceLog / elapsed) * 1000);
          s.log.spam('pipe source throughput', {
            zoneId: s.zoneId,
            bytesPerSec: bps,
          });
          sourceLastLogTs = now;
          sourceBytesSinceLog = 0;
        }
      }

      s.emitOutputChunk(chunk, { firstChunkLabel: 'direct pipe first chunk' });
    });
    s.pipeSource.onError((err: unknown) => {
      s.log.warn('pipe source error', {
        zoneId: s.zoneId,
        message: (err as { message?: string } | null)?.message || String(err),
      });
      if (!s.ending) {
        s.cleanup();
      }
    });
    s.pipeSource.onEndOrClose(() => {
      s.log.debug('pipe source ended', { zoneId: s.zoneId, profile: s.profile });
      if (!s.ending) {
        s.cleanup();
      }
    });
    // A restart re-adopts a stream that a previous topology may have left paused.
    s.pipeSource.resume();
  }

  /**
   * Pipe source that needs filter/codec conversion. PCM is bridged through pcmPipe →
   * encoderInput so a crossfade can swap the source without dropping ffmpeg.
   */
  public startPipeWithFfmpeg(
    stream: NodeJS.ReadableStream,
    fmt: string,
    sr: number,
    ch: number,
  ): void {
    const s = this.session;
    s.pipeSource.detach(s.pipeline.pcmPipe);
    s.pipeSource.adopt(stream);
    const paceInput = (s.source as { realTime?: boolean }).realTime !== false;
    // When pacing is enabled, apply -re so ffmpeg throttles to real-time. Without it,
    // ffmpeg may read from the upstream pipe as fast as possible which makes the
    // Sendspin timestamps run ahead of wall clock and causes the client to speed up.
    // The low-latency-args include -probesize 32k -analyzeduration 0 even though the
    // format is explicitly specified via -f. This is intentional: even with an explicit
    // format, ffmpeg still runs an analyze phase that buffers ~1.1 s of PCM before
    // producing any output. Setting analyzeduration=0 reduces that to ~50 ms.
    const inputArgs = [
      ...FFMPEG_LOW_LATENCY_ARGS,
      ...(paceInput ? ['-re'] : []),
      '-f', fmt,
      '-ar', String(sr),
      '-ac', String(ch),
      '-i', 'pipe:0',
    ];
    const args = [
      // `-nostats` because the log level may be `info` purely to get the input banner (see
      // `getLogLevel`), and info-level progress lines would otherwise arrive twice a second.
      '-hide_banner', '-nostats', '-loglevel', s.args.getLogLevel(),
      ...inputArgs,
      ...s.args.buildOutputArgs(s.equalizerBands),
      'pipe:1',
    ];

    s.log.debug('spawning ffmpeg (pipe stream)', {
      zoneId: s.zoneId,
      args,
      inputFormat: fmt,
      inputSampleRate: sr,
      inputChannels: ch,
      outputSampleRate: s.outputSettings.sampleRate,
      outputChannels: s.outputSettings.channels,
      outputBitDepth: s.outputSettings.pcmBitDepth,
      profile: s.profile,
    });
    // Insert PassThrough chain so crossfade can blend PCM before the encoder.
    // stream → pcmPipe → encoderInput → FFmpeg.stdin
    const pcmBridge = new PassThrough();
    const encInput = new PassThrough();
    s.pipeline.pcmPipe = pcmBridge;
    s.pipeline.encoderInput = encInput;
    stream.pipe(pcmBridge, { end: false });
    pcmBridge.pipe(encInput, { end: false });

    s.pipeSource.onEndOrClose(() => {
      try { stream.unpipe(pcmBridge); } catch { /* ignore */ }
      if (!s.crossfadeActive && !s.ending) encInput.end();
    });
    s.pipeSource.onError((err: unknown) => {
      s.log.warn('pipe source error', {
        zoneId: s.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      encInput.destroy();
    });

    s.startTs = Date.now();
    const proc: ReturnType<AudioSession['spawnFfmpeg']> = s.spawnFfmpeg(args, {
      restartOnFailure: false,
      logFirstChunk: false,
      onExit: () => {
        try { encInput.unpipe(proc.stdin); } catch { /* ignore */ }
      },
    });
    encInput.pipe(proc.stdin);
    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'EPIPE') {
        s.log.debug('ffmpeg stdin closed (EPIPE)', { zoneId: s.zoneId });
      } else {
        s.log.warn('ffmpeg stdin error', {
          zoneId: s.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Monitor incoming source stream for pacing visibility.
    let sourceBytesSinceLog = 0;
    let sourceLastLogTs = 0;
    let sourceFirstChunkLogged = false;
    s.pipeSource.onData((chunk: Buffer) => {
      if (!chunk?.length) {
        return;
      }
      sourceBytesSinceLog += chunk.length;
      if (!sourceFirstChunkLogged) {
        sourceFirstChunkLogged = true;
        s.log.info('pipe source first chunk', {
          zoneId: s.zoneId,
          bytes: chunk.length,
          format: fmt,
          sampleRate: sr,
          channels: ch,
          spawnToFirstInputMs: s.startTs ? Math.max(0, Date.now() - s.startTs) : null,
        });
      }
      const now = Date.now();
      if (!sourceLastLogTs) {
        sourceLastLogTs = now;
        return;
      }
      const elapsed = now - sourceLastLogTs;
      if (elapsed >= 1000) {
        const bps = Math.round((sourceBytesSinceLog / elapsed) * 1000);
        s.log.spam('pipe source throughput', {
          zoneId: s.zoneId,
          bytesPerSec: bps,
        });
        sourceLastLogTs = now;
        sourceBytesSinceLog = 0;
      }
    });

    s.process = proc;
  }

  /**
   * Pipe source without an attached stream (rare fallback). Builds input args from
   * the source path and runs a single ffmpeg without the pcmPipe/encoderInput bridge.
   */
  public startSingleStage(): void {
    const s = this.session;
    const args = [
      // `-nostats` because the log level may be `info` purely to get the input banner (see
      // `getLogLevel`), and info-level progress lines would otherwise arrive twice a second.
      '-hide_banner', '-nostats', '-loglevel', s.args.getLogLevel(),
      ...s.args.buildInputArgs(),
      ...s.args.buildOutputArgs(s.equalizerBands),
      'pipe:1',
    ];

    s.log.debug('spawning ffmpeg', {
      zoneId: s.zoneId,
      args,
      outputSampleRate: s.outputSettings.sampleRate,
      outputChannels: s.outputSettings.channels,
      outputBitDepth: s.outputSettings.pcmBitDepth,
      profile: s.profile,
    });
    s.startTs = Date.now();
    s.process = s.spawnFfmpeg(args, {
      // After the file/url guard, only pipe/crossfade sources reach here.
      restartOnFailure: s.source.kind === 'pipe',
      logFirstChunk: true,
    });
  }

  /**
   * File/URL source with DSP: ffmpeg decodes and resamples to float, our own stage owns the gain, the
   * equalizer and the requantisation, and only a codec profile needs an encoder behind it.
   *
   *   decoder ffmpeg (→ f32le) → PcmDspStage (→ int) → subscribers
   *                                                  ↳ encoder ffmpeg → subscribers   (flac/mp3/aac/opus)
   *
   * The point is not fewer processes (though a PCM zone does drop one): it is that the DSP no longer
   * lives inside a process whose command line is fixed for its lifetime, so an EQ change is a
   * coefficient swap instead of a respawn with a re-seek.
   */
  public startEngineDsp(sourceStream?: NodeJS.ReadableStream): void {
    const s = this.session;
    const spec = s.args.engineDspSpec(s.equalizerBands) ?? { gainDb: 0, bands: null };
    const dsp = new PcmDspStage({
      sampleRate: s.outputSettings.sampleRate,
      channels: s.outputSettings.channels,
      bitDepth: s.outputSettings.pcmBitDepth,
      floatOutput: s.args.engineDspEmitsFloat(),
      gainDb: spec.gainDb,
      bands: spec.bands,
    });
    s.dsp = dsp;
    s.engineDspMode = true;
    s.startTs = Date.now();

    const decoderArgs = s.args.buildF32DecoderArgs({ fromStdin: Boolean(sourceStream) });
    s.log.debug('spawning ffmpeg (engine-dsp decoder)', {
      zoneId: s.zoneId,
      args: decoderArgs,
      profile: s.profile,
      gainDb: spec.gainDb,
      headroomDb: dsp.headroomDb,
      equalizer: spec.bands ? [...spec.bands] : null,
    });
    // Ending the stage is `decoder.stdout.pipe(dsp)`'s job, and it does it on stdout's `end` — the
    // moment Node has read the pipe dry. The decoder *process* exits before that: the kernel still
    // holds what it wrote. Ending the stage from this handler therefore raced that drain and lost
    // every single time. The next chunk landed on an ended writable, `dsp` emitted
    // ERR_STREAM_WRITE_AFTER_END, and the error handler below answered it with `cleanup()` — so the
    // session was gone 4 ms after the decoder exited and seconds before the track was over, taking
    // the encoder's unflushed output with it. That cost the last ~5 s of every track and left the
    // zone silent until the clock ended the track for real (#322).
    //
    // A clean exit now ends nothing here. What still needs a hand is a stdout that will never drain
    // by itself: a decoder that failed to spawn, and one whose stdout `terminateDecoder` has
    // unhooked — which is how an EQ change restarts a PCM-profile zone, where this stage's `end` is
    // the only thing that drives the restart.
    const endStage = (): void => {
      if (!dsp.destroyed && !dsp.writableEnded) {
        dsp.end();
      }
    };
    const decoder = s.pipeline.spawnDecoder(decoderArgs, {
      onEnded: (reason) => {
        if (reason === 'exit' && decoder.stdout.listenerCount('data') > 0) {
          // Still piped, so stdout's `end` will end the stage. `close` is the backstop for a stdout
          // destroyed rather than drained, which unpipes without ending anything.
          decoder.stdout.once('close', endStage);
          return;
        }
        endStage();
      },
    });
    decoder.stdout.pipe(dsp);

    if (sourceStream) {
      // A live producer (a Spotify run, line-in) feeds the decoder's stdin. Its end must close that stdin so
      // ffmpeg flushes, and its errors must not be raised on a pipe nobody is reading.
      s.pipeSource.adopt(sourceStream);
      s.pipeTarget = decoder.stdin;
      sourceStream.pipe(decoder.stdin);
      decoder.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.code === 'EPIPE') {
          s.log.debug('engine dsp decoder stdin closed (EPIPE)', { zoneId: s.zoneId });
        } else {
          s.log.warn('engine dsp decoder stdin error', { zoneId: s.zoneId, message: err.message });
        }
      });
      s.pipeSource.onError((err: unknown) => {
        s.log.warn('pipe source error', {
          zoneId: s.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
        decoder.stdin.destroy();
      });
      s.pipeSource.onEndOrClose(() => {
        s.log.debug('pipe source ended', { zoneId: s.zoneId, profile: s.profile });
        if (!s.ending && !decoder.stdin.destroyed) {
          decoder.stdin.end();
        }
      });
      // A restart re-adopts a stream that a previous topology may have left paused.
      s.pipeSource.resume();
    }
    dsp.on('error', (err: Error) => {
      s.log.warn('engine dsp stage error', { zoneId: s.zoneId, message: err.message });
      // A write arriving after the stage finished says the producer outlived the stage, not that the
      // session is broken — everything downstream is already flushing on its own terms. Tearing the
      // session down is what threw the encoder's remaining output away (#322), so this one error is
      // logged and otherwise left alone.
      if (!s.ending && (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_WRITE_AFTER_END') {
        s.cleanup();
      }
    });

    if (s.profile === 'pcm') {
      // No encoder: the stage's output *is* the session's output.
      s.outputReadable = dsp;
      dsp.on('data', (chunk: Buffer) => {
        s.emitOutputChunk(chunk, { firstChunkLabel: 'engine dsp first chunk' });
      });
      dsp.on('end', () => {
        s.log.debug('engine dsp stage ended', { zoneId: s.zoneId, profile: s.profile });
        s.handleProducerEnded();
      });
      return;
    }

    const encoderArgs = s.args.buildEngineDspEncoderArgs();
    s.log.debug('spawning ffmpeg (engine-dsp encoder)', {
      zoneId: s.zoneId,
      args: encoderArgs,
      profile: s.profile,
    });
    s.process = s.spawnFfmpeg(encoderArgs, { logFirstChunk: true, stdinStream: dsp });
  }

  /**
   * File/URL source. Starts the two-stage pipeline (decoder ffmpeg → pcmPipe →
   * encoderInput → encoder ffmpeg) so crossfade can blend raw PCM.
   */
  public startTwoStage(): void {
    const s = this.session;
    s.startTs = Date.now();

    const decoderArgs = s.args.buildPcmDecoderArgs();
    s.log.debug('spawning ffmpeg (decoder)', { zoneId: s.zoneId, args: decoderArgs, profile: s.profile });
    s.pipeline.startDecoder(
      decoderArgs,
      () => s.crossfadeActive,
      (code) => s.gapless.takeOverFrom(s.pipeline.decoder ?? null, code),
    );

    const encoderArgs = s.args.buildPcmEncoderArgs(s.equalizerBands);
    s.log.debug('spawning ffmpeg (encoder)', { zoneId: s.zoneId, args: encoderArgs, profile: s.profile });
    s.process = s.spawnFfmpeg(encoderArgs, {
      logFirstChunk: true,
      stdinStream: s.pipeline.encoderInput,
    });
  }
}
