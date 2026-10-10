import type { AppleMusicAdminPort } from '@/ports/AppleMusicAdminPort';
import type { TuneInUsernameCheck } from '@/adapters/content/providers/tunein/tuneinAdmin';
import type { SoloistAdminPort } from '@/ports/SoloistAdminPort';
import type { YtMusicAdminPort } from '@/ports/YtMusicAdminPort';
import type { RadioAdminPort } from '@/ports/RadioAdminPort';
import type { OutputDiscoveryPort } from '@/ports/OutputDiscoveryPort';
import type { AdminApiOptions } from '@/adapters/http/adminApi/adminApiHandler';
import { SonnClientApiHandler } from '@/adapters/http/sonnClientApi/sonnClientApiHandler';
import { BeoremoteApiHandler } from '@/adapters/http/beoremote/beoremoteApiHandler';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManagerReadPort, GroupManagerWritePort } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { AlertFilesPort } from '@/ports/AlertFilesPort';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { DlnaLineInService } from '@/adapters/inputs/linein/dlnaLineInService';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import type { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MdnsPort } from '@/ports/MdnsPort';
import type { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import type { MediaServer } from '@/adapters/mediaserver/mediaServer';
import type { MqttPublisher } from '@/adapters/mqtt/mqttPublisher';
import type { WebdavServer } from '@/adapters/webdav/webdavServer';

/**
 * Everything the admin API needs, and nothing else.
 *
 * Twenty-six of `HttpService`'s fifty-two options, eight of which it shares with the public API
 * surface. Naming them is the point: before this, the only way to find out what the admin routes
 * depended on was to read a fifty-two field bag and follow each name by hand.
 */
export type AdminSurfaceDeps = {
  /** Apple Music's management operations; see AppleMusicAdminPort. */
  appleMusicAdmin: AppleMusicAdminPort;
  /** Whether a TuneIn username resolves; see the TuneIn admin module. */
  validateTuneInUsername: (username: string) => Promise<TuneInUsernameCheck>;
  /** Finding a radio station, and hearing one; see RadioAdminPort. */
  radioAdmin: RadioAdminPort;
  /** Soloist's management operations; see SoloistAdminPort. */
  soloistAdmin: SoloistAdminPort;
  /** The YouTube stack's management operations; see YtMusicAdminPort. */
  ytMusicAdmin: YtMusicAdminPort;
  /** Finds playback devices on the network; see OutputDiscoveryPort. */
  outputDiscovery: OutputDiscoveryPort;
    alertFiles: AlertFilesPort;
    audioManager: AudioManager;
    configPort: ConfigPort;
    contentManager: ContentManager;
    customRadioStore: CustomRadioStore;
    favoritesManager: FavoritesManager;
    groupManager: GroupManagerReadPort & GroupManagerWritePort;
    loxoneNotifier: LoxoneWsNotifier;
    mdnsPort: MdnsPort;
    mediaServer?: MediaServer;
    mqttPublisher?: MqttPublisher;
    musicAssistantStreamService: MusicAssistantStreamService;
    notifier: NotifierPort;
    onLoxoneToggle?: (enabled: boolean) => Promise<void>;
    onReinitialize?: () => Promise<boolean>;
    onSoftRestart?: () => Promise<boolean>;
    recentsManager: RecentsManager;
    sendspinLineInService: SendspinLineInService;
    dlnaLineInService?: DlnaLineInService;
    snapcastCore: SnapcastCore;
    sonnCorePeers: SonnCorePeerRegistry;
    spotifyInputService: SpotifyInputService;
    spotifyManagerProvider: SpotifyServiceManagerProvider;
    squeezeliteCore: SqueezeliteCore;
    webdav?: WebdavServer;
    zoneAudioPrefs: ZoneAudioPreferences;
    zoneManager: ZoneManagerFacade;
};

/** The handlers the admin API reaches through rather than owns, plus the port it reports. */
export type AdminSurfaceServices = {
  sonnClientApi: SonnClientApiHandler;
  beoremoteApi: BeoremoteApiHandler;
  httpPort: number;
};

export function createAdminApiDeps(
  deps: AdminSurfaceDeps,
  services: AdminSurfaceServices,
): AdminApiOptions {
  return {
    appleMusicAdmin: deps.appleMusicAdmin,
    validateTuneInUsername: deps.validateTuneInUsername,
    radioAdmin: deps.radioAdmin,
    soloistAdmin: deps.soloistAdmin,
    ytMusicAdmin: deps.ytMusicAdmin,
    outputDiscovery: deps.outputDiscovery,
    onReinitialize: deps.onReinitialize,
    onSoftRestart: deps.onSoftRestart,
    onLoxoneToggle: deps.onLoxoneToggle,
    notifier: deps.notifier,
    loxoneNotifier: deps.loxoneNotifier,
    spotifyManagerProvider: deps.spotifyManagerProvider,
    customRadioStore: deps.customRadioStore,
    zoneManager: deps.zoneManager,
    configPort: deps.configPort,
    spotifyInputService: deps.spotifyInputService,
    sendspinLineInService: deps.sendspinLineInService,
    dlnaLineInService: deps.dlnaLineInService,
    // Start/stop the DLNA advertisement to match its enabled flag, so the Access
    // toggle takes effect at runtime instead of only on the next boot.
    syncMediaServer: async () => {
      const ms = deps.mediaServer;
      if (!ms) return;
      if (ms.isEnabled()) await ms.start();
      else await ms.stop();
    },
    // Same idea for MQTT: connect, disconnect or reconnect to match the saved config
    // so a broker change applies without a restart.
    mqttPublisher: deps.mqttPublisher,
    musicAssistantStreamService: deps.musicAssistantStreamService,
    // Lets the admin UI's drop zone write through the same streaming path the
    // WebDAV share uses, instead of its own base64 endpoint.
    webdav: deps.webdav,
    snapcastCore: deps.snapcastCore,
    squeezeliteCore: deps.squeezeliteCore,
    recentsManager: deps.recentsManager,
    favoritesManager: deps.favoritesManager,
    groupManager: deps.groupManager,
    contentManager: deps.contentManager,
    audioManager: deps.audioManager,
    zoneAudioPrefs: deps.zoneAudioPrefs,
    mdnsPort: deps.mdnsPort,
    sonnCorePeers: deps.sonnCorePeers,
    alertFiles: deps.alertFiles,
    sonnClientApi: services.sonnClientApi,
    beoremoteApi: services.beoremoteApi,
    httpPort: services.httpPort,
  };
}
