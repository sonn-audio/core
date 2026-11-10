import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { LIBRARY_AUDIO_MIME_TYPES } from '@/shared/audio/libraryAudioFiles';
import type { EnginePort, EngineLocalSession } from '@/ports/EnginePort';
import type { ContentPort } from '@/ports/ContentPort';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';
import { allocateEphemeralSessionKey } from '@/ports/types/SessionKey';
import { resolvePlaybackSource as resolveDirectSource } from '@/application/playback/sourceResolver';

/**
 * Serves the audio bytes for `stream` / `download`.
 *
 * Two paths, chosen by what the track actually is:
 *
 *   - **Local file** → served straight from disk with real byte ranges. Nothing
 *     is transcoded, so the client gets the original container and working seek.
 *     This is the advantage Subsonic has over our DLNA server, where a live
 *     transcode forced `Accept-Ranges: none`.
 *   - **Provider track** (Apple/Deezer/Tidal/YT/SoundCloud/…) → resolved through
 *     the content layer and pulled through a self-owned engine session as MP3,
 *     the same mechanism the DLNA track endpoint uses. No ranges: the bytes do
 *     not exist until the transcode produces them.
 *
 * Spotify resolves to no PlaybackSource and 404s: it only plays through a zone's
 * own Connect host, never pulled through a zone-less engine session.
 */
export class SubsonicStreamHandler {
  private readonly log = createLogger('Subsonic', 'Stream');

  constructor(
    private readonly engine: EnginePort,
    private readonly content: ContentPort,
  ) {}

  /**
   * @param transcodeOnly forces the engine path even for local files, for a
   *   client that asked for a specific format or bitrate cap.
   */
  public async serve(
    req: IncomingMessage,
    res: ServerResponse,
    audiopath: string,
    options: { maxBitRateKbps?: number; transcodeOnly?: boolean } = {},
  ): Promise<boolean> {
    const direct = resolveDirectSource(audiopath);
    if (direct?.kind === 'file' && !options.transcodeOnly && !options.maxBitRateKbps) {
      const served = await this.serveFile(req, res, direct.path);
      if (served) {
        return true;
      }
      // The DB row outlived the file; fall through to the engine, which may still
      // resolve it (and will fail cleanly if it cannot).
    }

    const source = direct ?? (await this.resolveProviderSource(audiopath));
    if (!source) {
      return false;
    }
    await this.serveTranscoded(req, res, audiopath, source, options.maxBitRateKbps);
    return true;
  }

  // ── Local files ───────────────────────────────────────────────────────────

  /** Serve a file with Range support. Returns false when it is not readable. */
  private async serveFile(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
  ): Promise<boolean> {
    let size: number;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        return false;
      }
      size = stat.size;
    } catch {
      return false;
    }

    const range = parseRange(req.headers.range, size);
    const contentType = mimeForPath(filePath);
    const isHead = (req.method ?? 'GET').toUpperCase() === 'HEAD';

    if (range === 'unsatisfiable') {
      res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end();
      return true;
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;

    res.writeHead(range ? 206 : 200, {
      'Content-Type': contentType,
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });

    if (isHead || length === 0) {
      res.end();
      return true;
    }

    await new Promise<void>((resolve) => {
      const stream = fs.createReadStream(filePath, { start, end });
      const done = () => resolve();
      stream.on('error', (error) => {
        this.log.debug('file stream error', {
          filePath,
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.writableEnded) {
          res.end();
        }
        resolve();
      });
      res.on('close', () => {
        stream.destroy();
        resolve();
      });
      stream.on('end', done);
      stream.pipe(res);
    });
    return true;
  }

  // ── Provider tracks via the engine ────────────────────────────────────────

  private async resolveProviderSource(audiopath: string): Promise<PlaybackSource | null> {
    try {
      const resolution = await this.content.resolvePlaybackSource({
        audiopath,
        // A non-zone requester: no zone to scope the cache or route errors to.
        requester: { kind: 'ephemeral' },
      });
      return resolution.playbackSource ?? null;
    } catch (error) {
      this.log.debug('content resolve failed', {
        audiopath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async serveTranscoded(
    req: IncomingMessage,
    res: ServerResponse,
    audiopath: string,
    source: PlaybackSource,
    maxBitRateKbps?: number,
  ): Promise<void> {
    const settings = this.outputSettings(maxBitRateKbps);
    const duration = await this.resolveDuration(audiopath);
    const contentLength = estimateBytes(duration, settings.mp3Bitrate);

    // Clients probe with HEAD before streaming; answer headers and spin up nothing.
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      this.writeStreamHeaders(res, contentLength);
      res.end();
      return;
    }

    // Ephemeral session key: a non-zone consumer lives in a disjoint key space
    // that never resolves against zone state. The session is self-owned and
    // never looked up by key.
    const sessionKey = allocateEphemeralSessionKey();
    let session: EngineLocalSession;
    try {
      session = this.engine.createLocalSession(sessionKey, source, 'mp3', settings, () => {
        /* terminated: cleanup is driven by the stream/socket events below */
      });
    } catch (error) {
      this.log.warn('failed to create local session', {
        audiopath,
        message: error instanceof Error ? error.message : String(error),
      });
      this.serverError(res);
      return;
    }

    let subscriber: ReturnType<EngineLocalSession['createSubscriber']> = null;
    try {
      session.start();
      subscriber = session.createSubscriber({ primeWithBuffer: true, label: 'subsonic' });
    } catch (error) {
      this.log.warn('failed to start local session', {
        audiopath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!subscriber) {
      try {
        session.stop();
      } catch {
        /* ignore */
      }
      this.serverError(res);
      return;
    }

    this.writeStreamHeaders(res, contentLength);

    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        subscriber?.destroy();
      } catch {
        /* ignore */
      }
      try {
        session.stop();
      } catch {
        /* ignore */
      }
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        /* ignore */
      }
    };

    subscriber.pipe(res);
    subscriber.on('end', () => {
      if (!res.writableEnded) {
        res.end();
      }
    });
    subscriber.on('error', dispose);
    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
  }

  /** Honour the client's `maxBitRate` cap by lowering the engine's MP3 bitrate. */
  private outputSettings(maxBitRateKbps?: number): typeof audioOutputSettings {
    if (!maxBitRateKbps || !Number.isFinite(maxBitRateKbps) || maxBitRateKbps <= 0) {
      return audioOutputSettings;
    }
    const configured = Math.round(mp3BitrateToBps(audioOutputSettings.mp3Bitrate) / 1000);
    if (configured > 0 && maxBitRateKbps >= configured) {
      return audioOutputSettings;
    }
    return { ...audioOutputSettings, mp3Bitrate: `${Math.round(maxBitRateKbps)}k` };
  }

  private async resolveDuration(audiopath: string): Promise<number | undefined> {
    try {
      const meta = await this.content.resolveMetadata(audiopath);
      const duration = meta?.duration;
      return typeof duration === 'number' && duration > 0 ? duration : undefined;
    } catch {
      return undefined;
    }
  }

  private writeStreamHeaders(res: ServerResponse, contentLength: number | null): void {
    const headers: Record<string, string | number> = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      // The bytes are produced on the fly, so ranges cannot be honoured. Saying
      // so keeps a client from issuing a Range request it would misread.
      'Accept-Ranges': 'none',
    };
    if (contentLength && contentLength > 0) {
      // An estimated length (bitrate × duration) is what lets a client show a
      // seekbar and a finite track instead of treating this as a live stream.
      headers['Content-Length'] = contentLength;
    }
    res.writeHead(200, headers);
  }

  private serverError(res: ServerResponse): void {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
    }
    res.end('engine-unavailable');
  }
}

type ParsedRange = { start: number; end: number };

/**
 * Parse a single-range `Range` header. Multi-range requests are ignored (served
 * whole), which is legal and what audio clients expect.
 */
export function parseRange(
  header: string | string[] | undefined,
  size: number,
): ParsedRange | 'unsatisfiable' | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || size <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, startRaw = '', endRaw = ''] = match;
  if (!startRaw && !endRaw) {
    return null;
  }

  let start: number;
  let end: number;
  if (!startRaw) {
    // Suffix form `bytes=-N`: the last N bytes.
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return 'unsatisfiable';
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
    if (!Number.isFinite(start) || start >= size) {
      return 'unsatisfiable';
    }
    if (!Number.isFinite(end) || end >= size) {
      end = size - 1;
    }
    if (end < start) {
      return 'unsatisfiable';
    }
  }
  return { start, end };
}

const MIME_BY_EXT: Record<string, string> = {
  ...LIBRARY_AUDIO_MIME_TYPES,
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

function mimeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function estimateBytes(durationSeconds: number | undefined, mp3Bitrate: string): number | null {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  const bps = mp3BitrateToBps(mp3Bitrate);
  if (bps <= 0) {
    return null;
  }
  return Math.round((bps / 8) * durationSeconds);
}
