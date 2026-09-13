import type { LoxoneHttpConfig } from '@/config/loxone';
import type { NotifierPort } from '@/ports/NotifierPort';
import { LoxoneRouter } from '@/adapters/loxone/commands/router/loxoneRouter';
import { createSecureHandlers } from '@/adapters/loxone/commands/handlers/secureHandlers';
import { createPlaceholderHandler } from '@/adapters/loxone/commands/handlers/placeholderHandlers';
import { createConfigHandlers } from '@/adapters/loxone/commands/handlers/configHandlers';
import { createProviderHandlers } from '@/adapters/loxone/commands/handlers/providerHandlers';
import { createZoneHandlers } from '@/adapters/loxone/commands/handlers/zoneHandlers';
import { createGlobalSearchHandlers } from '@/adapters/loxone/commands/handlers/globalSearchHandlers';
import { createGroupHandlers } from '@/adapters/loxone/commands/handlers/groupHandlers';
import { createAlertHandlers } from '@/adapters/loxone/commands/handlers/alertHandlers';
import { createInputHandlers } from '@/adapters/loxone/commands/handlers/inputHandlers';
import { createPlaylistEditHandlers } from '@/adapters/loxone/commands/handlers/playlistEditHandlers';
import { createQueueEditHandlers } from '@/adapters/loxone/commands/handlers/queueEditHandlers';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { FavoritesManager } from '@/application/zones/favorites/favoritesManager';
import type { GroupManager } from '@/application/groups/groupManager';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { GroupTrackerPort } from '@/ports/GroupTrackerPort';
import type { FadeControllerPort } from '@/ports/FadeControllerPort';
import type { AlertsPort } from '@/ports/AlertsPort';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';

export interface RouteDependencies {
  config: LoxoneHttpConfig;
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  zoneManager: ZoneManagerFacade;
  configPort: ConfigPort;
  lineInActivationService: LineInActivationService;
  spotifyInputService: SpotifyInputService;
  recentsManager: RecentsManager;
  favoritesManager: FavoritesManager;
  groupManager: GroupManager;
  groupTracker: GroupTrackerPort;
  fadeController: FadeControllerPort;
  alerts: AlertsPort;
  contentManager: ContentManager;
}

/**
 * Registers every known Loxone command route with the shared router.
 */
export function registerRoutes(
  router: LoxoneRouter,
  dependencies: RouteDependencies,
): void {
  const secure = createSecureHandlers(dependencies.configPort);
  const placeholder = (name: string) => createPlaceholderHandler(name);
  const configHandlers = createConfigHandlers(dependencies.config, {
    onRestart: dependencies.onRestart,
    notifier: dependencies.notifier,
    loxoneNotifier: dependencies.loxoneNotifier,
    configService: dependencies.configService,
    configPort: dependencies.configPort,
    contentManager: dependencies.contentManager,
    spotifyInputService: dependencies.spotifyInputService,
  });
  const providerHandlers = createProviderHandlers(dependencies.contentManager, dependencies.loxoneNotifier);
  const globalSearchHandlers = createGlobalSearchHandlers(dependencies.contentManager, dependencies.loxoneNotifier);
  const zoneHandlers = createZoneHandlers(
    dependencies.zoneManager,
    dependencies.recentsManager,
    dependencies.favoritesManager,
    dependencies.contentManager,
    dependencies.configPort,
    dependencies.fadeController,
  );
  const alertHandlers = createAlertHandlers(dependencies.alerts);
  const groupHandlers = createGroupHandlers(
    dependencies.zoneManager,
    dependencies.groupManager,
    dependencies.configPort,
    dependencies.groupTracker,
  );
  const inputHandlers = createInputHandlers(dependencies.configPort, {
    lineIn: dependencies.lineInActivationService,
    notifier: dependencies.loxoneNotifier,
  });
  const playlistEditHandlers = createPlaylistEditHandlers(
    dependencies.contentManager,
    dependencies.loxoneNotifier,
  );
  const queueEditHandlers = createQueueEditHandlers(
    dependencies.zoneManager,
    dependencies.contentManager,
    dependencies.loxoneNotifier,
  );
  router.registerPrefix('secure', 'secure/info/pairing', secure.infoPairing);
  router.registerPrefix('secure', 'secure/hello', secure.hello);
  router.registerPrefix('secure', 'secure/authenticate', secure.authenticate);
  router.registerPrefix('secure', 'secure/init', secure.init);

  router.registerPrefix('audio', 'audio/cfg/globalsearch/describe', globalSearchHandlers.audioCfgGlobalSearchDescribe);
  router.registerPrefix('audio', 'audio/cfg/globalsearch', globalSearchHandlers.audioCfgGlobalSearch);

  router.registerPrefix('audio', 'audio/cfg/getmediafolder', providerHandlers.audioCfgGetMediaFolder);
  router.registerPrefix('audio', 'audio/cfg/rescan', providerHandlers.audioCfgRescan);
  router.registerPrefix('audio', 'audio/cfg/scanstatus', providerHandlers.audioCfgScanStatus);
  router.registerPrefix('audio', 'audio/cfg/storage/add', providerHandlers.audioCfgStorageAdd);
  router.registerPrefix('audio', 'audio/cfg/storage/list', providerHandlers.audioCfgStorageList);
  router.registerPrefix('audio', 'audio/cfg/storage/del', providerHandlers.audioCfgStorageDel);
  router.registerPrefix('audio', 'audio/cfg/getavailableservices', providerHandlers.audioCfgGetAvailableServices);
  router.registerPrefix('audio', 'audio/cfg/getservices', providerHandlers.audioCfgGetServices);
  router.registerPrefix('audio', 'audio/cfg/radios/add', providerHandlers.audioCfgRadiosAdd);
  router.registerPrefix('audio', 'audio/cfg/radios/del', providerHandlers.audioCfgRadiosDel);
  router.registerPrefix('audio', 'audio/cfg/radios/delete', providerHandlers.audioCfgRadiosDel);
  router.registerPrefix('audio', 'audio/cfg/getradios', providerHandlers.audioCfgGetRadios);
  router.registerPrefix('audio', 'audio/cfg/getinputs', inputHandlers.audioCfgGetInputs);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/rename\//, inputHandlers.audioCfgInputRename);
  router.registerRegex('audio', /^audio\/cfg\/input\/[^/]+\/type\//, inputHandlers.audioCfgInputType);
  router.registerPrefix('audio', 'audio/cfg/getservicefolder', providerHandlers.audioCfgGetServiceFolder);
  router.registerPrefix('audio', 'audio/cfg/getplaylists2', providerHandlers.audioCfgGetPlaylists);
  router.registerPrefix('audio', 'audio/cfg/playlist/create/', playlistEditHandlers.create);
  router.registerPrefix('audio', 'audio/cfg/playlist/update/', playlistEditHandlers.update);
  router.registerPrefix('audio', 'audio/cfg/playlist/rename/', playlistEditHandlers.rename);
  router.registerPrefix('audio', 'audio/cfg/playlist/deletelist/', playlistEditHandlers.deleteList);
  router.registerPrefix('audio', 'audio/cfg/isfollowed', providerHandlers.audioCfgIsFollowed);
  router.registerPrefix('audio', 'audio/cfg/follow', providerHandlers.audioCfgFollow);
  router.registerPrefix('audio', 'audio/cfg/unfollow', providerHandlers.audioCfgUnfollow);
  router.registerPrefix('audio', 'audio/cfg/diagnosis', configHandlers.diagnosis);

  router.registerPrefix('audio', 'audio/cfg/getroomfavs', zoneHandlers.audioCfgGetRoomFavs);
  router.registerPrefix('audio', 'audio/cfg/roomfavs/', zoneHandlers.audioCfgRoomFavs);

  router.registerPrefix('audio', 'audio/cfg/miniservertime', configHandlers.miniserverTime);
  router.registerPrefix('audio', 'audio/cfg/getconfig', configHandlers.getConfig);
  router.registerPrefix('audio', 'audio/cfg/ready', configHandlers.ready);
  router.registerPrefix('audio', 'audio/cfg/getkey/full', configHandlers.getKeyFull);
  router.registerPrefix('audio', 'audio/cfg/getkey', configHandlers.getKey);
  router.registerPrefix('audio', 'audio/cfg/setconfigtimestamp', configHandlers.setConfigTimestamp);
  router.registerPrefix('audio', 'audio/cfg/setconfig', configHandlers.setConfig);
  router.registerPrefix('audio', 'audio/cfg/volumes', configHandlers.setVolumes);
  router.registerPrefix('audio', 'audio/cfg/playeropts', placeholder('playeropts'));
  router.registerPrefix('audio', 'audio/cfg/playername', configHandlers.playerName);
  router.registerPrefix('audio', 'audio/cfg/identify', configHandlers.identify);
  router.registerRegex('audio', /^audio\/cfg\/geteq\/\d+\/?$/, zoneHandlers.audioCfgGetEq);
  router.registerRegex('audio', /^audio\/cfg\/equalizer\/\d+(?:\/[^/]+)?\/?$/, zoneHandlers.audioCfgEqualizer);
  router.registerRegex('audio', /^audio\/cfg\/seteq\/\d+\/.+$/, zoneHandlers.audioCfgSetEq);
  router.registerPrefix('audio', 'audio/cfg/restart', configHandlers.restart);
  router.registerPrefix('audio', 'audio/cfg/speakertype', placeholder('speakertype'));
  router.registerPrefix('audio', 'audio/cfg/groupopts', placeholder('groupopts'));
  router.registerPrefix('audio', 'audio/cfg/presencemode', placeholder('presencemode'));
  router.registerPrefix('audio', 'audio/cfg/miniserverip', placeholder('miniserverip'));
  router.registerPrefix('audio', 'audio/cfg/miniserverversion', placeholder('miniserverversion'));
  router.registerPrefix('audio', 'audio/cfg/timezone', placeholder('timezone'));
  router.registerPrefix('audio', 'audio/cfg/servicecfg/getlink', configHandlers.serviceCfgGetLink);
  router.registerPrefix('audio', 'audio/cfg/servicecfg/delete', configHandlers.serviceCfgDelete);
  router.registerPrefix('audio', 'audio/cfg/upload/audioupload/add/', alertHandlers.audioCfgUploadAudiouploadAdd);

  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/status\/?$/, zoneHandlers.audioGetStatus);
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/getqueue(?:\/\d+\/\d+(?:\/\d+)?)?\/?$/,
    zoneHandlers.audioCfgGetQueue,
  );
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/recent(?:\/(?:\d+|clear))?\/?$/,
    zoneHandlers.audioRecent,
  );
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/serviceplay\/.+$/, zoneHandlers.audioServicePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playlist\/play\/.+$/, zoneHandlers.audioPlaylistPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/library\/play\/.+$/, zoneHandlers.audioLibraryPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/play\//, zoneHandlers.audioFavoritePlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/roomfav\/plus\/?$/, zoneHandlers.audioRoomFavPlus);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playurl\/.+$/, zoneHandlers.audioPlayUrl);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/equalizersettings\/[^/]+\/?$/, zoneHandlers.audioEqualizerSettings);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/linein(?:\/.*)?$/, inputHandlers.audioLineIn);

  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/tts\/.+\/\d+\/?$/, alertHandlers.audioZoneTts);
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/(?:alarm|firealarm|bell|wecker|buzzer|clock|alarmclock)(?:\/\d+)?\/?$/,
    alertHandlers.audioZoneAlert,
  );

  router.registerRegex('audio', /^audio\/grouped\/(pause|play|resume|stop)\//, groupHandlers.audioGroupedPlayback);
  router.registerRegex('audio', /^audio\/grouped\/volume\//, groupHandlers.audioGroupedVolume);
  router.registerRegex('audio', /^audio\/grouped\/playuploadedfile\//, alertHandlers.audioPlayUploadedAlert);
  router.registerRegex('audio', /^audio\/grouped\/playeventfile\//, alertHandlers.audioPlayEventFile);
  router.registerRegex('audio', /^audio\/grouped\/(?!playuploadedfile)[^/]+\/.+$/, alertHandlers.audioGroupedAlert);

  router.registerRegex('audio', /^audio\/\d+\/mastervolume\//, groupHandlers.audioMasterVolume);
  router.registerRegex('audio', /^audio\/cfg\/dgroup\/update\//, groupHandlers.audioCfgDynamicGroup);
  router.registerRegex('audio', /^audio\/cfg\/defaultvolume\//, configHandlers.setDefaultVolume);
  router.registerRegex('audio', /^audio\/cfg\/maxvolume\//, configHandlers.setMaxVolume);
  router.registerRegex('audio', /^audio\/cfg\/eventvolumes\//, configHandlers.setEventVolumes);

  // Queue-edit command set (refcode parity). Registered before the generic
  // dynamic command so the queue paths win. Audiopaths/uids may contain `/`
  // and `:`, so these match greedily like serviceplay.
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queue\/play\/.+$/, queueEditHandlers.queuePlay);
  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/queue\/move\/.+\/before\/.+$/,
    queueEditHandlers.queueMove,
  );
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queue\/remove\/.+$/, queueEditHandlers.queueRemove);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queue\/clear\/?$/, queueEditHandlers.queueClear);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queueadd\/.+$/, queueEditHandlers.queueAdd);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queueinsert\/.+$/, queueEditHandlers.queueInsert);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queueandplay\/.+$/, queueEditHandlers.queueAndPlay);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queueremove\/.+$/, queueEditHandlers.queueRemove);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/queueundo\/?$/, queueEditHandlers.queueUndo);
  router.registerRegex('audio', /^audio\/(?:cfg\/)?\d+\/playlist\/save\/.+$/, queueEditHandlers.playlistSave);

  router.registerRegex(
    'audio',
    /^audio\/(?:cfg\/)?\d+\/(on|off|play|pause|resume|position|volume|queueplus|queueminus|repeat|shuffle(?:\/(?:enable|disable|on|off|1|0))?)(?:\/[+-]?\d+)?\/?$/,
    zoneHandlers.audioDynamicCommand,
  );
}
