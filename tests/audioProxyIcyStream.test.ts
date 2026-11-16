import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from './testHarness';
import { AudioProxyHandler } from '../src/adapters/http/streams/audioProxyHandler';

// The proxy windows an open-ended range into 4 MiB chunks because googlevideo refuses
// `bytes=0-`. A live radio stream must never take that path: its icy metadata blocks sit
// at fixed offsets into one continuous body, and the windowed writer forwards no
// `icy-metaint` for the client to skip them by — so ffmpeg decodes the metadata as audio
// and the listener hears a click every metaint bytes (issue #349, ORF Ö3 on Sonos).

const RANGE_CHUNK_BYTES = 4 * 1024 * 1024;

interface Upstream {
  url: string;
  ranges: string[];
  close: () => Promise<void>;
}

/**
 * A Shoutcast behind nginx: honours ranges and reports a length it made up. The real one
 * claims a gigabyte; this one claims two windows' worth, so that a build which does window
 * it finishes and fails an assertion instead of grinding through 256 windows.
 */
async function startIcyUpstream(metaInt: number, blocks: number): Promise<Upstream> {
  // One metaint of audio, then a zero-length metadata block, repeated.
  const block = Buffer.concat([Buffer.alloc(metaInt, 0x41), Buffer.from([0])]);
  const body = Buffer.concat(Array.from({ length: blocks }, () => block));
  const ranges: string[] = [];
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range ?? '(none)');
    const bounded = /^bytes=(\d+)-(\d+)$/.exec((req.headers.range ?? '').trim());
    const headers: Record<string, string> = {
      'Content-Type': 'audio/mpeg',
      'icy-metaint': String(metaInt),
    };
    if (bounded) {
      const start = Number(bounded[1]);
      const end = Math.min(Number(bounded[2]), body.length - 1);
      res.writeHead(206, {
        ...headers,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
      });
      res.end(body.subarray(start, end + 1));
      return;
    }
    // No length: a live stream runs until the listener leaves.
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/stream`,
    ranges,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A googlevideo-alike: 403 on an open-ended range, happy to serve a bounded one. */
async function startWindowOnlyUpstream(payload: Buffer): Promise<Upstream> {
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
    const end = Math.min(Number(bounded[2]), payload.length - 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
    });
    res.end(payload.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/video`,
    ranges,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * @param stopAfter Bytes after which the listener hangs up. A live stream has no end to wait
 *   for — the proxy reconnects to a station that closes — so a test of one has to leave.
 */
function fetchThroughProxy(
  port: number,
  target: string,
  headers: Record<string, string>,
  stopAfter?: number,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const path = `/streams/proxy?u=${encodeURIComponent(target)}`;
    const req = http.request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const finish = () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        if (stopAfter !== undefined && received >= stopAfter) {
          res.removeAllListeners('error');
          res.on('error', () => undefined);
          req.destroy();
          finish();
        }
      });
      res.on('end', finish);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('audio proxy: an icy radio stream is never served in stitched windows', async () => {
  const metaInt = 16000;
  // Just over two 4 MiB windows, whole metadata blocks throughout.
  const upstream = await startIcyUpstream(metaInt, 524);
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(
      proxy.port,
      upstream.url,
      { Range: 'bytes=0-', 'Icy-MetaData': '1' },
      524 * (metaInt + 1),
    );

    // The client must learn where the metadata blocks are, or it decodes them as audio.
    assert.equal(res.headers['icy-metaint'], String(metaInt));
    // The windowed writer advertises the host's fabricated gigabyte; the pass-through
    // path does not, because a live stream has no length.
    assert.equal(res.headers['content-length'], undefined);
    assert.equal(res.status, 200);

    // The window probe is allowed — that is how the icy-metaint is discovered — but the
    // body must come from a re-ask made exactly the way the client asked.
    assert.equal(upstream.ranges.length, 2);
    assert.equal(upstream.ranges[0], `bytes=0-${RANGE_CHUNK_BYTES - 1}`);
    assert.equal(upstream.ranges[1], 'bytes=0-');

    // Every metaint bytes the upstream writes a zero-length metadata block; those offsets
    // are what the client counts on, so they have to arrive unshifted.
    assert.equal(res.body.length % (metaInt + 1), 0);
    for (let offset = metaInt; offset < res.body.length; offset += metaInt + 1) {
      assert.equal(res.body[offset], 0, `metadata block misaligned at ${offset}`);
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test('audio proxy: a host that only serves bounded ranges is still stitched byte-exact', async () => {
  // Two and a bit windows, so the stitching is actually exercised.
  const payload = Buffer.alloc(RANGE_CHUNK_BYTES * 2 + 1234);
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = i % 251;
  }
  const upstream = await startWindowOnlyUpstream(payload);
  const proxy = await startProxy();
  try {
    const res = await fetchThroughProxy(proxy.port, upstream.url, { Range: 'bytes=0-' });
    assert.equal(res.status, 206);
    assert.equal(res.body.length, payload.length);
    assert.ok(res.body.equals(payload), 'stitched body differs from the source');
    assert.equal(upstream.ranges.length, 3);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

// Issue #348: a value in an icy metadata block ends at `';`, so a title may carry an
// apostrophe of its own. Capturing up to the first quote handed "Yazoo - Don't Go" to the
// zone as artist "Yazoo", title "Don" — the split runs after the parse, so only the tail
// went missing and the truncation looked like a display bug.
function parseIcy(text: string): { title: string; artist: string } | null {
  const handler = new AudioProxyHandler({} as any);
  return (handler as any).parseIcyMetadata(Buffer.from(text, 'utf8'));
}

test('audio proxy: an apostrophe in the stream title survives the icy parse', () => {
  assert.deepEqual(parseIcy("StreamTitle='Yazoo - Don't Go';StreamUrl='';"), {
    artist: 'Yazoo',
    title: "Don't Go",
  });
});

test('audio proxy: icy titles with several apostrophes stay whole', () => {
  assert.deepEqual(parseIcy("StreamTitle='Guns N' Roses - Sweet Child O' Mine';"), {
    artist: "Guns N' Roses",
    title: "Sweet Child O' Mine",
  });
});

test('audio proxy: an icy block that omits the trailing semicolon still parses', () => {
  assert.deepEqual(parseIcy("StreamTitle='Yazoo - Don't Go'"), {
    artist: 'Yazoo',
    title: "Don't Go",
  });
});

test('audio proxy: a semicolon inside the title is not a terminator', () => {
  assert.deepEqual(parseIcy("StreamTitle='Sepultura - Dead Embryonic Cells; Live';StreamUrl='';"), {
    artist: 'Sepultura',
    title: 'Dead Embryonic Cells; Live',
  });
});

test('audio proxy: double-quoted icy titles keep their apostrophes too', () => {
  assert.deepEqual(parseIcy('StreamTitle="Yazoo - Don\'t Go";'), {
    artist: 'Yazoo',
    title: "Don't Go",
  });
});

test('audio proxy: an empty icy title is still ignored', () => {
  assert.equal(parseIcy("StreamTitle='';StreamUrl='';"), null);
});
