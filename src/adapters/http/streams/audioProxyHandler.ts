import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';
import { isLocalRequest } from '@/shared/utils/net';
import { bestEffort } from '@/shared/bestEffort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import {
  decodeHeaders,
  encodeHeaders,
  resolveProxyHost,
  resolveProxyPort,
} from '@/shared/urlProxy';

const MAX_PLAYLIST_BYTES = 1024 * 1024;
/** A pointer playlist may name another one; stop before a cycle turns into a crawl. */
const MAX_PLAYLIST_HOPS = 3;
/** A `.pls` lists mirrors, so a dead first entry is not a dead station — try a few. */
const MAX_PLAYLIST_ENTRIES = 3;
/** Window size for hosts that refuse open-ended ranges; big enough to keep ahead of playback. */
const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
/** Upstream reads that may fail in a row, without a byte of progress, before we give up. */
const MAX_UPSTREAM_FAILURES = 3;
/** Pause before each retry after the first; the first resume goes out at once. */
const RESUME_BACKOFF_MS = 250;
/** Silence from upstream this long, while the client is keeping up, is a dead connection. */
const UPSTREAM_STALL_MS = 20_000;

type PipeOutcome =
  | { kind: 'end'; written: number }
  | { kind: 'client-gone'; written: number }
  | { kind: 'upstream-error'; written: number; error: unknown };

/** Message and socket code of a failed read; undici hides the code under `cause`. */
function describeReadError(error: unknown): { message: string; causeCode?: string } {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === 'string' ? { message, causeCode: cause.code } : { message };
}

/**
 * True only for a playlist ffmpeg can open itself.
 *
 * Its hls demuxer probes for `#EXTM3U` *and* one of the tags that make the file a
 * manifest rather than a pointer — that pair is the whole test, mirrored here.
 */
function isHlsManifest(body: string): boolean {
  if (!/^\s*#EXTM3U/.test(body)) {
    return false;
  }
  return /#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)[:\s]/i.test(body);
}

/**
 * The urls a pointer playlist names, in mirror order.
 *
 * The two flavours have to be told apart first: in a pls every other line (`[playlist]`,
 * `NumberOfEntries=2`) is bookkeeping that resolves into a perfectly valid relative url
 * and would be tried as a mirror, while in an m3u a bare line *is* the entry.
 */
function playlistEntries(body: string, baseUrl: string): string[] {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isPls = lines.some((line) => /^\[playlist\]$/i.test(line) || /^File\d+\s*=/i.test(line));
  const candidates = isPls
    ? lines
        .map((line) => /^File(\d+)\s*=\s*(.+)$/i.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((match) => (match[2] ?? '').trim())
    : lines.filter((line) => !line.startsWith('#'));

  const entries: string[] = [];
  for (const candidate of candidates) {
    // Anything with markup or whitespace in it is not an entry: a host that answers a
    // dead url with an html page under an `audio/x-mpegurl` header gets read as a
    // playlist, and `<!doctype html>` resolves against the base into a perfectly
    // fetchable url. Chasing those is how one junk page becomes several requests.
    if (!candidate || /[<>"\s]/.test(candidate)) {
      continue;
    }
    try {
      const absolute = new URL(candidate, baseUrl);
      if (absolute.protocol === 'http:' || absolute.protocol === 'https:') {
        entries.push(absolute.toString());
      }
    } catch {
      // Not a url — a stray line or a local file path we cannot reach anyway.
    }
  }
  return entries;
}

/** True for `bytes=N-` and for no Range at all — the shapes googlevideo answers with 403. */
function isUnboundedRange(range: string | undefined): boolean {
  if (!range) {
    return true;
  }
  return /^bytes=\d*-$/i.test(range.trim());
}

function parseRangeStart(range: string | undefined): number {
  const match = /^bytes=(\d+)-/i.exec((range ?? '').trim());
  const start = match ? Number(match[1]) : 0;
  return Number.isFinite(start) && start >= 0 ? start : 0;
}

function parseContentRange(value: string | null): { end: number; total: number | null } | null {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec((value ?? '').trim());
  if (!match) {
    return null;
  }
  const end = Number(match[2]);
  const totalRaw = match[3];
  const total = totalRaw === '*' ? null : Number(totalRaw);
  if (!Number.isFinite(end)) {
    return null;
  }
  return { end, total: total !== null && Number.isFinite(total) ? total : null };
}

interface UpstreamFetchOptions {
  upstreamHeaders: Record<string, string>;
  wantsRest: boolean;
  restStart: number;
}

export class AudioProxyHandler {
  private readonly log = createLogger('Http', 'AudioProxy');

  constructor(private readonly zoneManager: ZoneManagerFacade) {}

  public matches(pathname: string): boolean {
    return pathname === '/streams/proxy';
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method-not-allowed' }));
      return;
    }
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const requested = url.searchParams.get('u') ?? '';
    if (!requested) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing-target' }));
      return;
    }

    const extraHeaders = decodeHeaders(url.searchParams.get('h'));
    const upstreamHeaders = this.buildUpstreamHeaders(req, extraHeaders);

    // ffmpeg opens a stream with `Range: bytes=0-` — everything from here on. Some
    // hosts (googlevideo) answer that, and a Range-less request, with a flat 403 while
    // serving a bounded window of the very same url happily. So when the client wants
    // the whole rest, ask upstream for a window instead and stitch the windows back
    // into one response below. Asking unbounded first is not an option: the refusal
    // also counts against that video's request budget, which throttles quickly.
    const wantsRest = isUnboundedRange(upstreamHeaders.Range);
    const restStart = wantsRest ? parseRangeStart(upstreamHeaders.Range) : 0;
    const fetchOpts = { upstreamHeaders, wantsRest, restStart };

    let upstream: Response;
    try {
      upstream = await this.fetchUpstream(requested, fetchOpts);
    } catch (error) {
      this.log.warn('proxy fetch failed', {
        target: requested,
        message: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy-fetch-failed' }));
      return;
    }

    // A `.m3u`/`.pls` that only points at the real stream is not something ffmpeg can
    // open — its one m3u demuxer is the HLS one, and that needs a manifest, not a list
    // of urls (issue #368). Handing such a pointer straight on, right for HLS where
    // ffmpeg takes over from here, leaves it with a text file where it wanted audio. So
    // follow the pointer ourselves and stream what it names.
    const resolved = await this.followPointerPlaylists(res, upstream, requested, {
      ...fetchOpts,
      extraHeaders,
    });
    if (!resolved) {
      return;
    }
    upstream = resolved.response;
    const target = resolved.target;

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const contentRange = upstream.headers.get('content-range');
    const icyMetaInt = upstream.headers.get('icy-metaint');
    const zoneId = this.resolveZoneId(req);

    // The window came back: hand the client one continuous body built from this window
    // and the ones after it. Only when the host actually honoured the range (a 206 with
    // a total) — a 200 means it ignored the range and is already streaming the lot.
    // Never an icy stream: stitched windows would splice metadata blocks into the audio
    // and `streamInBoundedChunks` forwards no `icy-metaint` for a client to skip them by.
    if (wantsRest && upstream.ok && upstream.body && upstream.status === 206 && !icyMetaInt) {
      const parsed = parseContentRange(upstream.headers.get('content-range'));
      if (parsed?.total != null) {
        await this.streamInBoundedChunks(res, target, upstreamHeaders, restStart, upstream, parsed, {
          // Windowing upstream is our business, not the client's. One that never asked
          // for a range must still be answered 200 with the whole body — a renderer
          // handed an unrequested 206 is entitled to refuse it.
          clientAskedForRange: typeof req.headers.range === 'string',
        });
        return;
      }
    }

    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.status || 502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify({ error: 'upstream-error', status: upstream.status }));
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    };
    if (contentLength) headers['Content-Length'] = contentLength;
    if (acceptRanges) headers['Accept-Ranges'] = acceptRanges;
    // A 206 without its Content-Range is a broken partial response: the client
    // reads Content-Length bytes and treats them as the whole resource, ending
    // the stream early (ffmpeg's probe range-request then plays only the first
    // chunk of long tracks). Forward the upstream Content-Range so a partial
    // stays a partial.
    if (contentRange) headers['Content-Range'] = contentRange;
    if (icyMetaInt) headers['icy-metaint'] = icyMetaInt;

    res.writeHead(upstream.status || 200, headers);
    const stream = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
    if (zoneId && icyMetaInt) {
      const metaInt = Number(icyMetaInt);
      if (Number.isFinite(metaInt) && metaInt > 0) {
        this.attachIcyMetadataListener(stream, metaInt, zoneId);
      }
    }
    stream.on('error', (error) => {
      this.log.warn('proxy stream failed', {
        target,
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy-stream-failed' }));
      } else {
        res.destroy(error as Error);
      }
    });
    stream.pipe(res);
  }

  private buildUpstreamHeaders(
    req: IncomingMessage,
    extras?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (extras) {
      Object.assign(headers, extras);
    }
    if (!headers['User-Agent'] && typeof req.headers['user-agent'] === 'string') {
      headers['User-Agent'] = req.headers['user-agent'];
    }
    const range = req.headers.range;
    if (typeof range === 'string') {
      headers.Range = range;
    }
    const icy = req.headers['icy-metadata'];
    if (typeof icy === 'string') {
      headers['Icy-MetaData'] = icy;
    }
    return headers;
  }

  /**
   * One upstream request, with the windowing dance a range-hostile host needs.
   *
   * Throws whatever `fetch` throws; the caller decides what a dead host means.
   */
  private async fetchUpstream(target: string, opts: UpstreamFetchOptions): Promise<Response> {
    const { upstreamHeaders, wantsRest, restStart } = opts;
    const firstAttemptHeaders = wantsRest
      ? { ...upstreamHeaders, Range: `bytes=${restStart}-${restStart + RANGE_CHUNK_BYTES - 1}` }
      : upstreamHeaders;

    let upstream = await fetch(target, {
      headers: firstAttemptHeaders,
      redirect: 'follow',
    });
    if (wantsRest) {
      this.log.debug('proxy windowed first attempt', {
        clientRange: upstreamHeaders.Range ?? '(none)',
        sentRange: firstAttemptHeaders.Range,
        status: upstream.status,
        sentHeaders: Object.keys(firstAttemptHeaders).join(','),
      });
    }
    // A host that dislikes the window (or ignores ranges entirely, like a radio
    // stream) gets asked again exactly the way the client asked — no regression for
    // everything that was already working. Cancel the refused body first: dropping a
    // Response without reading it leaves the connection held open.
    //
    // An `icy-metaint` on the answer says the same thing from the other side: this is
    // a live radio stream carrying metadata blocks at fixed offsets into its body. Not
    // every one of them ignores ranges — an nginx-fronted Shoutcast serves the window
    // happily, 206 and a fabricated gigabyte of Content-Length — but those offsets only
    // hold within one unbroken body, so windowing it is never right regardless.
    if (wantsRest && (!upstream.ok || upstream.headers.has('icy-metaint'))) {
      await this.discardBody(upstream, 'discarding refused window', target);
      upstream = await fetch(target, { headers: upstreamHeaders, redirect: 'follow' });
    }
    return upstream;
  }

  /**
   * Walk `.m3u`/`.pls` pointers until an actual audio response is in hand.
   *
   * Returns null when the answer is already on the wire: a real HLS manifest, rewritten
   * and served for ffmpeg's hls demuxer to take from here, or a pointer leading nowhere.
   */
  private async followPointerPlaylists(
    res: ServerResponse,
    first: Response,
    firstTarget: string,
    opts: UpstreamFetchOptions & { extraHeaders?: Record<string, string> },
  ): Promise<{ response: Response; target: string } | null> {
    let upstream = first;
    let target = firstTarget;

    for (let hop = 0; ; hop++) {
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
      if (!upstream.ok || !this.isPlaylistResponse(contentType, upstream.url)) {
        return { response: upstream, target };
      }
      if (hop >= MAX_PLAYLIST_HOPS) {
        this.log.warn('playlist keeps pointing at playlists', { target });
        await this.discardBody(upstream, 'abandoning playlist chain', target);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'playlist-too-deep' }));
        return null;
      }

      const text = await this.readTextResponse(upstream);
      if (text == null) {
        res.writeHead(upstream.status || 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'playlist-read-failed' }));
        return null;
      }
      if (isHlsManifest(text)) {
        this.respondPlaylist(res, text, upstream, contentType, opts.extraHeaders);
        return null;
      }

      const next = await this.fetchFirstReachableEntry(text, upstream.url, opts);
      if (!next) {
        this.log.warn('playlist names no reachable stream', { target });
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'playlist-unplayable' }));
        return null;
      }
      this.log.debug('followed pointer playlist', { from: target, to: next.target });
      upstream = next.response;
      target = next.target;
    }
  }

  /** The first entry of a pointer playlist that answers — the rest are its mirrors. */
  private async fetchFirstReachableEntry(
    body: string,
    baseUrl: string,
    opts: UpstreamFetchOptions,
  ): Promise<{ response: Response; target: string } | null> {
    const entries = playlistEntries(body, baseUrl).slice(0, MAX_PLAYLIST_ENTRIES);
    for (const entry of entries) {
      let response: Response;
      try {
        response = await this.fetchUpstream(entry, opts);
      } catch (error) {
        this.log.debug('playlist entry unreachable', {
          entry,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (response.ok) {
        return { response, target: entry };
      }
      this.log.debug('playlist entry refused', { entry, status: response.status });
      await this.discardBody(response, 'discarding refused playlist entry', entry);
    }
    return null;
  }

  /** Drop a response we will not read: leaving the body open holds the connection. */
  private async discardBody(response: Response, label: string, target: string): Promise<void> {
    await bestEffort(() => response.body?.cancel() ?? Promise.resolve(), {
      fallback: undefined,
      onError: 'debug',
      log: this.log,
      label,
      context: { target },
    });
  }

  private respondPlaylist(
    res: ServerResponse,
    body: string,
    upstream: Response,
    contentType: string,
    extraHeaders?: Record<string, string>,
  ): void {
    const rewritten = this.rewriteM3u(body, upstream.url, extraHeaders);
    res.writeHead(upstream.status || 200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
    });
    res.end(rewritten);
  }

  /**
   * Walk the resource in bounded ranges and pour them into one response.
   *
   * The client asked for an open-ended range and the host said 403 to it. It will
   * answer a bounded one, so we ask for a window at a time and keep writing into the
   * same response body — the client sees a single continuous stream and never learns
   * the fetch underneath was chopped up.
   *
   * A window that breaks off mid-body (googlevideo resets long-lived range responses)
   * is asked for again from the exact byte already written, so the client never sees
   * the seam. When upstream keeps failing without progress, or the walk ends short of
   * the advertised length, the response is destroyed rather than ended: the client
   * then sees an error it can reconnect on instead of an open connection gone quiet.
   */
  private async streamInBoundedChunks(
    res: ServerResponse,
    target: string,
    baseHeaders: Record<string, string>,
    startByte: number,
    firstChunk: Response,
    firstRange: { end: number; total: number | null },
    opts: { clientAskedForRange: boolean },
  ): Promise<void> {
    let pos = startByte;
    let total: number | null = firstRange.total;
    let wroteHead = false;
    let failures = 0;
    // The opening window is already in hand — fetching it again would cost a request
    // against the same per-video budget that makes this dance necessary.
    let pending: { response: Response; range: { end: number; total: number | null } } | null = {
      response: firstChunk,
      range: firstRange,
    };

    while (total === null || pos < total) {
      if (res.destroyed) {
        return; // the client left while we were between windows
      }
      if (failures > MAX_UPSTREAM_FAILURES) {
        this.log.warn('proxy upstream keeps failing; giving up', { target, pos, total, failures });
        res.destroy();
        return;
      }
      let chunk: Response;
      let parsed: { end: number; total: number | null } | null;
      if (pending) {
        chunk = pending.response;
        parsed = pending.range;
        pending = null;
      } else {
        if (failures > 1) {
          await delay(RESUME_BACKOFF_MS * (failures - 1));
        }
        const end = pos + RANGE_CHUNK_BYTES - 1;
        try {
          chunk = await fetch(target, {
            headers: { ...baseHeaders, Range: `bytes=${pos}-${end}` },
            redirect: 'follow',
          });
        } catch (error) {
          this.log.warn('proxy chunk fetch failed', { target, pos, ...describeReadError(error) });
          failures += 1;
          continue;
        }
        // Only a partial starting at `pos` continues the body: a 200 is the file again
        // from byte 0, and splicing that in would garble everything after the seam.
        if (chunk.status !== 206 || !chunk.body) {
          this.log.warn('proxy chunk rejected mid-stream', { target, pos, status: chunk.status });
          await this.discardBody(chunk, 'discarding rejected window', target);
          failures += 1;
          continue;
        }
        parsed = parseContentRange(chunk.headers.get('content-range'));
        if (failures > 0) {
          this.log.info('proxy upstream resumed', { target, pos, failures });
        }
      }
      if (!chunk.body) {
        break;
      }
      if (total === null) {
        total = parsed?.total ?? null;
      }

      if (!wroteHead) {
        const headers: Record<string, string> = {
          'Content-Type': chunk.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Accept-Ranges': 'bytes',
        };
        // Advertise the whole remaining resource, not this first window — the client
        // asked for everything from `pos` on, and that is what it is about to get.
        if (total !== null) {
          headers['Content-Length'] = String(total - pos);
          if (opts.clientAskedForRange) {
            headers['Content-Range'] = `bytes ${pos}-${total - 1}/${total}`;
          }
        }
        res.writeHead(total !== null && opts.clientAskedForRange ? 206 : 200, headers);
        wroteHead = true;
      }

      const body = Readable.fromWeb(chunk.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      const piped = await this.pipeChunk(body, res);
      if (piped.kind === 'client-gone') {
        return; // client went away; nothing left to serve it
      }
      if (piped.kind === 'upstream-error') {
        failures = piped.written > 0 ? 1 : failures + 1;
        this.log.warn('proxy upstream read failed; resuming', {
          target,
          pos: pos + piped.written,
          windowStart: pos,
          total,
          failures,
          ...describeReadError(piped.error),
        });
        pos += piped.written;
        continue;
      }
      failures = 0;

      const advanced = parsed ? parsed.end + 1 : pos + RANGE_CHUNK_BYTES;
      if (advanced <= pos) {
        break; // no forward progress; stop rather than spin
      }
      pos = advanced;
      if (total === null) {
        break; // without a total there is no way to know where to stop
      }
    }

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy-chunk-failed' }));
      return;
    }
    if (total !== null && pos < total) {
      // A clean end here would pass a truncated body off as the whole one.
      this.log.warn('proxy stream ended short', { target, pos, total });
      res.destroy();
      return;
    }
    res.end();
  }

  /**
   * Pipe one window into the response, keeping it open, and say how it stopped and how
   * many bytes reached the response before it did.
   *
   * An upstream that goes silent for `UPSTREAM_STALL_MS` counts as failed, but only
   * while the client is keeping up: a paused or slow reader holds the pipe back on
   * purpose, and that silence is ours, not the host's.
   */
  private pipeChunk(body: Readable, res: ServerResponse): Promise<PipeOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let written = 0;
      const done = (outcome: PipeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(stall);
        body.removeListener('data', onData);
        body.removeListener('end', onEnd);
        body.removeListener('error', onError);
        res.removeListener('close', onClose);
        res.removeListener('drain', onDrain);
        body.unpipe(res);
        resolve(outcome);
      };
      const onData = (data: Buffer): void => {
        written += data.length;
        stall.refresh();
      };
      const onDrain = (): void => {
        stall.refresh();
      };
      const onStall = (): void => {
        if (res.writableNeedDrain) {
          stall.refresh();
          return;
        }
        body.destroy(new Error(`no upstream data for ${UPSTREAM_STALL_MS} ms`));
      };
      const onEnd = (): void => done({ kind: 'end', written });
      const onError = (error: unknown): void => {
        body.destroy();
        done({ kind: 'upstream-error', written, error });
      };
      const onClose = (): void => {
        body.destroy();
        done({ kind: 'client-gone', written });
      };
      const stall = setTimeout(onStall, UPSTREAM_STALL_MS);
      body.on('end', onEnd);
      body.on('error', onError);
      res.on('close', onClose);
      res.on('drain', onDrain);
      body.pipe(res, { end: false });
      body.on('data', onData);
    });
  }

  private async readTextResponse(upstream: Response): Promise<string | null> {
    const length = upstream.headers.get('content-length');
    const size = length ? Number(length) : null;
    if (size && size > MAX_PLAYLIST_BYTES) {
      return null;
    }
    const text = await bestEffort(() => upstream.text(), {
      // Best-effort read; if the playlist can't be read, treat as unavailable.
      fallback: null,
      onError: 'debug',
      log: this.log,
      label: 'playlist read failed',
      context: { url: upstream.url },
    });
    if (text == null || text.length > MAX_PLAYLIST_BYTES) {
      return null;
    }
    return text;
  }

  private rewriteM3u(
    body: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    const lines = body.split(/\r?\n/);
    const proxied = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (trimmed.startsWith('#')) {
        return this.rewriteHlsUriLine(line, baseUrl, headers);
      }
      return this.wrapProxyUrl(trimmed, baseUrl, headers);
    });
    return proxied.join('\n');
  }

  private rewriteHlsUriLine(
    line: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    return line.replace(/URI="([^"]+)"/gi, (_match, uri) => {
      const proxied = this.wrapProxyUrl(uri, baseUrl, headers);
      return `URI="${proxied}"`;
    });
  }

  private resolveZoneId(req: IncomingMessage): number | null {
    const header = req.headers['x-loxone-zone'];
    const raw = Array.isArray(header) ? header[0] : header;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  private attachIcyMetadataListener(
    stream: Readable,
    metaInt: number,
    zoneId: number,
  ): void {
    let bytesUntilMeta = metaInt;
    let metaRemaining = 0;
    let metaChunks: Buffer[] = [];
    let lastSignature = '';

    const handleMetadata = (payload: Buffer) => {
      const update = this.parseIcyMetadata(payload);
      if (!update) {
        return;
      }
      const signature = `${update.title}|||${update.artist}`;
      if (lastSignature === signature) {
        return;
      }
      lastSignature = signature;
      this.zoneManager.inputs.updateRadioMetadata(zoneId, update);
    };

    const onData = (chunk: Buffer) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (metaRemaining > 0) {
          const take = Math.min(metaRemaining, chunk.length - offset);
          metaChunks.push(chunk.subarray(offset, offset + take));
          offset += take;
          metaRemaining -= take;
          if (metaRemaining === 0) {
            const payload = Buffer.concat(metaChunks);
            metaChunks = [];
            handleMetadata(payload);
            bytesUntilMeta = metaInt;
          }
          continue;
        }
        if (bytesUntilMeta > 0) {
          const skip = Math.min(bytesUntilMeta, chunk.length - offset);
          offset += skip;
          bytesUntilMeta -= skip;
          if (bytesUntilMeta > 0) {
            continue;
          }
        }
        if (bytesUntilMeta === 0) {
          if (offset >= chunk.length) {
            break;
          }
          const length = chunk.readUInt8(offset);
          offset += 1;
          metaRemaining = length * 16;
          if (metaRemaining === 0) {
            bytesUntilMeta = metaInt;
          }
        }
      }
    };

    const cleanup = () => {
      stream.off('data', onData);
    };

    stream.on('data', onData);
    stream.on('end', cleanup);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
  }

  private parseIcyMetadata(payload: Buffer): { title: string; artist: string } | null {
    const text = payload.toString('utf8').replace(/\0/g, '').trim();
    if (!text) {
      return null;
    }
    // ICY packs `key='value';` pairs, and a value is allowed to hold an apostrophe of its
    // own — the terminator is `';`, not a bare quote. Ending the capture at the first
    // quote served "Yazoo - Don't Go" as "Yazoo - Don" (issue #348). Stations that leave
    // the trailing `;` off the last pair fall back to a quote at the end of the block.
    const match =
      /StreamTitle='([\s\S]*?)';/i.exec(text) ??
      /StreamTitle='([\s\S]*)'\s*$/i.exec(text) ??
      /StreamTitle="([\s\S]*?)";/i.exec(text) ??
      /StreamTitle="([\s\S]*)"\s*$/i.exec(text);
    const rawTitle = match?.[1]?.trim() ?? '';
    if (!rawTitle) {
      return null;
    }
    const normalized = rawTitle.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return null;
    }
    let artist = '';
    let title = normalized;
    const separator = ' - ';
    const idx = normalized.indexOf(separator);
    if (idx > 0) {
      artist = normalized.slice(0, idx).trim();
      title = normalized.slice(idx + separator.length).trim();
    }
    return { title, artist };
  }

  private wrapProxyUrl(
    rawUrl: string,
    baseUrl: string,
    headers?: Record<string, string>,
  ): string {
    let absolute: string;
    try {
      absolute = new URL(rawUrl, baseUrl).toString();
    } catch {
      return rawUrl;
    }
    const host = resolveProxyHost();
    const port = resolveProxyPort();
    const params = new URLSearchParams();
    params.set('u', absolute);
    const headerPayload = encodeHeaders(headers);
    if (headerPayload) {
      params.set('h', headerPayload);
    }
    return `http://${host}:${port}/streams/proxy?${params.toString()}`;
  }

  private isPlaylistResponse(contentType: string, finalUrl: string): boolean {
    const ct = (contentType ?? '').toLowerCase();
    if (ct.includes('mpegurl') || ct.includes('m3u')) {
      return true;
    }
    if (ct.includes('scpls') || ct.includes('pls')) {
      return true;
    }
    try {
      const path = new URL(finalUrl).pathname.toLowerCase();
      return path.endsWith('.m3u8') || path.endsWith('.m3u') || path.endsWith('.pls');
    } catch {
      return false;
    }
  }

}
