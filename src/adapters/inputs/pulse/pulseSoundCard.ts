import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';
import {
  frame,
  FrameSplitter,
  frameSize,
  PA,
  PA_CHANNEL_COMMAND,
  PA_PROTOCOL_VERSION,
  sampleWidth,
  TagReader,
  TagWriter,
  type SampleSpec,
} from '@/adapters/inputs/pulse/pulseProtocol';

/**
 * A sound card, in this process.
 *
 * Plenty of programs can only play to a sound card — Spotify's Soloist is the first here, but any
 * Linux audio application is the same story — and the usual answer is to run a sound server and
 * arrange for a sink that writes somewhere we can read. That costs a 207 MB dependency, a daemon
 * that refuses to start whenever another one holds its D-Bus name, and a pipe that keeps a quarter
 * second of the previous track between one song and the next.
 *
 * This is the same idea without the middleman. Such programs reach PulseAudio through `libpulse`,
 * which connects to whatever `PULSE_SERVER` names, and what it finds there is this: the decoded
 * audio arrives in this process directly, in whatever format the program chose. Because a client
 * may only send what it has been granted, the reader is the clock — no timer, no resampling, and
 * nothing between the decoder and the engine.
 *
 * One socket per caller, so two players cannot be confused with one another.
 */
export class PulseSoundCard {
  private readonly log = createLogger('Audio', 'PulseCard');
  private readonly cards = new Map<number, CardSocket>();
  private clientConfigWritten: Promise<string> | null = null;

  /**
   * @param owner what these cards are for, and part of every socket name.
   *
   * Ids are the caller's own — zone numbers here — and a second kind of player would bring its own
   * numbering. Naming the owner is what keeps two of them from asking for the same socket, and it
   * says at a glance whose a card is when you are looking at the directory.
   */
  constructor(private readonly owner: string) {}

  /**
   * Where the sockets live.
   *
   * Short paths matter: a unix socket address is capped near 100 bytes, which is why this is a
   * directory of its own near the data root rather than something nested per owner.
   */
  private get runtimeDir(): string {
    return resolveDataDir('pulse');
  }

  private socketPathFor(id: number): string {
    return path.join(this.runtimeDir, `card-${this.owner}-${id}.sock`);
  }

  /**
   * A client config that turns shared memory off.
   *
   * libpulse would otherwise hand audio over in shared memory segments, which is faster than a
   * socket and far more protocol than this needs. Refused in the handshake it falls back to the
   * socket, but saying so here as well keeps the client from preparing for it at all.
   */
  private async clientConfigPath(): Promise<string> {
    this.clientConfigWritten ??= (async () => {
      const file = path.join(this.runtimeDir, 'client.conf');
      await fsp.mkdir(this.runtimeDir, { recursive: true });
      await fsp.writeFile(file, 'enable-shm = no\nautospawn = no\n', 'utf8');
      return file;
    })();
    return this.clientConfigWritten;
  }

  /** Start listening for this caller's player. Idempotent. */
  public async ensure(id: number): Promise<boolean> {
    if (this.cards.has(id)) {
      return true;
    }
    const socketPath = this.socketPathFor(id);
    try {
      await fsp.mkdir(this.runtimeDir, { recursive: true });
      // A socket file left by a previous run is dead but still occupies the name.
      await fsp.rm(socketPath, { force: true });
      const card = new CardSocket(id, socketPath, this.log);
      await card.listen();
      this.cards.set(id, card);
      return true;
    } catch (error) {
      this.log.warn('could not open an audio socket', {
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** What a player needs in its environment to find this card and nothing else. */
  public async childEnv(id: number): Promise<Record<string, string>> {
    return {
      PULSE_SERVER: `unix:${this.socketPathFor(id)}`,
      PULSE_CLIENTCONFIG: await this.clientConfigPath(),
      /*
       * And nothing else means PipeWire too.
       *
       * A player that speaks both protocols asks PipeWire first and only falls back to
       * PulseAudio when there is no answer — Soloist dlopens `libpipewire-0.3.so.0` before it
       * ever looks at `libpulse.so.0`. `PULSE_SERVER` is then never read: on a host with a
       * PipeWire session the decoded audio goes to the machine's own speakers and this card
       * waits for a client that never arrives, which reaches the zone as a track that is
       * "playing" with no stream to start.
       *
       * PipeWire looks for its socket in this directory, and the only socket here is ours. That
       * is a narrower lie than moving XDG_RUNTIME_DIR, which everything else in the child reads
       * as well.
       */
      PIPEWIRE_RUNTIME_DIR: this.runtimeDir,
    };
  }

  /**
   * Take the audio this card is receiving, as a stream.
   *
   * Handing out a fresh stream per track mirrors what a track change means to the engine: the old
   * one ends, and nothing of the previous track can arrive on the new one.
   */
  public takeStream(id: number): Readable | null {
    return this.cards.get(id)?.takeStream() ?? null;
  }

  /**
   * What comes out of this card, once the player has said what it plays.
   *
   * Not always what the player sends: a decoder hands over float, and float cannot reach a 24-bit
   * output without something converting it. That something used to be PulseAudio's own sink, and
   * it is this card now — see `deliveredSpecOf`.
   */
  public specFor(id: number): SampleSpec | null {
    const spec = this.cards.get(id)?.spec;
    return spec ? deliveredSpecOf(spec) : null;
  }

  /**
   * Wait until the player has opened its stream and said what it is playing.
   *
   * Only the first track of a session ever waits: the client opens one stream and keeps it, so
   * afterwards the answer is already there. Without it, the first play of a fresh server asked for
   * a format nobody had stated yet and the caller refused to start.
   */
  public async waitForSpec(id: number, timeoutMs = 5_000): Promise<SampleSpec | null> {
    return this.cards.get(id)?.waitForSpec(timeoutMs) ?? null;
  }

  /** Throw away audio that arrived for a track this server has already finished with. */
  public discardPending(id: number): void {
    this.cards.get(id)?.discardPending();
  }

  /**
   * Forget what the last player played in, before starting the next one.
   *
   * `waitForSpec` answers at once when a format is already known, which is right for a player that
   * keeps one stream open and wrong for one that is replaced every track: the answer would be the
   * previous player's, given before the new one had connected.
   */
  public forgetSpec(id: number): void {
    this.cards.get(id)?.forgetSpec();
  }

  /**
   * Whether any player has spoken to this card since its format was last forgotten.
   *
   * The difference between the two ways a track can arrive without audio. A player that connected
   * and never opened a stream is something to look for here; one that never connected at all is
   * playing somewhere else — Soloist falls back to a driver that discards everything when it
   * cannot load libpulse, and still says it is playing.
   */
  public heardFrom(id: number): boolean {
    return this.cards.get(id)?.heardFrom ?? false;
  }

  public async remove(id: number): Promise<void> {
    const card = this.cards.get(id);
    if (!card) {
      return;
    }
    this.cards.delete(id);
    await card.close();
  }

  public async stop(): Promise<void> {
    const cards = [...this.cards.values()];
    this.cards.clear();
    await Promise.all(cards.map((card) => card.close()));
  }
}

/**
 * What each format a player may ask for is handed on as.
 *
 * The engine carries four shapes, all little-endian, and a card that accepts anything else has to
 * be the one that meets it — that is what a sound card is for. Float is the case that matters:
 * it is how a decoder thinks and nothing downstream takes it, and the old PulseAudio sink was
 * pinned to 24-bit for exactly this reason. The rest are here so that "any Linux audio
 * application" is true rather than nearly true; big-endian and 8-bit players are rare, but a rare
 * player that is handed its own bytes back mislabelled sounds like noise, not like a bug.
 */
const DELIVERED_FORMATS: Record<string, string> = {
  u8: 's16le',
  alaw: 's16le',
  ulaw: 's16le',
  s16le: 's16le',
  s16be: 's16le',
  s24le: 's24le',
  s24be: 's24le',
  s24_32le: 's24le',
  s24_32be: 's24le',
  s32le: 's32le',
  s32be: 's32le',
  f32le: 's24le',
  f32be: 's24le',
};

/** What a card hands on, given what the player sends it. */
export function deliveredSpecOf(spec: SampleSpec): SampleSpec {
  return { ...spec, format: DELIVERED_FORMATS[spec.format] ?? 's24le' };
}

/** Whether this card can carry what a player is asking to send. */
export function canCarry(spec: SampleSpec): boolean {
  return (
    DELIVERED_FORMATS[spec.format] !== undefined &&
    spec.channels >= 1 &&
    spec.channels <= 32 &&
    spec.rate >= 4_000 &&
    spec.rate <= 384_000
  );
}

/**
 * Float samples into 24-bit words.
 *
 * Rounded rather than truncated, and clamped: Spotify's own normalisation can push a peak past
 * full scale, and wrapping that would be a click where clipping is merely loud. A sample that is
 * not a number at all becomes silence rather than throwing halfway through a buffer.
 */
export function floatToS24(chunk: Buffer, littleEndian = true): Buffer {
  const samples = Math.floor(chunk.length / 4);
  const out = Buffer.allocUnsafe(samples * 3);
  for (let i = 0; i < samples; i += 1) {
    const raw = littleEndian ? chunk.readFloatLE(i * 4) : chunk.readFloatBE(i * 4);
    const value = Number.isNaN(raw) ? 0 : Math.max(-1, Math.min(1, raw));
    const scaled = Math.round(value * 8388607);
    out.writeUIntLE(scaled < 0 ? scaled + 0x1000000 : scaled, i * 3, 3);
  }
  return out;
}

/** Unsigned 8-bit is centred on 128; everything else here is centred on zero. */
function u8ToS16(chunk: Buffer): Buffer {
  const out = Buffer.allocUnsafe(chunk.length * 2);
  for (let i = 0; i < chunk.length; i += 1) {
    out.writeInt16LE((chunk[i]! - 128) << 8, i * 2);
  }
  return out;
}

/** Reverse each sample's bytes. The incoming buffer belongs to the socket, so this copies. */
function swapBytes(chunk: Buffer, width: 2 | 4): Buffer {
  const out = Buffer.from(chunk);
  if (width === 2) {
    out.swap16();
  } else {
    out.swap32();
  }
  return out;
}

/** Three bytes at a time, which `Buffer.swap*` does not do. */
function swap24(chunk: Buffer): Buffer {
  const out = Buffer.allocUnsafe(chunk.length);
  for (let i = 0; i + 2 < chunk.length; i += 3) {
    out[i] = chunk[i + 2]!;
    out[i + 1] = chunk[i + 1]!;
    out[i + 2] = chunk[i]!;
  }
  return out;
}

/**
 * 24 bits carried in a 32-bit word, down to a plain 24-bit word.
 *
 * Taking the whole word as 32-bit instead would be 48 dB quiet, which is the kind of mistake that
 * is heard long before it is found.
 */
function s24In32ToS24(chunk: Buffer, littleEndian: boolean): Buffer {
  const samples = Math.floor(chunk.length / 4);
  const out = Buffer.allocUnsafe(samples * 3);
  for (let i = 0; i < samples; i += 1) {
    const at = i * 4;
    const to = i * 3;
    if (littleEndian) {
      out[to] = chunk[at]!;
      out[to + 1] = chunk[at + 1]!;
      out[to + 2] = chunk[at + 2]!;
    } else {
      out[to] = chunk[at + 3]!;
      out[to + 1] = chunk[at + 2]!;
      out[to + 2] = chunk[at + 1]!;
    }
  }
  return out;
}

/**
 * The G.711 companding tables, expanded once.
 *
 * Both are one byte standing for a sample on a logarithmic scale, so a lookup is the whole
 * conversion. Neither belongs to music, but a player is free to ask for them, and one that does
 * would otherwise have its telephone bytes read as something else entirely.
 */
const ALAW_TO_S16 = buildTable((byte) => {
  const value = byte ^ 0x55;
  const mantissa = (value & 0x0f) << 4;
  const exponent = (value & 0x70) >> 4;
  const magnitude = exponent === 0 ? mantissa + 8 : (mantissa + 0x108) << (exponent - 1);
  return value & 0x80 ? magnitude : -magnitude;
});

const ULAW_TO_S16 = buildTable((byte) => {
  const value = ~byte & 0xff;
  const magnitude = (((value & 0x0f) << 3) + 0x84) << ((value & 0x70) >> 4);
  return value & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
});

function buildTable(decode: (byte: number) => number): Int16Array {
  const table = new Int16Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    table[byte] = decode(byte);
  }
  return table;
}

function companded(table: Int16Array): (chunk: Buffer) => Buffer {
  return (chunk) => {
    const out = Buffer.allocUnsafe(chunk.length * 2);
    for (let i = 0; i < chunk.length; i += 1) {
      out.writeInt16LE(table[chunk[i]!]!, i * 2);
    }
    return out;
  };
}

/** How a format's bytes become what this card delivers. Absent means they already fit. */
export function converterFor(format: string): ((chunk: Buffer) => Buffer) | undefined {
  return CONVERTERS[format];
}

/** How each format is turned into what it is delivered as. Absent means the bytes already fit. */
const CONVERTERS: Record<string, (chunk: Buffer) => Buffer> = {
  u8: u8ToS16,
  alaw: companded(ALAW_TO_S16),
  ulaw: companded(ULAW_TO_S16),
  s16be: (chunk) => swapBytes(chunk, 2),
  s24be: swap24,
  s24_32le: (chunk) => s24In32ToS24(chunk, true),
  s24_32be: (chunk) => s24In32ToS24(chunk, false),
  s32be: (chunk) => swapBytes(chunk, 4),
  f32le: (chunk) => floatToS24(chunk, true),
  f32be: (chunk) => floatToS24(chunk, false),
};

/** How much audio a client may run ahead of us. One second is what a sound card would offer. */
const TARGET_BUFFER_SEC = 1;
/** Never ask for less than this at a time; a stream of tiny grants is all overhead. */
const MIN_REQUEST_SEC = 0.125;

/** One card: its socket, the player on it, and the stream its audio is going to. */
class CardSocket {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private stream: CardStream | null = null;
  /** Bytes promised to the client and not yet arrived. */
  private granted = 0;
  /** The clock, in bytes: what may still be sent, filling at the rate the music plays. */
  private tokens = 0;
  private tokensAt = 0;
  /** Set when the clock, not the buffer, is what says no — nothing else would come back to look. */
  private tokenTimer: NodeJS.Timeout | null = null;
  private streamIndex = 0;
  private corked = true;
  private written = 0;
  /**
   * Audio that arrived before anyone took a stream.
   *
   * A player starts sounding a moment before this server has asked for the stream, and those first
   * frames are the start of the track. Holding them is what keeps a song from starting clipped.
   *
   * Each entry remembers what it cost the player to send as well as what it became, because the
   * two differ the moment anything is converted, and every promise made to a client is in the
   * client's own units.
   */
  private pending: Array<{ data: Buffer; sent: number }> = [];
  private pendingBytes = 0;
  /** Bytes of a sample that a write ended in the middle of; converting them alone would be wrong. */
  private carry = EMPTY;
  private bufferAttr = { maxlength: 4 << 20, tlength: 0, prebuf: 0, minreq: 0 };
  /** Drains waiting for the audio still here to have been read. */
  private draining: Array<{ tag: number; timer: NodeJS.Timeout; reply: (tag: number) => void }> = [];
  /**
   * The level the player asked for, remembered but not applied.
   *
   * A zone's volume belongs to the zone, and every output already applies it. Scaling the samples
   * here as well would put a second taper on the same signal — two volumes, neither of them the
   * one anybody set. Answering with what was asked keeps a client from seeing its setting vanish.
   */
  private volume: number[] = [];
  private muted = false;
  private specWaiters: Array<(spec: SampleSpec | null) => void> = [];
  public spec: SampleSpec | null = null;
  /** Whether a player has introduced itself since `forgetSpec`; see `PulseSoundCard.heardFrom`. */
  public heardFrom = false;

  constructor(
    private readonly id: number,
    private readonly socketPath: string,
    private readonly log: ReturnType<typeof createLogger>,
  ) {}

  public listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onClient(socket));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        this.server = server;
        this.log.debug('sound card listening', { id: this.id, socket: this.socketPath });
        resolve();
      });
    });
  }

  public waitForSpec(timeoutMs: number): Promise<SampleSpec | null> {
    if (this.spec) {
      return Promise.resolve(this.spec);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.specWaiters = this.specWaiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (spec: SampleSpec | null): void => {
        clearTimeout(timer);
        resolve(spec);
      };
      this.specWaiters.push(waiter);
    });
  }

  public discardPending(): void {
    this.pending = [];
    this.pendingBytes = 0;
  }

  public forgetSpec(): void {
    this.spec = null;
    this.heardFrom = false;
  }

  public takeStream(): Readable {
    this.stream?.destroy();
    // A Readable of our own rather than a PassThrough, because being read is the signal that
    // matters: it happens whenever the consumer wants more, including the moment it comes back
    // after the engine has restarted a session. Hanging the credit on writes and drains instead
    // left the player waiting through exactly that gap — the room fell silent until something
    // happened to set it going again.
    const stream = new CardStream(() => this.onReaderWanted());
    this.stream = stream;
    // A new track starts with a full bucket, so the first second may be sent at once and the room
    // has something to begin on.
    this.tokens = this.spec ? this.spec.rate * frameSize(this.spec) * TARGET_BUFFER_SEC : 0;
    this.tokensAt = Date.now();
    for (const entry of this.pending) {
      stream.feed(entry.data);
    }
    this.discardPending();
    return stream;
  }

  /**
   * Everything this card is still holding, counted in the bytes the player sent.
   *
   * One place, because there were two and they disagreed: the buffer is measured in what it will
   * be handed on as, and a second of that is a different number of bytes from a second of what
   * arrived. Reporting one against the other told the player its audio was closer to the speakers
   * than it was.
   */
  private heldAsSent(): number {
    const spec = this.spec;
    const buffered = this.stream && !this.stream.destroyed ? this.stream.readableLength : 0;
    if (!spec) {
      return this.pendingBytes + buffered;
    }
    const asSent = frameSize(spec) / frameSize(deliveredSpecOf(spec));
    return buffered * asSent + this.pendingBytes;
  }

  /** The consumer wants more: the buffer just got smaller, so look again at both promises. */
  private onReaderWanted(): void {
    this.settleDrainIfEmpty();
    this.grant();
  }

  /**
   * A drain is answered once what we hold has actually been read, not on arrival.
   *
   * Answering straight away tells a player its track finished while a second of it is still
   * waiting to sound. The timer is only a floor under a reader that stops altogether: it is the
   * time this audio would take to play, plus room to spare, so it can never answer early.
   */
  private awaitDrain(tag: number, reply: (tag: number) => void): void {
    const held = this.heldAsSent();
    if (held <= 0) {
      reply(tag);
      return;
    }
    const spec = this.spec;
    const bytesPerSec = spec ? spec.rate * frameSize(spec) : 0;
    const wait = bytesPerSec > 0 ? (held / bytesPerSec) * 1000 + 2_000 : 5_000;
    this.draining.push({ tag, reply, timer: setTimeout(() => this.settleDrain(), wait) });
  }

  private settleDrainIfEmpty(): void {
    if (this.draining.length > 0 && this.heldAsSent() <= 0) {
      this.settleDrain();
    }
  }

  private settleDrain(): void {
    for (const waiter of this.draining.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reply(waiter.tag);
    }
  }

  public async close(): Promise<void> {
    this.settleDrain();
    this.stream?.destroy();
    this.stream = null;
    this.socket?.destroy();
    this.socket = null;
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
    await fsp.rm(this.socketPath, { force: true }).catch(() => undefined);
  }

  private onClient(socket: net.Socket): void {
    // One player per card, so a second connection means the first is gone, and nothing it was
    // part-way through saying belongs to the one arriving now.
    this.socket?.destroy();
    this.socket = socket;
    this.granted = 0;
    this.corked = true;
    this.carry = EMPTY;
    this.settleDrain();
    let version = PA_PROTOCOL_VERSION;
    const frames = new FrameSplitter();

    const send = (payload: Buffer): void => {
      socket.write(frame(PA_CHANNEL_COMMAND, payload));
    };
    const reply = (tag: number, body: TagWriter = new TagWriter()): void => {
      send(Buffer.concat([new TagWriter().u32(PA.REPLY).u32(tag).build(), body.build()]));
    };

    socket.on('error', (error) => {
      this.log.debug('audio client disconnected', { id: this.id, message: error.message });
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        // What this player was playing in is not what the next one will be playing in, and it is
        // not always given the chance to say so: a player that is killed mid-track never deletes
        // its stream. Leaving the format behind would have the next track answered with it before
        // its player has even connected — for a card that gets a new player on every track, that
        // is the difference between waiting for the real answer and guessing the last one.
        this.spec = null;
      }
    });

    socket.on('data', (chunk: Buffer) => {
      frames.push(chunk);
      for (;;) {
        let next: { channel: number; payload: Buffer } | null;
        try {
          next = frames.next();
        } catch (error) {
          // Not a frame boundary any more, so nothing after it can be trusted either.
          this.log.warn('audio connection lost the thread', {
            id: this.id,
            message: error instanceof Error ? error.message : String(error),
          });
          socket.destroy();
          return;
        }
        if (!next) {
          return;
        }
        if (next.channel !== PA_CHANNEL_COMMAND) {
          this.onAudio(next.payload);
          continue;
        }
        try {
          const reader = new TagReader(next.payload);
          const command = reader.next() as number;
          const tag = reader.next() as number;
          version = this.onCommand(command, tag, reader, version, reply, send);
        } catch (error) {
          this.log.warn('could not read an audio command', {
            id: this.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
  }

  /** Audio. The whole point: decoded Spotify, straight into this process. */
  private onAudio(chunk: Buffer): void {
    this.granted = Math.max(0, this.granted - chunk.length);
    this.written += chunk.length;
    const stream = this.stream;
    if (!stream || stream.destroyed) {
      // Nobody has taken this track's stream yet. A sound card would keep accepting audio — and so
      // do we, holding the last moment of it, because that moment is the start of the song. Older
      // than that is the previous track and is dropped.
      this.pending.push({ data: this.convert(chunk), sent: chunk.length });
      this.pendingBytes += chunk.length;
      while (this.pendingBytes > this.maxPending() && this.pending.length > 1) {
        this.pendingBytes -= this.pending.shift()?.sent ?? 0;
      }
      this.grant();
      return;
    }
    stream.feed(this.convert(chunk));
    this.grant();
  }

  /**
   * Whatever arrives, in the shape this card hands on.
   *
   * A write is not promised to stop on a sample boundary, and converting half a sample turns the
   * rest of the buffer into noise, so the odd bytes wait here for the write that completes them.
   */
  private convert(chunk: Buffer): Buffer {
    const spec = this.spec;
    const convert = spec ? converterFor(spec.format) : undefined;
    if (!spec || !convert) {
      return chunk;
    }
    const input = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = input.length - (input.length % sampleWidth(spec.format));
    this.carry = whole === input.length ? EMPTY : Buffer.from(input.subarray(whole));
    return whole === 0 ? EMPTY : convert(input.subarray(0, whole));
  }

  /** At most a second of audio may wait for a reader; beyond that it is not a start any more. */
  private maxPending(): number {
    const spec = this.spec;
    return spec ? spec.rate * frameSize(spec) : 512 * 1024;
  }

  /** Tell the player how much more it may send, counted from what we are still holding. */
  private grant(): void {
    const socket = this.socket;
    const spec = this.spec;
    if (!socket || !spec || this.corked) {
      return;
    }
    const bytesPerSec = spec.rate * frameSize(spec);
    const target = Math.round(bytesPerSec * TARGET_BUFFER_SEC);
    const held = this.heldAsSent();
    /*
     * Two bounds, and the smaller wins.
     *
     * How much we are holding keeps the buffer shallow. Time keeps the player at the speed of the
     * music — and that one is not optional. A sound card is a clock, which is what the sink this
     * replaced was; without it the reader downstream takes everything on offer, the player runs
     * ahead into buffers it cannot see, and it reaches the end of a track while the room is still
     * a quarter of a minute behind. Then it moves on, and the room is dragged with it: a track of
     * 1:03 ended after 52 seconds.
     *
     * A bucket rather than a running total, so time that passes with nobody reading — a session
     * restarting, a zone paused — cannot be saved up and spent in a burst. It fills at the rate
     * the music plays and holds at most one buffer's worth.
     */
    const now = Date.now();
    this.tokens = Math.min(
      target,
      this.tokens + ((now - (this.tokensAt || now)) / 1000) * bytesPerSec,
    );
    this.tokensAt = now;
    const minimum = Math.round(bytesPerSec * MIN_REQUEST_SEC);
    const byBuffer = target - held - this.granted;
    const want = Math.min(byBuffer, Math.floor(this.tokens));
    if (want < minimum) {
      // Room in the buffer but not yet on the clock: nothing else will come back to look, since
      // audio only arrives once it is asked for. So a timer does, once there is enough to ask for.
      if (byBuffer >= minimum) {
        this.wakeWhenAllowed(minimum - this.tokens, bytesPerSec);
      }
      return;
    }
    const ask = want - (want % frameSize(spec));
    this.granted += ask;
    this.tokens -= ask;
    socket.write(
      frame(PA_CHANNEL_COMMAND, new TagWriter().u32(PA.REQUEST).u32(0xffffffff).u32(this.streamIndex).u32(ask).build()),
    );
  }

  /** Come back when the clock has caught up with what the buffer already has room for. */
  private wakeWhenAllowed(missing: number, bytesPerSec: number): void {
    if (this.tokenTimer) {
      return;
    }
    const ms = Math.max(10, Math.ceil((missing / bytesPerSec) * 1000));
    this.tokenTimer = setTimeout(() => {
      this.tokenTimer = null;
      this.grant();
    }, ms);
    this.tokenTimer.unref?.();
  }

  private onCommand(
    command: number,
    tag: number,
    reader: TagReader,
    version: number,
    reply: (tag: number, body?: TagWriter) => void,
    send: (payload: Buffer) => void,
  ): number {
    switch (command) {
      case PA.AUTH: {
        const remote = reader.next() as number;
        const negotiated = Math.min(PA_PROTOCOL_VERSION, remote & 0xffff);
        this.heardFrom = true;
        this.log.debug('audio client connected', { id: this.id, clientVersion: remote & 0xffff });
        // No flags in the answer: no shared memory, no memfd, so the audio comes over the socket.
        reply(tag, new TagWriter().u32(negotiated));
        return negotiated;
      }
      case PA.SET_CLIENT_NAME: {
        reply(tag, version >= 13 ? new TagWriter().u32(1) : new TagWriter());
        return version;
      }
      case PA.GET_SERVER_INFO: {
        const spec = this.spec ?? DEFAULT_SPEC;
        const body = new TagWriter()
          .str('sonn')
          .str('15.0')
          .str('sonn')
          .str('sonn')
          .sampleSpec(spec)
          .str(SINK_NAME)
          .str(`${SINK_NAME}.monitor`)
          .u32(0);
        if (version >= 15) {
          body.channelMap(spec.channels);
        }
        reply(tag, body);
        return version;
      }
      case PA.GET_SINK_INFO:
      case PA.GET_SINK_INFO_LIST: {
        reply(tag, this.sinkInfo(version));
        return version;
      }
      case PA.LOOKUP_SINK: {
        reply(tag, new TagWriter().u32(0));
        return version;
      }
      case PA.GET_SOURCE_INFO_LIST: {
        reply(tag);
        return version;
      }
      case PA.CREATE_PLAYBACK_STREAM: {
        const spec = reader.next() as SampleSpec;
        reader.next(); // channel map
        reader.next(); // sink index
        reader.next(); // sink name
        const maxlength = reader.next() as number;
        const corked = reader.next() as boolean;
        reader.next(); // tlength, ours to decide
        const prebuf = reader.next() as number;
        reader.next(); // minreq, ours to decide

        if (!canCarry(spec)) {
          // Saying no is the kind thing. libpulse tells the player its format was refused and it
          // can ask for another; accepting would mean handing the engine bytes described as
          // something they are not, which is heard as noise and looked for everywhere but here.
          this.log.warn('a player asked to send audio this card cannot carry', {
            id: this.id,
            format: spec.format,
            rate: spec.rate,
            channels: spec.channels,
          });
          send(new TagWriter().u32(PA.ERROR).u32(tag).u32(3).build());
          return version;
        }

        this.spec = spec;
        for (const waiter of this.specWaiters.splice(0)) {
          waiter(spec);
        }
        this.corked = corked;
        this.granted = 0;
        this.written = 0;
        this.carry = EMPTY;
        this.settleDrain();
        const bytesPerSec = spec.rate * frameSize(spec);
        const tlength = Math.round(bytesPerSec * TARGET_BUFFER_SEC);
        const minreq = Math.round(bytesPerSec * MIN_REQUEST_SEC);
        this.bufferAttr = {
          maxlength: maxlength === 0xffffffff ? 4 << 20 : maxlength,
          tlength,
          prebuf: prebuf === 0xffffffff ? 0 : prebuf,
          minreq,
        };
        this.log.info('player opened a stream', {
          id: this.id,
          format: spec.format,
          rate: spec.rate,
          channels: spec.channels,
          corked,
        });

        // The reply's third field is the first grant; a corked stream gets nothing until it starts.
        const initial = corked ? 0 : tlength;
        this.granted = initial;
        const body = new TagWriter().u32(this.streamIndex).u32(this.streamIndex).u32(initial);
        if (version >= 9) {
          body
            .u32(this.bufferAttr.maxlength)
            .u32(this.bufferAttr.tlength)
            .u32(this.bufferAttr.prebuf)
            .u32(this.bufferAttr.minreq);
        }
        if (version >= 12) {
          body.sampleSpec(spec).channelMap(spec.channels).u32(0).str(SINK_NAME).bool(false);
        }
        if (version >= 13) {
          body.usec(Math.round(TARGET_BUFFER_SEC * 1e6));
        }
        reply(tag, body);
        return version;
      }
      case PA.CORK_PLAYBACK_STREAM: {
        reader.next(); // stream index; there is only one
        const corked = reader.next() as boolean;
        this.corked = corked;
        reply(tag);
        if (!corked) {
          send(new TagWriter().u32(PA.STARTED).u32(0xffffffff).u32(this.streamIndex).build());
          this.grant();
        }
        return version;
      }
      case PA.GET_PLAYBACK_LATENCY: {
        const spec = this.spec ?? DEFAULT_SPEC;
        const bytesPerSec = spec.rate * frameSize(spec);
        const held = this.heldAsSent();
        // What we are still holding is exactly how far behind the sound is; saying so is what keeps
        // the player's own position honest.
        const body = new TagWriter()
          .usec((held / bytesPerSec) * 1e6)
          .usec(0)
          .bool(!this.corked)
          .timeval()
          .timeval()
          .s64(this.written)
          .s64(Math.max(0, this.written - held));
        if (version >= 13) {
          body.u64(0).u64((this.written / bytesPerSec) * 1e6);
        }
        reply(tag, body);
        return version;
      }
      case PA.FLUSH_PLAYBACK_STREAM: {
        // A flush means this audio never sounded. Keeping it would have a player that seeked hear
        // the second it had already sent before the jump, which is the one thing a seek must not do.
        this.discardPending();
        this.stream?.discard();
        this.carry = EMPTY;
        this.granted = 0;
        reply(tag);
        this.settleDrainIfEmpty();
        this.grant();
        return version;
      }
      case PA.DELETE_PLAYBACK_STREAM: {
        this.corked = true;
        this.granted = 0;
        this.carry = EMPTY;
        // The next stream may well open in another format, and answering with this one's would
        // have the engine set up for audio that never arrives.
        this.spec = null;
        this.settleDrain();
        reply(tag);
        return version;
      }
      case PA.DRAIN_PLAYBACK_STREAM: {
        this.awaitDrain(tag, reply);
        return version;
      }
      case PA.SET_STREAM_BUFFER_ATTR: {
        // The answer has to carry the attributes back. A bare acknowledgement is read as a broken
        // reply, and that costs the whole connection rather than this one request. What a client
        // asks for is noted and not taken: the buffer is the card's, the same as on real hardware.
        const body = new TagWriter()
          .u32(this.bufferAttr.maxlength)
          .u32(this.bufferAttr.tlength)
          .u32(this.bufferAttr.prebuf)
          .u32(this.bufferAttr.minreq);
        if (version >= 13) {
          body.usec(Math.round(TARGET_BUFFER_SEC * 1e6));
        }
        reply(tag, body);
        return version;
      }
      case PA.GET_SINK_INPUT_INFO_LIST: {
        // A list of one while a player is playing, and empty otherwise — an empty tagstruct is
        // how "nothing here" is said, and is not the same as refusing the question.
        reply(tag, this.spec ? this.sinkInputInfo(version) : new TagWriter());
        return version;
      }
      case PA.GET_SINK_INPUT_INFO: {
        if (!this.spec) {
          // 5 = no such entity. Nothing is playing, so there is nothing to describe.
          send(new TagWriter().u32(PA.ERROR).u32(tag).u32(5).build());
          return version;
        }
        reply(tag, this.sinkInputInfo(version));
        return version;
      }
      case PA.SET_SINK_INPUT_VOLUME: {
        reader.next(); // sink input index; there is only one
        const volumes = reader.next();
        if (Array.isArray(volumes)) {
          this.volume = volumes as number[];
        }
        reply(tag);
        return version;
      }
      case PA.SET_SINK_INPUT_MUTE: {
        reader.next(); // sink input index
        this.muted = reader.next() === true;
        reply(tag);
        return version;
      }
      case PA.STAT: {
        reply(tag, new TagWriter().u32(0).u32(0).u32(0).u32(0).u32(0));
        return version;
      }
      case PA.TRIGGER_PLAYBACK_STREAM:
      case PA.UPDATE_PLAYBACK_STREAM_PROPLIST:
      case PA.SUBSCRIBE: {
        reply(tag);
        return version;
      }
      default: {
        this.log.debug('a player asked for something this sound card does not do', {
          id: this.id,
          command,
        });
        // 19 = not implemented. Refusing plainly beats leaving the client waiting for a reply.
        send(new TagWriter().u32(PA.ERROR).u32(tag).u32(19).build());
        return version;
      }
    }
  }

  private sinkInfo(version: number): TagWriter {
    const spec = this.spec ?? DEFAULT_SPEC;
    const body = new TagWriter()
      .u32(0)
      .str(SINK_NAME)
      .str(SINK_DESCRIPTION)
      .sampleSpec(spec)
      .channelMap(spec.channels)
      .u32(0xffffffff)
      .cvolume(spec.channels)
      .bool(false)
      .u32(0xffffffff)
      .str(null)
      .usec(Math.round(TARGET_BUFFER_SEC * 1e6))
      .str('sonn')
      .u32(0);
    if (version >= 13) {
      body.proplist({ 'device.description': SINK_DESCRIPTION }).usec(Math.round(TARGET_BUFFER_SEC * 1e6));
    }
    if (version >= 15) {
      // Base volume, state (0 = running), volume steps, and the card this belongs to — there is
      // none, so the invalid index. A string here instead of that index is what a client reads as
      // a broken reply, and it drops the whole connection rather than the one request.
      body.volume().u32(0).u32(0x10000).u32(0xffffffff);
    }
    return body;
  }

  /** The player's own stream, as it would appear on a real server. */
  private sinkInputInfo(version: number): TagWriter {
    const spec = this.spec ?? DEFAULT_SPEC;
    const bytesPerSec = spec.rate * frameSize(spec);
    const body = new TagWriter()
      .u32(this.streamIndex)
      .str(SINK_DESCRIPTION)
      .u32(0xffffffff)
      .u32(1)
      .u32(0)
      .sampleSpec(spec)
      .channelMap(spec.channels)
      .cvolumeOf(this.volumeFor(spec.channels))
      .usec(bytesPerSec > 0 ? (this.heldAsSent() / bytesPerSec) * 1e6 : 0)
      .usec(0)
      // Nothing is resampled here; the engine is handed the rate the player chose.
      .str('copy')
      .str('sonn');
    if (version >= 11) {
      body.bool(this.muted);
    }
    if (version >= 13) {
      body.proplist({ 'media.name': SINK_DESCRIPTION });
    }
    return body;
  }

  /** Whatever the player last set, padded to the channels it is playing in. */
  private volumeFor(channels: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < channels; i += 1) {
      out.push(this.volume[i] ?? this.volume[0] ?? 0x10000);
    }
    return out;
  }
}

/**
 * The audio of one card, as a stream the engine can read.
 *
 * `_read` is the whole point: Node calls it whenever the consumer has room, which is the only
 * honest moment to let the player send more.
 */
class CardStream extends Readable {
  constructor(private readonly onWanted: () => void) {
    super({ highWaterMark: 256 * 1024 });
  }

  public override _read(): void {
    this.onWanted();
  }

  /**
   * Every read is a moment the buffer got smaller, and the only honest one to look again.
   *
   * `_read` alone is not enough. Node calls it once and then waits for a push before it will ask
   * again, so a card that answers "not yet, I am still holding a second" is never asked a second
   * time — and since the client may only send what it has been granted, no audio arrives to break
   * the tie either. The room simply stopped after one second. Reads always keep coming, so this is
   * where the credit is released.
   */
  public override read(size?: number): unknown {
    const chunk = super.read(size) as unknown;
    this.onWanted();
    return chunk;
  }

  /** Hand over audio as it arrives. Backpressure is expressed by granting, not by refusing. */
  public feed(chunk: Buffer): void {
    if (chunk.length > 0) {
      this.push(chunk);
    }
  }

  /**
   * Throw away what is buffered, for a flush.
   *
   * Reading it out is the only way to take audio back off a stream, and it is the honest one:
   * whatever the engine has already been handed has gone, and this is the rest of it.
   */
  public discard(): void {
    while (super.read() !== null) {
      /* the player has said this audio never happened */
    }
  }
}

const SINK_NAME = 'sonn';
/** What this card says it is before a player has said what it wants. */
const DEFAULT_SPEC: SampleSpec = { format: 's24le', channels: 2, rate: 44100 };
const SINK_DESCRIPTION = 'Sonn';
const EMPTY = Buffer.alloc(0);
