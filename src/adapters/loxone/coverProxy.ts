import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Covers handed to the Loxone clients by way of this server, so that a client which cannot load
 * the original still gets them through the Miniserver (#449).
 *
 * The Loxone app loads every cover through one repository (`CoverRepository.fetch`). For a url
 * whose path contains `imgcache` it first tries the url itself, and when that fails it tries
 * again on the connection it already has to the server, as
 * `<connection origin>/proxy/<viaproxy>/<path>`. A client that reaches this server through the
 * Miniserver (the Web UI served over HTTPS, the app away from home) has that connection on the
 * Miniserver, so the retry comes from the Miniserver's own origin and certificate: no mixed
 * content, and no address on the home network that the client cannot reach.
 *
 * Only `http:` covers are wrapped. Those are the ones such a client cannot load: this server's
 * own images, a Sonos speaker's art, a station logo on a plain web server. An `https:` cover
 * loads anywhere already and goes out as it is.
 *
 * The wrapped url names the original, signed with a key that lives as long as the process, so
 * the route cannot be used to make this server fetch arbitrary addresses. A client caches the
 * bytes under the url, so a new key after a restart only means one more fetch.
 */
export type LoxoneCoverProxyOptions = {
  /** This server's address as the clients reach it. */
  host: () => string | null;
  /** The port of the app server, the one the Miniserver's proxy leads to. */
  port: number;
  /** This server's uuid in the Miniserver's structure, the `viaproxy` of the retry. */
  uuid: () => string | null;
};

const IMGCACHE_PREFIX = '/imgcache/';
const COVER_KEYS = new Set(['coverurl', 'coverUrl', 'thumbnail', 'icon']);

export class LoxoneCoverProxy {
  private readonly key = randomBytes(32);

  constructor(private readonly options: LoxoneCoverProxyOptions) {}

  /** The url a Loxone client gets for `cover`; the cover itself when it cannot be wrapped. */
  public clientUrl(cover: string): string {
    if (!/^http:\/\//i.test(cover) || cover.includes(IMGCACHE_PREFIX)) return cover;
    const host = this.options.host()?.trim();
    const uuid = this.options.uuid()?.trim();
    if (!host || !uuid) return cover;
    const encoded = Buffer.from(cover, 'utf8').toString('base64url');
    const path = `${IMGCACHE_PREFIX}${this.sign(encoded)}/${encoded}`;
    return `http://${host}:${this.options.port}${path}?viaproxy=${encodeURIComponent(uuid)}`;
  }

  /** Every cover field in a payload for the Loxone clients, wrapped. Returns a copy. */
  public rewrite<T>(payload: T): T {
    return this.walk(payload) as T;
  }

  /** The original cover a request for `path` names, or null when it is not one of ours. */
  public resolve(path: string): string | null {
    const pathname = path.split('?')[0] ?? '';
    if (!pathname.startsWith(IMGCACHE_PREFIX)) return null;
    const [signature, encoded] = pathname.slice(IMGCACHE_PREFIX.length).split('/');
    if (!signature || !encoded) return null;
    const expected = Buffer.from(this.sign(encoded));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const cover = Buffer.from(encoded, 'base64url').toString('utf8');
    return /^http:\/\//i.test(cover) ? cover : null;
  }

  public static isCoverRequest(path: string): boolean {
    return path.startsWith(IMGCACHE_PREFIX);
  }

  private sign(encoded: string): string {
    return createHmac('sha256', this.key).update(encoded).digest('base64url').slice(0, 22);
  }

  private walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.walk(entry));
    if (!value || typeof value !== 'object') return value;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = typeof entry === 'string' && COVER_KEYS.has(key) ? this.clientUrl(entry) : this.walk(entry);
    }
    return copy;
  }
}
