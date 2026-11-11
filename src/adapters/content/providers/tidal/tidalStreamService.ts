import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig, TidalQuality } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { parseTrackAudiopath } from '@/domain/zones/audiopath';
import { findBridgeForProviderKey } from '@/adapters/content/providers/bridgeLookup';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolveProxyHost, resolveProxyPort } from '@/shared/urlProxy';
import { pruneExpiredSessions, type StreamProxyRoute } from '@/shared/streamProxyRoute';
import { sharedTidalAuth, type TidalApiAccess } from '@/adapters/content/providers/tidal/tidalAuth';
import { TIDAL_API_BASE } from '@/adapters/content/providers/tidal/tidalAuthClient';
import { hasContentProtection } from '@/adapters/content/providers/tidal/tidalOpenApi';

const TIDAL_QUALITIES: readonly TidalQuality[] = ['LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS'];
export const DEFAULT_TIDAL_QUALITY: TidalQuality = 'LOSSLESS';
export const TIDAL_PLAYBACK_REFUSED = "Tidal refused playback for this app's token";

/** manifestMimeType values the playbackinfopostpaywall endpoint returns. */
const MANIFEST_BTS = 'application/vnd.tidal.bts';
const MANIFEST_DASH = 'application/dash+xml';

/**
 * The quality a playback answer says it carries (v1's `audioQuality`), when it is lower than the
 * one asked for. TIDAL caps some clients (HIGH, AAC 320, for a client that asked for LOSSLESS);
 * that is recorded, never retried.
 */
export function downgradeOf(asked: TidalQuality, delivered: unknown): TidalQuality | undefined {
  if (typeof delivered !== 'string' || !TIDAL_QUALITIES.includes(delivered as TidalQuality)) return undefined;
  return TIDAL_QUALITIES.indexOf(delivered as TidalQuality) < TIDAL_QUALITIES.indexOf(asked) ? (delivered as TidalQuality) : undefined;
}

export function tidalQualityOf(service: Pick<StreamingServiceConfig, 'tidalQuality'>): TidalQuality {
  const q = service.tidalQuality;
  return q && TIDAL_QUALITIES.includes(q) ? q : DEFAULT_TIDAL_QUALITY;
}

/**
 * What a playback-info response resolves to.
 *
 * BTS manifests are base64 JSON with plain file URLs (LOW to LOSSLESS); DASH manifests are base64
 * MPDs (hi-res), which ffmpeg needs at a URL it can fetch more than once.
 */
export type TidalManifest =
  | { kind: 'direct'; url: string }
  | { kind: 'dash'; manifest: string; mimeType: string }
  | { kind: 'drm' }
  | { kind: 'unsupported' };

export function resolveTidalManifest(playback: {
  manifest?: unknown;
  manifestMimeType?: unknown;
}): TidalManifest {
  const manifest = decodeManifest(typeof playback.manifest === 'string' ? playback.manifest : null);
  if (!manifest) return { kind: 'unsupported' };
  const mimeType = typeof playback.manifestMimeType === 'string' ? playback.manifestMimeType : '';
  const trimmed = manifest.trim();
  if (mimeType === MANIFEST_BTS || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { encryptionType?: unknown };
      if (typeof parsed.encryptionType === 'string' && parsed.encryptionType !== 'NONE') return { kind: 'drm' };
    } catch {
      return { kind: 'unsupported' };
    }
    const url = extractDirectUrlFromManifest(trimmed);
    return url ? { kind: 'direct', url } : { kind: 'unsupported' };
  }
  if (mimeType === MANIFEST_DASH || trimmed.startsWith('<?xml') || trimmed.startsWith('<MPD')) {
    if (hasContentProtection(trimmed) || /widevine/i.test(trimmed)) return { kind: 'drm' };
    return { kind: 'dash', manifest: trimmed, mimeType: mimeType || MANIFEST_DASH };
  }
  return { kind: 'unsupported' };
}

type TidalPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type TidalTrackRequest = {
  providerId: string;
  trackId: string;
  bridge: StreamingServiceConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

/** What a track resolves to. */
type Resolution =
  | TidalManifest
  | { kind: 'refused'; status: number }
  | { kind: 'failed' };

type PlaybackInfoOutcome =
  | { kind: 'ok'; playback: Record<string, unknown> }
  /** 401/403 after the one refresh the auth does: Tidal will not play for this token. */
  | { kind: 'refused'; status: number }
  | { kind: 'failed'; status?: number };

type TidalProxySession = {
  id: string;
  manifest: string;
  mimeType: string;
  createdAt: number;
};

export class TidalStreamService {
  private readonly log = createLogger('Content', 'TidalStream');
  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly proxySessions = new Map<string, TidalProxySession>();
  private readonly configPort: ConfigPort;
  private readonly auth: TidalApiAccess;

  constructor(
    private readonly notifyOutputError: OutputErrorHandler,
    configPort: ConfigPort,
    auth: TidalApiAccess = sharedTidalAuth,
  ) {
    this.configPort = configPort;
    this.auth = auth;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
    const tidalBridges = bridges.filter((b) => (b.provider || '').toLowerCase() === 'tidal');
    const single = tidalBridges.length <= 1;
    for (const bridge of tidalBridges) {
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
      // Also index under the SERVICE-NATIVE prefix the provider now emits, so a
      // `tidal[:<slug>]:track:...` audiopath resolves to its bridge.
      const slug = slugFromBridgeId(bridge.id, 'tidal');
      this.bridgesByProvider.set(`tidal:${slug}`, bridge);
      if (single) {
        this.bridgesByProvider.set('tidal', bridge);
      }
    }
  }

  public isTidalProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('tidal');
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<TidalPlaybackResult> {
    const suppressErrors = options?.suppressErrors === true;
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('tidal stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'tidal invalid request', suppressErrors);
      return { playbackSource: null };
    }

    const quality = tidalQualityOf(request.bridge);
    const resolved = await this.resolveV1(request, quality);

    switch (resolved.kind) {
      case 'refused':
        this.log.warn(TIDAL_PLAYBACK_REFUSED, { zoneId, trackId: request.trackId, status: resolved.status });
        this.reportPlaybackError(zoneId, TIDAL_PLAYBACK_REFUSED, suppressErrors);
        return { playbackSource: null };
      case 'failed':
        this.reportPlaybackError(zoneId, 'tidal playback info unavailable', suppressErrors);
        return { playbackSource: null };
      case 'direct':
        return { playbackSource: { kind: 'url', url: resolved.url } };
      case 'drm':
        this.log.warn('tidal stream is DRM protected', { zoneId, trackId: request.trackId, quality });
        this.reportPlaybackError(zoneId, 'tidal stream is DRM protected', suppressErrors);
        return { playbackSource: null };
      case 'unsupported':
        this.log.warn('tidal manifest format not supported', { zoneId, trackId: request.trackId });
        this.reportPlaybackError(zoneId, 'tidal manifest unsupported', suppressErrors);
        return { playbackSource: null };
      case 'dash':
        break;
    }

    const sessionId = randomUUID();
    pruneExpiredSessions(this.proxySessions);
    this.proxySessions.set(sessionId, {
      id: sessionId,
      manifest: resolved.manifest,
      mimeType: resolved.mimeType,
      createdAt: Date.now(),
    });
    const url = `http://${resolveProxyHost()}:${resolveProxyPort()}/tidal/${sessionId}/manifest.mpd`;
    return {
      playbackSource: {
        kind: 'url',
        url,
        inputFormat: 'dash',
      },
    };
  }

  /** v1 playbackinfopostpaywall: BTS (a file URL) up to lossless, DASH for hi-res. */
  private async resolveV1(request: TidalTrackRequest, quality: TidalQuality): Promise<Resolution> {
    let outcome = await this.fetchPlaybackInfo(request, quality);
    let manifest = outcome.kind === 'ok' ? resolveTidalManifest(outcome.playback) : null;
    // Hi-res comes as DASH and is not offered (or offered encrypted) for every track, app or
    // subscription: ask once more for lossless rather than play nothing.
    if (quality === 'HI_RES_LOSSLESS' && (outcome.kind === 'failed' || manifest?.kind === 'drm' || manifest?.kind === 'unsupported')) {
      this.log.info('tidal hi-res not playable; falling back to lossless', {
        trackId: request.trackId,
        reason: outcome.kind === 'ok' ? manifest?.kind : `http ${outcome.status ?? 'error'}`,
      });
      outcome = await this.fetchPlaybackInfo(request, 'LOSSLESS');
      manifest = outcome.kind === 'ok' ? resolveTidalManifest(outcome.playback) : null;
    }
    if (outcome.kind === 'refused') return { kind: 'refused', status: outcome.status };
    if (outcome.kind !== 'ok' || !manifest) return { kind: 'failed' };
    if (manifest.kind === 'direct' || manifest.kind === 'dash') {
      await this.noteQuality(request, quality, outcome.playback.audioQuality);
    }
    return manifest;
  }

  /** Record what TIDAL delivered against what the service asks for; a played track always counts. */
  private async noteQuality(request: TidalTrackRequest, asked: TidalQuality, delivered: unknown): Promise<void> {
    if (typeof delivered !== 'string' || !delivered) return;
    await this.auth.noteQuality(request.bridge.id, downgradeOf(asked, delivered)).catch((err: unknown) => {
      this.log.debug('tidal quality not recorded', { message: err instanceof Error ? err.message : String(err) });
    });
  }

  private reportPlaybackError(zoneId: number | undefined, reason: string, suppressErrors = false): void {
    if (suppressErrors) return;
    // No zone to route the error to (ephemeral/non-zone requester) — stay silent.
    if (zoneId == null) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): TidalTrackRequest | null {
    const parsed = parseTrackAudiopath(audiopath);
    if (!parsed || parsed.kind !== 'track') return null;
    const bridge = findBridgeForProviderKey(
      parsed.providerKey,
      this.bridgesByProvider,
      this.bridgesById,
    );
    if (!bridge) return null;
    return { providerId: parsed.providerKey, trackId: parsed.id, bridge };
  }

  private async fetchPlaybackInfo(request: TidalTrackRequest, quality: TidalQuality): Promise<PlaybackInfoOutcome> {
    const url = new URL(`${TIDAL_API_BASE}/tracks/${encodeURIComponent(request.trackId)}/playbackinfopostpaywall`);
    url.searchParams.set('audioquality', quality);
    url.searchParams.set('playbackmode', 'STREAM');
    url.searchParams.set('assetpresentation', 'FULL');
    // No surround pipeline here, so never ask for the Atmos asset.
    url.searchParams.set('immersiveaudio', 'false');
    try {
      // The auth refreshes once on a 401 and retries; a refusal after that is final.
      const res = await this.auth.fetch(request.bridge.id, url);
      if (!res) {
        this.log.warn('tidal playback without a sign-in or token', { serviceId: request.bridge.id });
        return { kind: 'failed' };
      }
      if (res.status === 401 || res.status === 403) {
        return { kind: 'refused', status: res.status };
      }
      if (!res.ok) {
        this.log.warn('tidal playback info failed', { status: res.status, trackId: request.trackId, quality });
        return { kind: 'failed', status: res.status };
      }
      return { kind: 'ok', playback: (await res.json()) as Record<string, unknown> };
    } catch (err) {
      this.log.warn('tidal playback info failed', { trackId: request.trackId, message: err instanceof Error ? err.message : String(err) });
      return { kind: 'failed' };
    }
  }

  /**
   * Route served on the shared HTTP gateway (:7090) instead of a per-service
   * ephemeral server. Hosts decoded DASH manifests for ffmpeg to pull.
   */
  public getProxyRoute(): StreamProxyRoute {
    return {
      matches: (pathname) => pathname.startsWith('/tidal/'),
      handle: (req, res) => this.handleProxyRequest(req, res),
    };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = String(req.url || '');
    const match = url.match(/^\/tidal\/([^/]+)\/manifest\.mpd/i);
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = match[1] ?? '';
    const session = this.proxySessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end();
      return;
    }
    // ffmpeg may come back for the manifest (a seek, a restart): keep it from being pruned meanwhile.
    session.createdAt = Date.now();
    res.writeHead(200, { 'Content-Type': session.mimeType, 'Cache-Control': 'no-cache' });
    res.end(session.manifest);
  }
}

function decodeManifest(encoded: string | null | undefined): string | null {
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function extractDirectUrlFromManifest(manifest: string): string | null {
  const trimmed = manifest.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as { urls?: unknown; url?: unknown };
      const urls = parsed?.urls;
      if (Array.isArray(urls) && typeof urls[0] === 'string') {
        return urls[0];
      }
      if (typeof parsed?.url === 'string') {
        return parsed.url;
      }
    } catch {
      return null;
    }
  }
  return null;
}
