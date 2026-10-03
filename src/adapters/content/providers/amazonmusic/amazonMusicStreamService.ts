import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { LicenseType as WvLicenseType, Widevine } from 'widevine';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { parseTrackAudiopath } from '@/domain/zones/audiopath';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import { findBridgeForProviderKey } from '@/adapters/content/providers/bridgeLookup';
import {
  buildWidevinePsshFromKid,
  coercePssh,
  extractKidFromPssh,
  loadWidevineArtifacts,
  normalizeBase64,
  WidevineArtifactsError,
} from '@/adapters/content/drm/widevine';
import { resolveProxyHost, resolveProxyPort } from '@/shared/urlProxy';
import { pruneExpiredSessions, type StreamProxyRoute } from '@/shared/streamProxyRoute';
import { AmazonMusicClient } from './amazonMusicClient';
import { parseAmazonManifest, pickRepresentation, type AmazonAudioRepresentation } from './amazonMusicManifest';

const PROVIDER = 'amazonmusic';
const KEY_TTL_MS = 60 * 60 * 1000;
const WIDEVINE_MISSING_REASON = 'widevine missing';

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

type PlaybackResult = { playbackSource: PlaybackSource | null; outputOnly?: boolean };

type ProxySession = { id: string; url: string; createdAt: number };

type KeyResult = { key: string } | { key: null; reason: string };

/**
 * Plays Amazon Music tracks.
 *
 * A track resolves to one CENC-encrypted MP4 on Amazon's CDN plus a content key from its
 * Widevine licence server — the same CDM files Apple Music uses, since an ordinary L3 CDM is all
 * the per-track ("web") PSSH needs. ffmpeg decrypts as it demuxes (`-decryption_key`), so the
 * stream is never written out in the clear. The file is fetched through the shared gateway
 * because ffmpeg in this process cannot resolve hosts itself; Range requests are passed through
 * so a seek does not restart the download.
 */
export class AmazonMusicStreamService {
  private readonly log = createLogger('Content', 'AmazonMusicStream');
  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly clients = new Map<string, AmazonMusicClient>();
  private readonly sessions = new Map<string, ProxySession>();
  private readonly keys = new Map<string, { key: string; expiresAt: number }>();

  constructor(
    private readonly notifyOutputError: OutputErrorHandler,
    private readonly configPort: ConfigPort,
  ) {}

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    this.clients.clear();
    const bridges = (this.configPort.getConfig().content?.streamingServices ?? []).filter(
      (b) => (b.provider || '').toLowerCase() === PROVIDER,
    );
    for (const bridge of bridges) {
      this.bridgesByProvider.set(`spotify@${bridge.id}`, bridge);
      this.bridgesById.set(bridge.id, bridge);
      this.bridgesByProvider.set(`${PROVIDER}:${slugFromBridgeId(bridge.id, PROVIDER)}`, bridge);
      if (bridges.length === 1) {
        this.bridgesByProvider.set(PROVIDER, bridge);
      }
    }
  }

  public isAmazonMusicProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    if (this.bridgesById.has(providerId.split('@')[1] ?? providerId)) return true;
    return providerId.toLowerCase().includes(PROVIDER);
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<PlaybackResult> {
    const fail = (reason: string, context: Record<string, unknown> = {}): PlaybackResult => {
      this.log.warn('amazon music stream unavailable', { zoneId, audiopath, reason, ...context });
      if (!options?.suppressErrors && zoneId != null) this.notifyOutputError(zoneId, reason);
      return { playbackSource: null };
    };

    const parsed = parseTrackAudiopath(audiopath);
    if (!parsed || parsed.kind !== 'track') return fail('amazon music invalid request');
    const bridge = findBridgeForProviderKey(parsed.providerKey, this.bridgesByProvider, this.bridgesById);
    if (!bridge) return fail('amazon music account not configured');
    const client = this.clientFor(bridge);
    if (!client) return fail('amazon music not signed in');

    const asin = parsed.id;
    let rep: AmazonAudioRepresentation | null;
    try {
      const mpd = await client.dashManifest(asin);
      if (!mpd) return fail('amazon music track unavailable', { asin });
      const reps = parseAmazonManifest(mpd);
      rep = pickRepresentation(reps, { lossless: client.tier === 'unlimited' });
      if (!rep) {
        return fail('amazon music no playable format', {
          asin,
          offered: reps.map((r) => `${r.codec}/${r.sampleRate}${r.spatial ? '/spatial' : ''}`),
        });
      }
    } catch (err) {
      return fail('amazon music manifest request failed', { asin, message: err instanceof Error ? err.message : String(err) });
    }

    const keyResult = await this.contentKey(client, asin, rep);
    if (keyResult.key === null) return fail(keyResult.reason, { asin });

    this.log.info('amazon music stream ready', {
      zoneId,
      asin,
      codec: rep.codec,
      quality: rep.quality,
      sampleRate: rep.sampleRate,
      bitDepth: rep.bitDepth,
    });
    const sessionId = this.openSession(rep.url);
    const lossless = rep.codec === 'flac';
    return {
      playbackSource: {
        kind: 'url',
        url: `http://${resolveProxyHost()}:${resolveProxyPort()}/${PROVIDER}/${sessionId}/stream`,
        // Always fragmented MP4; naming the demuxer keeps ffmpeg from probing the encrypted bytes.
        inputFormat: 'mov',
        decryptionKey: keyResult.key,
        realTime: false,
        lowLatency: false,
        nativeFormat: rep.sampleRate
          ? {
              sampleRate: rep.sampleRate,
              channels: 2,
              lossless,
              ...(lossless && (rep.bitDepth === 16 || rep.bitDepth === 24) ? { bitDepth: rep.bitDepth } : {}),
              codecName: rep.codec,
            }
          : undefined,
      },
    };
  }

  private clientFor(bridge: StreamingServiceConfig): AmazonMusicClient | null {
    const cached = this.clients.get(bridge.id);
    if (cached) return cached;
    const credentials = bridge.amazonMusic;
    if (!credentials?.adpToken || !credentials.devicePrivateKey) return null;
    try {
      const client = new AmazonMusicClient(credentials);
      this.clients.set(bridge.id, client);
      return client;
    } catch (err) {
      this.log.warn('amazon music credentials unusable', {
        bridgeId: bridge.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** The hex content key for a representation, from cache or a fresh licence. */
  private async contentKey(client: AmazonMusicClient, asin: string, rep: AmazonAudioRepresentation): Promise<KeyResult> {
    const pssh = rep.pssh
      ? coercePssh(Buffer.from(normalizeBase64(rep.pssh), 'base64'))
      : rep.defaultKid
        ? buildWidevinePsshFromKid(Buffer.from(rep.defaultKid, 'hex'))
        : null;
    if (!pssh) return { key: null, reason: 'amazon music manifest has no licensable key' };
    const kid = (rep.defaultKid ?? extractKidFromPssh(pssh)?.toString('hex') ?? '').toLowerCase();

    const cacheKey = kid || `${asin}:${rep.url}`;
    const cached = this.keys.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { key: cached.key };

    let artifacts: { privateKey: Buffer; clientIdBlob: Buffer };
    try {
      artifacts = await loadWidevineArtifacts();
    } catch (err) {
      if (err instanceof WidevineArtifactsError) return { key: null, reason: WIDEVINE_MISSING_REASON };
      throw err;
    }

    try {
      const session = Widevine.init(artifacts.clientIdBlob, artifacts.privateKey).createSession(pssh, WvLicenseType.STREAMING);
      const challenge = Buffer.from(session.generateChallenge()).toString('base64');
      const licenseB64 = await client.license(asin, challenge);
      if (!licenseB64) return { key: null, reason: 'amazon music licence refused' };
      let license = Buffer.from(normalizeBase64(licenseB64), 'base64');
      if (license[0] === 0x1f && license[1] === 0x8b) license = gunzipSync(license);
      const keys = session.parseLicense(license) as Array<{ kid?: string; key?: string }>;
      const match = keys.find((k) => k.key && kid && String(k.kid ?? '').toLowerCase() === kid) ?? keys.find((k) => k.key);
      if (!match?.key) {
        this.log.warn('amazon music licence carried no usable key', {
          asin,
          expectedKid: kid || undefined,
          kids: keys.map((k) => k.kid).filter(Boolean),
        });
        return { key: null, reason: 'amazon music licence refused' };
      }
      this.keys.set(cacheKey, { key: match.key, expiresAt: Date.now() + KEY_TTL_MS });
      return { key: match.key };
    } catch (err) {
      this.log.warn('amazon music licence failed', { asin, message: err instanceof Error ? err.message : String(err) });
      return { key: null, reason: 'amazon music licence refused' };
    }
  }

  private openSession(url: string): string {
    pruneExpiredSessions(this.sessions);
    const now = Date.now();
    for (const [key, entry] of this.keys) {
      if (entry.expiresAt <= now) this.keys.delete(key);
    }
    const id = randomUUID();
    this.sessions.set(id, { id, url, createdAt: now });
    return id;
  }

  /** `/amazonmusic/<session>/stream` on the shared gateway. */
  public getProxyRoute(): StreamProxyRoute {
    return {
      matches: (pathname) => pathname.startsWith(`/${PROVIDER}/`),
      handle: (req, res) => this.handleProxyRequest(req, res),
    };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
    const session = parts[2] === 'stream' ? this.sessions.get(parts[1] ?? '') : undefined;
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    // ffmpeg is killed on every skip; without this the CDN download carries on for nobody.
    req.on('aborted', abort);
    res.on('close', abort);

    const headers: Record<string, string> = {};
    if (typeof req.headers.range === 'string') headers.range = req.headers.range;
    try {
      const upstream = await fetch(session.url, { headers, signal: controller.signal });
      if (!upstream.ok || !upstream.body) {
        this.log.warn('amazon music cdn rejected', { status: upstream.status });
        res.writeHead(upstream.status || 502, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      const out: Record<string, string> = {
        'Content-Type': upstream.headers.get('content-type') ?? 'video/mp4',
        'Accept-Ranges': 'bytes',
      };
      for (const name of ['content-length', 'content-range']) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      res.writeHead(upstream.status, out);
      const body = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      body.on('error', (error) => {
        if (!controller.signal.aborted) {
          this.log.warn('amazon music cdn stream failed', { message: error.message });
        }
        res.destroy();
      });
      body.pipe(res);
    } catch (err) {
      if (controller.signal.aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      this.log.warn('amazon music cdn fetch failed', { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
    }
  }
}
