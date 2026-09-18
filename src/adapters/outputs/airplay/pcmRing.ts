/**
 * The PCM buffer both AirPlay lanes sit behind.
 *
 * A sender reads from a stream that produces faster than realtime and writes to
 * a device that only wants a lead ahead of now. Everything between those two
 * facts — priming before the session is built, holding the source back, letting
 * it go again, handing out exactly one packet's worth — is the same on AirPlay 1
 * and AirPlay 2, and each rule in here was paid for once already on the AirPlay 2
 * path. Sharing it is what keeps a fix on one lane from being a bug on the other.
 */

const SAMPLE_RATE = 44_100;
const BYTES_PER_FRAME = 4; // s16le stereo
const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_FRAME;

/**
 * Backpressure bounds. The engine produces faster than realtime, so without
 * these the ring simply grows — and everything in it is audio the listener has
 * to sit through before a skip is heard. Measured before this existed: a track
 * change kept playing the old track for the best part of ten seconds.
 *
 * The window is deliberately wide and sits well above the prime target. A LIVE
 * source — an AirPlay input feeding this output — never stops for a paused
 * reader, so every pause simply pushes the backlog one buffer upstream and the
 * input logs a failed write for every packet that arrives meanwhile. Priming to
 * the pause threshold made that permanent. With this spacing a realtime source
 * settles below the gate and never trips it, while a source that genuinely runs
 * fast is still held. MAX_RING_BYTES is the last-resort cap for one that ignores
 * both.
 */
const PAUSE_RING_BYTES = Math.round(BYTES_PER_SECOND * 1.2);
const RESUME_RING_BYTES = Math.round(BYTES_PER_SECOND * 0.7);
const MAX_RING_BYTES = BYTES_PER_SECOND * 3;

export class PcmRing {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private source: NodeJS.ReadableStream | null = null;
  private onData: ((chunk: Buffer) => void) | null = null;
  private sourcePaused = false;

  public get bufferedBytes(): number {
    return this.bytes;
  }

  public get bufferedMs(): number {
    return Math.round((this.bytes / BYTES_PER_SECOND) * 1000);
  }

  public get isSourcePaused(): boolean {
    return this.sourcePaused;
  }

  public attach(source: NodeJS.ReadableStream): void {
    if (this.source === source) {
      return;
    }
    this.detach();
    this.source = source;
    this.onData = (chunk: Buffer): void => {
      if (this.bytes >= MAX_RING_BYTES) {
        return;
      }
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      if (!this.sourcePaused && this.bytes >= PAUSE_RING_BYTES) {
        this.sourcePaused = true;
        this.source?.pause();
      }
    };
    source.on('data', this.onData);
    this.sourcePaused = false;
  }

  public detach(): void {
    if (this.source && this.onData) {
      this.source.removeListener('data', this.onData);
    }
    this.source = null;
    this.onData = null;
    this.sourcePaused = false;
  }

  public clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  /**
   * Wait until there is something worth opening a session for.
   *
   * The receiver drops the control channel when a stream SETUP is not followed
   * promptly by audio, so the buffer has to be filled BEFORE the session is
   * built, never after (measured: four seconds of silence between SETUP and the
   * first packet ends the session, and the sender keeps streaming into the void
   * with nothing to show for it).
   */
  public async waitForPrime(primeMs: number, timeoutMs = 15_000): Promise<boolean> {
    // Below PAUSE_RING_BYTES by construction, so priming never trips the
    // backpressure gate it shares a ring with.
    const target = Math.min(
      PAUSE_RING_BYTES,
      Math.ceil((primeMs / 1000) * SAMPLE_RATE) * BYTES_PER_FRAME,
    );
    const deadline = Date.now() + timeoutMs;
    while (this.bytes < target && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.bytes > 0;
  }

  /** One packet of `size` bytes, or null when the ring cannot fill one yet. */
  public take(size: number): Buffer | null {
    if (this.bytes < size) {
      this.maybeResume();
      return null;
    }
    const parts: Buffer[] = [];
    let needed = size;
    while (needed > 0) {
      const head = this.chunks[0] as Buffer;
      if (head.length <= needed) {
        parts.push(head);
        needed -= head.length;
        this.chunks.shift();
      } else {
        parts.push(head.subarray(0, needed));
        this.chunks[0] = head.subarray(needed);
        needed = 0;
      }
    }
    this.bytes -= size;
    this.maybeResume();
    return Buffer.concat(parts);
  }

  /**
   * Let the source run again once the ring has drained enough.
   *
   * This must be reachable on EVERY path through the reader, not only after a
   * successful read: a ring that empties while the source is paused would
   * otherwise never resume it, and the stall propagates all the way back up the
   * chain — a live AirPlay input then fills its whole buffer and reports a
   * failed write for every packet that arrives.
   */
  private maybeResume(): void {
    if (this.sourcePaused && this.bytes <= RESUME_RING_BYTES) {
      this.sourcePaused = false;
      this.source?.resume();
    }
  }
}
