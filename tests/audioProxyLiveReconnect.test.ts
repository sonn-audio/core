import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from './testHarness';
import { AudioProxyHandler } from '../src/adapters/http/streams/audioProxyHandler';
import { IcyReframer } from '../src/adapters/http/streams/icyReframer';

// A station that closes its connection has not stopped broadcasting. The proxy used to hand
// that close on as the end of the response, the decoder took it for the end of a track, and
// the zone went quiet until someone pressed play again.

function icyBlock(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const padded = Buffer.alloc(Math.ceil(payload.length / 16) * 16);
  payload.copy(padded);
  return Buffer.concat([Buffer.from([padded.length / 16]), padded]);
}

/** Splits a client-side ICY body back into audio and the texts of its metadata blocks. */
function deinterleave(body: Buffer, metaInt: number): { audio: Buffer; titles: string[] } {
  const audio: Buffer[] = [];
  const titles: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    audio.push(body.subarray(offset, Math.min(body.length, offset + metaInt)));
    offset += metaInt;
    if (offset >= body.length) break;
    const length = body.readUInt8(offset) * 16;
    offset += 1;
    if (length > 0) {
      titles.push(body.subarray(offset, offset + length).toString('utf8').replace(/\0/g, ''));
    }
    offset += length;
  }
  return { audio: Buffer.concat(audio), titles };
}

test('icy reframer: an unbroken body goes out byte for byte', () => {
  const metaInt = 100;
  const body = Buffer.concat([
    Buffer.alloc(metaInt, 1),
    icyBlock("StreamTitle='A - B';"),
    Buffer.alloc(metaInt, 2),
    Buffer.from([0]),
    Buffer.alloc(metaInt, 3),
  ]);
  const seen: string[] = [];
  const reframer = new IcyReframer(metaInt, (payload) => seen.push(payload.toString('utf8').replace(/\0/g, '')));
  reframer.startBody(metaInt);
  // Fed in awkward pieces, so blocks and boundaries straddle chunks.
  const out: Buffer[] = [];
  for (let offset = 0; offset < body.length; offset += 7) {
    out.push(reframer.push(body.subarray(offset, offset + 7)));
  }
  assert.ok(Buffer.concat(out).equals(body));
  assert.deepEqual(seen, ["StreamTitle='A - B';"]);
});

test('icy reframer: a second body that starts mid-interval stays on the client count', () => {
  const metaInt = 100;
  const reframer = new IcyReframer(metaInt, () => undefined);
  reframer.startBody(metaInt);
  // The first connection dies 40 bytes into an interval.
  const first = reframer.push(Buffer.alloc(40, 1));
  // The second starts its own count, and carries a title after its first interval.
  reframer.startBody(metaInt);
  const second = reframer.push(
    Buffer.concat([Buffer.alloc(metaInt, 2), icyBlock("StreamTitle='New';"), Buffer.alloc(metaInt, 3)]),
  );
  const { audio, titles } = deinterleave(Buffer.concat([first, second]), metaInt);
  assert.equal(audio.length, 240, 'no audio byte lost and no metadata byte read as audio');
  assert.ok(audio.subarray(0, 40).every((b) => b === 1));
  assert.ok(audio.subarray(40, 140).every((b) => b === 2));
  assert.ok(audio.subarray(140).every((b) => b === 3));
  assert.deepEqual(titles, ["StreamTitle='New';"], 'the title waits for the next client boundary');
});

test('icy reframer: a client promised no metadata gets audio only', () => {
  const reframer = new IcyReframer(null, () => undefined);
  reframer.startBody(50);
  const out = reframer.push(Buffer.concat([Buffer.alloc(50, 7), icyBlock("StreamTitle='x';"), Buffer.alloc(10, 7)]));
  assert.equal(out.length, 60);
  assert.ok(out.every((b) => b === 7));
});

test('audio proxy: a station that closes the connection is reconnected under the same response', async () => {
  const metaInt = 1000;
  let connections = 0;
  const station = http.createServer((_req, res) => {
    connections += 1;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'icy-metaint': String(metaInt) });
    // 1500 bytes of audio per connection: every one is cut off in the middle of an interval.
    res.end(
      Buffer.concat([
        Buffer.alloc(metaInt, connections),
        icyBlock(`StreamTitle='Track ${connections}';`),
        Buffer.alloc(500, connections),
      ]),
    );
  });
  await new Promise<void>((resolve) => station.listen(0, '127.0.0.1', resolve));
  const titles: string[] = [];
  const handler = new AudioProxyHandler({
    inputs: { updateRadioMetadata: (_zone: number, update: { title: string }) => titles.push(update.title) },
  } as never);
  const proxy = http.createServer((req, res) => void handler.handle(req, res));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const target = `http://127.0.0.1:${(station.address() as AddressInfo).port}/live`;
    const body = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const req = http.request(
        {
          host: '127.0.0.1',
          port: (proxy.address() as AddressInfo).port,
          path: `/streams/proxy?u=${encodeURIComponent(target)}`,
          headers: { 'Icy-MetaData': '1', 'X-Loxone-Zone': '4' },
        },
        (res) => {
          assert.equal(res.headers['icy-metaint'], String(metaInt));
          res.on('error', () => undefined);
          res.on('end', () => reject(new Error('the live response ended')));
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            // Three connections' worth of audio, whatever the framing adds.
            if (received >= 4500) {
              req.destroy();
              resolve(Buffer.concat(chunks));
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    const { audio } = deinterleave(body, metaInt);
    // The proxy probes a station once before it settles on how to ask, so the body it serves does
    // not begin with the first connection. Whichever it was, the ones after it follow in order.
    const first = audio[0]!;
    assert.ok(connections >= first + 2, `expected reconnects, saw ${connections} connection(s)`);
    // Audio is whole runs of 1500 identical bytes; a metadata byte read as audio would break one.
    for (let i = 0; i < Math.min(audio.length, 4000); i += 1) {
      assert.equal(audio[i], first + Math.floor(i / 1500), `audio byte ${i} is out of place`);
    }
    assert.deepEqual(titles.slice(0, 2), [`Track ${first}`, `Track ${first + 1}`]);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => station.close(() => resolve()));
  }
});
