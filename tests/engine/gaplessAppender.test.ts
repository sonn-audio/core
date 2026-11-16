import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from '../testHarness';
import { zoneSessionKey } from '../../src/ports/types/SessionKey';
import { AudioSession } from '../../src/engine/audioSession';
import type { AudioOutputSettings } from '../../src/engine/audioFormat';

// Between two tracks the engine stopped one session and started another, and every output was
// told to play a new stream — a pause in the middle of anything recorded as one piece. A next
// track can instead be joined onto the PCM bus behind the current one, at the sample.

const OUTPUT: AudioOutputSettings = {
  sampleRate: 44100,
  channels: 2,
  pcmBitDepth: 16,
  mp3Bitrate: '256k',
  prebufferBytes: 0,
  httpProfile: 'default',
  httpFallbackSeconds: 12 * 3600,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'test',
};

class FakeFfmpeg extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public exitCode: number | null = null;
  public signalCode: string | null = null;
  public killed = false;

  constructor(public readonly args: string[]) {
    super();
  }

  public kill(signal?: string): boolean {
    this.killed = true;
    if (this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal ?? 'SIGTERM';
      this.stdout.end();
      this.emit('exit', null, this.signalCode);
    }
    return true;
  }

  /** The process finishing by itself: its output closes and it exits. */
  public finish(code = 0): void {
    this.exitCode = code;
    this.stdout.end();
    this.emit('exit', code, null);
  }
}

const childProcess = require('node:child_process') as typeof import('node:child_process');

/** Runs `fn` with every ffmpeg spawn replaced by a fake whose pipes the test drives. */
async function withFakeFfmpeg(fn: (spawned: FakeFfmpeg[]) => Promise<void>): Promise<void> {
  const previous = childProcess.spawn;
  const spawned: FakeFfmpeg[] = [];
  childProcess.spawn = ((_command: string, args: string[]) => {
    const proc = new FakeFfmpeg(args);
    spawned.push(proc);
    return proc;
  }) as never;
  try {
    await fn(spawned);
  } finally {
    childProcess.spawn = previous;
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/** `frames` stereo 16-bit frames, every sample the same value, so a track is recognisable by it. */
function pcm(frames: number, value: number): Buffer {
  const buf = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames * 2; i += 1) buf.writeInt16LE(value, i * 2);
  return buf;
}

function startSession(gaplessCapable: boolean): AudioSession {
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'file', path: '/music/album/01.flac', realTime: false },
    'flac',
    () => {},
    OUTPUT,
    null,
    false,
    undefined,
    gaplessCapable,
  );
  session.start();
  return session;
}

/** Everything that reaches the encoder: the PCM bus, in order. */
function captureBus(encoder: FakeFfmpeg): { bytes: () => Buffer; ended: () => boolean } {
  const chunks: Buffer[] = [];
  let ended = false;
  encoder.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  encoder.stdin.on('end', () => {
    ended = true;
  });
  return { bytes: () => Buffer.concat(chunks), ended: () => ended };
}

test('gapless: the next track follows the last sample of the current one, on the same encoder', async () => {
  await withFakeFfmpeg(async (spawned) => {
    const session = startSession(true);
    const [first, encoder] = spawned as [FakeFfmpeg, FakeFfmpeg];
    assert.equal(spawned.length, 2, 'a decoder and an encoder: the decoder has to be replaceable');
    const bus = captureBus(encoder);

    first.stdout.write(pcm(1000, 111));
    const joined = session.armNext({ kind: 'file', path: '/music/album/02.flac', realTime: false });
    await settle();
    const second = spawned[2]!;
    assert.ok(second.args.includes('/music/album/02.flac'), 'the next track is opened ahead of time');
    // It is ready and waiting; nothing of it may be heard yet.
    second.stdout.write(pcm(500, 222));
    first.stdout.write(pcm(1000, 111));
    await settle();
    assert.equal(bus.bytes().length, 2000 * 4, 'only the current track so far');

    first.finish(0);
    const splice = await joined;
    await settle();
    assert.deepEqual(splice, { frames: 2000, sampleRate: 44100 });
    assert.equal(bus.ended(), false, 'the encoder never saw an end');
    assert.ok(bus.bytes().equals(Buffer.concat([pcm(2000, 111), pcm(500, 222)])), 'joined at the sample, nothing lost or added');
    assert.equal((session.source as { path: string }).path, '/music/album/02.flac', 'the session now plays the next track');
    assert.ok(session.args.buildInputArgs().includes('/music/album/02.flac'), 'and a respawn would reopen that one');

    // And a third behind the second, the same way.
    const joinedAgain = session.armNext({ kind: 'file', path: '/music/album/03.flac', realTime: false });
    await settle();
    const third = spawned[3]!;
    third.stdout.write(pcm(100, 333));
    second.finish(0);
    assert.deepEqual(await joinedAgain, { frames: 500, sampleRate: 44100 });
    await settle();
    assert.ok(bus.bytes().subarray(2500 * 4).equals(pcm(100, 333)));

    // The last track ends the encoder, after everything it produced has gone in.
    third.stdout.write(pcm(50, 333));
    third.finish(0);
    await settle();
    assert.equal(bus.bytes().length, (2500 + 150) * 4);
    assert.equal(bus.ended(), true);
    session.stop(true);
  });
});

test('gapless: a track that fails is not passed off as finished', async () => {
  await withFakeFfmpeg(async (spawned) => {
    const session = startSession(true);
    const [first, encoder] = spawned as [FakeFfmpeg, FakeFfmpeg];
    const bus = captureBus(encoder);
    first.stdout.write(pcm(100, 111));
    const joined = session.armNext({ kind: 'file', path: '/music/album/02.flac', realTime: false });
    await settle();
    const second = spawned[2]!;
    second.stdout.write(pcm(100, 222));

    first.finish(1);
    assert.equal(await joined, null);
    await settle();
    assert.equal(second.killed, true, 'the waiting decoder is let go');
    assert.ok(bus.bytes().equals(pcm(100, 111)), 'nothing of the next track was played');
    assert.equal(bus.ended(), true, 'and the session ends as a failed track does');
    session.stop(true);
  });
});

test('gapless: a next track that cannot be opened leaves the current one to end normally', async () => {
  await withFakeFfmpeg(async (spawned) => {
    const session = startSession(true);
    const [first, encoder] = spawned as [FakeFfmpeg, FakeFfmpeg];
    const bus = captureBus(encoder);
    const joined = session.armNext({ kind: 'url', url: 'http://gone.example/02.flac' });
    await settle();
    spawned[2]!.finish(1);
    assert.equal(await joined, null);
    first.stdout.write(pcm(300, 111));
    first.finish(0);
    await settle();
    assert.ok(bus.bytes().equals(pcm(300, 111)));
    assert.equal(bus.ended(), true);
    session.stop(true);
  });
});

test('gapless: stopping lets go of a track that was lined up', async () => {
  await withFakeFfmpeg(async (spawned) => {
    const session = startSession(true);
    const joined = session.armNext({ kind: 'file', path: '/music/album/02.flac', realTime: false });
    await settle();
    session.stop(true);
    assert.equal(await joined, null);
    assert.equal(spawned[2]!.killed, true);
  });
});

test('gapless: a session that runs as one process cannot take a next track, and says so', async () => {
  await withFakeFfmpeg(async (spawned) => {
    const session = startSession(false);
    assert.equal(spawned.length, 1, 'one ffmpeg, as before');
    assert.equal(await session.armNext({ kind: 'file', path: '/music/album/02.flac' }), null);
    assert.equal(spawned.length, 1, 'and nothing was started for it');
    session.stop(true);
  });
});
