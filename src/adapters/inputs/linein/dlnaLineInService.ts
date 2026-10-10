import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Readable, type Writable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import { buildBaseUrl } from '@/shared/streamUrl';
import { resolveCoverHost } from '@/shared/utils/net';
import { FfmpegProcess } from '@/engine/ffmpegProcess';
import { LINEIN_INGEST_HIGH_WATER_MARK, lineInSource, resolveLineInEntries } from '@/domain/config/lineIn';
import type { LineInIngestFormat, LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import {
  SsdpAdvertiser,
  UpnpMediaRenderer,
  RENDERER_PATHS,
  type RendererHandler,
} from '@sonn-audio/node-upnp';

/**
 * What every DLNA line-in is decoded to. Fixed rather than following the cast: the
 * zone resamples to its own output anyway, and a fixed shape means the ingest format
 * is known before the first byte — which the metadata capture and the zone both read.
 */
export const DLNA_LINEIN_FORMAT: LineInIngestFormat = {
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
  pcmFormat: 's16le',
};

const BASE_PATH = '/dlna-linein/';

/** The body of a cast URI, and what the control point said it is. */
export type OpenedCast = { contentType: string; body: NodeJS.ReadableStream };

/** One running decoder: PCM comes out of `onData`, the cast goes into `stdin`. */
export type DecoderHandle = { stdin: Writable; terminate(): void };

export type DecoderHandlers = {
  onData(chunk: Buffer): void;
  onExit(code: number | null): void;
  onError(message: string): void;
};

export type DlnaLineInDeps = {
  /** Fetch a cast URI. Aborting `signal` must end the body. */
  openCast?: (uri: string, signal: AbortSignal) => Promise<OpenedCast>;
  spawnDecoder?: (args: string[], handlers: DecoderHandlers) => DecoderHandle;
};

type Ingest = {
  generation: number;
  abort: AbortController;
  decoder: DecoderHandle | null;
  stream: PassThrough;
  started: boolean;
  dropping: boolean;
};

type InputRenderer = {
  inputId: string;
  name: string;
  renderer: UpnpMediaRenderer;
  uri: string | null;
  ingest: Ingest | null;
};

/**
 * Path segment for one input. Ids look like `MAC#1000001` and are free text when set by
 * hand, and the gateway decodes the path before it gets here — so the id itself is not
 * a safe segment, and a digest of it is.
 */
function segmentFor(inputId: string): string {
  return createHash('sha1').update(inputId).digest('hex').slice(0, 12);
}

/** A UDN that stays put for as long as the input keeps its id. */
function udnFor(inputId: string): string {
  const h = createHash('sha1').update(`sonn-dlna-linein:${inputId}`).digest('hex');
  return `uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * ffmpeg input options for a cast's content type.
 *
 * Containers and codecs are found by probing, but raw `audio/L16` has nothing to probe:
 * it is bare big-endian PCM whose rate and channel count travel only as content-type
 * parameters (RFC 2586). Without them ffmpeg cannot read it at all.
 */
export function decoderInputArgs(contentType: string): string[] {
  const [mime, ...params] = contentType.split(';').map((part) => part.trim());
  if (mime?.toLowerCase() !== 'audio/l16') {
    return [];
  }
  const values = new Map<string, string>();
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq > 0) {
      values.set(param.slice(0, eq).trim().toLowerCase(), param.slice(eq + 1).trim());
    }
  }
  const rate = Number.parseInt(values.get('rate') ?? '', 10);
  const channels = Number.parseInt(values.get('channels') ?? '', 10);
  return [
    '-f',
    's16be',
    '-ar',
    String(Number.isFinite(rate) && rate > 0 ? rate : 44100),
    '-ac',
    String(Number.isFinite(channels) && channels > 0 ? channels : 1),
  ];
}

export function decoderArgs(contentType: string): string[] {
  const format = DLNA_LINEIN_FORMAT;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    // A live input: anything ffmpeg holds back to analyse is delay at the speaker.
    '-probesize',
    '65536',
    ...decoderInputArgs(contentType),
    '-i',
    'pipe:0',
    '-vn',
    '-ac',
    String(format.channels),
    '-ar',
    String(format.sampleRate),
    '-f',
    format.pcmFormat,
    'pipe:1',
  ];
}

async function defaultOpenCast(uri: string, signal: AbortSignal): Promise<OpenedCast> {
  const res = await fetch(uri, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`cast fetch failed: HTTP ${res.status}`);
  }
  return {
    contentType: res.headers.get('content-type') ?? '',
    body: Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream),
  };
}

function defaultSpawnDecoder(args: string[], handlers: DecoderHandlers): DecoderHandle {
  const log = createLogger('Input', 'DlnaLineInDecoder');
  const proc = new FfmpegProcess(
    args,
    {
      onStdout: handlers.onData,
      onStderr: (line) => log.debug('ffmpeg', { line }),
      onExit: (code) => handlers.onExit(code),
      onError: (error) => handlers.onError(error.message),
    },
    log,
  );
  return { stdin: proc.stdin, terminate: () => proc.terminate() };
}

/**
 * A line-in fed by DLNA: each line-in whose source is `{ type: 'dlna' }` is advertised as
 * a MediaRenderer of its own, and whatever a control point casts at it becomes that
 * input's audio.
 *
 * This is the other half of the per-zone renderers in `DlnaInputService`. Those play a
 * cast *as* the zone's track; this one turns it into a live source, so it is picked like
 * any other line-in (Loxone, BeoRemote, the app), starts a zone that is waiting on it, and
 * plays in sync across a group. The case it was built for is a WiiM's "DLNA Out", which
 * pushes the device's analog input to a single renderer and leaves grouping to it (#407).
 *
 * The cast is fetched here rather than by ffmpeg, for the content type: raw `audio/L16`
 * only says what it is in that header. The decoded PCM goes into the ingest registry,
 * the same door the TCP, WebSocket and sendspin transports use.
 */
export class DlnaLineInService {
  private readonly log = createLogger('Input', 'DlnaLineIn');
  private readonly inputs = new Map<string, InputRenderer>();
  private readonly openCast: NonNullable<DlnaLineInDeps['openCast']>;
  private readonly spawnDecoder: NonNullable<DlnaLineInDeps['spawnDecoder']>;
  private generation = 0;
  private started = false;

  constructor(
    private readonly registry: LineInIngestRegistry,
    private readonly config: ConfigPort,
    private readonly ssdp: SsdpAdvertiser,
    private readonly httpPort: number,
    deps: DlnaLineInDeps = {},
  ) {
    this.openCast = deps.openCast ?? defaultOpenCast;
    this.spawnDecoder = deps.spawnDecoder ?? defaultSpawnDecoder;
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.refresh();
  }

  public stop(): void {
    this.started = false;
    for (const inputId of Array.from(this.inputs.keys())) {
      this.removeInput(inputId);
    }
  }

  /** Bring the advertised renderers in line with the configured line-ins. */
  public refresh(): void {
    if (!this.started) return;
    const desired = new Set<string>();
    for (const entry of resolveLineInEntries(this.config.getConfig())) {
      const source = lineInSource(entry.record);
      if (String(source?.type ?? '').toLowerCase() !== 'dlna') {
        continue;
      }
      desired.add(entry.id);
      const publishName = typeof source?.publishName === 'string' ? source.publishName.trim() : '';
      const name = publishName || entry.name;
      const existing = this.inputs.get(entry.id);
      if (existing) {
        existing.name = name; // friendlyName() reads this live
        continue;
      }
      this.addInput(entry.id, name);
    }
    for (const inputId of Array.from(this.inputs.keys())) {
      if (!desired.has(inputId)) {
        this.removeInput(inputId);
      }
    }
  }

  private baseUrl(inputId: string): string {
    const host = resolveCoverHost(this.config.getConfig().system.audioserver.ip);
    return `${buildBaseUrl({ host, port: this.httpPort })}${BASE_PATH}${segmentFor(inputId)}`;
  }

  private addInput(inputId: string, name: string): void {
    const entry: InputRenderer = {
      inputId,
      name,
      renderer: null as unknown as UpnpMediaRenderer,
      uri: null,
      ingest: null,
    };
    const handler: RendererHandler = {
      onSetUri: (uri) => {
        entry.uri = uri;
      },
      // A seek on a live input has nothing to seek to, so the offset is dropped.
      onPlay: (uri) => {
        entry.uri = uri;
        this.startIngest(entry, uri);
      },
      // A pause does not keep the connection: the source buffers while paused, and that
      // buffer would come out as delay once it resumes. A fresh fetch is live again.
      onPause: () => this.stopIngest(entry, 'paused'),
      onResume: () => {
        if (entry.uri) this.startIngest(entry, entry.uri);
      },
      onStop: () => this.stopIngest(entry, 'stopped'),
    };
    entry.renderer = new UpnpMediaRenderer({
      udn: udnFor(inputId),
      friendlyName: () => entry.name,
      baseUrl: () => this.baseUrl(inputId),
      handler,
      identity: {
        manufacturer: 'Sonn Audio',
        modelName: 'Sonn Audio Line-In',
        modelDescription: 'Sonn Audio DLNA Line-In',
      },
      logger: this.log,
    });
    this.inputs.set(inputId, entry);
    this.ssdp.addDevice({
      udn: entry.renderer.udn,
      ...entry.renderer.deviceTypeAndServices(),
      location: () => `${this.baseUrl(inputId)}/${RENDERER_PATHS.device}`,
    });
    this.log.info('dlna line-in advertised', { inputId, name });
  }

  private removeInput(inputId: string): void {
    const entry = this.inputs.get(inputId);
    if (!entry) return;
    this.stopIngest(entry, 'removed');
    this.ssdp.removeDevice(entry.renderer.udn);
    entry.renderer.dispose();
    this.inputs.delete(inputId);
  }

  private startIngest(entry: InputRenderer, uri: string): void {
    this.stopIngest(entry, 'replaced');
    const ingest: Ingest = {
      generation: ++this.generation,
      abort: new AbortController(),
      decoder: null,
      stream: new PassThrough({ highWaterMark: LINEIN_INGEST_HIGH_WATER_MARK }),
      started: false,
      dropping: false,
    };
    entry.ingest = ingest;
    this.log.info('dlna line-in cast', { inputId: entry.inputId, uri });
    void this.runIngest(entry, ingest, uri);
  }

  private isCurrent(entry: InputRenderer, ingest: Ingest): boolean {
    return entry.ingest?.generation === ingest.generation;
  }

  private async runIngest(entry: InputRenderer, ingest: Ingest, uri: string): Promise<void> {
    let cast: OpenedCast;
    try {
      cast = await this.openCast(uri, ingest.abort.signal);
    } catch (error) {
      if (this.isCurrent(entry, ingest)) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('dlna line-in fetch failed', { inputId: entry.inputId, message });
        this.endIngest(entry, ingest, 'fetch-failed');
      }
      return;
    }
    if (!this.isCurrent(entry, ingest)) {
      (cast.body as Readable).destroy?.();
      return;
    }
    this.log.info('dlna line-in decoding', { inputId: entry.inputId, contentType: cast.contentType });
    const decoder = this.spawnDecoder(decoderArgs(cast.contentType), {
      onData: (chunk) => this.writePcm(entry, ingest, chunk),
      onExit: (code) => {
        if (this.isCurrent(entry, ingest)) {
          this.log.info('dlna line-in decoder exited', { inputId: entry.inputId, code });
          this.endIngest(entry, ingest, 'ended');
        }
      },
      onError: (message) => {
        if (this.isCurrent(entry, ingest)) {
          this.log.warn('dlna line-in decoder failed', { inputId: entry.inputId, message });
          this.endIngest(entry, ingest, 'decoder-error');
        }
      },
    });
    ingest.decoder = decoder;
    // An aborted fetch or a decoder that went away mid-write is the normal end of a cast,
    // not something to crash on.
    cast.body.on('error', () => decoder.stdin.end());
    decoder.stdin.on('error', () => {});
    cast.body.pipe(decoder.stdin);
  }

  /**
   * Hand decoded PCM to the ingest, starting the session on the first chunk so a cast
   * that never produces audio never looks like a source that came up. When nothing is
   * reading — no zone on this input — chunks are dropped instead of backing up: a live
   * input that queues comes out late.
   */
  private writePcm(entry: InputRenderer, ingest: Ingest, chunk: Buffer): void {
    if (!this.isCurrent(entry, ingest) || !chunk.length) return;
    if (!ingest.started) {
      ingest.started = true;
      this.registry.start(entry.inputId, ingest.stream, { format: DLNA_LINEIN_FORMAT });
    }
    if (ingest.dropping) return;
    if (!ingest.stream.write(chunk)) {
      ingest.dropping = true;
      ingest.stream.once('drain', () => {
        ingest.dropping = false;
      });
    }
  }

  private stopIngest(entry: InputRenderer, reason: string): void {
    const ingest = entry.ingest;
    if (ingest) this.endIngest(entry, ingest, reason);
  }

  private endIngest(entry: InputRenderer, ingest: Ingest, reason: string): void {
    if (!this.isCurrent(entry, ingest)) return;
    entry.ingest = null;
    ingest.abort.abort();
    ingest.decoder?.terminate();
    if (ingest.started) {
      // Before ending the stream: the registry stops the session itself when its source
      // ends, and would log that as a plain 'ended' instead of why.
      this.registry.stop(entry.inputId, `dlna-${reason}`);
    }
    ingest.stream.end();
    if (reason === 'ended' || reason === 'fetch-failed' || reason === 'decoder-error') {
      // The control point thinks it is still playing; tell it otherwise.
      entry.renderer.reflectTransportState('STOPPED');
    }
  }

  // ── HTTP dispatch (registered on the gateway for /dlna-linein/*) ──────────────

  public matches(pathname: string): boolean {
    return pathname.startsWith(BASE_PATH);
  }

  public async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const rest = pathname.slice(BASE_PATH.length);
    const slash = rest.indexOf('/');
    const segment = slash >= 0 ? rest.slice(0, slash) : rest;
    const sub = slash >= 0 ? rest.slice(slash + 1) : '';
    const entry = Array.from(this.inputs.values()).find((e) => segmentFor(e.inputId) === segment);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('renderer-not-found');
      return;
    }
    await entry.renderer.handle(req, res, sub);
  }
}
