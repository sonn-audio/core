/**
 * Waiting out a service's rate limit instead of reporting it as an empty answer.
 *
 * A 429 is the service saying "ask again in a moment", usually with the moment spelled out. A
 * provider that returned it to its caller as a failure turned a pause of a second or two into a
 * folder with nothing in it — and, because the callers behind it kept asking, into a longer pause.
 */

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * A `Retry-After` header as milliseconds from `now`: either a number of seconds or an HTTP date.
 * Null when the header is missing or says nothing usable.
 */
export function retryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  const text = (value ?? '').trim();
  if (!text) {
    return null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.round(Number(text) * 1000);
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export interface RateLimitOptions {
  /** Tries in total, the first included. */
  maxAttempts?: number;
  /** The longest single wait worth sitting through; a longer one is handed back to the caller. */
  maxWaitMs?: number;
  sleep?: Sleep;
  now?: () => number;
  /** Called for every wait, for a log line. */
  onWait?: (info: { waitMs: number; attempt: number }) => void;
}

/**
 * One account's (or one address's) standing with a service.
 *
 * Shared by every request made on that account, which is the point: the limit is the account's,
 * so once one request has been told to wait, the others wait with it instead of each finding out
 * for themselves and extending the penalty.
 */
export class RateLimiter {
  private blockedUntil = 0;
  private readonly maxAttempts: number;
  private readonly maxWaitMs: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly onWait?: RateLimitOptions['onWait'];

  constructor(options: RateLimitOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxWaitMs = options.maxWaitMs ?? 8000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.onWait = options.onWait;
  }

  /** How long the service has asked this account to stay away for, from now. */
  public remainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Record that the service asked for a pause of `waitMs`. */
  public block(waitMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + waitMs);
  }

  /**
   * Make a request, waiting and asking again while the service answers 429.
   *
   * The answer returned is the service's own: a 429 still comes back as one when the tries are
   * used up or the pause asked for is longer than is worth holding a caller for. While such a long
   * pause is running nothing is sent at all — the answer is known, and asking counts against us.
   */
  public async fetch(send: () => Promise<Response>): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const standing = this.remainingMs();
      if (standing > this.maxWaitMs) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': String(Math.ceil(standing / 1000)) },
        });
      }
      if (standing > 0) {
        await this.sleep(standing);
      }
      const response = await send();
      if (response.status !== 429) {
        return response;
      }
      const asked = retryAfterMs(response.headers.get('retry-after'), this.now());
      // Without a stated pause, back off on our own: half a second, doubling, never in step.
      const waitMs = asked ?? Math.round(500 * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
      this.block(waitMs);
      if (attempt >= this.maxAttempts || waitMs > this.maxWaitMs) {
        return response;
      }
      this.onWait?.({ waitMs, attempt });
      // Nothing reads the refused answer; let its connection go.
      await response.body?.cancel().catch(() => undefined);
    }
  }
}
