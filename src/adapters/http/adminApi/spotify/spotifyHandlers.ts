import type { SoloistAdminPort } from '@/ports/SoloistAdminPort';
import type { YtMusicAdminPort } from '@/ports/YtMusicAdminPort';
import type { AmazonMusicAdminPort } from '@/ports/AmazonMusicAdminPort';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { StreamingServiceConfig } from '@/domain/config/types';
import {
  buildSpotifyAuthLink,
  deleteSpotifyAccount,
  handleSpotifyOAuthCallback,
} from '@/adapters/content/providers/spotify/serviceAuth';
import {
  handleSoloistBinaryUpload,
  handleSoloistPairing,
  handleSoloistSettings,
  handleSoloistStatus,
} from '@/adapters/http/adminApi/spotify/soloistHandlers';
import type { Route } from '@/adapters/http/adminApi/routeTypes';
import { defaultConfig } from '@/adapters/http/adminApi/config/configHandlers';
import type { MusicAssistantConnectionResult } from '@/adapters/http/adminApi/musicassistant/musicAssistantHelpers';
import {
  isValidMusicAssistantHost,
  testMusicAssistantBridge,
} from '@/adapters/http/adminApi/musicassistant/musicAssistantHelpers';

export type { MusicAssistantConnectionResult };

export type SpotifyHandlerDeps = {
  /** Soloist's management operations, passed through to the Soloist routes. */
  soloistAdmin: SoloistAdminPort;
  /**
   * The YouTube stack's management operations; see YtMusicAdminPort.
   *
   * This screen shares the cookie check and the PO Token URL rules with the YT Music one, so it
   * asks the same object rather than importing the same two modules a second time.
   */
  ytMusicAdmin: YtMusicAdminPort;
  /** Hands over the device registration an Amazon Music sign-in produced, when one is saved. */
  amazonMusicAdmin: AmazonMusicAdminPort;
  log: ComponentLogger;
  configPort: ConfigPort;
  notifier: NotifierPort;
  contentManager: ContentManager;
  spotifyInputService: SpotifyInputService;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  zoneManager: ZoneManagerFacade;
  musicAssistantStreamService: MusicAssistantStreamService;
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  readBinaryBody: (req: IncomingMessage, res: ServerResponse, maxBytes: number) => Promise<Buffer | null>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildSpotifyRoutes(deps: SpotifyHandlerDeps): Route[] {
  return [
    {
      pattern: /^\/spotify\/auth\/callback/,
      handler: async (req, res) =>
        handleSpotifyOAuthCallback(
          req,
          res,
          deps.notifier,
          deps.configPort,
          deps.contentManager,
          deps.spotifyInputService,
        ),
    },
    // Soloist: the only Spotify playback client. Inert until it is given a key.
    {
      method: 'GET',
      pattern: /^\/spotify\/soloist\/status$/,
      handler: async (_req, res) => handleSoloistStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/spotify\/soloist\/settings$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as
          | { apiKey?: string; lossless?: boolean; normalize?: boolean }
          | null;
        if (res.writableEnded) return;
        await handleSoloistSettings(res, deps, body);
      },
    },
    {
      method: 'POST',
      pattern: /^\/spotify\/soloist\/binary$/,
      handler: async (req, res) => handleSoloistBinaryUpload(req, res, deps),
    },
    // Signing an account in, once. Returns at once; the GET reports whether anyone has picked the
    // device in their Spotify app yet.
    {
      method: 'POST',
      pattern: /^\/spotify\/soloist\/pair$/,
      handler: async (req, res) => handleSoloistPairing(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/spotify\/soloist\/pair$/,
      handler: async (req, res) => handleSoloistPairing(req, res, deps),
    },
    {
      method: 'DELETE',
      pattern: /^\/spotify\/accounts\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const accountId = decodeURIComponent(match[1] ?? '');
        await handleSpotifyAccountDelete(accountId, res, deps);
      },
    },
    {
      method: 'GET',
      pattern: /^\/spotify\/accounts\/link$/,
      handler: async (_req, res) => {
        await handleSpotifyAccountLink(res, deps);
      },
    },
    // Neutral streaming-service account routes. Non-Spotify services (Apple
    // Music, Tidal, Deezer, …) are first-class accounts, not "Spotify bridges";
    // the bridge disguise is a Loxone-adapter detail. The legacy
    // /spotify/bridges routes are kept as deprecated aliases.
    {
      method: 'POST',
      pattern: /^\/content\/services$/,
      handler: async (req, res) => {
        await handleStreamingServiceCreate(req, res, deps);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/content\/services\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const serviceId = decodeURIComponent(match[1] ?? '');
        await handleStreamingServiceDelete(serviceId, res, deps);
      },
    },
    // Deprecated aliases (old adminui / cached clients).
    {
      method: 'POST',
      pattern: /^\/spotify\/bridges$/,
      handler: async (req, res) => {
        await handleStreamingServiceCreate(req, res, deps);
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/spotify\/bridges\/([^/]+)$/,
      handler: async (_req, res, match) => {
        const serviceId = decodeURIComponent(match[1] ?? '');
        await handleStreamingServiceDelete(serviceId, res, deps);
      },
    },
  ];
}

async function handleSpotifyAccountDelete(
  accountId: string,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  if (!accountId) {
    deps.sendJson(res, 400, { error: 'invalid-account-id' });
    return;
  }
  try {
    await deleteSpotifyAccount(
      deps.configPort,
      accountId,
      deps.notifier,
      deps.contentManager,
      deps.spotifyInputService,
    );
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('spotify account delete failed', { err, accountId });
    deps.sendJson(res, 500, { error: 'spotify-account-delete-failed' });
  }
}

async function handleSpotifyAccountLink(
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  try {
    const cfg = deps.configPort.getConfig();
    const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';
    const link = buildSpotifyAuthLink({ audioServerHost: host }, deps.configPort);
    deps.sendJson(res, 200, { link });
  } catch (err) {
    deps.log.warn('spotify account link build failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-account-link-failed' });
  }
}

async function handleStreamingServiceCreate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as Partial<StreamingServiceConfig> | null;
  if (res.writableEnded) {
    return;
  }
  const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  if (!provider) {
    deps.sendJson(res, 400, { error: 'invalid-service-payload' });
    return;
  }
  const isMusicAssistant = provider === 'musicassistant';
  if (provider === 'musicassistant') {
    const apiKeyValid = typeof body?.apiKey === 'string' && body.apiKey.trim().length > 0;
    if (!apiKeyValid) {
      deps.sendJson(res, 400, { error: 'api-key-required' });
      return;
    }
  }

  let musicAssistantHost: string | undefined;
  let musicAssistantPort: number | undefined;
  let musicAssistantApiKey: string | undefined;
  let musicAssistantConnection: MusicAssistantConnectionResult | null = null;

  if (isMusicAssistant) {
    const hostRaw = typeof body?.host === 'string' ? body.host.trim() : '';
    const portRaw = body?.port;
    musicAssistantHost = hostRaw || '127.0.0.1';
    musicAssistantPort =
      typeof portRaw === 'number' && Number.isFinite(portRaw) && portRaw > 0
        ? Math.round(portRaw)
        : 8095;
    musicAssistantApiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';

    if (!isValidMusicAssistantHost(musicAssistantHost)) {
      deps.sendJson(res, 400, { error: 'invalid-musicassistant-host', message: 'Invalid Music Assistant host.' });
      return;
    }
    if (!musicAssistantPort || musicAssistantPort < 1 || musicAssistantPort > 65535) {
      deps.sendJson(res, 400, { error: 'invalid-musicassistant-port', message: 'Invalid Music Assistant port.' });
      return;
    }
    if (!musicAssistantApiKey) {
      deps.sendJson(res, 400, { error: 'api-key-required' });
      return;
    }

    const testResult = await testMusicAssistantBridge(
      musicAssistantHost,
      musicAssistantPort,
      musicAssistantApiKey,
    );
    if (!testResult.ok) {
      deps.sendJson(res, 400, {
        error: 'musicassistant-connection-failed',
        message: testResult.message || 'Unable to connect to Music Assistant.',
        host: testResult.host,
        port: testResult.port,
      });
      return;
    }
    musicAssistantConnection = testResult;
  }

  if (provider === 'ytmusic') {
    const pasted = typeof body?.ytmusicCookie === 'string' ? body.ytmusicCookie.trim() : '';
    if (pasted) {
      // Checked here because a YouTube Music cookie can be dead on arrival: YouTube
      // rotates account cookies on open tabs, so one copied out of a live session is
      // often already worthless by the time it is pasted — and it fails silently, as
      // an empty library rather than an error. Saying so now beats letting someone
      // conclude the service is broken.
      const verdict = await deps.ytMusicAdmin.verifyCookie(pasted);
      if (verdict.state === 'expired' || verdict.state === 'invalid') {
        deps.sendJson(res, 400, {
          error: verdict.state === 'invalid' ? 'ytmusic-cookie-invalid' : 'ytmusic-cookie-expired',
          message:
            verdict.message ??
            'This cookie is not signed in any more. YouTube rotates cookies on open tabs, so copy it from a private/incognito window and close that window without signing out.',
        });
        return;
      }
    }
  }

  const generatedId = `bridge-${provider}-${Math.random().toString(36).slice(2, 8)}`;
  const id = typeof body?.id === 'string' && body.id.trim() ? body.id.trim() : generatedId;

  // An Amazon Music account is its device registration, which the sign-in flow holds server-side
  // and hands over by login id. Re-saving an existing account (a new label, say) keeps the one it
  // has; a new account without a finished sign-in has nothing to play with.
  let amazonMusicCredentials: StreamingServiceConfig['amazonMusic'];
  if (provider === 'amazonmusic') {
    const loginId = typeof (body as { amazonMusicLoginId?: unknown } | null)?.amazonMusicLoginId === 'string'
      ? String((body as { amazonMusicLoginId: string }).amazonMusicLoginId)
      : '';
    amazonMusicCredentials = loginId ? deps.amazonMusicAdmin.takeCredentials(loginId) ?? undefined : undefined;
    const existing = (deps.configPort.getConfig().content?.streamingServices ?? []).find(
      (b) => b?.id?.toLowerCase() === id.toLowerCase(),
    );
    if (!amazonMusicCredentials && !existing?.amazonMusic) {
      deps.sendJson(res, 400, {
        error: 'amazonmusic-login-required',
        message: loginId ? 'This sign-in has expired. Sign in to Amazon again.' : 'Sign in to Amazon first.',
      });
      return;
    }
  }
  const defaultLabel =
    provider === 'applemusic'
      ? 'Apple Music'
      : provider === 'musicassistant'
        ? 'Music Assistant'
        : provider === 'deezer'
          ? 'Deezer'
          : provider === 'tidal'
            ? 'Tidal'
            : provider === 'amazonmusic'
              ? 'Amazon Music'
              : provider === 'ytmusic'
                ? 'YouTube Music'
                : id;

  const bridge: StreamingServiceConfig = {
    id,
    label: typeof body?.label === 'string' && body.label.trim() ? body.label.trim() : defaultLabel,
    provider,
    enabled: body?.enabled !== false,
    registerAll: body?.registerAll !== false,
    mode: isMusicAssistant && body?.mode === 'sink' ? 'sink' : isMusicAssistant ? 'source' : undefined,
    accountId: undefined,
    host: isMusicAssistant
      ? musicAssistantHost
      : typeof body?.host === 'string' && body.host.trim()
        ? body.host.trim()
        : undefined,
    port: isMusicAssistant
      ? musicAssistantPort
      : typeof body?.port === 'number' && Number.isFinite(body.port) && body.port > 0
        ? Math.round(body.port)
        : undefined,
    apiKey: isMusicAssistant
      ? musicAssistantApiKey
      : typeof body?.apiKey === 'string' && body.apiKey.trim()
        ? body.apiKey.trim()
        : undefined,
    developerToken:
      typeof body?.developerToken === 'string' && body.developerToken.trim() ? body.developerToken.trim() : undefined,
    userToken: typeof body?.userToken === 'string' && body.userToken.trim() ? body.userToken.trim() : undefined,
    deezerArl: typeof body?.deezerArl === 'string' && body.deezerArl.trim() ? body.deezerArl.trim() : undefined,
    tidalAccessToken:
      typeof body?.tidalAccessToken === 'string' && body.tidalAccessToken.trim()
        ? body.tidalAccessToken.trim()
        : undefined,
    tidalCountryCode:
      typeof body?.tidalCountryCode === 'string' && body.tidalCountryCode.trim()
        ? body.tidalCountryCode.trim().toUpperCase()
        : undefined,
    ytmusicCookie:
      typeof body?.ytmusicCookie === 'string' && body.ytmusicCookie.trim()
        ? body.ytmusicCookie.trim()
        : undefined,
    ytmusicPoTokenUrl: deps.ytMusicAdmin.normalizePotServerUrl(body?.ytmusicPoTokenUrl) || undefined,
    youtubeApiKey:
      typeof body?.youtubeApiKey === 'string' && body.youtubeApiKey.trim()
        ? body.youtubeApiKey.trim()
        : undefined,
    soundcloudOauthToken:
      typeof body?.soundcloudOauthToken === 'string' && body.soundcloudOauthToken.trim()
        ? body.soundcloudOauthToken.trim()
        : undefined,
    soundcloudClientId:
      typeof body?.soundcloudClientId === 'string' && body.soundcloudClientId.trim()
        ? body.soundcloudClientId.trim()
        : undefined,
  };

  // Only when there is a new one: the update below merges over the stored account, and an
  // explicit undefined would erase the registration it already has.
  if (amazonMusicCredentials) {
    bridge.amazonMusic = amazonMusicCredentials;
  }

  try {
    await deps.configPort.updateConfig((cfg) => {
      if (!cfg.content) cfg.content = defaultConfig().content;
      if (!Array.isArray(cfg.content.streamingServices)) cfg.content.streamingServices = [];
      const bridges = cfg.content.streamingServices;
      const idx = bridges.findIndex(
        (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridge.id.toLowerCase(),
      );
      if (idx >= 0) {
        const cleaned = { ...bridges[idx], ...bridge } as StreamingServiceConfig & { storefront?: string };
        delete cleaned.storefront;
        bridges[idx] = cleaned;
      } else {
        const cleaned = bridge as StreamingServiceConfig & { storefront?: string };
        delete cleaned.storefront;
        bridges.push(cleaned);
      }
    });
    deps.contentManager.refreshFromConfig();
    // Unconditionally: the refresh re-reads every provider's config and is cheap, while the
    // list this used to be gated on had gone stale — YouTube was missing, so adding a YouTube
    // service left its stream service without a bridge until the next restart.
    deps.zoneManager.refreshContentProviders();
    deps.musicAssistantStreamService.configureFromConfig();
    const cfg = deps.configPort.getConfig();
    await deps.musicAssistantStreamService.registerZones(cfg.zones ?? []);
    const connection = isMusicAssistant ? musicAssistantConnection ?? undefined : undefined;
    if (connection?.ok) {
      deps.log.info('music assistant connection ok', { host: connection.host, port: connection.port });
    }
    deps.notifier.notifyReloadMusicApp('useradd', bridge.provider || 'spotify', bridge.id);
    deps.sendJson(res, 200, { bridge, connection });
  } catch (err) {
    deps.log.warn('spotify bridge create failed', { err });
    deps.sendJson(res, 500, { error: 'spotify-bridge-create-failed' });
  }
}

async function handleStreamingServiceDelete(
  bridgeId: string,
  res: ServerResponse,
  deps: SpotifyHandlerDeps,
): Promise<void> {
  if (!bridgeId) {
    deps.sendJson(res, 400, { error: 'invalid-service-id' });
    return;
  }
  try {
    const cfgBefore = deps.configPort.getConfig();
    const existing = (cfgBefore.content?.streamingServices ?? []).find(
      (b) => typeof b?.id === 'string' && b.id.trim().toLowerCase() === bridgeId.trim().toLowerCase(),
    );
    await deps.configPort.updateConfig((cfg) => {
      if (!cfg.content?.streamingServices) return;
      const current = cfg.content.streamingServices ?? [];
      cfg.content.streamingServices = current.filter(
        (b) => typeof b?.id !== 'string' || b.id.trim().toLowerCase() !== bridgeId.trim().toLowerCase(),
      );
    });
    deps.contentManager.refreshFromConfig();
    // Same as on create: gating this on a hand-kept list meant deleting a SoundCloud or
    // YouTube service left its stream service holding the bridge that was just removed.
    deps.zoneManager.refreshContentProviders();
    deps.musicAssistantStreamService.configureFromConfig();
    const cfg = deps.configPort.getConfig();
    await deps.musicAssistantStreamService.registerZones(cfg.zones ?? []);
    if (existing) {
      deps.notifier.notifyReloadMusicApp('userdel', existing.provider || 'spotify', existing.id);
    }
    deps.sendJson(res, 204, {});
  } catch (err) {
    deps.log.warn('spotify bridge delete failed', { err, bridgeId });
    deps.sendJson(res, 500, { error: 'spotify-bridge-delete-failed' });
  }
}
