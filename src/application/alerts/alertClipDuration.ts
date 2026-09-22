import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createLogger } from '@/shared/logging/logger';
import { ffmpegBinary } from '@/engine/ffmpegProcess';

const DURATION_PROBE_TIMEOUT_MS = 30000;

const log = createLogger('Alerts', 'Duration');

/**
 * Memoized per clip, keyed by what the file *is* rather than only where it sits.
 *
 * An alert clip is not written once and then only read, which is what an earlier
 * version of this cache assumed: the admin UI replaces a bundled sound in place
 * and can revert it, both to the same path. Keyed on the path alone, a 3 s bell
 * replaced by a 30 s clip kept reporting 3 s until a restart — and the stop timer
 * is fed from here, so the new clip was cut off mid-way. Size and mtime change
 * whenever the bytes do, so a replaced file simply misses the cache.
 */
const durationCache = new Map<string, number>();

/** Bounded so replacing a clip repeatedly cannot grow the map without end. */
const CACHE_LIMIT = 200;

/**
 * Identity of the file's current contents, or null when it cannot be stat'd —
 * in which case nothing is cached and the probe is left to fail on its own.
 */
async function cacheKey(absPath: string): Promise<string | null> {
  try {
    const info = await stat(absPath);
    return `${absPath}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

function remember(key: string, seconds: number): void {
  if (durationCache.size >= CACHE_LIMIT) {
    const oldest = durationCache.keys().next().value;
    if (oldest !== undefined) {
      durationCache.delete(oldest);
    }
  }
  durationCache.set(key, seconds);
}

/**
 * Resolve the playable length of an alert clip in seconds, or `undefined` when it
 * cannot be determined.
 *
 * Every alert source funnels through here — bundled files, uploads, and the
 * clips synthesized by the TTS providers — so the stop timer is fed by one
 * measurement method regardless of where the audio came from.
 *
 * The fraction is kept. Rounding to whole seconds here quietly shortened the stop
 * window by up to half a second on every clip that does not land on a second
 * boundary — a 5.14 s announcement was timed as 5 s — and that comes straight off
 * the tail, which is the one end of an alert nothing else can give back (#387).
 * Whole seconds are what Loxone is *told*; they are not what the clip lasts, so
 * the rounding belongs at that edge and only there.
 */
export async function probeAlertDurationSeconds(absPath: string): Promise<number | undefined> {
  const key = await cacheKey(absPath);
  if (key !== null) {
    const cached = durationCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
  }
  const seconds = await decode(absPath);
  if (typeof seconds === 'number' && seconds > 0) {
    if (key !== null) {
      remember(key, seconds);
    }
    log.debug('alert duration probed', { path: absPath, durationSec: seconds });
    return seconds;
  }
  return undefined;
}

type DurationDecoder = (absPath: string) => Promise<number | undefined>;

let decode: DurationDecoder = (absPath) => decodeDurationSeconds(absPath);

/**
 * Test seam: swap the ffmpeg probe out, and restore it with the returned
 * function. The suite mocks every ffmpeg spawn globally, so a test cannot reach
 * the real decoder — and what is worth testing here is the caching, not ffmpeg.
 */
export function setDurationDecoderForTests(fn: DurationDecoder): () => void {
  const previous = decode;
  decode = fn;
  return () => {
    decode = previous;
  };
}

/**
 * Measure the true playable duration by decoding the file to null and reading ffmpeg's
 * final reported position, instead of trusting the container header.
 *
 * Loxone voice recordings carry a WAV `data` chunk size that under-reports the real length;
 * a header parser (music-metadata) then returned e.g. 18 s for a 30 s clip, so the alert
 * stop timer fired early and clipped the recording on Sonos (#276). Decoding reports what
 * actually plays out, which is exactly what the stop timer needs. The same trap is open to
 * any TTS backend that answers in wav or opus, which is why they share this probe.
 *
 * `-vn` because cover art is a video stream of one frame at t=0, and the position ffmpeg
 * reports is the *earliest* of its outputs: with the picture mapped, `bell.mp3` measured
 * 0.00 s instead of 3.48 s. A zero-length probe falls back to `MIN_ALERT_DURATION_MS`, so
 * the doorbell held the zone for 20 seconds and the music came back long after the ring.
 */
function decodeDurationSeconds(absPath: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let lastSeconds: number | undefined;
    const finish = (value: number | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const proc = spawn(ffmpegBinary(), ['-hide_banner', '-i', absPath, '-vn', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(lastSeconds);
    }, DURATION_PROBE_TIMEOUT_MS);
    timer.unref?.();
    // ffmpeg reports the running output position on stderr as `time=HH:MM:SS.ss`; the final
    // line carries the true total once decoding reaches EOF.
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const re = /time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        if (Number.isFinite(seconds) && seconds >= 0) {
          lastSeconds = seconds;
        }
      }
    });
    proc.on('error', (err) => {
      log.debug('alert duration probe failed', {
        path: absPath,
        message: err instanceof Error ? err.message : String(err),
      });
      finish(undefined);
    });
    proc.on('exit', () => finish(lastSeconds));
  });
}
