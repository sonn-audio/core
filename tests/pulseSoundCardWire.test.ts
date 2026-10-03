import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { test } from './testHarness';
import { PulseSoundCard } from '../src/adapters/inputs/pulse/pulseSoundCard';
import {
  frame,
  frameSize,
  PA,
  PA_CHANNEL_COMMAND,
  TagReader,
  TagWriter,
  type SampleSpec,
} from '../src/adapters/inputs/pulse/pulseProtocol';

/**
 * The card driven over its own socket, by a client that speaks the wire rather than calls into it.
 *
 * These are the behaviours no unit test reaches: the promise made to a player and when it is
 * renewed, what a flush throws away, and when a drain is answered. Every one of them has already
 * been wrong in a way that only showed up as a room going quiet.
 */

const SPEC: SampleSpec = { format: 'f32le', channels: 2, rate: 44100 };
const BYTES_PER_SEC = SPEC.rate * frameSize(SPEC);

/** A player, in as much of the protocol as it takes to be one. */
class WirePlayer {
  private buffered = Buffer.alloc(0);
  private readonly waiters: Array<{ match: (cmd: number) => boolean; resolve: (v: unknown[]) => void }> = [];
  /** Bytes this player has been told it may send and has not sent yet. */
  public credit = 0;
  public sent = 0;
  public grants = 0;
  /** Fills every grant as it arrives, the way libpulse does with a file to play. */
  public autoSend = true;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => undefined);
  }

  public static async connect(socketPath: string): Promise<WirePlayer> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socketPath, () => resolve(s));
      s.once('error', reject);
    });
    return new WirePlayer(socket);
  }

  private onData(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    for (;;) {
      if (this.buffered.length < 20) return;
      const length = this.buffered.readUInt32BE(0);
      if (this.buffered.length < 20 + length) return;
      const payload = this.buffered.subarray(20, 20 + length);
      this.buffered = this.buffered.subarray(20 + length);

      const reader = new TagReader(payload);
      const values: unknown[] = [];
      while (!reader.done) values.push(reader.next());
      const command = values[0] as number;

      if (command === PA.REQUEST) {
        this.grants += 1;
        this.credit += values[3] as number;
        if (this.autoSend) this.flushCredit();
        continue;
      }
      const waiter = this.waiters.findIndex((w) => w.match(command));
      if (waiter >= 0) this.waiters.splice(waiter, 1)[0]!.resolve(values);
    }
  }

  /** Send every byte this player is allowed to, as a player with audio ready would. */
  public flushCredit(): void {
    while (this.credit >= 4096) {
      const size = Math.min(this.credit, 65472) - (Math.min(this.credit, 65472) % frameSize(SPEC));
      this.socket.write(frame(0, Buffer.alloc(size)));
      this.credit -= size;
      this.sent += size;
    }
  }

  private await(match: (cmd: number) => boolean): Promise<unknown[]> {
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }

  public send(payload: Buffer): void {
    this.socket.write(frame(PA_CHANNEL_COMMAND, payload));
  }

  /** Send a command and wait for its answer, whether that is a reply or a refusal. */
  public async ask(payload: Buffer): Promise<{ ok: boolean; values: unknown[] }> {
    const answer = this.await((cmd) => cmd === PA.REPLY || cmd === PA.ERROR);
    this.send(payload);
    const values = await answer;
    return { ok: values[0] === PA.REPLY, values: values.slice(2) };
  }

  public async handshake(): Promise<void> {
    await this.ask(new TagWriter().u32(PA.AUTH).u32(0).u32(15).build());
    await this.ask(new TagWriter().u32(PA.SET_CLIENT_NAME).u32(1).proplist({ 'application.name': 'wire' }).build());
  }

  public async createStream(spec: SampleSpec = SPEC): Promise<{ ok: boolean; values: unknown[] }> {
    const result = await this.ask(
      new TagWriter()
        .u32(PA.CREATE_PLAYBACK_STREAM)
        .u32(2)
        .sampleSpec(spec)
        .channelMap(spec.channels)
        .u32(0xffffffff)
        .str(null)
        .u32(0xffffffff)
        .bool(false)
        .u32(0xffffffff)
        .u32(0xffffffff)
        .u32(0xffffffff)
        .u32(0)
        .cvolume(spec.channels)
        .build(),
    );
    if (result.ok) {
      // The reply's third field is the first grant.
      this.credit += result.values[2] as number;
      if (this.autoSend) this.flushCredit();
    }
    return result;
  }

  /**
   * Open a stream claiming a format by its number on the wire.
   *
   * Built by hand because the writer maps a name it does not know onto float, which is exactly the
   * guess under test — going through it would send a perfectly ordinary float stream.
   */
  public async createStreamWithFormatCode(code: number): Promise<{ ok: boolean; values: unknown[] }> {
    const spec = Buffer.alloc(7);
    spec.write('a');
    spec.writeUInt8(code, 1);
    spec.writeUInt8(2, 2);
    spec.writeUInt32BE(44100, 3);
    return this.ask(
      Buffer.concat([
        new TagWriter().u32(PA.CREATE_PLAYBACK_STREAM).u32(2).build(),
        spec,
        new TagWriter()
          .channelMap(2)
          .u32(0xffffffff)
          .str(null)
          .u32(0xffffffff)
          .bool(false)
          .u32(0xffffffff)
          .u32(0xffffffff)
          .u32(0xffffffff)
          .u32(0)
          .cvolume(2)
          .build(),
      ]),
    );
  }

  public close(): void {
    this.socket.destroy();
  }
}

/** A card on a socket of its own, plus the temp directory it lives in. */
async function withCard(
  body: (card: PulseSoundCard, socketPath: string) => Promise<void>,
): Promise<void> {
  const originalCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-pulse-'));
  process.chdir(dir);
  const card = new PulseSoundCard('test');
  try {
    assert.ok(await card.ensure(1), 'the card should open its socket');
    const env = await card.childEnv(1);
    await body(card, env.PULSE_SERVER!.replace('unix:', ''));
  } finally {
    await card.stop();
    process.chdir(originalCwd);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read a stream as fast as it will give, counting what arrives. */
function drain(stream: Readable, counter: { bytes: number }): void {
  stream.on('data', (chunk: Buffer) => {
    counter.bytes += chunk.length;
  });
}

test('a player keeps being granted more for as long as the engine keeps reading', async () => {
  // The one that mattered. Credit used to be released only when Node asked the stream for more,
  // and Node asks once and then waits for something to be pushed — so a card that answered "not
  // yet, I am still holding a second" was never asked again, and no audio could arrive to break
  // the tie. Playback stopped dead at exactly one second, every time.
  await withCard(async (card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    await settle();

    const received = { bytes: 0 };
    drain(card.takeStream(1)!, received);

    // Five seconds of audio is five grant cycles past the first, which is four more than the
    // broken version ever managed.
    const wanted = BYTES_PER_SEC * 5;
    const deadline = Date.now() + 10_000;
    while (player.sent < wanted && Date.now() < deadline) {
      await settle(20);
    }
    player.close();

    assert.ok(player.grants > 3, `the card should keep asking for more, asked ${player.grants} times`);
    assert.ok(player.sent >= wanted, `player sent ${player.sent} of ${wanted} bytes`);
    // Float in, 24-bit out, so three quarters of what was sent is what comes back.
    assert.ok(
      received.bytes >= wanted * 0.7,
      `engine received ${received.bytes}, expected around ${wanted * 0.75}`,
    );
  });
});

test('a player is never granted more than the card is willing to hold', async () => {
  // The other half of the same promise: nothing reads this stream, so beyond the second the card
  // keeps for the start of a track the player must be made to wait.
  await withCard(async (_card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    await settle(300);
    player.close();

    assert.ok(
      player.sent <= BYTES_PER_SEC * 1.5,
      `an unread card took ${player.sent} bytes, over a second and a half of audio`,
    );
  });
});

test('a flush throws away the audio that had not sounded yet', async () => {
  // What a seek is made of. Keeping it means the jump is followed by the second from before it.
  await withCard(async (card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    await settle(150);

    const stream = card.takeStream(1)!;
    assert.ok(stream.readableLength > 0, 'there should be audio waiting before the flush');

    player.autoSend = false;
    await player.ask(new TagWriter().u32(PA.FLUSH_PLAYBACK_STREAM).u32(9).u32(0).build());
    assert.equal(stream.readableLength, 0, 'nothing from before the flush may survive it');
    player.close();
  });
});

test('a drain is answered once the audio has been read, not the moment it is asked', async () => {
  // Answering straight away tells a player its track has finished while a second of it is still
  // waiting to be heard.
  await withCard(async (card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    await settle(150);

    player.autoSend = false;
    let answered = false;
    const drained = player
      .ask(new TagWriter().u32(PA.DRAIN_PLAYBACK_STREAM).u32(11).u32(0).build())
      .then(() => {
        answered = true;
      });

    await settle(150);
    assert.equal(answered, false, 'a drain must wait while the card is still holding audio');

    const received = { bytes: 0 };
    drain(card.takeStream(1)!, received);
    await drained;
    assert.ok(received.bytes > 0, 'and it is the reading that releases it');
    player.close();
  });
});

test('setting the buffer attributes is answered with attributes', async () => {
  // A bare acknowledgement here is read as a broken reply, and libpulse drops the whole connection
  // over it rather than the one request — the same way a short sink info once did.
  await withCard(async (_card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();

    const { ok, values } = await player.ask(
      new TagWriter()
        .u32(PA.SET_STREAM_BUFFER_ATTR)
        .u32(21)
        .u32(0)
        .u32(1 << 20)
        .u32(1 << 16)
        .u32(0)
        .u32(1 << 14)
        .build(),
    );
    assert.ok(ok);
    // maxlength, tlength, prebuf, minreq, and the latency that goes with them.
    assert.equal(values.length, 5, `expected five fields, got ${JSON.stringify(values)}`);
    for (const value of values) assert.equal(typeof value, 'number');
    assert.ok((values[1] as number) > 0, 'a target length of nothing would never be filled');
    player.close();
  });
});

test('a format this card cannot carry is refused instead of quietly mangled', async () => {
  await withCard(async (card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    // 99 is not a sample format anybody has; it used to be read as float and played as noise.
    const { ok } = await player.createStreamWithFormatCode(99);
    assert.equal(ok, false, 'the stream should be refused');
    assert.equal(card.specFor(1), null, 'and nothing should be left claiming to know the format');
    player.close();
  });
});

test('deleting a stream forgets its format, so the next one is waited for', async () => {
  // Answering with the format of a stream that is over sets the engine up for audio that never
  // arrives in that shape.
  await withCard(async (card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    assert.equal(card.specFor(1)?.format, 's24le');

    await player.ask(new TagWriter().u32(PA.DELETE_PLAYBACK_STREAM).u32(31).u32(0).build());
    assert.equal(card.specFor(1), null);

    await player.createStream({ format: 's16le', channels: 2, rate: 48000 });
    assert.deepEqual(card.specFor(1), { format: 's16le', channels: 2, rate: 48000 });
    player.close();
  });
});

test('a card knows whether a player reached it since the last track, stream or not', async () => {
  // A player that never connects and one that connects without opening a stream both leave the
  // room silent, and only the card can tell them apart.
  await withCard(async (card, socketPath) => {
    assert.equal(card.heardFrom(1), false);

    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    assert.equal(card.heardFrom(1), true);
    assert.equal(card.specFor(1), null);

    card.forgetSpec(1);
    assert.equal(card.heardFrom(1), false);
    player.close();
  });
});

test('the latency reported is the audio actually held, counted in the player\'s own bytes', async () => {
  // It used to divide a buffer measured in what is handed on by a rate measured in what arrives,
  // so a full second of float came back as 750 ms. The player believed its audio was a quarter of
  // a second closer to the speakers than it was.
  await withCard(async (_card, socketPath) => {
    const player = await WirePlayer.connect(socketPath);
    await player.handshake();
    await player.createStream();
    await settle(200);

    const { ok, values } = await player.ask(
      new TagWriter().u32(PA.GET_PLAYBACK_LATENCY).u32(41).u32(0).timeval().build(),
    );
    assert.ok(ok);
    const latency = values[0] as number;
    const written = values[5] as number;
    const read = values[6] as number;

    // A card holding its whole second says so.
    assert.ok(
      Math.abs(latency - 1_000_000) < 60_000,
      `held a second of audio but reported ${latency} usec`,
    );
    // And the two indexes are in the same units, so their gap is that same second.
    assert.ok(
      Math.abs((written - read) / BYTES_PER_SEC - 1) < 0.06,
      `write index ${written} and read index ${read} disagree about how much is held`,
    );
    player.close();
  });
});
