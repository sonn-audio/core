/**
 * Keeps one ICY framing towards the client across any number of upstream bodies.
 *
 * A live radio body interleaves audio with metadata blocks: `metaint` bytes of audio, one
 * length byte, `length * 16` bytes of text, and round again. The client was told that
 * interval once, in the response header, and counts along from the first byte it received.
 * A second upstream body — the station closed the connection and we opened a new one —
 * starts its own count at zero, somewhere in the middle of the client's. Passed on as it
 * comes, its metadata blocks land in what the client takes for audio and the other way
 * round: a click every interval, or a decoder that never finds its way back.
 *
 * So the two counts are kept apart. Upstream is taken to pieces by its own interval, into
 * audio and whole metadata blocks; the client is handed that audio on the interval it was
 * promised, with a block at every boundary — the newest one upstream sent, or an empty one.
 * On an unbroken body the boundaries coincide and what goes out is byte for byte what came
 * in.
 */
export class IcyReframer {
  /** Audio bytes still to read from upstream before its next metadata block; null without ICY. */
  private upstreamUntilMeta: number | null = null;
  private upstreamInterval: number | null = null;
  /** Bytes of the metadata block being read that have not arrived yet. */
  private metaRemaining = 0;
  private metaParts: Buffer[] = [];
  /** The length byte of the block being read, kept so the block goes out exactly as it came. */
  private metaLengthByte = 0;

  /** Audio bytes the client still expects before its next metadata block. */
  private clientUntilMeta: number;
  /** A complete block from upstream that the client has not reached a boundary for yet. */
  private heldBlock: Buffer | null = null;

  /**
   * @param clientInterval The `icy-metaint` the client was sent, or null when it was sent
   *   none and must get audio only.
   * @param onMetadata Called with the text of every non-empty block upstream sends.
   */
  constructor(
    private readonly clientInterval: number | null,
    private readonly onMetadata: (payload: Buffer) => void,
  ) {
    this.clientUntilMeta = clientInterval ?? 0;
  }

  /** A new upstream body begins; `interval` is its own `icy-metaint`, or null for plain audio. */
  public startBody(interval: number | null): void {
    this.upstreamInterval = interval && interval > 0 ? interval : null;
    this.upstreamUntilMeta = this.upstreamInterval;
    // A block cut off by the old body's end can never be completed by the new one.
    this.metaRemaining = 0;
    this.metaParts = [];
  }

  /** Takes the next bytes of the current upstream body and returns what the client gets for them. */
  public push(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.metaRemaining > 0) {
        const take = Math.min(this.metaRemaining, chunk.length - offset);
        this.metaParts.push(chunk.subarray(offset, offset + take));
        offset += take;
        this.metaRemaining -= take;
        if (this.metaRemaining === 0) {
          this.completeBlock(out);
        }
        continue;
      }
      if (this.upstreamUntilMeta === null) {
        this.emitAudio(chunk.subarray(offset), out);
        break;
      }
      if (this.upstreamUntilMeta > 0) {
        const take = Math.min(this.upstreamUntilMeta, chunk.length - offset);
        this.emitAudio(chunk.subarray(offset, offset + take), out);
        offset += take;
        this.upstreamUntilMeta -= take;
        continue;
      }
      this.metaLengthByte = chunk.readUInt8(offset);
      offset += 1;
      this.metaRemaining = this.metaLengthByte * 16;
      this.metaParts = [];
      if (this.metaRemaining === 0) {
        this.completeBlock(out);
      }
    }
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  private completeBlock(out: Buffer[]): void {
    const payload = Buffer.concat(this.metaParts);
    this.metaParts = [];
    this.upstreamUntilMeta = this.upstreamInterval;
    if (payload.length > 0) {
      this.onMetadata(payload);
    }
    if (this.clientInterval === null) {
      return;
    }
    const block = Buffer.concat([Buffer.from([this.metaLengthByte]), payload]);
    if (this.clientUntilMeta === 0) {
      // The client is at its boundary too: the block goes out where upstream put it.
      out.push(block);
      this.clientUntilMeta = this.clientInterval;
      return;
    }
    // Out of step with the client. An empty block carries nothing worth holding on to, and
    // must not displace a title that is still waiting for its boundary.
    if (payload.length > 0) {
      this.heldBlock = block;
    }
  }

  private emitAudio(audio: Buffer, out: Buffer[]): void {
    if (this.clientInterval === null) {
      out.push(audio);
      return;
    }
    let offset = 0;
    while (offset < audio.length) {
      if (this.clientUntilMeta === 0) {
        // Audio arrived where the client expects a block, so upstream is not going to supply one.
        out.push(this.heldBlock ?? Buffer.from([0]));
        this.heldBlock = null;
        this.clientUntilMeta = this.clientInterval;
      }
      const take = Math.min(this.clientUntilMeta, audio.length - offset);
      out.push(audio.subarray(offset, offset + take));
      offset += take;
      this.clientUntilMeta -= take;
    }
  }
}
