import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { parseTrackAudiopath } from '@/domain/zones/audiopath';
import { findBridgeForProviderKey } from '@/adapters/content/providers/bridgeLookup';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import {
  asId,
  buildDrmCacheKey,
  buildLicenseHeaders,
  buildStreamHeaders,
  extractStreamUrl,
  normalizeLicenseUrl,
  normalizeSalableAdamId,
  resolvePaceInput,
  sanitizeProxyHeaders,
} from '@/adapters/content/providers/applemusic/appleMusicStreamHelpers';
import { LicenseType as WvLicenseType, Widevine } from 'widevine';
import {
  loadWidevineArtifacts,
  WidevineArtifactsError,
  extractPsshFromKeyUri,
  extractKidFromKeyUri,
  normalizeBase64,
} from './widevine';
import {
  extractKeyInfo,
  findPsshKeyUri,
  findVariantPlaylistUrl,
  extractFirstSegmentUrl,
  parseSegmentUrls,
  readM3u8Attribute,
  replaceM3u8Attribute,
  stripM3u8Attribute,
  isHlsUrl,
} from './appleMusicHls';
import { getShippedDeveloperToken, buildBaseHeaders, scrapeBearerToken, describeFetchError } from './appleMusicAuth';
import { gunzipSync } from 'zlib';
import { Agent } from 'undici';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { resolveProxyHost, resolveProxyPort } from '@/shared/urlProxy';
import { pruneExpiredSessions, type StreamProxyRoute } from '@/shared/streamProxyRoute';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

const APPLE_MUSIC_API_BASE = 'https://amp-api.music.apple.com/v1';
const WEBPLAYBACK_URL = 'https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback';

const BEARER_TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Apple Music's web-playback tier serves AAC-LC 44.1 kHz stereo for every asset
 * (verified with ffprobe against a live asset: codec_name=aac, profile=LC,
 * sample_rate=44100, channels=2, ~285 kbps).
 *
 * Declaring it lets the engine skip resampling to a 48 kHz sink, which otherwise
 * alters every sample and inflates a FLAC-encoded output roughly 2.7x for no gain.
 * We deliberately declare no bitDepth: the source is lossy, so there is no
 * original sample depth worth preserving.
 *
 * If Apple ever ships a different rate, the worst case is that ffmpeg resamples
 * as it does today — the engine only skips the resampler when the *negotiated*
 * output rate already equals the declared one.
 */
const APPLE_MUSIC_NATIVE_FORMAT = {
  sampleRate: 44100,
  channels: 2,
  lossless: false,
  codecName: 'aac',
} as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type AppleMusicPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
  errorReason?: string;
};

type AppleMusicTrackRequest = {
  providerId: string;
  trackId: string;
  isLibrary: boolean;
  bridge: StreamingServiceConfig;
};

type BearerState = {
  token?: string;
  fetchedAt: number;
  inFlight?: Promise<string | null>;
};

type AppleMusicProxySession = {
  id: string;
  streamUrl: string;
  headers?: Record<string, string>;
  keyBytes?: Buffer;
  createdAt: number;
  playlist?: string;
  playlistBaseUrl?: string;
  initUrl?: string;
  segmentUrls?: string[];
};

type AppleMusicDrmStreamInfo = {
  fileUrl: string;
  keyUri?: string;
};

type AppleMusicDrmKeyCacheEntry = {
  key?: string;
  expiresAt: number;
  inFlight?: Promise<DrmKeyResult>;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

const DRM_KEY_TTL_MS = 60 * 60 * 1000;
const WIDEVINE_MISSING_REASON = 'widevine missing';

type DrmKeyResult = {
  key: string | null;
  errorReason?: string;
};

export class AppleMusicStreamService {
  private readonly log = createLogger('Content', 'AppleMusicStream');
  private readonly proxyAgent = new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connections: 10,
    pipelining: 1,
  });

  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly bearerTokens = new Map<string, BearerState>();
  private readonly proxySessions = new Map<string, AppleMusicProxySession>();
  private readonly drmKeyCache = new Map<string, AppleMusicDrmKeyCacheEntry>();
  private readonly storefrontByBridge = new Map<string, string>();
  private readonly proxyHost = resolveProxyHost();
  private readonly proxyPort = resolveProxyPort();
  private readonly configPort: ConfigPort;

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
    const appleBridges = bridges.filter((b) => (b.provider || '').toLowerCase() === 'applemusic');
    const single = appleBridges.length <= 1;
    for (const bridge of appleBridges) {
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
      // Also index under the SERVICE-NATIVE prefix the provider now emits, so a
      // `applemusic[:<slug>]:track:...` audiopath resolves to its bridge.
      const slug = slugFromBridgeId(bridge.id, 'applemusic');
      this.bridgesByProvider.set(`applemusic:${slug}`, bridge);
      if (single) {
        this.bridgesByProvider.set('applemusic', bridge);
      }
    }
  }

  public isAppleMusicProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('applemusic');
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<AppleMusicPlaybackResult> {
    const suppressErrors = options?.suppressErrors === true;
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('apple music stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'apple music invalid request', suppressErrors);
      return { playbackSource: null };
    }

    let headers = await this.buildAuthHeaders(request.bridge);
    if (!headers.authorization) {
      this.log.warn('apple music stream missing bearer token', { zoneId, providerId: request.providerId });
    }

    let webPlayback = await this.fetchWebPlayback(headers, request.trackId, request.isLibrary);
    if (webPlayback?.__error?.authStatus) {
      // Stale bearer: drop it, rebuild auth headers and retry once with a fresh token. (A configured
      // developerToken can't be refreshed, so this only recovers the scraped-bearer path.)
      this.log.info('apple music webPlayback auth failed; refreshing bearer', {
        zoneId,
        status: webPlayback.__error.authStatus,
      });
      this.invalidateBearer(request.bridge);
      headers = await this.buildAuthHeaders(request.bridge);
      webPlayback = await this.fetchWebPlayback(headers, request.trackId, request.isLibrary);
    }
    let streamUrl = extractStreamUrl(webPlayback);
    let drmTrackId = request.trackId;
    let drmIsLibrary = request.isLibrary;
    let failureReason = '';

    // MA-aligned fast path: library tracks frequently expose a direct, unencrypted asset URL.
    // When that URL is not an HLS playlist it needs no Widevine, so play it straight away and
    // skip the catalog/DRM round-trip entirely. HLS/DRM library URLs fall through to the
    // catalog resolution below.
    if (request.isLibrary && streamUrl && !isHlsUrl(streamUrl)) {
      this.log.info('apple music library direct stream (no drm)', {
        zoneId,
        trackId: request.trackId,
      });
      return { playbackSource: await this.buildStreamPlaybackSource(streamUrl, headers, request.bridge) };
    }

    if (request.isLibrary) {
      // Prefer a catalog stream for library tracks: catalog assets get DRM licenses where the
      // library asset often does not. resolvePlayableCatalog walks the stored catalogId, the live
      // catalog relationship, and finally an exact metadata search (music-assistant #4109) so a
      // deprecated/pulled catalog version is transparently replaced by the current one.
      const librarySongId = webPlayback && !webPlayback.__error ? asId(webPlayback.songId) : undefined;
      const resolved = await this.resolvePlayableCatalog(headers, request.bridge, request.trackId, librarySongId);
      if (resolved) {
        this.log.info('apple music library using catalog playback for drm', {
          zoneId,
          trackId: request.trackId,
          catalogId: resolved.catalogId,
          via: resolved.via,
        });
        webPlayback = resolved.webPlayback;
        streamUrl = resolved.streamUrl;
        drmTrackId = resolved.catalogId;
        drmIsLibrary = false;
      }
      // If resolve failed but the library webPlayback yielded an HLS streamUrl, we keep it and let
      // the DRM path below try the library asset (unchanged). If there is no streamUrl at all, the
      // !streamUrl block below reports the underlying webPlayback error (e.g. 3076 unavailable).
    }

    if (!streamUrl) {
      const webPlaybackError = webPlayback?.__error as
        | { failureType?: string; customerMessage?: string; keys?: string[]; authStatus?: number }
        | undefined;
      if (!failureReason && webPlaybackError?.authStatus) {
        failureReason = `apple music auth rejected (${webPlaybackError.authStatus})`;
      }
      if (!failureReason && webPlaybackError) {
        const details = [
          webPlaybackError.failureType,
          webPlaybackError.customerMessage,
        ].filter(Boolean);
        failureReason = details.length
          ? `apple music webPlayback missing songList (${details.join(' | ')})`
          : 'apple music webPlayback missing songList';
      }
      this.log.warn('apple music stream url unavailable', {
        zoneId,
        trackId: request.trackId,
        failureType: webPlaybackError?.failureType,
      });
      this.reportPlaybackError(zoneId, failureReason || 'apple music stream url unavailable', suppressErrors);
      return { playbackSource: null };
    }

    const requiresDrm = await this.detectDrm(streamUrl, headers);
    if (!requiresDrm) {
      return { playbackSource: await this.buildStreamPlaybackSource(streamUrl, headers, request.bridge) };
    }

    const drmHandled = await this.tryPrepareDrmStream(
      headers,
      streamUrl,
      drmTrackId,
      drmIsLibrary,
      request.bridge,
      webPlayback,
    );
    if (drmHandled?.playbackSource) return drmHandled;

    if (drmHandled?.errorReason) {
      this.log.warn('apple music stream blocked; drm not available', {
        zoneId,
        trackId: request.trackId,
        reason: drmHandled.errorReason,
      });
      this.reportPlaybackError(zoneId, drmHandled.errorReason, suppressErrors);
      return { playbackSource: null };
    }

    this.log.warn('apple music stream blocked; drm not available', { zoneId, trackId: request.trackId });
    this.reportPlaybackError(zoneId, 'apple music drm unavailable', suppressErrors);
    return { playbackSource: null };
  }

  private reportPlaybackError(zoneId: number | undefined, reason: string, suppressErrors = false): void {
    if (suppressErrors) return;
    // No zone to route the error to (ephemeral/non-zone requester) — stay silent.
    if (zoneId == null) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): AppleMusicTrackRequest | null {
    const parsed = parseTrackAudiopath(audiopath);
    if (!parsed || parsed.kind !== 'track') return null;
    const trackId = parsed.id;
    // Apple library IDs are prefixed a./i./l./p. (artist/item/album/playlist), so a
    // path can be a library one without saying so in its kind. Only Apple has that.
    const isLibrary = parsed.isLibrary || /^[ailp]\./i.test(trackId);
    const providerKey = parsed.providerKey;

    const bridge = findBridgeForProviderKey(
      providerKey,
      this.bridgesByProvider,
      this.bridgesById,
    );
    if (!bridge) return null;

    return { providerId: providerKey, trackId, isLibrary, bridge };
  }

  private async fetchWebPlayback(
    headers: Record<string, string>,
    trackId: string,
    isLibrary: boolean,
  ): Promise<any | null> {
    const normalizedTrackId = isLibrary ? trackId : normalizeSalableAdamId(trackId);
    const payload: Record<string, any> = {
      'user-initiated': true,
    };
    if (isLibrary) {
      payload.universalLibraryId = trackId;
      payload.isLibrary = true;
    } else {
      payload.salableAdamId = normalizedTrackId;
    }
    const body = JSON.stringify(payload);

    // One retry on transient failures (network error / 429 / 5xx). A response that parses but is
    // missing songList is a genuine content problem, so we return it without retrying.
    const maxAttempts = 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetch(WEBPLAYBACK_URL, { method: 'POST', headers, body });

        if (!res.ok) {
          const text = await safeReadText(res, '', {
            onError: 'debug',
            log: this.log,
            label: 'apple music web playback read failed',
            context: { status: res.status },
          });
          this.log.warn('apple music webPlayback failed', {
            status: res.status,
            attempt: attempt + 1,
            body: text ? text.slice(0, 200) : undefined,
          });
          if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          // Signal auth failures so the caller can refresh a stale bearer and retry once.
          if (res.status === 401 || res.status === 403) {
            return { __error: { authStatus: res.status } };
          }
          return null;
        }

        const data = (await res.json()) as Record<string, any> | null;
        const song = data?.songList?.[0];
        if (!song) {
          const keys = data && typeof data === 'object' ? Object.keys(data) : undefined;
          const failureType = data?.failureType ?? data?.['failureType'];
          const customerMessage = data?.customerMessage ?? data?.['customerMessage'];
          this.log.warn('apple music webPlayback missing songList', {
            keys,
            failureType,
            customerMessage,
          });
          return {
            __error: {
              failureType: typeof failureType === 'string' ? failureType : undefined,
              customerMessage: typeof customerMessage === 'string' ? customerMessage : undefined,
              keys,
            },
          };
        }
        if (song && data?.['hls-key-server-url'] && !song['hls-key-server-url']) {
          song['hls-key-server-url'] = data['hls-key-server-url'];
        }
        return song ?? null;
      } catch (err) {
        this.log.warn('apple music webPlayback error', {
          attempt: attempt + 1,
          message: err instanceof Error ? err.message : String(err),
        });
        if (attempt < maxAttempts - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        return null;
      }
    }
    return null;
  }

  private async detectDrm(streamUrl: string, headers: Record<string, string>): Promise<boolean> {
    const playlist = await this.fetchText(streamUrl, headers);
    if (!playlist) return false;
    return /#EXT-X-KEY/i.test(playlist);
  }

  private async tryPrepareDrmStream(
    headers: Record<string, string>,
    streamUrl: string,
    trackId: string,
    isLibrary: boolean,
    bridge: StreamingServiceConfig,
    webPlayback?: any,
  ): Promise<AppleMusicPlaybackResult | null> {
    const drmStreamInfo = await this.resolveCtrp256StreamInfo(webPlayback, headers);
    const playbackUrl = drmStreamInfo?.fileUrl ?? streamUrl;
    let playlist = await this.fetchText(streamUrl, headers);
    if (!playlist) {
      this.log.warn('apple music drm check failed; playlist unavailable');
      return null;
    }

    const variantUrl = findVariantPlaylistUrl(playlist, streamUrl);
    if (variantUrl) {
      this.log.debug('Apple Music DRM: resolved variant playlist', { variantUrl });
    }
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) {
        playlist = variantPlaylist;
      } else {
        this.log.warn('Apple Music DRM: failed to fetch variant playlist', { variantUrl });
      }
    }

    const keyInfo = extractKeyInfo(playlist);
    let keyUri = keyInfo?.uri ?? null;

    if (keyUri && !extractPsshFromKeyUri(keyUri)) {
      this.log.debug('Apple Music DRM: key URI missing PSSH; searching fallback', {
        keyUri,
        keyLine: keyInfo?.line,
      });
      const fallbackUri = findPsshKeyUri(playlist);
      if (fallbackUri) keyUri = fallbackUri;
    }

    if (!keyUri || !extractPsshFromKeyUri(keyUri)) {
      const assetKey = await this.findKeyUriFromAssets(webPlayback, headers);
      if (assetKey) keyUri = assetKey;
    }
    if (!keyUri && drmStreamInfo?.keyUri) {
      keyUri = drmStreamInfo.keyUri;
    }

    if (!keyUri) {
      return { playbackSource: await this.buildStreamPlaybackSource(playbackUrl, headers, bridge) };
    }

    const licenseUrl = normalizeLicenseUrl(webPlayback?.['hls-key-server-url']);
    if (!licenseUrl) {
      this.log.warn('Apple Music DRM: missing license URL in playback metadata', { trackId, isLibrary });
      return null;
    }
    const drmKeyResult = await this.fetchDrmKey(
      headers,
      licenseUrl,
      keyUri,
      keyInfo?.format,
      trackId,
      isLibrary,
    );
    if (!drmKeyResult.key) {
      return { playbackSource: null, errorReason: drmKeyResult.errorReason };
    }

    this.log.info('DRM key ready, streaming with decryption', {
      keyPreview: `${drmKeyResult.key.slice(0, 16)}...`,
    });
    return {
      playbackSource: await this.buildStreamPlaybackSource(playbackUrl, headers, bridge, drmKeyResult.key),
    };
  }

  private async fetchDrmKey(
    headers: Record<string, string>,
    licenseUrl: string,
    keyUri: string,
    _keyFormat: string | undefined,
    trackId: string,
    isLibrary: boolean,
  ): Promise<DrmKeyResult> {
    const cacheKey = buildDrmCacheKey(trackId, isLibrary);
    const now = Date.now();
    const cached = this.drmKeyCache.get(cacheKey);
    if (cached?.key && cached.expiresAt > now) {
      this.log.debug('Apple Music DRM: using cached key', {
        trackId,
        isLibrary,
        expiresInMs: cached.expiresAt - now,
      });
      return { key: cached.key };
    }
    if (cached?.expiresAt && cached.expiresAt <= now && !cached.inFlight) {
      this.drmKeyCache.delete(cacheKey);
    }
    if (cached?.inFlight) {
      const result = await cached.inFlight;
      if (result.key || result.errorReason) {
        return result;
      }
    }
    const inFlight = this.fetchDrmKeyUncached(headers, licenseUrl, keyUri, _keyFormat, trackId, isLibrary);
    this.drmKeyCache.set(cacheKey, {
      key: cached?.key,
      expiresAt: cached?.expiresAt ?? 0,
      inFlight,
    });
    const keyResult = await inFlight;
    const entry = this.drmKeyCache.get(cacheKey);
    if (entry?.inFlight === inFlight) {
      if (keyResult.key) {
        this.drmKeyCache.set(cacheKey, {
          key: keyResult.key,
          expiresAt: Date.now() + DRM_KEY_TTL_MS,
        });
      } else {
        this.drmKeyCache.delete(cacheKey);
      }
    }
    return keyResult;
  }

  private async fetchDrmKeyUncached(
    headers: Record<string, string>,
    licenseUrl: string,
    keyUri: string,
    _keyFormat: string | undefined,
    trackId: string,
    isLibrary: boolean,
  ): Promise<DrmKeyResult> {
    try {
      this.log.info('Apple Music DRM: starting key extraction (new format)', { trackId, isLibrary, keyUri });

      const pssh = extractPsshFromKeyUri(keyUri);
      if (!pssh) {
        this.log.warn('Apple Music DRM: unsupported key URI; missing PSSH data', { keyUri });
        return { key: null };
      }
      const expectedKid = extractKidFromKeyUri(keyUri, pssh);
      const expectedKidHex = expectedKid ? expectedKid.toString('hex') : null;

      let device: ReturnType<typeof Widevine.init>;
      let artifacts: { privateKey: Buffer; clientIdBlob: Buffer };
      try {
        artifacts = await loadWidevineArtifacts();
      } catch (err) {
        if (err instanceof WidevineArtifactsError) {
          this.log.error('Apple Music DRM: Widevine artifacts missing', {
            error: err.message,
            details: err.details,
          });
          return { key: null, errorReason: WIDEVINE_MISSING_REASON };
        }
        this.log.error('Apple Music DRM: Widevine artifacts unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { key: null };
      }

      try {
        device = Widevine.init(artifacts.clientIdBlob, artifacts.privateKey);
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine init failed', {
          error: err instanceof Error ? err.message : String(err),
          usingWvd: false,
        });
        return { key: null };
      }

      let session: ReturnType<typeof device.createSession>;
      try {
        session = device.createSession(pssh, WvLicenseType.STREAMING);
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine session creation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { key: null };
      }

      let challenge: Buffer;
      try {
        challenge = session.generateChallenge();
      } catch (err) {
        this.log.error('Apple Music DRM: Widevine challenge generation failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { key: null };
      }

      const payload = {
        challenge: Buffer.from(challenge).toString('base64'),
        'key-system': 'com.widevine.alpha',
        uri: keyUri,
        adamId: trackId,
        isLibrary,
        'user-initiated': true,
      };

      this.log.debug('Apple Music DRM: requesting license', { licenseUrl });
      const licenseHeaders = buildLicenseHeaders(headers);
      const licenseRes = await fetch(licenseUrl, {
        method: 'POST',
        headers: licenseHeaders,
        body: JSON.stringify(payload),
      });

      if (!licenseRes.ok) {
        const text = await safeReadText(licenseRes, '', {
          onError: 'debug',
          log: this.log,
          label: 'apple music license read failed',
          context: { status: licenseRes.status },
        });
        this.log.warn('License request failed', { status: licenseRes.status, body: text.slice(0, 300) });
        return { key: null };
      }

      const licenseJson = (await licenseRes.json()) as { license?: string; failureType?: string; message?: string };
      if (licenseJson.failureType || licenseJson.message) {
        this.log.warn('License response indicates failure', {
          failureType: licenseJson.failureType,
          message: licenseJson.message,
        });
        return { key: null };
      }
      const licenseBase64 = licenseJson.license;
      if (!licenseBase64) {
        this.log.warn('No license in response');
        return { key: null };
      }

      let license = Buffer.from(normalizeBase64(licenseBase64), 'base64');
      if (license.length >= 2 && license[0] === 0x1f && license[1] === 0x8b) {
        try {
          license = gunzipSync(license);
          this.log.debug('License response was gzipped', { licenseLength: license.length });
        } catch (err) {
          this.log.warn('Failed to gunzip license response', {
            message: err instanceof Error ? err.message : String(err),
          });
          return { key: null };
        }
      }
      this.log.debug('License response header', {
        licenseLength: license.length,
        licenseHeaderHex: license.subarray(0, 12).toString('hex'),
      });

      let keys: Array<{ key?: string } | undefined>;
      try {
        keys = session.parseLicense(license);
      } catch (err) {
        this.log.error('DRM license parse failed', {
          error: err instanceof Error ? err.message : String(err),
          licenseHeaderHex: license.subarray(0, 12).toString('hex'),
        });
        return { key: null };
      }

      if (!keys.length) {
        this.log.warn('No keys in license');
        return { key: null };
      }

      this.log.debug('DRM license keys parsed', {
        expectedKid: expectedKidHex ?? undefined,
        availableKids: keys.map((entry: any) => entry?.kid).filter(Boolean),
      });

      const contentKey = expectedKidHex
        ? keys.find((key: any) => key?.key && String(key?.kid || '').toLowerCase() === expectedKidHex)
        : keys.find((key) => key?.key);
      const keyHex = contentKey?.key;
      if (!keyHex) {
        this.log.warn('No content key found', {
          expectedKid: expectedKidHex ?? undefined,
          availableKids: keys.map((entry: any) => entry?.kid).filter(Boolean),
        });
        return { key: null };
      }
      this.log.info('DRM key extracted successfully', { keyPreview: `${keyHex.slice(0, 16)}...` });
      return { key: keyHex };
    } catch (err) {
      this.log.error('DRM key extraction failed', { error: err instanceof Error ? err.message : String(err) });
      return { key: null };
    }
  }

  private async findKeyUriFromAssets(
    webPlayback: any,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const assets = webPlayback?.assets;
    if (!Array.isArray(assets)) return null;
    const ctrpAsset = assets.find(
      (asset: any) => asset?.flavor === '28:ctrp256' && typeof asset?.URL === 'string',
    );
    const assetUrl = ctrpAsset?.URL;
    if (!assetUrl) return null;

    let playlist = await this.fetchText(assetUrl, headers);
    if (!playlist) return null;

    const variantUrl = findVariantPlaylistUrl(playlist, assetUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) playlist = variantPlaylist;
    }

    const keyInfo = extractKeyInfo(playlist);
    const keyUri = keyInfo?.uri ?? null;
    if (keyUri && extractPsshFromKeyUri(keyUri)) return keyUri;
    return findPsshKeyUri(playlist);
  }

  private async buildStreamPlaybackSource(
    streamUrl: string,
    headers: Record<string, string>,
    bridge: StreamingServiceConfig,
    decryptionKey?: string,
  ): Promise<PlaybackSource> {
    const streamHeaders = buildStreamHeaders(headers);
    if (isHlsUrl(streamUrl)) {
      return this.buildProxyPlaybackSource(streamUrl, streamHeaders, bridge, decryptionKey);
    }
    return this.buildDirectProxyPlaybackSource(streamUrl, streamHeaders, bridge, decryptionKey);
  }

  private async buildDirectProxyPlaybackSource(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    bridge: StreamingServiceConfig,
    decryptionKey?: string,
  ): Promise<PlaybackSource> {
    const { host, port, sessionId } = await this.ensureProxySession(streamUrl, headers, decryptionKey);
    const url = `http://${host}:${port}/applemusic/${sessionId}/segment?u=${encodeURIComponent(streamUrl)}`;
    // DRM-decrypted assets are always fragmented MP4, so pin -f mov for stable probing.
    // Plain library direct assets (no DRM) can be audio/mpeg (matched/uploaded content)
    // as well as mp4 — forcing mov there makes ffmpeg fail with "moov atom not found",
    // so leave the format unset and let ffmpeg auto-detect the container.
    const inputFormat = decryptionKey ? 'mov' : undefined;
    await this.logInputDetails('proxy', streamUrl, headers, inputFormat, sessionId);
    const realTime = resolvePaceInput(bridge);
    if (!realTime) {
      this.log.info('Apple Music pacing disabled (proxy direct)', { inputFormat, sessionId });
    }
    return {
      kind: 'url',
      url,
      inputFormat,
      realTime,
      // Apple Music fragmented MP4 streams are finite and DRM-decrypted; avoid
      // aggressive low-latency probing to reduce premature EOF/truncation.
      lowLatency: false,
      decryptionKey,
      nativeFormat: APPLE_MUSIC_NATIVE_FORMAT,
    };
  }

  private async resolveCtrp256StreamInfo(
    webPlayback: any,
    headers: Record<string, string>,
  ): Promise<AppleMusicDrmStreamInfo | null> {
    const assets = webPlayback?.assets;
    if (!Array.isArray(assets)) return null;
    const ctrpAsset = assets.find(
      (asset: any) => asset?.flavor === '28:ctrp256' && typeof asset?.URL === 'string',
    );
    const assetUrl = ctrpAsset?.URL;
    if (!assetUrl) return null;
    let playlist = await this.fetchText(assetUrl, headers);
    if (!playlist) return null;
    let baseUrl = assetUrl;
    const variantUrl = findVariantPlaylistUrl(playlist, assetUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, headers);
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const fileUrl = extractFirstSegmentUrl(playlist, baseUrl);
    if (!fileUrl) return null;
    const keyInfo = extractKeyInfo(playlist);
    return { fileUrl, keyUri: keyInfo?.uri };
  }

  private async buildProxyPlaybackSource(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    bridge: StreamingServiceConfig,
    decryptionKey?: string,
  ): Promise<PlaybackSource> {
    const { host, port, sessionId } = await this.ensureProxySession(streamUrl, headers, decryptionKey);
    const url = `http://${host}:${port}/applemusic/${sessionId}/playlist.m3u8`;
    await this.logInputDetails('proxy', streamUrl, headers, 'hls', sessionId);
    const realTime = resolvePaceInput(bridge);
    if (!realTime) {
      this.log.info('Apple Music pacing disabled (proxy)', { inputFormat: 'hls', sessionId });
    }
    return {
      kind: 'url',
      url,
      inputFormat: 'hls',
      realTime,
      // Keep parser buffering enabled for better HLS end-of-track stability.
      lowLatency: false,
      nativeFormat: APPLE_MUSIC_NATIVE_FORMAT,
    };
  }

  private async logInputDetails(
    kind: 'direct' | 'proxy',
    streamUrl: string,
    _headers: Record<string, string> | undefined,
    inputFormat?: string,
    sessionId?: string,
  ): Promise<void> {
    this.log.debug('Apple Music input details', {
      kind,
      streamUrl,
      inputFormat,
      sessionId,
    });
  }

  private async ensureProxySession(
    streamUrl: string,
    headers: Record<string, string> | undefined,
    decryptionKey?: string,
  ): Promise<{ host: string; port: number; sessionId: string }> {
    const host = this.proxyHost;
    const port = this.proxyPort;
    this.pruneProxySessions();
    this.pruneDrmKeyCache();
    const sessionId = randomUUID();
    const session: AppleMusicProxySession = {
      id: sessionId,
      streamUrl,
      headers,
      keyBytes: decryptionKey ? Buffer.from(decryptionKey, 'hex') : undefined,
      createdAt: Date.now(),
    };
    this.proxySessions.set(sessionId, session);
    return { host, port, sessionId };
  }

  /**
   * Route served on the shared HTTP gateway (:7090) instead of a per-service
   * ephemeral server. Rewrites HLS playlists and proxies DRM keys / MP4
   * segments for ffmpeg to pull.
   */
  public getProxyRoute(): StreamProxyRoute {
    return {
      matches: (pathname) => pathname.startsWith('/applemusic/'),
      handle: (req, res) => this.handleProxyRequest(req, res),
    };
  }

  private async handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'applemusic') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    // parts.length >= 3 verified above
    const sessionId = parts[1]!;
    const resource = parts[2]!;
    const session = this.proxySessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }

    if (resource === 'playlist.m3u8') {
      const playlist = await this.getProxyPlaylist(session);
      if (!playlist) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(playlist);
      return;
    }

    if (resource === 'key') {
      if (!session.keyBytes) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(session.keyBytes);
      return;
    }

    if (resource === 'segment') {
      const target = url.searchParams.get('u');
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end();
        return;
      }
      await this.proxyUpstreamResponse(req, res, target, session.headers);
      return;
    }

    if (resource === 'stream.mp4') {
      await this.streamConcatenatedMp4(res, session);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end();
  }

  private async getProxyPlaylist(session: AppleMusicProxySession): Promise<string | null> {
    if (session.playlist && session.playlistBaseUrl) {
      return session.playlist;
    }
    let playlist = await this.fetchText(session.streamUrl, session.headers ?? {});
    if (!playlist) return null;
    let baseUrl = session.streamUrl;
    const variantUrl = findVariantPlaylistUrl(playlist, baseUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, session.headers ?? {});
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const rewritten = this.rewritePlaylistForProxy(session, playlist, baseUrl);
    const preview = rewritten.split(/\r?\n/, 2);
    this.log.debug('Apple Music proxy playlist ready', {
      sessionId: session.id,
      length: rewritten.length,
      firstLine: preview[0] ?? '',
      secondLine: preview[1] ?? '',
    });
    session.playlist = rewritten;
    session.playlistBaseUrl = baseUrl;
    return rewritten;
  }

  private rewritePlaylistForProxy(
    session: AppleMusicProxySession,
    playlist: string,
    baseUrl: string,
  ): string {
    const normalized = playlist.startsWith('#EXTM3U') ? playlist : `#EXTM3U\n${playlist}`;
    const sourceLines = normalized.split(/\r?\n/);
    const keyUrl = `http://${this.proxyHost}:${this.proxyPort}/applemusic/${session.id}/key`;
    const output: string[] = [];
    for (const line of sourceLines) {
      if (line.startsWith('#EXT-X-KEY')) {
        let next = replaceM3u8Attribute(line, 'URI', keyUrl);
        next = stripM3u8Attribute(next, 'KEYFORMAT');
        next = stripM3u8Attribute(next, 'KEYFORMATVERSIONS');
        output.push(next);
        continue;
      }
      if (line.startsWith('#EXT-X-MAP')) {
        const mapUri = readM3u8Attribute(line, 'URI');
        if (mapUri) {
          const absolute = new URL(mapUri, baseUrl).toString();
          const proxyUrl = this.buildProxySegmentUrl(session.id, absolute);
          output.push(replaceM3u8Attribute(line, 'URI', proxyUrl));
          continue;
        }
      }
      if (!line || line.startsWith('#')) {
        output.push(line);
        continue;
      }
      const absolute = new URL(line.trim(), baseUrl).toString();
      output.push(this.buildProxySegmentUrl(session.id, absolute));
    }
    return output.join('\n');
  }

  private buildProxySegmentUrl(sessionId: string, targetUrl: string): string {
    const encoded = encodeURIComponent(targetUrl);
    return `http://${this.proxyHost}:${this.proxyPort}/applemusic/${sessionId}/segment?u=${encoded}`;
  }

  private async proxyUpstreamResponse(
    req: IncomingMessage,
    res: ServerResponse,
    targetUrl: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    // Important: do NOT apply a strict "no data for N seconds" body timeout here.
    // The downstream consumer (ffmpeg) can legitimately apply backpressure (pause/seek/output buffering),
    // which would stop us from reading from `response.body` and would make an "idle" timer fire even
    // though the connection is healthy. That leads to truncated MP4s and AAC decode errors.
    //
    // We only enforce a time-to-first-byte (TTFB) timeout; after the first chunk arrives, we let the
    // stream run until the client disconnects or the upstream ends.
    let ttfbTimer: NodeJS.Timeout | null = null;
    let sawFirstByte = false;
    const bumpFirstByte = () => {
      if (sawFirstByte) return;
      sawFirstByte = true;
      if (ttfbTimer) {
        clearTimeout(ttfbTimer);
        ttfbTimer = null;
      }
    };
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (ttfbTimer) {
        clearTimeout(ttfbTimer);
        ttfbTimer = null;
      }
      req.off('aborted', abort);
      res.off('close', abort);
      res.off('close', cleanup);
      res.off('finish', cleanup);
    };
    // ffmpeg is often killed during rapid skips; without aborting the upstream request, undici will
    // keep downloading the MP4 even though nobody is listening anymore, eventually stalling new
    // requests due to connection/resource exhaustion.
    req.on('aborted', abort);
    res.on('close', abort);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    try {
      const upstreamHeaders = sanitizeProxyHeaders(targetUrl, headers);
      const response = await fetch(
        targetUrl,
        upstreamHeaders
          ? { headers: upstreamHeaders, dispatcher: this.proxyAgent as any, signal: controller.signal }
          : { dispatcher: this.proxyAgent as any, signal: controller.signal },
      );
      if (!response.ok || !response.body) {
        let bodyPreview = '';
        try {
          const text = await response.text();
          bodyPreview = text.slice(0, 200);
        } catch {
          bodyPreview = '';
        }
        this.log.warn('Apple Music proxy upstream rejected', {
          status: response.status,
          targetUrl,
          contentType: response.headers.get('content-type') ?? undefined,
          bodyPreview: bodyPreview || undefined,
        });
        res.writeHead(response.status || 502, { 'Content-Type': 'text/plain' });
        res.end(bodyPreview);
        return;
      }
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      this.log.debug('Apple Music proxy upstream ok', {
        targetUrl,
        contentType,
        contentLength: response.headers.get('content-length') ?? undefined,
      });
      res.writeHead(200, { 'Content-Type': contentType });
      const stream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      // TTFB guard: abort if the upstream body never yields any bytes.
      ttfbTimer = setTimeout(() => controller.abort(), 30_000);
      ttfbTimer.unref();
      stream.once('data', bumpFirstByte);
      stream.on('end', cleanup);
      stream.on('close', cleanup);
      stream.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const name = error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
        const aborted = controller.signal.aborted || name === 'AbortError' || message.toLowerCase().includes('aborted');
        if (aborted) {
          this.log.debug('Apple Music proxy stream aborted', {
            targetUrl,
            sawFirstByte,
          });
        } else {
          this.log.warn('Apple Music proxy stream failed', { message, targetUrl });
        }
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (error) {
      cleanup();
      const message = error instanceof Error ? error.message : String(error);
      if (controller.signal.aborted) {
        this.log.debug('Apple Music proxy fetch aborted', { targetUrl });
        // Client went away; nothing to do.
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          res.writeHead(499, { 'Content-Type': 'text/plain' });
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
        return;
      }
      this.log.warn('Apple Music proxy fetch failed', { message, targetUrl });
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
  }

  private async streamConcatenatedMp4(res: ServerResponse, session: AppleMusicProxySession): Promise<void> {
    const segments = await this.ensureSegmentList(session);
    if (!segments || segments.length === 0) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const headers = session.headers;
    const urls = session.initUrl ? [session.initUrl, ...segments] : segments;
    for (const url of urls) {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      const ok = await this.pipeFetchToResponse(url, headers, res);
      if (!ok) return;
    }
    res.end();
  }

  private async ensureSegmentList(session: AppleMusicProxySession): Promise<string[] | null> {
    if (session.segmentUrls && session.segmentUrls.length > 0) {
      return session.segmentUrls;
    }
    let playlist = await this.fetchText(session.streamUrl, session.headers ?? {});
    if (!playlist) return null;
    let baseUrl = session.streamUrl;
    const variantUrl = findVariantPlaylistUrl(playlist, baseUrl);
    if (variantUrl) {
      const variantPlaylist = await this.fetchText(variantUrl, session.headers ?? {});
      if (variantPlaylist) {
        playlist = variantPlaylist;
        baseUrl = variantUrl;
      }
    }
    const { initUrl, segments } = parseSegmentUrls(playlist, baseUrl);
    session.initUrl = initUrl ?? undefined;
    session.segmentUrls = segments;
    return segments;
  }

  private async pipeFetchToResponse(
    targetUrl: string,
    headers: Record<string, string> | undefined,
    res: ServerResponse,
  ): Promise<boolean> {
    try {
      const upstreamHeaders = sanitizeProxyHeaders(targetUrl, headers);
      const response = await fetch(
        targetUrl,
        upstreamHeaders
          ? { headers: upstreamHeaders, dispatcher: this.proxyAgent as any }
          : { dispatcher: this.proxyAgent as any },
      );
      if (!response.ok || !response.body) {
        this.log.warn('Apple Music proxy stream segment failed', {
          status: response.status,
          targetUrl,
        });
        res.end();
        return false;
      }
      const stream = Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
      await new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.on('end', () => resolve());
        stream.pipe(res, { end: false });
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('Apple Music proxy stream segment error', { message, targetUrl });
      res.end();
      return false;
    }
  }

  private pruneProxySessions(): void {
    pruneExpiredSessions(this.proxySessions);
  }

  /** Drop expired DRM key cache entries (those without an in-flight fetch). */
  private pruneDrmKeyCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.drmKeyCache) {
      if (!entry.inFlight && entry.expiresAt && entry.expiresAt <= now) {
        this.drmKeyCache.delete(key);
      }
    }
  }

  /**
   * Fetch with one retry on transient failures (network error / 429 / 5xx). Returns the Response
   * (which may be a non-ok, non-transient status the caller should inspect), or null when every
   * attempt threw. Keeps the stream path resilient to the same hiccups the metadata path retries.
   */
  private async fetchResilient(url: string, init?: RequestInit, maxAttempts = 2): Promise<Response | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const res = await fetch(url, init);
        if (res.ok) return res;
        if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        return res;
      } catch (err) {
        if (attempt < maxAttempts - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        this.log.warn('apple music fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    }
    return null;
  }

  private async fetchJson<T>(url: string, headers: Record<string, string>): Promise<T | null> {
    const res = await this.fetchResilient(url, { headers });
    if (!res || !res.ok) return null;
    try {
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn('apple music json fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async fetchText(url: string, headers?: Record<string, string>): Promise<string | null> {
    const res = await this.fetchResilient(url, headers ? { headers } : undefined);
    if (!res || !res.ok) return null;
    try {
      return await res.text();
    } catch (err) {
      this.log.warn('apple music text fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Resolve a catalog webPlayback for a library track. Tries, in order: the catalogId stored on the
   * library song, the live catalog relationship, and an exact metadata search. Returns the first
   * candidate whose webPlayback yields a stream URL, or null when none are playable.
   */
  private async resolvePlayableCatalog(
    headers: Record<string, string>,
    bridge: StreamingServiceConfig,
    libraryTrackId: string,
    songId?: string,
  ): Promise<{ catalogId: string; webPlayback: any; streamUrl: string; via: 'songId' | 'playParams' | 'relationship' | 'search' } | null> {
    const info = await this.fetchLibraryTrackCatalogInfo(headers, libraryTrackId);
    if (!info) return null;

    const tryCatalog = async (
      catalogId: string,
      via: 'songId' | 'playParams' | 'relationship' | 'search',
    ): Promise<{ catalogId: string; webPlayback: any; streamUrl: string; via: typeof via } | null> => {
      const playback = await this.fetchWebPlayback(headers, catalogId, false);
      const streamUrl = extractStreamUrl(playback);
      if (playback && streamUrl) return { catalogId, webPlayback: playback, streamUrl, via };
      return null;
    };

    // Catalog ids Apple already associates with the library track, in priority order: the webPlayback
    // songId (Apple's live mapping), then the stored playParams id, then the catalog relationship
    // (often the current id after Apple replaces a deprecated album version).
    const sources: Array<['songId' | 'playParams' | 'relationship', string | undefined]> = [
      ['songId', songId],
      ['playParams', info.playParamsCatalogId],
      ['relationship', info.relationshipCatalogId],
    ];
    const seen = new Set<string>();
    for (const [via, id] of sources) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const hit = await tryCatalog(id, via);
      if (hit) return hit;
    }
    const known = [...seen];

    // Stored ids are unavailable (deprecated/pulled). Apple still serves a current version under a
    // new catalog id; find it by exact metadata match (music-assistant #4109).
    const replacement = await this.findReplacementCatalogId(headers, bridge, info);
    if (replacement && !known.includes(replacement)) {
      const hit = await tryCatalog(replacement, 'search');
      if (hit) {
        this.log.info('apple music deprecated catalog replaced via search', {
          libraryTrackId,
          deprecatedCatalogId: known[0],
          replacementCatalogId: replacement,
        });
        return hit;
      }
    }
    return null;
  }

  private async fetchLibraryTrackCatalogInfo(
    headers: Record<string, string>,
    trackId: string,
  ): Promise<{ playParamsCatalogId?: string; relationshipCatalogId?: string; name?: string; artistName?: string; albumName?: string } | null> {
    const url = `${APPLE_MUSIC_API_BASE}/me/library/songs/${encodeURIComponent(trackId)}?include=catalog`;
    const data = await this.fetchJson<any>(url, headers);
    const item = data?.data?.[0];
    if (!item) return null;
    const attrs = item.attributes ?? {};
    const playParamsCatalogId = attrs.playParams?.catalogId ?? attrs.catalogId;
    const relationshipCatalogId = item.relationships?.catalog?.data?.[0]?.id;
    const asStr = (v: unknown): string | undefined =>
      v === undefined || v === null ? undefined : String(v);
    return {
      playParamsCatalogId: asStr(playParamsCatalogId),
      relationshipCatalogId: asStr(relationshipCatalogId),
      name: typeof attrs.name === 'string' ? attrs.name : undefined,
      artistName: typeof attrs.artistName === 'string' ? attrs.artistName : undefined,
      albumName: typeof attrs.albumName === 'string' ? attrs.albumName : undefined,
    };
  }

  /**
   * Find the current catalog id for a track whose stored catalog version is gone, by searching the
   * catalog and requiring an exact name + artist (+ album, when known) match — conservative on
   * purpose so we never silently swap in the wrong song.
   */
  private async findReplacementCatalogId(
    headers: Record<string, string>,
    bridge: StreamingServiceConfig,
    info: { name?: string; artistName?: string; albumName?: string },
  ): Promise<string | null> {
    if (!info.name || !info.artistName) return null;
    const storefront = await this.ensureStorefront(headers, bridge);
    if (!storefront) {
      this.log.debug('apple music replacement search skipped: no storefront');
      return null;
    }
    // Keep the term lean — name + artist. Folding the album in too made Apple's search return zero
    // hits for some tracks; the album is still enforced in the match filter below. Strip apostrophes
    // (Apple's search chokes on them) like the provider does.
    const term = [info.name, info.artistName].filter(Boolean).join(' ').replace(/'/g, '');
    const url = new URL(`${APPLE_MUSIC_API_BASE}/catalog/${storefront}/search`);
    url.searchParams.set('term', term);
    url.searchParams.set('types', 'songs');
    url.searchParams.set('limit', '25');
    const data = await this.fetchJson<any>(url.toString(), headers);
    const norm = (s?: string): string => (s ?? '').normalize('NFC').trim().toLowerCase();
    // Distinguish a failed request (fetchJson null) from a genuine empty result set — they need
    // very different follow-up, and conflating them hid whether search even works for this account.
    if (data === null) {
      this.log.warn('apple music replacement search request failed', { storefront, term });
      return null;
    }
    const songs = data?.results?.songs?.data;
    if (!Array.isArray(songs) || songs.length === 0) {
      this.log.debug('apple music replacement search: zero hits', { storefront, term });
      return null;
    }
    const wantName = norm(info.name);
    const wantArtist = norm(info.artistName);
    const wantAlbum = norm(info.albumName);
    const match = songs.find((s: any) => {
      const a = s?.attributes ?? {};
      if (norm(a.name) !== wantName) return false;
      if (norm(a.artistName) !== wantArtist) return false;
      if (wantAlbum && norm(a.albumName) !== wantAlbum) return false;
      return true;
    });
    this.log.debug('apple music replacement search', {
      term,
      candidates: songs.length,
      matched: match ? String(match.id) : null,
    });
    return match?.id ? String(match.id) : null;
  }

  /** Coerce an Apple id (number or string) to a non-empty string, or undefined. */

  private async ensureStorefront(
    headers: Record<string, string>,
    bridge: StreamingServiceConfig,
  ): Promise<string | null> {
    const cached = this.storefrontByBridge.get(bridge.id);
    if (cached) return cached;
    const account = await this.fetchJson<any>(`${APPLE_MUSIC_API_BASE}/me/account?meta=subscription`, headers);
    const storefront = account?.meta?.subscription?.storefront;
    const resolved = storefront ? String(storefront).toLowerCase() : null;
    if (resolved) this.storefrontByBridge.set(bridge.id, resolved);
    return resolved;
  }

  private async buildAuthHeaders(bridge: StreamingServiceConfig): Promise<Record<string, string>> {
    const headers = buildBaseHeaders(bridge.userToken);
    let bearer: string | null = bridge.developerToken ?? getShippedDeveloperToken();
    if (!bearer && bridge.userToken) bearer = await this.ensureBearerToken(bridge);
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return headers;
  }

  /** Drop the cached bearer for a bridge so the next auth-header build re-scrapes a fresh token. */
  private invalidateBearer(bridge: StreamingServiceConfig): void {
    this.bearerTokens.delete(bridge.id);
  }

  private async ensureBearerToken(bridge: StreamingServiceConfig): Promise<string | null> {
    const key = bridge.id;
    const cached = this.bearerTokens.get(key);
    if (cached?.token && Date.now() - cached.fetchedAt < BEARER_TOKEN_TTL_MS) return cached.token;
    if (cached?.inFlight) return cached.inFlight;

    const state: BearerState = cached ?? { fetchedAt: 0 };
    state.inFlight = (async () => {
      try {
        const token = await scrapeBearerToken(buildBaseHeaders(bridge.userToken));
        if (!token) return null;
        state.token = token;
        state.fetchedAt = Date.now();
        return token;
      } catch (err) {
        this.log.warn('apple music bearer fetch failed', { message: describeFetchError(err) });
        return null;
      } finally {
        state.inFlight = undefined;
      }
    })();

    this.bearerTokens.set(key, state);
    return state.inFlight;
  }

}
