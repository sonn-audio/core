import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from './testHarness';
import { AudioProxyHandler } from '../src/adapters/http/streams/audioProxyHandler';

// Issue #435: googlevideo resets a long-lived range response mid-body. The windowed
// writer took the broken read for the client leaving and returned with the response
// still open, so ffmpeg sat on a silent connection until the track's duration ran out.
// A broken window is now asked for again from the exact byte already written.

const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
const CUT_AT = 1_000_000;

type Answer = (res: http.ServerResponse, start: number, end: number, request: http.IncomingMessage) => void;

interface Upstream {
  url: string;
  ranges: string[];
  close: () => Promise<void>;
}

function makePayload(): Buffer {
  const payload = Buffer.alloc(RANGE_CHUNK_BYTES + 777_777);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = (i * 7) % 253;
  }
  return payload;
}

function servePartial(res: http.ServerResponse, payload: Buffer, start: number, end: number): void {
  const last = Math.min(end, payload.length - 1);
  res.writeHead(206, {
    'Content-Type': 'audio/webm',
    'Content-Length': String(last - start + 1),
    'Content-Range': `bytes ${start}-${last}/${payload.length}`,
  });
  res.end(payload.subarray(start, last + 1));
}

/** Promise a window, send its first `bytes`, then drop the connection mid-body. */
function serveCutOff(res: http.ServerResponse, payload: Buffer, start: number, end: number, bytes: number): void {
  const last = Math.min(end, payload.length - 1);
  res.writeHead(206, {
    'Content-Type': 'audio/webm',
    'Content-Length': String(last - start + 1),
    'Content-Range': `bytes ${start}-${last}/${payload.length}`,
  });
  res.write(payload.subarray(start, start + bytes), () => {
    setTimeout(() => res.socket?.destroy(), 50);
  });
}

/** A googlevideo-alike that only serves bounded ranges; `answers[n]` scripts request n. */
async function startUpstream(payload: Buffer, answers: Answer[]): Promise<Upstream> {
  const ranges: string[] = [];
  const server = http.createServer((req, res) => {
    const range = (req.headers.range ?? '').trim();
    ranges.push(range || '(none)');
    const bounded = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!bounded) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('open-ended refused');
      return;
    }
    const start = Number(bounded[1]);
    const end = Number(bounded[2]);
    const answer = answers[ranges.length - 1];
    if (answer) {
      answer(res, start, end, req);
    } else {
      servePartial(res, payload, start, end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/videoplayback`,
    ranges,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function startProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const zoneManager = { inputs: { updateRadioMetadata: () => undefined } };
  const handler = new AudioProxyHandler(zoneManager as never);
  const server = http.createServer((req, res) => {
    void handler.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Read the whole proxied body the way ffmpeg asks for it; `complete` is false on a cut. */
function readThroughProxy(
  port: number,
  target: string,
): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const path = `/streams/proxy?u=${encodeURIComponent(target)}`;
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Range: 'bytes=0-' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', () => undefined);
      res.on('close', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), complete: res.complete }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const windowAfter = (start: number): string => `bytes=${start}-${start + RANGE_CHUNK_BYTES - 1}`;

test('audio proxy: a window cut off mid-body resumes from the exact byte written', async () => {
  const payload = makePayload();
  const upstream = await startUpstream(payload, [
    (res, start, end) => serveCutOff(res, payload, start, end, CUT_AT),
  ]);
  const proxy = await startProxy();
  try {
    const res = await readThroughProxy(proxy.port, upstream.url);
    assert.equal(res.status, 206);
    assert.ok(res.complete, 'response did not end cleanly');
    assert.ok(res.body.equals(payload), 'resumed body differs from the source');
    // The resumed window reaches past the end, so it is the last one asked for.
    assert.deepEqual(upstream.ranges, [windowAfter(0), windowAfter(CUT_AT)]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a resume answered with the whole file is not spliced in', async () => {
  const payload = makePayload();
  const upstream = await startUpstream(payload, [
    (res, start, end) => serveCutOff(res, payload, start, end, CUT_AT),
    (res) => {
      res.writeHead(200, { 'Content-Type': 'audio/webm', 'Content-Length': String(payload.length) });
      res.end(payload);
    },
  ]);
  const proxy = await startProxy();
  try {
    const res = await readThroughProxy(proxy.port, upstream.url);
    assert.ok(res.complete, 'response did not end cleanly');
    assert.ok(res.body.equals(payload), 'a 200 was spliced into the stream');
    assert.deepEqual(upstream.ranges.slice(0, 3), [windowAfter(0), windowAfter(CUT_AT), windowAfter(CUT_AT)]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: an upstream that keeps failing ends in a broken response, not silence', async () => {
  const payload = makePayload();
  const refuse: Answer = (res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('busy');
  };
  const upstream = await startUpstream(payload, [
    (res, start, end) => serveCutOff(res, payload, start, end, CUT_AT),
    refuse,
    refuse,
    refuse,
    refuse,
  ]);
  const proxy = await startProxy();
  try {
    const res = await readThroughProxy(proxy.port, upstream.url);
    // The client must see the cut, so its own reconnect can take over.
    assert.equal(res.complete, false);
    assert.equal(res.body.length, CUT_AT);
    assert.ok(res.body.equals(payload.subarray(0, CUT_AT)));
    assert.deepEqual(upstream.ranges, [windowAfter(0), windowAfter(CUT_AT), windowAfter(CUT_AT), windowAfter(CUT_AT)]);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a client that leaves mid-window just stops the stream', async () => {
  const payload = makePayload();
  let upstreamClosed!: () => void;
  const upstreamGone = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = await startUpstream(payload, [
    (res, start, end, req) => {
      // Half a window, then hold the connection open as a slow host would.
      res.writeHead(206, {
        'Content-Type': 'audio/webm',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      });
      res.write(payload.subarray(start, start + CUT_AT));
      req.socket.on('close', () => upstreamClosed());
    },
  ]);
  const proxy = await startProxy();
  try {
    await new Promise<void>((resolve, reject) => {
      const path = `/streams/proxy?u=${encodeURIComponent(upstream.url)}`;
      const req = http.request({ host: '127.0.0.1', port: proxy.port, path, headers: { Range: 'bytes=0-' } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      req.on('response', (res) => res.on('error', () => undefined));
      req.end();
      setTimeout(() => reject(new Error('no data from proxy')), 5000);
    });
    await upstreamGone;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(upstream.ranges, [windowAfter(0)], 'proxy kept fetching for a client that left');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
