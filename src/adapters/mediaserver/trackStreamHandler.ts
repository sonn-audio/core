import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import { LIBRARY_AUDIO_MIME_TYPES } from '@/shared/audio/libraryAudioFiles';
import type { EnginePort, EngineLocalSession } from '@/ports/EnginePort';
import type { ContentPort } from '@/ports/ContentPort';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { audioOutputSettings, mp3BitrateToBps } from '@/ports/types/audioFormat';
import { allocateEphemeralSessionKey } from '@/ports/types/SessionKey';
import { resolvePlaybackSource as resolveDirectSource } from '@/application/playback/sourceResolver';
import { decodeObjectId } from '@/adapters/mediaserver/objectId';
import { buildId3v2Tag } from '@sonn-audio/node-upnp';
import { AUDIO_DLNA_FEATURES } from '@/adapters/mediaserver/mediaContentProvider';
import type { ContentItemMetadata } from '@/ports/ContentTypes';

/**
 * Serves the zone-less track endpoint `/dlna/track/<objectId>.mp3`.
 *
 * This is the piece the existing `/streams/:zone/:id` path cannot provide: a
 * stateless URL a DLNA renderer can GET at any time without a live zone session.
 * On each request we:
 *   1. decode the object id back to the track's audiopath,
 *   2. resolve it to a PlaybackSource (direct file/http, else a provider stream),
 *   3. spin up a self-owned local engine session (no zone-id coupling),
 *   4. pipe its MP3 subscriber to the response and tear the session down on close.
 *
 * Spotify resolves to no PlaybackSource and returns 404: it only plays through a
 * zone's own Connect host, so there is nothing to pull through a zone-less engine.
 */
export class TrackStreamHandler {
  private readonly log = createLogger('MediaServer', 'Track');

  constructor(
    private readonly engine: EnginePort,
    private readonly content: ContentPort,
  ) {}

  public matches(pathname: string): boolean {
    return pathname.startsWith('/dlna/track/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const encoded = stripAudioExtension(pathname.slice('/dlna/track/'.length));
    const objectId = safeDecodeURIComponent(encoded);
    const ref = decodeObjectId(objectId);
    if (!ref || ref.kind !== 'item') {
      this.notFound(res);
      return;
    }
    const audiopath = ref.audiopath;

    const source = await this.resolveSource(audiopath);
    if (!source) {
      this.log.debug('no playable source for dlna track', { audiopath });
      this.notFound(res);
      return;
    }

    // Metadata for now-playing on the renderer. The engine emits untagged audio,
    // so a renderer that reads now-playing from the stream (not the controller's
    // DIDL) would otherwise show nothing. resolveMetadata is usually a harvest-
    // cache hit from the preceding browse.
    const metadata = await this.resolveMetadata(audiopath);

    // Advertise the track as a FINITE file: a Content-Length (estimated from
    // bitrate × duration) plus the ID3 tag length. Without this the response is a
    // chunked, length-less, non-seekable body, which the B&O app reads as a LIVE
    // stream and then shows no track info at all. A real length makes it a track.
    const id3 = buildId3v2Tag({
      title: metadata?.title,
      artist: metadata?.artist,
      album: metadata?.album,
    });
    const audioBytes = this.estimateAudioBytes(metadata?.duration);
    const contentLength = audioBytes ? audioBytes + id3.length : null;

    // HEAD: renderers probe before the GET. Answer headers, spin up nothing.
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      this.writeStreamHeaders(res, contentLength);
      res.end();
      return;
    }

    // Ephemeral session key: a non-zone consumer, so it lives in a disjoint key
    // space that never resolves against zone state. The local session is
    // self-owned (its own onTerminated below) and never looked up by key.
    const sessionKey = allocateEphemeralSessionKey();
    let session: EngineLocalSession;
    try {
      session = this.engine.createLocalSession(
        sessionKey,
        source,
        'mp3',
        audioOutputSettings,
        () => {
          /* terminated: response cleanup is driven by stream/socket events below */
        },
      );
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
      subscriber = session.createSubscriber({ primeWithBuffer: true, label: 'dlna-ms' });
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

    // The ID3 tag counts toward Content-Length (it is the first body bytes).
    if (id3.length && !res.writableEnded) {
      res.write(id3);
    }

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

    if (contentLength) {
      // Deliver exactly (Content-Length − id3) audio bytes, padding a short tail
      // or truncating an overshoot, so the body matches the advertised length and
      // the client sees a finite, complete track. Backpressure via pause/resume.
      this.pipeWithContentLength(res, subscriber, audioBytes!);
    } else {
      // No duration to size the track: fall back to a plain chunked stream.
      subscriber.pipe(res);
      subscriber.on('end', () => {
        if (!res.writableEnded) {
          res.end();
        }
      });
    }
    subscriber.on('error', dispose);
    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
  }

  private estimateAudioBytes(durationSeconds?: number): number | null {
    if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }
    const bps = mp3BitrateToBps(audioOutputSettings.mp3Bitrate);
    if (bps <= 0) {
      return null;
    }
    return Math.round((bps / 8) * durationSeconds);
  }

  /**
   * Pipe the live transcode into a response that advertised a fixed Content-Length
   * for the audio portion. The encoder's real byte count rarely equals the
   * estimate, so we truncate any overshoot and zero-pad a short tail (trailing
   * zeros after the last MP3 frame are ignored by decoders) to end at exactly the
   * advertised length. Backpressure is honoured so the engine paces to the client.
   */
  private pipeWithContentLength(
    res: ServerResponse,
    subscriber: NodeJS.ReadableStream & { destroy?: (error?: Error) => void; pause?: () => void; resume?: () => void },
    audioLength: number,
  ): void {
    let written = 0;
    let finished = false;
    const MAX_PAD_BYTES = 2 * 1024 * 1024;

    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      subscriber.off?.('data', onData);
      if (res.writableEnded || res.destroyed || !res.writable) {
        return;
      }
      const remaining = audioLength - written;
      try {
        if (remaining > 0 && remaining <= MAX_PAD_BYTES) {
          res.end(Buffer.alloc(remaining));
        } else {
          res.end();
        }
      } catch {
        /* socket gone */
      }
    };

    const onData = (chunk: Buffer) => {
      if (finished) {
        return;
      }
      const remaining = audioLength - written;
      if (remaining <= 0) {
        subscriber.destroy?.();
        finish();
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      written += slice.length;
      const ok = res.write(slice);
      if (written >= audioLength) {
        subscriber.destroy?.();
        finish();
        return;
      }
      if (!ok) {
        subscriber.pause?.();
      }
    };

    res.on('drain', () => {
      if (!finished) {
        subscriber.resume?.();
      }
    });
    subscriber.on('data', onData);
    subscriber.on('end', finish);
    subscriber.on('close', finish);
  }

  private async resolveMetadata(audiopath: string): Promise<ContentItemMetadata | null> {
    try {
      return await this.content.resolveMetadata(audiopath);
    } catch (error) {
      this.log.debug('metadata resolve failed', {
        audiopath,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async resolveSource(audiopath: string): Promise<PlaybackSource | null> {
    // Direct sources (library://, http(s)://, alerts) resolve without a provider.
    const direct = resolveDirectSource(audiopath);
    if (direct) {
      return direct;
    }
    // Otherwise ask the content layer (Apple/Deezer/Tidal/YT/SoundCloud) as an
    // ephemeral (non-zone) requester: no zone to scope the cache or route errors.
    try {
      const resolution = await this.content.resolvePlaybackSource({
        audiopath,
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

  private writeStreamHeaders(res: ServerResponse, contentLength: number | null): void {
    const headers: Record<string, string | number> = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'transferMode.dlna.org': 'Streaming',
      // Must match the <res> protocolInfo exactly (incl. DLNA.ORG_PN=MP3), or a
      // strict sink rejects the resource and drops its now-playing metadata.
      'contentFeatures.dlna.org': AUDIO_DLNA_FEATURES,
    };
    if (contentLength && contentLength > 0) {
      // A concrete length makes the client treat this as a finite track (with a
      // seekbar/duration) rather than a live stream — the fix for "shows live, no
      // track info". We still don't serve real byte ranges, so Accept-Ranges: none.
      headers['Content-Length'] = contentLength;
      headers['Accept-Ranges'] = 'none';
    } else {
      headers['Accept-Ranges'] = 'none';
      headers['Transfer-Encoding'] = 'chunked';
    }
    res.writeHead(200, headers);
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('track-not-found');
  }

  private serverError(res: ServerResponse): void {
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
    }
    res.end('engine-unavailable');
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Drops a trailing audio extension from the requested object id. Our own URLs end in `.mp3`; a
 * renderer may ask for any extension the library knows, so the same list applies here.
 */
function stripAudioExtension(value: string): string {
  const dot = value.lastIndexOf('.');
  if (dot === -1) {
    return value;
  }
  const ext = value.slice(dot).toLowerCase();
  return Object.hasOwn(LIBRARY_AUDIO_MIME_TYPES, ext) ? value.slice(0, dot) : value;
}
