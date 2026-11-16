import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { StreamingServiceConfig } from '@/domain/config/types';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { parseTrackAudiopath } from '@/domain/zones/audiopath';
import { findBridgeForProviderKey } from '@/adapters/content/providers/bridgeLookup';
import { slugFromBridgeId } from '@/domain/media/serviceIdentity';
import { buildProxyUrl } from '@/shared/urlProxy';
import {
  SoundCloudClient,
  type SoundCloudTrack,
} from '@/adapters/content/providers/soundcloud/soundcloudClient';

const SC_STREAM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

type SoundCloudPlaybackResult = {
  playbackSource: PlaybackSource | null;
  outputOnly?: boolean;
};

type SoundCloudTrackRequest = {
  providerId: string;
  trackId: string;
  bridge: StreamingServiceConfig;
};

type OutputErrorHandler = (zoneId: number, reason?: string) => void;

/**
 * The transcodings of a track that can be played, best choice first.
 *
 * Progressive mp3 leads because it seeks freely, then HLS mp3. AAC comes last, as the way in for
 * tracks that are no longer offered as mp3 at all: SoundCloud has been moving its catalogue to AAC
 * over HLS, and a track with only those used to be reported as DRM protected when it was not.
 * Anything whose protocol says `encrypted` really is DRM and stays out.
 */
export function orderPlayableTranscodings<T extends { preset?: string; format?: { protocol?: string } }>(
  transcodings: readonly T[],
): T[] {
  const open = transcodings.filter((t) => !(t.format?.protocol ?? '').includes('encrypted'));
  const mp3 = open.filter((t) => (t.preset ?? '').startsWith('mp3'));
  const aac = open.filter((t) => (t.preset ?? '').startsWith('aac'));
  return [
    ...mp3.filter((t) => t.format?.protocol === 'progressive'),
    ...mp3.filter((t) => t.format?.protocol !== 'progressive'),
    ...aac,
  ];
}

/**
 * Resolves playable CDN URLs for SoundCloud tracks. SoundCloud hands us a signed
 * URL (progressive MP3 or HLS) that ffmpeg can pull directly, so unlike
 * Deezer/Tidal there is no local proxy — the resolved URL becomes a `kind:'url'`
 * playback source. Progressive is preferred: its HLS windows can be limited to
 * ~10 min which breaks mid-track seeking (per the MA reference).
 */
export class SoundCloudStreamService {
  private readonly log = createLogger('Content', 'SoundCloudStream');
  private readonly bridgesByProvider = new Map<string, StreamingServiceConfig>();
  private readonly bridgesById = new Map<string, StreamingServiceConfig>();
  private readonly clients = new Map<string, SoundCloudClient>();
  private readonly configPort: ConfigPort;

  constructor(private readonly notifyOutputError: OutputErrorHandler, configPort: ConfigPort) {
    this.configPort = configPort;
  }

  public configureFromConfig(): void {
    this.bridgesByProvider.clear();
    this.bridgesById.clear();
    this.clients.clear();
    const bridges = this.configPort.getConfig().content?.streamingServices ?? [];
    const soundcloudBridges = bridges.filter(
      (b) => (b.provider || '').toLowerCase() === 'soundcloud',
    );
    const single = soundcloudBridges.length <= 1;
    for (const bridge of soundcloudBridges) {
      const providerId = `spotify@${bridge.id}`;
      this.bridgesByProvider.set(providerId, bridge);
      this.bridgesById.set(bridge.id, bridge);
      // Also index under the SERVICE-NATIVE prefix the provider now emits, so a
      // `soundcloud[:<slug>]:track:...` audiopath resolves to its bridge.
      const slug = slugFromBridgeId(bridge.id, 'soundcloud');
      this.bridgesByProvider.set(`soundcloud:${slug}`, bridge);
      if (single) {
        this.bridgesByProvider.set('soundcloud', bridge);
      }
    }
  }

  public isSoundcloudProvider(providerId: string): boolean {
    if (!providerId) return false;
    if (this.bridgesByProvider.has(providerId)) return true;
    const id = providerId.split('@')[1] ?? providerId;
    if (this.bridgesById.has(id)) return true;
    return providerId.toLowerCase().includes('soundcloud');
  }

  public async startStreamForAudiopath(
    zoneId: number | undefined,
    audiopath: string,
    options?: { suppressErrors?: boolean },
  ): Promise<SoundCloudPlaybackResult> {
    const suppressErrors = options?.suppressErrors === true;
    const request = this.parseTrackRequest(audiopath);
    if (!request) {
      this.log.warn('soundcloud stream request unresolved', { zoneId, audiopath });
      this.reportPlaybackError(zoneId, 'soundcloud invalid request', suppressErrors);
      return { playbackSource: null };
    }

    const client = this.clientFor(request);
    const track = await client.apiGet<SoundCloudTrack>(`/tracks/${encodeURIComponent(request.trackId)}`);
    if (!track?.id) {
      this.reportPlaybackError(zoneId, 'soundcloud track data unavailable', suppressErrors);
      return { playbackSource: null };
    }

    const resolved = await this.resolveStreamUrl(client, track);
    if (!resolved.url) {
      // `attempted` means the track advertised plain mp3 transcodings but every
      // signed URL 404'd (or it only exposes *-encrypted-hls) — i.e. SoundCloud
      // serves it via FairPlay DRM, which we cannot decrypt. Distinguish that
      // from a genuine transient failure so the surfaced reason is truthful.
      const reason = resolved.attempted
        ? 'soundcloud track is DRM protected'
        : 'soundcloud stream url unavailable';
      this.log.warn('soundcloud stream unresolved', {
        zoneId,
        trackId: request.trackId,
        drmOnly: resolved.attempted,
      });
      this.reportPlaybackError(zoneId, reason, suppressErrors);
      return { playbackSource: null };
    }

    this.log.info('soundcloud stream ready', {
      zoneId,
      trackId: request.trackId,
      protocol: resolved.protocol,
    });

    const isHls = resolved.protocol === 'hls' || resolved.url.includes('.m3u8');
    // ffmpeg in minimal/sandboxed server environments often lacks DNS, so route
    // the CDN URL through the shared local proxy (:7090/streams/proxy) — the
    // server does the outbound fetch and ffmpeg only talks to 127.0.0.1. Same
    // pattern as the YouTube/YtMusic providers. (For the rare HLS fallback the
    // proxy only fronts the playlist, not its segments; progressive is preferred
    // precisely so the single-URL proxy path is the norm.)
    const headers = { 'User-Agent': SC_STREAM_USER_AGENT };
    const proxiedUrl = buildProxyUrl(resolved.url, headers);
    return {
      playbackSource: {
        kind: 'url',
        url: proxiedUrl ?? resolved.url,
        headers: proxiedUrl ? undefined : headers,
        realTime: false,
        lowLatency: false,
        // ffmpeg needs the demuxer hint for HLS playlists; progressive mp3 is auto-detected.
        ...(isHls ? { inputFormat: 'hls' } : {}),
        // CDN URLs are short-lived; let the engine re-request on transient failures.
        restartOnFailure: true,
      },
    };
  }

  private async resolveStreamUrl(
    client: SoundCloudClient,
    track: SoundCloudTrack,
  ): Promise<{ url: string | null; protocol?: string; attempted: boolean }> {
    const transcodings = track.media?.transcodings ?? [];
    const trackAuth = track.track_authorization;
    // Prefer progressive mp3 (full seeking); fall back to HLS mp3 only if the
    // progressive URL can't be resolved. Ordering the candidates ourselves keeps
    // the two attempts genuinely distinct regardless of the API's list order.
    // *-encrypted-hls transcodings are FairPlay DRM and deliberately skipped.
    const ordered = orderPlayableTranscodings(transcodings);
    // `attempted` records that a plain-mp3 stream was advertised but every
    // signed URL failed — the practical signature of a DRM-only track.
    let attempted = false;
    for (const candidate of ordered) {
      if (!candidate.url) {
        continue;
      }
      attempted = true;
      const url = await client.resolveTranscodingUrl(candidate.url, trackAuth);
      if (url) {
        return { url, protocol: candidate.format?.protocol ?? 'progressive', attempted: true };
      }
    }
    // No mp3 transcodings at all also means DRM-only (encrypted-hls only).
    if (!attempted && transcodings.length > 0) {
      attempted = true;
    }
    return { url: null, attempted };
  }

  private reportPlaybackError(zoneId: number | undefined, reason: string, suppressErrors = false): void {
    if (suppressErrors) return;
    // No zone to route the error to (ephemeral/non-zone requester) — stay silent.
    if (zoneId == null) return;
    const trimmed = reason.trim();
    if (!trimmed) return;
    this.notifyOutputError(zoneId, trimmed);
  }

  private parseTrackRequest(audiopath: string): SoundCloudTrackRequest | null {
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

  private clientFor(request: SoundCloudTrackRequest): SoundCloudClient {
    const existing = this.clients.get(request.providerId);
    if (existing) {
      return existing;
    }
    const client = new SoundCloudClient({
      oauthToken: request.bridge.soundcloudOauthToken,
      clientId: request.bridge.soundcloudClientId,
    });
    this.clients.set(request.providerId, client);
    return client;
  }
}
