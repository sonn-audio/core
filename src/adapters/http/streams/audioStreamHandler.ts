import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSession } from '@/ports/types/playback';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { EnginePort } from '@/ports/EnginePort';
import type { OutputProfile } from '@/ports/EngineTypes';
import { zoneSessionKey } from '@/ports/types/SessionKey';
import { resolveSessionCover } from '@/shared/coverArt';
import { serveCover } from '@/adapters/http/streams/serveCover';
import {
  audioOutputSettings,
  buildWavHeader,
  mp3BitrateToBps,
  type HttpProfile,
  type AudioOutputSettings,
} from '@/ports/types/audioFormat';
import type { StreamEvents } from '@/adapters/http/streams/streamEvents';
import { resolveSessionPreDelayMs } from '@/application/playback/playbackPreDelay';

/**
 * Serves `/streams/:zone/:id` endpoints backed by the audio manager sessions.
 */
export class AudioStreamHandler {
  private readonly log = createLogger('Http', 'Streams');
  private readonly syncStreams = new Map<string, SyncStreamEntry>();
  private readonly syncClientPassThroughBytes = 2 * 1024 * 1024;
  private readonly syncClientMaxBacklogBytes = 8 * 1024 * 1024;
  // Buffer a short window of audio while waiting for sync clients to connect,
  // so the engine subscriber doesn't accumulate lag and get dropped.
  // Keep this small to avoid audible "rewind" when creating a sync-group mid-track.
  private readonly syncPreStartMaxBytes = 64 * 1024;
  // Keep a short post-start history so late joiners (common with squeezelite reconnects)
  // can be caught up to the exact same byte stream without requiring a "no data" barrier.
  private readonly syncPostStartHistoryMaxBytes = 2 * 1024 * 1024;
  private readonly syncPostStartJoinWindowMs = 1500;
  // Some squeezelite clients briefly close/reopen the HTTP connection around buffer_ready/unpause.
  // Keep the sync stream alive for a short grace period to avoid sending EOF and causing underruns.
  private readonly syncIdleCleanupMs = 4000;

  constructor(
    private readonly engine: EnginePort,
    private readonly streamEvents: StreamEvents,
    private readonly audioManager: AudioManager,
    private readonly zoneAudioPrefs: ZoneAudioPreferences,
  ) {}

  public matches(pathname: string): boolean {
    return pathname.startsWith('/streams/');
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const [, , zoneStr, rawStream, extra] = pathname.split('/');
    const streamToken = rawStream?.split(/[?#]/)[0] ?? '';
    const resourceToken = extra?.split(/[?#]/)[0] ?? '';
    const streamId = this.stripExtension(streamToken);
    const isWav = streamToken.endsWith('.wav');
    const isPcm = streamToken.endsWith('.pcm');
    const isAac = streamToken.endsWith('.aac');
    const isFlac = streamToken.endsWith('.flac');
    const zoneId = Number(zoneStr);
    const isCoverRequest = resourceToken === 'cover';
    if (!Number.isFinite(zoneId) || !streamId) {
      this.notFound(res);
      return;
    }

    const session = this.audioManager.getSession(zoneId);
    if (!session) {
      this.log.debug('no active session for stream request', { zoneId, streamId });
      this.notFound(res);
      return;
    }
    const requestedMatches =
      streamId === 'current'
        ? true
        : this.audioManager.isStreamIdActive(zoneId, streamId);
    if (!requestedMatches) {
      this.log.debug('stream id mismatch', {
        zoneId,
        requested: streamId,
        active: [session.stream.id, session.pcmStream?.id].filter(Boolean),
      });
      this.notFound(res);
      return;
    }

    if (isCoverRequest) {
      await this.handleCoverRequest(res, session);
      return;
    }

    // DLNA renderers (measured: B&O) probe with a HEAD before the real GET. Answer it
    // immediately with the streaming headers and no body — do NOT spin up the transcode
    // engine for a probe that's about to be discarded, and don't make the renderer wait on
    // engine startup just to see the content type. Blocking here delayed audible start.
    //
    // The HEAD headers must MATCH what the GET will send, or a strict renderer keys on the
    // probe and gets it wrong. Measured: B&O reads the HEAD's chunked/no-length response as
    // a LIVE stream and pins now-playing to "live" even though the GET carries a real
    // Content-Length. So for a forced_content_length zone, compute and advertise the same
    // Content-Length here.
    if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
      const headOutputSettings = this.zoneAudioPrefs.getEffectiveOutputSettings(zoneId);
      const headOutputProfile: OutputProfile = isWav || isPcm ? 'pcm' : isAac ? 'aac' : isFlac ? 'flac' : 'mp3';
      const headContentType = isWav
        ? 'audio/wav'
        : isPcm
          ? this.buildPcmContentType(headOutputSettings)
          : isAac
            ? 'audio/aac'
            : isFlac
              ? 'audio/flac'
              : 'audio/mpeg';
      const headHttpProfile =
        this.zoneAudioPrefs.getHttpPreferences(zoneId)?.httpProfile ?? audioOutputSettings.httpProfile;
      const headContentLength = this.shouldUseIcy(req, false)
        ? null
        : this.estimateContentLength(
          headOutputProfile,
          this.resolveDurationSeconds(session),
          headHttpProfile,
          headOutputSettings,
        );
      this.writeHeaders(res, headContentType, {
        contentLength: headContentLength,
        chunked: !headContentLength && this.shouldUseChunked(headHttpProfile),
      });
      res.end();
      return;
    }

    const outputSettings = this.zoneAudioPrefs.getEffectiveOutputSettings(zoneId);
    const httpPrefs = this.zoneAudioPrefs.getHttpPreferences(zoneId);
    const httpProfile = httpPrefs?.httpProfile ?? audioOutputSettings.httpProfile;
    const drainMsAfterEnd = httpPrefs?.drainMsAfterEnd ?? 0;
    const icyEnabledOverride = httpPrefs?.icyEnabled ?? audioOutputSettings.httpIcyEnabled;
    const icyIntervalOverride = httpPrefs?.icyInterval ?? audioOutputSettings.httpIcyInterval;
    const icyNameOverride = httpPrefs?.icyName ?? audioOutputSettings.httpIcyName;

    const outputProfile = isWav || isPcm ? 'pcm' : isAac ? 'aac' : isFlac ? 'flac' : 'mp3';
    const syncParams = this.parseSyncParams(req.url ?? '');
    if (syncParams && (outputProfile === 'mp3' || outputProfile === 'flac' || outputProfile === 'pcm')) {
      await this.handleSyncStream(req, res, session, zoneId, outputProfile, outputSettings, httpProfile, {
        icyEnabledOverride,
        icyIntervalOverride,
        icyNameOverride,
      }, syncParams);
      return;
    }
    const clientLabel = this.buildClientLabel(req, outputProfile);
    const primeWithBuffer = this.shouldPrimeWithBuffer(req);
    let audioStream = this.engine.createStream(zoneSessionKey(zoneId), outputProfile, {
      label: clientLabel,
      primeWithBuffer,
    });
    if (!audioStream && session.playbackSource) {
      // Start the engine with the requested profile (plus PCM for local consumers).
      const profiles = Array.from(new Set<OutputProfile>([outputProfile, 'pcm']));
      this.engine.start(zoneSessionKey(zoneId), session.playbackSource, profiles);
      audioStream = this.engine.createStream(zoneSessionKey(zoneId), outputProfile, {
        label: clientLabel,
        primeWithBuffer,
      });
    }
    if (!audioStream) {
      this.log.warn('audio engine stream unavailable', { zoneId });
      this.engineUnavailable(res);
      return;
    }

    const contentType = isWav
      ? 'audio/wav'
      : isPcm
        ? this.buildPcmContentType(outputSettings)
        : isAac
          ? 'audio/aac'
          : isFlac
            ? 'audio/flac'
            : 'audio/mpeg';
    // Log every accepted pull. For a push output (DLNA/Cast/Sonos) this line is the only proof in
    // the log that the device did more than accept the transport command — its absence after a
    // "playback started" is the signature of a renderer that was armed but never fetched a byte.
    this.log.info('stream request', {
      zoneId,
      requested: streamId,
      streamId: session.stream.id,
      profile: outputProfile,
      remote: req.socket?.remoteAddress ?? 'unknown',
    });
    this.streamEvents.recordStreamRequest({
      zoneId,
      streamId,
      url: req.url ?? '',
      remoteAddress: req.socket?.remoteAddress ?? null,
    });
    const durationSeconds = this.resolveDurationSeconds(session);
    const icyEnabled = this.shouldUseIcy(req, icyEnabledOverride);
    const contentLength = icyEnabled
      ? null
      : this.estimateContentLength(
          outputProfile,
          durationSeconds,
          httpProfile,
          outputSettings,
        );
    const useChunked = this.shouldUseChunked(httpProfile);

    this.writeHeaders(res, contentType, {
      contentLength,
      chunked: useChunked,
      icy: icyEnabled,
      icyInterval: icyIntervalOverride,
      icyName: icyNameOverride,
    });

    // PCM profile is raw PCM at configured format; for .wav requests we prepend a lightweight WAV header.
    if (isWav) {
      const header = buildWavHeader({
        sampleRate: outputSettings.sampleRate,
        channels: outputSettings.channels,
        bitDepth: outputSettings.pcmBitDepth,
      });
      res.write(header);
    }
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    if (icyEnabled) {
      this.pipeWithIcyMetadata(req, res, audioStream, session, icyIntervalOverride, icyNameOverride);
    } else if (!isWav && contentLength && contentLength > 0) {
      // Deliver exactly Content-Length bytes. A live transcode's real byte count rarely
      // matches the (bitrate × duration) estimate, so ending short of the advertised length
      // makes Node abort the socket (RST) and the client (notably Google Cast) drops the
      // audio it had buffered ahead — clipping the tail of every track.
      this.pipeWithContentLength(res, audioStream, contentLength);
    } else if (drainMsAfterEnd > 0) {
      // Keep the response open for a drain window after the source ends so a buffering
      // renderer (Cast) can play out its read-ahead before the connection closes.
      audioStream.pipe(res, { end: false });
      const scheduleDrainEnd = () => {
        if (drainTimer || res.writableEnded) return;
        drainTimer = setTimeout(() => {
          drainTimer = undefined;
          if (!res.writableEnded) {
            try {
              res.end();
            } catch {
              /* ignore */
            }
          }
        }, drainMsAfterEnd);
        drainTimer.unref?.();
      };
      audioStream.on('end', scheduleDrainEnd);
      audioStream.on('close', scheduleDrainEnd);
    } else {
      audioStream.pipe(res);
    }

    let unregisterHandle: (() => void) | undefined;
    const dispose = () => {
      if (drainTimer) {
        clearTimeout(drainTimer);
        drainTimer = undefined;
      }
      audioStream.destroy();
      // End the HTTP response so squeezelite/etc see a clean EOF on this stream id.
      // Important for URL rotation: closeSubscribersForStreamId() relies on this to
      // make the OLD URL terminate after the NEW URL has had time to pre-buffer.
      try {
        if (!res.writableEnded) res.end();
      } catch { /* ignore */ }
      unregisterHandle?.();
      unregisterHandle = undefined;
    };
    unregisterHandle = this.audioManager.registerSubscriberHandle(zoneId, streamId, dispose);

    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
    audioStream.on('error', (error) => {
      this.log.warn('stream pipe error', {
        zoneId,
        streamId,
        message: error instanceof Error ? error.message : String(error),
      });
      dispose();
    });
  }

  private async handleCoverRequest(res: ServerResponse, session: PlaybackSession): Promise<void> {
    // A session cover is only valid while that session lives, so it is not cached.
    await serveCover(res, session.cover ?? resolveSessionCover(session) ?? null, this.log);
  }

  private writeHeaders(
    res: ServerResponse,
    contentType = 'audio/mpeg',
    options: {
      contentLength?: number | null;
      chunked?: boolean;
      icy?: boolean;
      icyInterval?: number;
      icyName?: string;
    } = {},
  ): void {
    // DLNA.ORG_PN names the media profile. Advertising the MP3 profile makes the
    // stream a recognised, conformant DLNA resource rather than an unnamed one —
    // the correct value to send for an MP3 body. (Note: it does NOT make a B&O
    // renderer show a timeline; B&O only shows a seekbar for items in its own
    // native play queue and treats any UPnP push as a live DLNA_DMR stream. That
    // is a renderer-side limitation, not something the stream headers can change.)
    // Only add it for audio/mpeg; other content types keep their working headers.
    const dlnaPn = contentType === 'audio/mpeg' ? 'DLNA.ORG_PN=MP3;' : '';
    const headers: Record<string, string | number> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Accept-Ranges': 'none',
      Connection: 'close',
      'transferMode.dlna.org': 'Streaming',
      // Live, non-seekable transcode: advertise no seek ops (OP=00) so renderers don't probe
      // for range support we don't offer (Accept-Ranges: none). Previously we sent OP=01
      // (range-seek supported) alongside Accept-Ranges: none — a contradiction that made
      // strict renderers (B&O) stall on a HEAD/range probe before committing to the GET.
      // FLAGS 8D500000 = sender-paced + streaming-transfer + no-full-clear + background-ok.
      'contentFeatures.dlna.org':
        `${dlnaPn}DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000`,
    };
    if (options.chunked) {
      headers['Transfer-Encoding'] = 'chunked';
    } else if (options.contentLength && options.contentLength > 0) {
      headers['Content-Length'] = options.contentLength;
    }
    if (options.icy) {
      headers['icy-metaint'] = options.icyInterval ?? audioOutputSettings.httpIcyInterval;
      headers['icy-name'] = options.icyName ?? audioOutputSettings.httpIcyName;
    }
    res.writeHead(200, headers);
  }

  private notFound(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'stream-not-found' }));
  }

  private engineUnavailable(res: ServerResponse): void {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'audio-engine-unavailable',
        message: 'No active audio stream. Ensure ffmpeg is installed and playback is running.',
      }),
    );
  }

  private stripExtension(value: string): string {
    if (!value) {
      return '';
    }
    const dotIndex = value.indexOf('.');
    return dotIndex > 0 ? value.slice(0, dotIndex) : value;
  }

  /**
   * How long the stream we serve lasts, which is not how long the track lasts: the engine
   * prepends the amp's wake-up silence to the body, and a Content-Length sized from the track
   * alone ends the response that much before the music does. On a DLNA renderer that was the
   * last second of every announcement on a cold zone, closed off by us mid-word (#387).
   *
   * The longer of the two durations wins. The engine's is whole seconds and can round a clip
   * down; an alert's metadata carries its stop margin. Too long costs only zero padding at the
   * tail (see `pipeWithContentLength`); too short costs audio.
   */
  private resolveDurationSeconds(session: PlaybackSession): number | null {
    const trackSeconds = Math.max(
      session?.duration && session.duration > 0 ? session.duration : 0,
      session?.metadata?.duration && session.metadata.duration > 0 ? session.metadata.duration : 0,
    );
    if (trackSeconds <= 0) {
      return null;
    }
    return trackSeconds + resolveSessionPreDelayMs(session) / 1000;
  }

  private shouldUseChunked(profile: HttpProfile): boolean {
    return profile === 'chunked';
  }

  private buildClientLabel(req: IncomingMessage, profile: OutputProfile): string {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const agent = (req.headers['user-agent'] ?? '').toString();
    const shortAgent = agent ? agent.split(/\s+/).slice(0, 2).join('/') : '';
    return `http:${ip}:${profile}${shortAgent ? `:${shortAgent}` : ''}`;
  }

  private shouldUseIcy(req: IncomingMessage, icyEnabled: boolean): boolean {
    if (!icyEnabled) {
      return false;
    }
    // Some clients (e.g. Squeezelite) don't reliably send `Icy-MetaData: 1`.
    // We allow forcing ICY via `?icy=1` on the stream URL.
    const rawUrl = req.url ?? '';
    if (rawUrl) {
      try {
        const url = new URL(rawUrl, 'http://localhost');
        const param = (url.searchParams.get('icy') ?? '').trim().toLowerCase();
        if (param === '1' || param === 'true') {
          return true;
        }
      } catch {
        // ignore
      }
    }
    const header = req.headers['icy-metadata'] ?? req.headers['icy-metadata'.toLowerCase()];
    return String(header ?? '').trim() === '1';
  }

  private shouldPrimeWithBuffer(req: IncomingMessage): boolean {
    const rawUrl = req.url ?? '';
    if (!rawUrl) {
      return true;
    }
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const value = url.searchParams.get('prime');
      if (value === '0' || value === 'false') {
        return false;
      }
    } catch {
      return true;
    }
    return true;
  }

  private pipeWithIcyMetadata(
    req: IncomingMessage,
    res: ServerResponse,
    audioStream: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
    session: PlaybackSession,
    intervalOverride?: number,
    _nameOverride?: string,
  ): void {
    const interval = Math.max(
      1024,
      intervalOverride ?? audioOutputSettings.httpIcyInterval ?? 0,
    );
    let bytesUntilMeta = interval;

    const writeMetadata = () => {
      const meta = this.buildIcyBlock(session);
      if (meta) {
        res.write(meta);
      }
    };

    const onData = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        const remaining = bytesUntilMeta;
        const toWrite = Math.min(remaining, chunk.length - offset);
        res.write(chunk.subarray(offset, offset + toWrite));
        offset += toWrite;
        bytesUntilMeta -= toWrite;
        if (bytesUntilMeta <= 0) {
          writeMetadata();
          bytesUntilMeta = interval;
        }
      }
    };

    const dispose = () => {
      audioStream.off('data', onData);
      if (typeof audioStream.destroy === 'function') {
        audioStream.destroy();
      }
      if (!res.writableEnded) {
        res.end();
      }
    };

    audioStream.on('data', onData);
    audioStream.on('end', () => res.end());
    audioStream.on('close', () => res.end());
    audioStream.on('error', () => dispose());
    req.on('close', dispose);
    req.on('aborted', dispose);
    res.on('close', dispose);
  }

  /**
   * Pipe a live transcoded stream to a response that advertised a fixed Content-Length,
   * guaranteeing the body is exactly that many bytes.
   *
   * The encoder's real output rarely equals the (bitrate × duration) estimate and the source
   * asset can be a touch shorter than the catalog duration. If the body ends short of the
   * advertised length Node aborts the socket (RST); Google Cast then discards whatever it had
   * buffered ahead of the playback head, clipping the last several seconds of every track.
   * So we never write past Content-Length (truncating a rare overshoot) and pad a short tail
   * with zero bytes — trailing zeros after the last MP3 frame are ignored by decoders and only
   * serve to make the response complete and drainable. Backpressure is honoured so the engine's
   * output pacing keeps working.
   */
  private pipeWithContentLength(
    res: ServerResponse,
    audioStream: NodeJS.ReadableStream & { destroy?: (error?: Error) => void },
    contentLength: number,
  ): void {
    let written = 0;
    let finished = false;
    // Cap tail padding (~30s @ 256 kbit) so a wildly wrong estimate can't blast huge buffers.
    const MAX_PAD_BYTES = 1024 * 1024;

    const finish = () => {
      if (finished) return;
      finished = true;
      audioStream.off('data', onData);
      if (res.writableEnded || res.destroyed || !res.writable) return;
      const remaining = contentLength - written;
      try {
        if (remaining > 0 && remaining <= MAX_PAD_BYTES) {
          res.end(Buffer.alloc(remaining));
        } else {
          res.end();
        }
      } catch {
        /* socket may have gone away */
      }
    };

    const onData = (chunk: Buffer) => {
      if (finished) return;
      const remaining = contentLength - written;
      if (remaining <= 0) {
        audioStream.destroy?.();
        finish();
        return;
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      written += slice.length;
      const ok = res.write(slice);
      if (written >= contentLength) {
        audioStream.destroy?.();
        finish();
        return;
      }
      if (!ok) audioStream.pause();
    };

    res.on('drain', () => {
      if (!finished) audioStream.resume();
    });
    audioStream.on('data', onData);
    audioStream.on('end', finish);
    audioStream.on('close', finish);
  }

  private buildIcyBlock(session: PlaybackSession): Buffer | null {
    const title = session.metadata?.title;
    const artist = session.metadata?.artist;
    const text = title && artist ? `${artist} - ${title}` : title || session.source || 'Audio';
    const safe = (text ?? '').replace(/\s+/g, ' ').trim();
    // Readers end the value at `';`, so an apostrophe inside the title travels fine and
    // only that exact pair has to go — dropping every quote turned "Don't Go" into
    // "Dont Go" on the renderer (issue #348).
    const payload = `StreamTitle='${safe.replace(/';/g, "'")}';`;
    const raw = Buffer.from(payload, 'utf8');
    const maxLen = 255 * 16;
    const trimmed = raw.length > maxLen ? raw.subarray(0, maxLen) : raw;
    const paddedLength = Math.ceil(trimmed.length / 16) * 16;
    const padded = Buffer.alloc(1 + paddedLength, 0);
    padded.writeUInt8(paddedLength / 16, 0);
    trimmed.copy(padded, 1);
    return padded;
  }

  private estimateContentLength(
    profile: 'pcm' | 'mp3' | 'aac' | 'flac',
    durationSeconds: number | null,
    httpProfile: HttpProfile,
    output: AudioOutputSettings,
  ): number | null {
    if (httpProfile !== 'forced_content_length') {
      return null;
    }
    const duration = durationSeconds ?? output.httpFallbackSeconds;
    if (!Number.isFinite(duration) || duration <= 0) {
      return null;
    }
    if (profile === 'pcm') {
      const bytesPerSecond =
        output.sampleRate *
        output.channels *
        (output.pcmBitDepth / 8);
      return Math.round(bytesPerSecond * duration);
    }
    if (profile !== 'mp3') {
      // We don't attempt to estimate content-length for FLAC/AAC in forced mode.
      return null;
    }
    const bps = mp3BitrateToBps(output.mp3Bitrate);
    if (bps <= 0) {
      return null;
    }
    return Math.round((bps / 8) * duration);
  }

  private parseSyncParams(rawUrl: string): { syncId: string; expected: number } | null {
    if (!rawUrl) return null;
    try {
      const url = new URL(rawUrl, 'http://localhost');
      const syncId = url.searchParams.get('sync');
      const expected = Number(url.searchParams.get('expect') ?? '');
      if (!syncId || !Number.isFinite(expected) || expected < 2) {
        return null;
      }
      return { syncId, expected: Math.floor(expected) };
    } catch {
      return null;
    }
  }

  private async handleSyncStream(
    req: IncomingMessage,
    res: ServerResponse,
    session: PlaybackSession,
    zoneId: number,
    outputProfile: 'mp3' | 'flac' | 'pcm',
    outputSettings: AudioOutputSettings,
    httpProfile: HttpProfile,
    icyOverrides: { icyEnabledOverride: boolean; icyIntervalOverride?: number; icyNameOverride?: string },
    sync: { syncId: string; expected: number },
  ): Promise<void> {
    const contentType =
      outputProfile === 'flac'
        ? 'audio/flac'
        : outputProfile === 'pcm'
          ? this.buildPcmContentType(outputSettings)
          : 'audio/mpeg';
    const durationSeconds = this.resolveDurationSeconds(session);
    const icyEnabled = this.shouldUseIcy(req, icyOverrides.icyEnabledOverride);
    const contentLength = icyEnabled
      ? null
      : this.estimateContentLength(
          outputProfile,
          durationSeconds,
          httpProfile,
          outputSettings,
        );
    const useChunked = this.shouldUseChunked(httpProfile);

    let entry: SyncStreamEntry;
    try {
      entry = this.getOrCreateSyncEntry(
        sync.syncId,
        zoneId,
        outputProfile,
        outputSettings,
        session,
        sync.expected,
      );
    } catch {
      this.engineUnavailable(res);
      return;
    }
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Use a larger buffer per client so brief network hiccups don't backpressure the whole sync group.
    const passThrough = new PassThrough({ highWaterMark: this.syncClientPassThroughBytes });

    entry.clients.set(clientId, {
      req,
      res,
      passThrough,
      icyEnabled,
      icyInterval: icyOverrides.icyIntervalOverride,
      icyName: icyOverrides.icyNameOverride,
      attached: false,
    });
    if (entry.idleCleanupId) {
      clearTimeout(entry.idleCleanupId);
      entry.idleCleanupId = undefined;
    }

    this.writeHeaders(res, contentType, {
      contentLength,
      chunked: useChunked,
      icy: icyEnabled,
      icyInterval: icyOverrides.icyIntervalOverride,
      icyName: icyOverrides.icyNameOverride,
    });

    const cleanup = () => this.removeSyncClient(sync.syncId, clientId);
    req.on('close', cleanup);
    req.on('aborted', cleanup);
    res.on('close', cleanup);

    // If the sync entry already started (e.g., timeout fallback), late joiners must be attached
    // immediately or they'll never receive audio.
    const client = entry.clients.get(clientId);
    if (client && entry.started) {
      this.attachSyncClient(entry, client);
      this.replaySyncHistory(entry, client);
      return;
    }

    // Start immediately on first client. Some squeezelite builds will close the HTTP connection
    // if no bytes are delivered quickly. We keep a short history so late joiners can catch up.
    this.maybeStartSyncEntry(entry);
  }

  private buildPcmContentType(output: AudioOutputSettings): string {
    // node-slimproto expects these params in order to generate the correct PCM codc details.
    // Keep them stable: `rate`, `channels`, and `bitrate` (bit-depth).
    const rate = Number.isFinite(output.sampleRate) ? Math.round(output.sampleRate) : 44100;
    const channels = Number.isFinite(output.channels) ? Math.round(output.channels) : 2;
    const bitDepth = Number.isFinite(output.pcmBitDepth) ? Math.round(output.pcmBitDepth) : 16;
    return `audio/pcm;rate=${rate};channels=${channels};bitrate=${bitDepth}`;
  }

  private maybeStartSyncEntry(entry: SyncStreamEntry): void {
    if (entry.started) return;
    // Start as soon as we see the first client. Late joiners will be caught up via history.
    if (entry.clients.size > 0) {
      this.startSyncEntry(entry);
    }
  }

  private getOrCreateSyncEntry(
    syncId: string,
    zoneId: number,
    outputProfile: 'pcm' | 'mp3' | 'flac',
    outputSettings: AudioOutputSettings,
    session: PlaybackSession,
    expectedCount: number,
  ): SyncStreamEntry {
    const existing = this.syncStreams.get(syncId);
    if (existing) {
      existing.expectedCount = Math.max(existing.expectedCount, expectedCount);
      return existing;
    }

    const clientLabel = `sync:${syncId}`;
    let audioStream = this.engine.createStream(zoneSessionKey(zoneId), outputProfile, {
      label: clientLabel,
      // Avoid priming a backlog for sync groups; it can overwhelm some clients and cause early underruns.
      primeWithBuffer: false,
    });
    if (!audioStream && session.playbackSource) {
      this.engine.start(zoneSessionKey(zoneId), session.playbackSource, Array.from(new Set<OutputProfile>([outputProfile, 'pcm'])));
      audioStream = this.engine.createStream(zoneSessionKey(zoneId), outputProfile, {
        label: clientLabel,
        primeWithBuffer: false,
      });
    }
    if (!audioStream) {
      throw new Error('sync stream unavailable');
    }

    const entry: SyncStreamEntry = {
      id: syncId,
      zoneId,
      outputProfile,
      outputSettings,
      session,
      expectedCount,
      clients: new Map(),
      stream: audioStream,
      started: false,
      // Align with Music Assistant: don't wait forever for all expected clients.
      timeoutId: setTimeout(() => this.startSyncEntry(entry), 2500),
      preStartBuffer: [],
      preStartBytes: 0,
      postStartHistory: [],
      postStartHistoryBytes: 0,
      postStartHistoryUntil: 0,
    };
    entry.timeoutId.unref?.();

    // Start consuming immediately to avoid the engine subscriber being dropped for lag.
    // We buffer a small window so we can "release" the same bytes to all clients at start.
    const onData = (chunk: Buffer | Uint8Array) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!entry.started) {
        entry.preStartBuffer.push(buf);
        entry.preStartBytes += buf.length;
        while (entry.preStartBytes > this.syncPreStartMaxBytes && entry.preStartBuffer.length > 1) {
          const removed = entry.preStartBuffer.shift();
          if (removed) entry.preStartBytes -= removed.length;
        }
        return;
      }
      if (entry.postStartHistoryUntil && Date.now() < entry.postStartHistoryUntil) {
        entry.postStartHistory.push(buf);
        entry.postStartHistoryBytes += buf.length;
        while (
          entry.postStartHistoryBytes > this.syncPostStartHistoryMaxBytes &&
          entry.postStartHistory.length > 1
        ) {
          const removed = entry.postStartHistory.shift();
          if (removed) entry.postStartHistoryBytes -= removed.length;
        }
      }
      for (const [clientId, client] of entry.clients) {
        if (client.passThrough.destroyed) {
          this.removeSyncClient(entry.id, clientId);
          continue;
        }
        client.passThrough.write(buf);
        const backlog = client.passThrough.writableLength;
        if (typeof backlog === 'number' && backlog > this.syncClientMaxBacklogBytes) {
          this.removeSyncClient(entry.id, clientId);
        }
      }
    };
    entry.onData = onData;
    entry.stream.on?.('data', onData);
    audioStream.on('error', (error) => {
      this.log.warn('sync stream error', {
        syncId,
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.cleanupSyncEntry(entry);
    });
    audioStream.on('end', () => this.cleanupSyncEntry(entry));
    audioStream.on('close', () => this.cleanupSyncEntry(entry));

    this.syncStreams.set(syncId, entry);
    return entry;
  }

  private startSyncEntry(entry: SyncStreamEntry): void {
    if (entry.started) return;
    entry.started = true;
    clearTimeout(entry.timeoutId);
    entry.postStartHistoryUntil = Date.now() + this.syncPostStartJoinWindowMs;

    for (const client of entry.clients.values()) {
      this.attachSyncClient(entry, client);
    }

    // Release buffered data so all clients start from the same byte.
    if (entry.preStartBuffer.length) {
      for (const buf of entry.preStartBuffer) {
        for (const [clientId, client] of entry.clients) {
          if (client.passThrough.destroyed) {
            this.removeSyncClient(entry.id, clientId);
            continue;
          }
          client.passThrough.write(buf);
          const backlog = client.passThrough.writableLength;
          if (typeof backlog === 'number' && backlog > this.syncClientMaxBacklogBytes) {
            this.removeSyncClient(entry.id, clientId);
          }
        }
      }
      entry.preStartBuffer = [];
      entry.preStartBytes = 0;
    }
  }

  private replaySyncHistory(entry: SyncStreamEntry, client: SyncClient): void {
    if (!entry.postStartHistoryUntil || Date.now() > entry.postStartHistoryUntil) {
      return;
    }
    if (!entry.postStartHistory.length) {
      return;
    }
    if (client.passThrough.destroyed) {
      return;
    }
    // Best-effort: write what we have so the client can catch up to the same byte stream.
    for (const buf of entry.postStartHistory) {
      client.passThrough.write(buf);
      const backlog = client.passThrough.writableLength;
      if (typeof backlog === 'number' && backlog > this.syncClientMaxBacklogBytes) {
        // Too slow to catch up; drop.
        client.passThrough.end();
        client.passThrough.destroy();
        if (!client.res.writableEnded) {
          client.res.end();
        }
        return;
      }
    }
  }

  private attachSyncClient(entry: SyncStreamEntry, client: SyncClient): void {
    if (client.attached) {
      return;
    }
    client.attached = true;
    if (client.icyEnabled) {
      this.pipeWithIcyMetadata(
        client.req,
        client.res,
        client.passThrough,
        entry.session,
        client.icyInterval,
        client.icyName,
      );
    } else {
      client.passThrough.pipe(client.res);
    }
  }

  private removeSyncClient(syncId: string, clientId: string): void {
    const entry = this.syncStreams.get(syncId);
    if (!entry) return;
    const existing = entry.clients.get(clientId);
    entry.clients.delete(clientId);
    if (existing) {
      existing.passThrough.end();
      existing.passThrough.destroy();
      if (!existing.res.writableEnded) {
        existing.res.end();
      }
    }
    if (entry.clients.size === 0) {
      // Don't immediately tear down the engine subscriber; allow quick reconnects.
      if (!entry.idleCleanupId) {
        entry.idleCleanupId = setTimeout(() => {
          entry.idleCleanupId = undefined;
          // If nobody reconnected, stop the stream.
          if (this.syncStreams.get(entry.id) === entry && entry.clients.size === 0) {
            this.cleanupSyncEntry(entry);
          }
        }, this.syncIdleCleanupMs);
        entry.idleCleanupId.unref?.();
      }
    }
  }

  private cleanupSyncEntry(entry: SyncStreamEntry): void {
    clearTimeout(entry.timeoutId);
    if (entry.idleCleanupId) {
      clearTimeout(entry.idleCleanupId);
      entry.idleCleanupId = undefined;
    }
    if (this.syncStreams.get(entry.id) === entry) {
      this.syncStreams.delete(entry.id);
    }
    if (entry.onData) {
      (entry.stream as NodeJS.EventEmitter).off?.('data', entry.onData);
      entry.onData = undefined;
    }
    entry.preStartBuffer = [];
    entry.preStartBytes = 0;
    entry.postStartHistory = [];
    entry.postStartHistoryBytes = 0;
    entry.postStartHistoryUntil = 0;
    entry.clients.forEach((client) => {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    });
    entry.clients.clear();
    const destroyable = entry.stream as { destroy?: () => void };
    if (typeof destroyable.destroy === 'function') {
      destroyable.destroy();
    }
  }
}

type SyncClient = {
  req: IncomingMessage;
  res: ServerResponse;
  passThrough: PassThrough;
  icyEnabled: boolean;
  icyInterval?: number;
  icyName?: string;
  attached: boolean;
};

type SyncStreamEntry = {
  id: string;
  zoneId: number;
  outputProfile: 'pcm' | 'mp3' | 'flac';
  outputSettings: AudioOutputSettings;
  session: PlaybackSession;
  expectedCount: number;
  clients: Map<string, SyncClient>;
  stream: NodeJS.ReadableStream;
  started: boolean;
  timeoutId: NodeJS.Timeout;
  onData?: (chunk: Buffer | Uint8Array) => void;
  idleCleanupId?: NodeJS.Timeout;
  preStartBuffer: Buffer[];
  preStartBytes: number;
  postStartHistory: Buffer[];
  postStartHistoryBytes: number;
  postStartHistoryUntil: number;
};
