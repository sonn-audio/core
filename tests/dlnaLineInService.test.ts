import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  DLNA_LINEIN_FORMAT,
  DlnaLineInService,
  decoderInputArgs,
  type DecoderHandlers,
} from '../src/adapters/inputs/linein/dlnaLineInService';
import { LineInIngestRegistry } from '../src/adapters/inputs/linein/lineInIngestRegistry';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { LineInInputConfig } from '../src/domain/config/types';
import type { SsdpAdvertiser } from '@sonn-audio/node-upnp';

// A line-in whose source is DLNA is a renderer of its own: a control point (a WiiM's
// "DLNA Out") casts at it, and the cast comes out as that input's PCM in the ingest
// registry, the same door every other line-in transport uses. These go through the
// SOAP wire, as a control point would, with the fetch and ffmpeg replaced.

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public body = '';

  public writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }

  public write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.emit('finish');
  }
}

type Advertised = { udn: string; location: () => string };

function makeSsdp(): { ssdp: SsdpAdvertiser; devices: Map<string, Advertised> } {
  const devices = new Map<string, Advertised>();
  const ssdp = {
    addDevice: (d: Advertised) => devices.set(d.udn, d),
    removeDevice: (udn: string) => devices.delete(udn),
  } as unknown as SsdpAdvertiser;
  return { ssdp, devices };
}

function makeConfig(inputs: LineInInputConfig[]): { port: ConfigPort; inputs: LineInInputConfig[] } {
  const config = {
    system: { audioserver: { ip: '127.0.0.1', macId: 'AABBCCDDEEFF' } },
    inputs: { lineIn: { inputs } },
  };
  return { port: { getConfig: () => config } as unknown as ConfigPort, inputs };
}

class FakeDecoder {
  public args: string[] = [];
  public handlers: DecoderHandlers | null = null;
  public stdin = new PassThrough();
  public terminated = false;
}

function makeService(inputs: LineInInputConfig[], contentType = 'audio/flac') {
  const registry = new LineInIngestRegistry();
  const { ssdp, devices } = makeSsdp();
  const { port, inputs: configured } = makeConfig(inputs);
  const decoders: FakeDecoder[] = [];
  const fetched: Array<{ uri: string; signal: AbortSignal }> = [];
  const service = new DlnaLineInService(registry, port, ssdp, 7090, {
    openCast: async (uri, signal) => {
      fetched.push({ uri, signal });
      return { contentType, body: Readable.from([Buffer.from('cast-bytes')]) };
    },
    spawnDecoder: (args, handlers) => {
      const decoder = new FakeDecoder();
      decoder.args = args;
      decoder.handlers = handlers;
      decoders.push(decoder);
      return { stdin: decoder.stdin, terminate: () => (decoder.terminated = true) };
    },
  });
  service.start();
  return { service, registry, devices, decoders, fetched, configured };
}

/** The renderer's base path, read off what it advertised — the same place a control point gets it. */
function basePath(devices: Map<string, Advertised>): string {
  const [device] = Array.from(devices.values());
  assert.ok(device, 'a renderer was advertised');
  return new URL(device.location()).pathname.replace(/\/device\.xml$/, '');
}

async function soap(
  service: DlnaLineInService,
  base: string,
  action: string,
  args = '',
): Promise<FakeResponse> {
  const envelope =
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    `<InstanceID>0</InstanceID>${args}</u:${action}></s:Body></s:Envelope>`;
  const req = Readable.from([Buffer.from(envelope)]) as unknown as IncomingMessage;
  (req as { method?: string }).method = 'POST';
  (req as { headers?: Record<string, string> }).headers = {
    soapaction: `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
  };
  const res = new FakeResponse();
  await service.handle(req, res as unknown as ServerResponse, `${base}/avt/control`);
  return res;
}

async function cast(service: DlnaLineInService, base: string, uri: string): Promise<void> {
  await soap(
    service,
    base,
    'SetAVTransportURI',
    `<CurrentURI>${uri}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`,
  );
  await soap(service, base, 'Play', '<Speed>1</Speed>');
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('only a line-in whose source is dlna is advertised, and it goes when the source changes', () => {
  const { service, devices, configured } = makeService([
    { name: 'Turntable', source: { type: 'sendspin', clientId: 'x' } },
    { name: 'WiiM', source: { type: 'dlna' } },
  ]);
  assert.equal(devices.size, 1);

  configured[1]!.source = { type: 'sendspin', clientId: 'y' };
  service.refresh();
  assert.equal(devices.size, 0);
});

test('a cast becomes the input\'s audio, starting the session on the first decoded chunk', async () => {
  const { service, registry, devices, decoders, fetched } = makeService([
    { name: 'WiiM', source: { type: 'dlna' } },
  ]);
  const inputId = 'AABBCCDDEEFF#1000001';
  const started: string[] = [];
  registry.onStart(inputId, (s) => started.push(s.id));

  await cast(service, basePath(devices), 'http://192.168.1.20:49152/linein.flac');
  await flush();

  assert.equal(fetched[0]?.uri, 'http://192.168.1.20:49152/linein.flac');
  const decoder = decoders[0]!;
  assert.ok(decoder.args.includes('pipe:0'));
  // Nothing decoded yet: a cast that never produces audio must not look like a source that came up.
  assert.equal(registry.getSession(inputId), null);

  const read: Buffer[] = [];
  decoder.handlers!.onData(Buffer.from([1, 2, 3, 4]));
  const session = registry.getSession(inputId);
  assert.ok(session);
  assert.deepEqual(session.format, DLNA_LINEIN_FORMAT);
  assert.deepEqual(started, [inputId]);
  session.stream.on('data', (c: Buffer) => read.push(c));
  decoder.handlers!.onData(Buffer.from([5, 6, 7, 8]));
  await flush();
  assert.deepEqual(Buffer.concat(read), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
});

test('stop ends the session, the fetch and the decoder', async () => {
  const { service, registry, devices, decoders, fetched } = makeService([
    { name: 'WiiM', source: { type: 'dlna' } },
  ]);
  const inputId = 'AABBCCDDEEFF#1000001';
  const stops: Array<string | undefined> = [];
  registry.onStop(inputId, (_s, reason) => stops.push(reason));
  const base = basePath(devices);

  await cast(service, base, 'http://192.168.1.20:49152/linein.flac');
  await flush();
  decoders[0]!.handlers!.onData(Buffer.alloc(8));
  await soap(service, base, 'Stop');

  assert.equal(registry.getSession(inputId), null);
  assert.deepEqual(stops, ['dlna-stopped']);
  assert.equal(fetched[0]!.signal.aborted, true);
  assert.equal(decoders[0]!.terminated, true);
});

test('a decoder that exits on its own tells the control point it stopped', async () => {
  const { service, registry, devices, decoders } = makeService([{ name: 'WiiM', source: { type: 'dlna' } }]);
  const base = basePath(devices);

  await cast(service, base, 'http://192.168.1.20:49152/linein.flac');
  await flush();
  decoders[0]!.handlers!.onData(Buffer.alloc(8));
  decoders[0]!.handlers!.onExit(0);

  assert.equal(registry.getSession('AABBCCDDEEFF#1000001'), null);
  const info = await soap(service, base, 'GetTransportInfo');
  assert.match(info.body, /<CurrentTransportState>STOPPED</);
});

test('a new cast replaces the running one instead of feeding the input twice', async () => {
  const { service, devices, decoders } = makeService([{ name: 'WiiM', source: { type: 'dlna' } }]);
  const base = basePath(devices);

  await cast(service, base, 'http://192.168.1.20:49152/a.flac');
  await flush();
  await cast(service, base, 'http://192.168.1.20:49152/b.flac');
  await flush();

  assert.equal(decoders.length, 2);
  assert.equal(decoders[0]!.terminated, true);
  assert.equal(decoders[1]!.terminated, false);
});

test('raw L16 is decoded with the rate and channels from its content type', () => {
  assert.deepEqual(decoderInputArgs('audio/L16;rate=44100;channels=2'), [
    '-f', 's16be', '-ar', '44100', '-ac', '2',
  ]);
  // RFC 2586: channels defaults to one.
  assert.deepEqual(decoderInputArgs('audio/l16; rate=48000'), ['-f', 's16be', '-ar', '48000', '-ac', '1']);
  assert.deepEqual(decoderInputArgs('audio/flac'), []);
});

test('the renderer is not reachable under anything but its own path', async () => {
  const { service } = makeService([{ name: 'WiiM', source: { type: 'dlna' } }]);
  const res = await soap(service, '/dlna-linein/nope', 'GetTransportInfo');
  assert.equal(res.statusCode, 404);
});
