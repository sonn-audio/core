import type { AppleMusicAdminPort } from '@/ports/AppleMusicAdminPort';
import type { TuneInUsernameCheck } from '@/adapters/content/providers/tunein/tuneinAdmin';
import type { SoloistAdminPort } from '@/ports/SoloistAdminPort';
import type { YtMusicAdminPort } from '@/ports/YtMusicAdminPort';
import type { RadioAdminPort } from '@/ports/RadioAdminPort';
import { providerTitle } from '@/adapters/content/providerRegistry';
import type { OutputDiscoveryPort } from '@/ports/OutputDiscoveryPort';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@/shared/logging/logger';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { ZoneTransportConfig } from '@/domain/config/types';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { DlnaLineInService } from '@/adapters/inputs/linein/dlnaLineInService';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { WebdavServer } from '@/adapters/webdav/webdavServer';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { GroupManagerReadPort } from '@/application/groups/groupManager';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { loadConfig as loadRuntimeConfig } from '@/config';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MdnsPort } from '@/ports/MdnsPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { MqttPublisher } from '@/adapters/mqtt/mqttPublisher';

export type AdminApiOptions = {
  /** Apple Music's management operations; see AppleMusicAdminPort. */
  appleMusicAdmin: AppleMusicAdminPort;
  /** Whether a TuneIn username resolves; see the TuneIn admin module. */
  validateTuneInUsername: (username: string) => Promise<TuneInUsernameCheck>;
  /** Soloist's management operations; see SoloistAdminPort. */
  soloistAdmin: SoloistAdminPort;
  /** The YouTube stack's management operations; see YtMusicAdminPort. */
  ytMusicAdmin: YtMusicAdminPort;
  /** Finding a radio station, and hearing one; see RadioAdminPort. */
  radioAdmin: RadioAdminPort;
  /** Finds playback devices on the network; see OutputDiscoveryPort. */
  outputDiscovery: OutputDiscoveryPort;
  onReinitialize?: () => Promise<boolean>;
  onSoftRestart?: () => Promise<boolean>;
  onLoxoneToggle?: (enabled: boolean) => Promise<void>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  spotifyManagerProvider: SpotifyServiceManagerProvider;
  customRadioStore: CustomRadioStore;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  spotifyInputService: SpotifyInputService;
  sendspinLineInService: SendspinLineInService;
  dlnaLineInService?: DlnaLineInService;
  syncMediaServer?: () => Promise<void>;
  /** Drives /mqtt/status and applies a saved broker change without a restart. */
  mqttPublisher?: MqttPublisher;
  musicAssistantStreamService: MusicAssistantStreamService;
  /** Shared streaming write path for the admin UI's drop zone. */
  webdav?: WebdavServer;
  snapcastCore: SnapcastCore;
  squeezeliteCore: SqueezeliteCore;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManagerReadPort;
  contentManager: ContentManager;
  audioManager: AudioManager;
  zoneAudioPrefs: ZoneAudioPreferences;
  mdnsPort: MdnsPort;
  sonnCorePeers: SonnCorePeerRegistry;
  alertFiles: AlertFilesPort;
  sonnClientApi: SonnClientApiHandler;
  beoremoteApi: BeoremoteApiHandler;
  /** Gateway port, so handlers can build client-facing URLs. */
  httpPort: number;
};

import type { Route } from '@/adapters/http/adminApi/routeTypes';
import {
  AdminSessionStore,
  isPublicAdminApiRoute,
} from '@/adapters/http/adminApi/auth/adminSessionStore';
import { MiniserverAuthClient } from '@/adapters/http/adminApi/auth/miniserverAuthClient';
import { buildAuthRoutes } from '@/adapters/http/adminApi/auth/authHandlers';
import { buildAppleMusicRoutes } from '@/adapters/http/adminApi/applemusic/appleMusicHandlers';
import { buildAlertsRoutes } from '@/adapters/http/adminApi/alerts/alertsHandlers';
import { buildSubsonicRoutes } from '@/adapters/http/adminApi/subsonic/subsonicHandlers';
import { buildMqttRoutes } from '@/adapters/http/adminApi/mqtt/mqttHandlers';
import { hasAdminUser } from '@/application/auth/localUsers';
import { buildUsersRoutes } from '@/adapters/http/adminApi/users/usersHandlers';
import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import { buildTransportsRoutes } from '@/adapters/http/adminApi/transports/transportsHandlers';
import { buildContentRoutes } from '@/adapters/http/adminApi/content/contentHandlers';
import {
  buildZonesRoutes,
  STATE_CONTROLLER_DEFINITIONS,
} from '@/adapters/http/adminApi/zones/zonesHandlers';
import { buildSpotifyRoutes } from '@/adapters/http/adminApi/spotify/spotifyHandlers';
import { buildYtDlpRoutes } from '@/adapters/http/adminApi/ytdlp/ytdlpHandlers';
import { buildYtMusicRoutes } from '@/adapters/http/adminApi/ytmusic/ytmusicHandlers';
import { buildMiscRoutes } from '@/adapters/http/adminApi/misc/miscHandlers';
import { buildConfigRoutes } from '@/adapters/http/adminApi/config/configHandlers';
import { buildSonnClientRoutes } from '@/adapters/http/adminApi/sonnclients/sonnClientAdminHandlers';
import type { SonnClientApiHandler } from '@/adapters/http/sonnClientApi/sonnClientApiHandler';
import { buildBeoremoteRoutes } from '@/adapters/http/adminApi/beoremote/beoremoteAdminHandlers';
import type { BeoremoteApiHandler } from '@/adapters/http/beoremote/beoremoteApiHandler';
import {
  readBinaryBody,
  readJsonBody,
  sendHtml,
  sendJson,
} from '@/adapters/http/adminApi/helpers/httpUtils';
import { ClockOffsetTracker } from '@/adapters/http/adminApi/helpers/clockOffset';

export type AdminSqueezelitePlayerSnapshot = {
  mac: string | null;
  name: string | null;
  connected: boolean;
};

type SqueezelitePlayerLike = {
  playerId?: string | null;
  name?: string | null;
};

export function buildSqueezeliteAdminPlayerSnapshot(
  output: ZoneTransportConfig | null | undefined,
  players: SqueezelitePlayerLike[],
): AdminSqueezelitePlayerSnapshot | undefined {
  const outputId = stringValue(output?.id).toLowerCase();
  if (outputId !== 'squeezelite') {
    return undefined;
  }
  const configuredPlayerId = stringValue((output as { playerId?: unknown }).playerId);
  const configuredPlayerName = stringValue((output as { playerName?: unknown }).playerName);
  const normalizedPlayerId = normalizeSqueezelitePlayerId(configuredPlayerId);
  const normalizedPlayerName = normalizeSqueezelitePlayerName(configuredPlayerName);
  const player =
    players.find((entry) => {
      if (normalizedPlayerId) {
        return normalizeSqueezelitePlayerId(entry.playerId) === normalizedPlayerId;
      }
      if (normalizedPlayerName) {
        return normalizeSqueezelitePlayerName(entry.name) === normalizedPlayerName;
      }
      return false;
    }) ?? (!normalizedPlayerId && !normalizedPlayerName && players.length === 1 ? players[0] : null);
  return {
    mac: formatSqueezeliteMac(player?.playerId) ?? formatSqueezeliteMac(configuredPlayerId),
    name: stringValue(player?.name) || configuredPlayerName || null,
    connected: Boolean(player),
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSqueezelitePlayerId(value: unknown): string {
  return stringValue(value).replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function normalizeSqueezelitePlayerName(value: unknown): string {
  return stringValue(value).toLowerCase();
}

function formatSqueezeliteMac(value: unknown): string | null {
  const normalized = normalizeSqueezelitePlayerId(value);
  if (normalized.length !== 12) {
    return null;
  }
  return normalized
    .match(/.{2}/g)!
    .join(':')
    .toUpperCase();
}

export class AdminApiHandler {
  private readonly log = createLogger('Http', 'AdminApi');
  private readonly runtimeConfig = loadRuntimeConfig();
  private readonly onReinitialize?: () => Promise<boolean>;
  private readonly onSoftRestart?: () => Promise<boolean>;
  private readonly onLoxoneToggle?: (enabled: boolean) => Promise<void>;
  private readonly notifier: NotifierPort;
  private readonly loxoneNotifier: LoxoneWsNotifier;
  private readonly spotifyManagerProvider: SpotifyServiceManagerProvider;
  private readonly customRadioStore: CustomRadioStore;
  private readonly zoneManager: ZoneManagerFacade;
  private readonly configPort: ConfigPort;
  private readonly outputDiscovery: OutputDiscoveryPort;
  private readonly ytMusicAdmin: YtMusicAdminPort;
  private readonly radioAdmin: RadioAdminPort;
  private readonly soloistAdmin: SoloistAdminPort;
  private readonly appleMusicAdmin: AppleMusicAdminPort;
  private readonly validateTuneInUsername: AdminApiOptions['validateTuneInUsername'];
  private readonly spotifyInputService: SpotifyInputService;
  private readonly sendspinLineInService: SendspinLineInService;
  private readonly dlnaLineInService?: DlnaLineInService;
  private readonly syncMediaServer?: () => Promise<void>;
  private readonly mqttPublisher?: MqttPublisher;
  private readonly musicAssistantStreamService: MusicAssistantStreamService;
  private readonly webdav?: WebdavServer;
  private readonly snapcastCore: SnapcastCore;
  private readonly squeezeliteCore: SqueezeliteCore;
  private readonly recentsManager: RecentsManager;
  private readonly favoritesManager: FavoritesManager;
  private readonly groupManager: GroupManagerReadPort;
  private readonly contentManager: ContentManager;
  private readonly audioManager: AudioManager;
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly mdns: MdnsPort;
  private readonly sonnCorePeers: SonnCorePeerRegistry;
  private readonly alertFiles: AlertFilesPort;
  private readonly sonnClientApi: SonnClientApiHandler;
  private readonly beoremoteApi: BeoremoteApiHandler;
  private readonly httpPort: number;
  private readonly clockOffsetTracker = new ClockOffsetTracker(this.log);
  private readonly routes: Route[];
  private readonly sessionStore = new AdminSessionStore();
  private readonly miniserverAuthClient = new MiniserverAuthClient();

  constructor(options: AdminApiOptions) {
    this.onReinitialize = options.onReinitialize;
    this.onSoftRestart = options.onSoftRestart;
    this.onLoxoneToggle = options.onLoxoneToggle;
    this.notifier = options.notifier;
    this.loxoneNotifier = options.loxoneNotifier;
    this.spotifyManagerProvider = options.spotifyManagerProvider;
    this.customRadioStore = options.customRadioStore;
    this.zoneManager = options.zoneManager;
    this.configPort = options.configPort;
    this.outputDiscovery = options.outputDiscovery;
    this.ytMusicAdmin = options.ytMusicAdmin;
    this.soloistAdmin = options.soloistAdmin;
    this.appleMusicAdmin = options.appleMusicAdmin;
    this.validateTuneInUsername = options.validateTuneInUsername;
    this.radioAdmin = options.radioAdmin;
    this.spotifyInputService = options.spotifyInputService;
    this.sendspinLineInService = options.sendspinLineInService;
    this.dlnaLineInService = options.dlnaLineInService;
    this.syncMediaServer = options.syncMediaServer;
    this.mqttPublisher = options.mqttPublisher;
    this.musicAssistantStreamService = options.musicAssistantStreamService;
    this.webdav = options.webdav;
    this.snapcastCore = options.snapcastCore;
    this.squeezeliteCore = options.squeezeliteCore;
    this.recentsManager = options.recentsManager;
    this.favoritesManager = options.favoritesManager;
    this.groupManager = options.groupManager;
    this.contentManager = options.contentManager;
    this.audioManager = options.audioManager;
    this.zoneAudioPrefs = options.zoneAudioPrefs;
    this.mdns = options.mdnsPort;
    this.sonnCorePeers = options.sonnCorePeers;
    this.alertFiles = options.alertFiles;
    this.sonnClientApi = options.sonnClientApi;
    this.beoremoteApi = options.beoremoteApi;
    this.httpPort = options.httpPort;
    this.routes = this.buildRoutes();
  }

  public matches(pathname: string): boolean {
    return this.normalizeApiPath(pathname) !== null;
  }

  private normalizeApiPath(pathname: string): string | null {
    const raw = (pathname.split('?')[0] ?? '').trim() || '/';
    if (!raw.startsWith('/admin/api')) {
      return null;
    }
    const suffix = raw.slice('/admin/api'.length);
    const trimmed = suffix.replace(/\/+$/, '');
    if (!trimmed) {
      return '/';
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  private buildRoutes(): Route[] {
    return [
      ...buildAppleMusicRoutes({
        appleMusicAdmin: this.appleMusicAdmin,
        log: this.log,
        readBinaryBody: (req, res, max) => readBinaryBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
        sendHtml: (res, status, html) => sendHtml(res, status, html),
      }),
      ...buildYtDlpRoutes({
        log: this.log,
        ytMusicAdmin: this.ytMusicAdmin,
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildYtMusicRoutes({
        log: this.log,
        ytMusicAdmin: this.ytMusicAdmin,
        configPort: this.configPort,
        readJsonBody: (req, res) => readJsonBody(req, res),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildSpotifyRoutes({
        log: this.log,
        ytMusicAdmin: this.ytMusicAdmin,
        soloistAdmin: this.soloistAdmin,
        configPort: this.configPort,
        notifier: this.notifier,
        contentManager: this.contentManager,
        spotifyInputService: this.spotifyInputService,
        spotifyManagerProvider: this.spotifyManagerProvider,
        zoneManager: this.zoneManager,
        musicAssistantStreamService: this.musicAssistantStreamService,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        readBinaryBody: (req, res, max) => readBinaryBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildAuthRoutes({
        configPort: this.configPort,
        sessionStore: this.sessionStore,
        miniserverAuthClient: this.miniserverAuthClient,
        log: this.log,
        readJsonBody: (req, res) => readJsonBody(req, res),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildMiscRoutes({
        // Same check the auth middleware makes; /info answers either way and varies
        // its payload instead of failing.
        isAuthenticated: (req) => this.sessionStore.getFromRequest(req) !== null,
        log: this.log,
        configPort: this.configPort,
        groupManager: this.groupManager,
        snapcastCore: this.snapcastCore,
        runtimeConfig: this.runtimeConfig,
        onReinitialize: this.onReinitialize,
        onSoftRestart: this.onSoftRestart,
        onLoxoneToggle: this.onLoxoneToggle,
        loxoneNotifier: this.loxoneNotifier,
        sonnCorePeers: this.sonnCorePeers,
        sonnClientVersions: () =>
          this.sonnClientApi
            .listForAdmin()
            .map((device) => device.registration?.version)
            .filter((version): version is string => Boolean(version)),
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildZonesRoutes({
        log: this.log,
        configPort: this.configPort,
        audioManager: this.audioManager,
        zoneAudioPrefs: this.zoneAudioPrefs,
        zoneManager: this.zoneManager,
        favoritesManager: this.favoritesManager,
        recentsManager: this.recentsManager,
        getClockOffsetMs: () => this.clockOffsetTracker.get(),
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildTransportsRoutes({
        log: this.log,
        discovery: this.outputDiscovery,
        configPort: this.configPort,
        mdns: this.mdns,
        snapcastCore: this.snapcastCore,
        squeezeliteCore: this.squeezeliteCore,
        musicAssistantStreamService: this.musicAssistantStreamService,
        stateControllerDefinitions: STATE_CONTROLLER_DEFINITIONS,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildContentRoutes({
        validateTuneInUsername: (username) => this.validateTuneInUsername(username),
        radioAdmin: this.radioAdmin,
        log: this.log,
        contentManager: this.contentManager,
        webdav: this.webdav,
        customRadioStore: this.customRadioStore,
        loxoneNotifier: this.loxoneNotifier,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildConfigRoutes({
        log: this.log,
        configPort: this.configPort,
        contentManager: this.contentManager,
        loxoneNotifier: this.loxoneNotifier,
        sendspinLineInService: this.sendspinLineInService,
        dlnaLineInService: this.dlnaLineInService,
        zoneManager: this.zoneManager,
        syncMediaServer: this.syncMediaServer,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildUsersRoutes({
        log: this.log,
        configPort: this.configPort,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildSubsonicRoutes({
        log: this.log,
        configPort: this.configPort,
        httpPort: this.httpPort,
        listBrowsableServices: (providers) => this.contentManager.listBrowsableServices(providers),
        providerTitle: (provider) => providerTitle(provider),
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildMqttRoutes({
        log: this.log,
        configPort: this.configPort,
        publisher: this.mqttPublisher,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildSonnClientRoutes({
        log: this.log,
        configPort: this.configPort,
        sonnClientApi: this.sonnClientApi,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildBeoremoteRoutes({
        log: this.log,
        beoremoteApi: this.beoremoteApi,
        sendJson: (res, status, payload) => sendJson(res, status, payload),
      }),
      ...buildAlertsRoutes({
        log: this.log,
        readJsonBody: (req, res, max) => readJsonBody(req, res, max),
        sendJson: (res, status, payload) => sendJson(res, status, payload),
        alertFiles: this.alertFiles,
      }),
    ];
  }

  private async dispatchRoute(
    pathname: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    for (const route of this.routes) {
      if (route.method && route.method !== method) {
        continue;
      }
      const match = pathname.match(route.pattern);
      if (!match) {
        continue;
      }
      await route.handler(req, res, match, pathname);
      return true;
    }
    return false;
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rawUrl = req.url ?? '';
    const rawPathname = (rawUrl.split('?')[0] ?? '').trim() || '/';
    const pathname = this.normalizeApiPath(rawPathname);
    if (!pathname) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // Authentication is driven purely by the local admin account created during
      // first-run setup — NOT by Miniserver pairing. So connecting Loxone never
      // forces auth on its own, and a fresh box stays open just long enough to
      // create that first admin (the setup endpoint is public until one exists).
      // Miniserver credentials remain an alternate way to log in once connected.
      // Gating on `hasAdminUser` rather than "any user" matters — a stream-only
      // Subsonic account must not lock an operator out.
      const authRequired = hasAdminUser(this.configPort);
      if (authRequired && !isPublicAdminApiRoute(pathname, method)) {
        const session = this.sessionStore.getFromRequest(req);
        if (!session) {
          sendJson(res, 401, { error: 'auth-required' });
          return;
        }
      }
      const handled = await this.dispatchRoute(pathname, method, req, res);
      if (!handled) {
        this.handleNotImplemented(res, method, rawPathname);
      }
    } catch (err) {
      this.log.error('admin api error', { err });
      sendJson(res, 500, { error: 'admin-api-error' });
    }
  }

  private handleNotImplemented(
    res: ServerResponse,
    method: string,
    url: string,
  ): void {
    this.log.info('admin api stub hit', { method, url });
    sendJson(res, 501, { error: 'admin-api-not-implemented' });
  }
}
