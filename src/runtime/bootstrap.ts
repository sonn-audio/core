import path from 'node:path';
import { loadConfig } from '@/config';
import { loadEnvironment } from '@/config/environment';
import { createLogger, logManager } from '@/shared/logging/logger';
import { createContentManager } from '@/adapters/content/contentManager';
import { createContentAdapter } from '@/adapters/content/ContentAdapter';
import { toLoxoneAudiopath } from '@/domain/zones/bridgeIdentity';
import { ServerLifecycle } from '@/domain/server/lifecycle';
import { MqttPublisher } from '@/adapters/mqtt/mqttPublisher';
import { toApiZoneState } from '@/adapters/http/api/zoneProjection';
import { ZoneSessionStats } from '@/application/zones/zoneSessionStats';
import { MediaServer } from '@/adapters/mediaserver/mediaServer';
import { SubsonicApi } from '@/adapters/subsonic/subsonicApi';
import { WebdavServer } from '@/adapters/webdav/webdavServer';
import { SsdpAdvertiser } from '@sonn-audio/node-upnp';
import { DlnaInputService } from '@/adapters/inputs/dlna/dlnaInputService';
import { BluetoothInputService } from '@/adapters/inputs/bluetooth/bluetoothInputService';
import { CustomRadioStore } from '@/adapters/content/providers/customRadioStore';
import { SpotifyServiceManagerProvider } from '@/adapters/content/providers/spotifyServiceManager';
import { createStreamProviders } from '@/runtime/streamProviders';
import { createApiZoneResolvers } from '@/runtime/apiZoneResolvers';
import { HttpService } from '@/adapters/http';
import { LoxoneHttpService } from '@/adapters/loxone/http';
import { LoxoneCommandProcessor } from '@/adapters/loxone/http/commandProcessor';
import { BrowserZoneRegistry } from '@/application/zones/browserZoneRegistry';
import { createInputsAdapter } from '@/adapters/inputs/InputsAdapter';
import { createOutputsAdapter } from '@/adapters/outputs/OutputsAdapter';
import { outputDiscovery } from '@/adapters/outputs/outputDiscovery';
import { ytMusicAdmin } from '@/adapters/content/providers/ytmusic/ytmusicAdmin';
import { soloistAdmin } from '@/adapters/inputs/spotify/soloist/soloistAdmin';
import { appleMusicAdmin } from '@/adapters/content/providers/applemusic/appleMusicAdmin';
import { validateTuneInUsername } from '@/adapters/content/providers/tunein/tuneinAdmin';
import { radioAdmin } from '@/adapters/content/providers/radiobrowser/radioAdmin';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { EngineAdapter } from '@/adapters/engine/EngineAdapter';
import { AudioStreamEngine } from '@/engine/audioStreamEngine';
import { AudioAnalysisService } from '@/application/audio/audioAnalysisService';
import { EngineAnalysisFeed } from '@/application/audio/analysisFeed';
import { zoneSessionKey } from '@/ports/types/SessionKey';
import { WaveformService } from '@/application/audio/waveformService';
import { AudioMeter } from '@/application/audio/audioMeter';
import type { ApiOutputCapabilities } from '@/domain/zones/apiTypes';
import { createZoneManager, type ZoneManagerFacade } from '@/application/zones/createZoneManager';
import { resolveZoneOutputProtocol } from '@/application/zones/outputProtocol';
import type { AudioServerConfig } from '@/domain/config/types';
import { PlaybackService } from '@/application/playback/PlaybackService';
import { AirplayInputService } from '@/adapters/inputs/airplay/airplayInputService';
import { LineInMetadataService } from '@/adapters/inputs/linein/lineInMetadataService';
import { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import { MusicAssistantInputService } from '@/adapters/inputs/musicassistant/musicAssistantInputService';
import { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import { LineInIngestRegistry } from '@/adapters/inputs/linein/lineInIngestRegistry';
import { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';
import { createLineInSourceAdapter } from '@/adapters/inputs/linein/lineInSourceAdapter';
import { createLineInActivationService } from '@/application/inputs/lineInActivationService';
import { SendspinHookRegistry } from '@/adapters/outputs/sendspin/sendspinHookRegistry';
import { SpotifyDeviceRegistry } from '@/adapters/outputs/spotify/deviceRegistry';
import { StreamEvents } from '@/adapters/http/streams/streamEvents';
import { SendspinClientConnector } from '@/adapters/outputs/sendspin/sendspinClientConnector';
import { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import { AudioManager } from '@/application/playback/audioManager';
import { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import { LmsCliServer } from '@/adapters/outputs/squeezelite/lmsCliServer';
import { NetworkService } from '@/adapters/network';
import { MdnsService } from '@/adapters/discovery';
import { SonnCoreMdnsService } from '@/adapters/discovery/sonnCoreMdnsService';
import { SonnCorePeerRegistry } from '@/adapters/discovery/sonnCorePeerRegistry';
import { SnapcastMdnsService } from '@/adapters/outputs/snapcast/snapcastMdnsService';
import { SendspinServerAdvertiser } from '@/adapters/outputs/sendspin/sendspinServerAdvertiser';
import { loadSendspinIdentity } from '@/adapters/outputs/sendspin/sendspinIdentity';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import type { MdnsLifecycleService } from '@/adapters/discovery/mdnsLifecycle';
import { createAirplayGroupController } from '@/application/outputs/airplayGroupController';
import { createSnapcastGroupController } from '@/application/outputs/snapcastGroupController';
import { sonosGroupController } from '@/application/outputs/sonosGroupController';
import { sendspinGroupController } from '@/application/outputs/sendspinGroupController';
import { createSqueezeliteGroupController } from '@/application/outputs/squeezeliteGroupController';
import { createGroupManager } from '@/application/groups/groupManager';
import { createGroupTrackerPort } from '@/application/groups/groupTrackerPort';
import { createPlayerRegistryPort } from '@/application/playback/playerRegistryPort';
import { createFadeControllerPort } from '@/application/zones/fadeControllerPort';
import { createAlertsPort } from '@/application/alerts/alertsPort';
import { createAlertFilesPort } from '@/application/alerts/alertFilesPort';
import { createMixedGroupController } from '@/application/groups/mixedGroupController';
import { createFavoritesManager } from '@/application/zones/favorites/favoritesManager';
import { createRecentsManager } from '@/application/zones/recents/recentsManager';
import { createRuntimePorts, createZoneManagerProxy } from '@/runtime/ports';
import { alertsManager } from '@/application/alerts/alertsManager';
import { fadeController } from '@/application/zones/fadeController';
import { LoxoneNotifierAdapter } from '@/adapters/loxone/LoxoneNotifierAdapter';
import { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import { withApiEvents } from '@/adapters/http/api/apiNotifierTap';
import { withDlnaReflection } from '@/adapters/inputs/dlna/dlnaNotifierTap';
import { readBuildVersion } from '@/shared/serverVersion';
import { ConnectionRegistry } from '@/adapters/loxone/ws/connectionRegistry';
import { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';
import { ServerHeartbeat } from '@/adapters/loxone/ws/serverHeartbeat';
import { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';
import { stopWithTimeout } from '@/runtime/stopWithTimeout';
import { startWithTimeout } from '@/runtime/startWithTimeout';

/**
 * How long a best-effort subsystem may take to start before startup carries on without it.
 *
 * Generous next to what these actually do — binding a socket and registering a device are
 * millisecond work even on a busy Pi — because the bound exists to catch a start that never
 * returns at all, not to police a slow one.
 */
const OPTIONAL_START_TIMEOUT_MS = 10_000;

/**
 * Loxone gets its own, much larger bound: its first start generates a 2048-bit RSA key in
 * pure JS (see loadOrGenerateSelfSignedTls), which is tens of seconds of honest work on a
 * Pi. Timing that out would cost a Miniserver its TLS listener to fix a hang it never had.
 */
const LOXONE_START_TIMEOUT_MS = 120_000;

/**
 * Descriptor for services that need graceful shutdown coordination.
 */
type LifecycleService = {
  name: string;
  stop: () => Promise<void>;
};

export type Runtime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type OutputHandlers = ReturnType<ZoneManagerFacade['getOutputHandlers']>;

export function createRuntime(): Runtime {
  const connectionRegistry = new ConnectionRegistry();
  const groupTracker = createGroupTrackerPort();
  const playerRegistry = createPlayerRegistryPort();
  const fadeControllerPort = createFadeControllerPort();
  const alertsPort = createAlertsPort();
  const alertFilesPort = createAlertFilesPort();
  const loxoneNotifier = new LoxoneWsNotifier(connectionRegistry, groupTracker);
  // The public /api surface listens on the same zone-change signal the Loxone
  // notifier does, so both always describe the same state (see withApiEvents).
  // These answer the parts of a zone that ZoneState does not hold; the getters are
  // there because the collaborators are built further down this same function.
  const {
    resolveOutputDevice,
    resolveVolumeLimits,
    resolveOutputProtocol,
    resolveServiceLabel,
    resolveInputLabel,
    resolveStreamFormat,
    resolvePowerState,
  } = createApiZoneResolvers({
    configPort: () => configPort,
    zoneManager: () => zoneManager,
    audioManager: () => audioManager,
    squeezeliteCore: () => squeezeliteCore,
  });

  const apiEventHub = new ApiEventHub();
  /*
   * The per-room session counters, built here because two paths need the same instance: the notifier
   * tap feeds it every zone change, and the request path reads it so a GET and an event agree about
   * what the room has been doing.
   */
  const zoneSessions = new ZoneSessionStats();
  const ports = createRuntimePorts({
    // Two taps on the one zone-change signal: the public API's event stream, and the
    // per-zone DLNA renderers. Neither is a second source of truth — both project the
    // same `ZoneState` the Loxone notifier gets. The DLNA service is resolved lazily
    // because it is constructed below, from the config port these ports hand out.
    notifier: withDlnaReflection(
      withApiEvents(new LoxoneNotifierAdapter(loxoneNotifier), apiEventHub, {
        device: resolveOutputDevice,
        outputProtocol: resolveOutputProtocol,
        outputCapabilities: (zoneId) =>
          zoneManager.getOutputCapabilities(zoneId) as ApiOutputCapabilities | null,
        // Same lookup the request path uses: without it a GET carried `output.sync` and an event
        // did not, which is the field-appears-and-disappears failure this tap exists to prevent.
        outputSync: (zoneId) => zoneManager.getOutputSyncStatus(zoneId),
        group: (zoneId) => zoneManager.getGroupMembership(zoneId),
        serviceLabel: resolveServiceLabel,
        inputLabel: resolveInputLabel,
        streamFormat: resolveStreamFormat,
        volumeLimits: resolveVolumeLimits,
        powerState: resolvePowerState,
        sessions: zoneSessions,
      }),
      () => dlnaInputService,
    ),
  });
  const configPort = ports.config;
  // Drive the per-session crossfade pipeline-shape from the system-wide
  // `audioserver.crossfadeSec` config: when crossfade is off (0 or empty) the
  // engine starts a single ffmpeg per file/URL zone instead of decoder+encoder.
  const audioAnalysis = new AudioAnalysisService((options, listener) => new AudioMeter({
    sampleRate: options.sampleRate,
    channels: options.channels,
    bitDepth: options.bitDepth,
    rateMax: options.rateMax,
    emitLoudness: options.loudness === true,
    emitFpeak: options.fPeak === true,
    emitPeak: options.peak === true,
    emitPitch: options.pitch === true,
    emitStereo: options.stereo === true,
    emitCorrelation: options.correlation === true,
    emitTruePeak: options.truePeak === true,
    emitEbu: options.ebu === true,
    emitScope: options.scope === true,
    emitGonio: options.gonio === true,
    spectrum: options.spectrum,
    onLoudness: (value, timestampUs) => listener({ type: 'loudness', value, timestampUs }),
    onStereo: (left, right, timestampUs) => listener({ type: 'stereo', left, right, timestampUs }),
    onSpectrum: (bins, timestampUs) => listener({ type: 'spectrum', bins, timestampUs }),
    onFpeak: (frequencyHz, amplitude, timestampUs) =>
      listener({ type: 'f_peak', frequencyHz, amplitude, timestampUs }),
    onPeak: (strength, timestampUs) => listener({ type: 'peak', strength, timestampUs }),
    onPitch: (midiQ88, confidence, timestampUs) =>
      listener({ type: 'pitch', midiQ88, confidence, timestampUs }),
    onCorrelation: (value, dcOffset, timestampUs) =>
      listener({ type: 'correlation', value, dcOffset, timestampUs }),
    onTruePeak: (leftDb, rightDb, clips, timestampUs) =>
      listener({ type: 'truepeak', leftDb, rightDb, clips, timestampUs }),
    onEbu: (loudness, timestampUs) => listener({ type: 'ebu', ...loudness, timestampUs }),
    onScope: (points, timestampUs) => listener({ type: 'scope', points, timestampUs }),
    onGonio: (points, timestampUs) => listener({ type: 'gonio', points, timestampUs }),
  }));
  const audioStreamEngine = new AudioStreamEngine(
    () => (configPort.getSystemConfig()?.audioserver?.crossfadeSec ?? 0) > 0,
    (zoneId, pcm, timestampUs) => audioAnalysis.push(Number(zoneId), pcm, timestampUs),
  );
  // Outputs whose session profile is PCM push frames into the analysis service themselves (see the
  // engine callback above). For every other output the audio only exists encoded, so the feed
  // subscribes to the session like any other client and decodes that copy — no change to the stream
  // the device is being sent. Attached here so it is live for whoever asks first: the API, a lighting
  // adapter, or the player's spectrum.
  audioAnalysis.setFeedController(
    new EngineAnalysisFeed({
      engine: audioStreamEngine,
      sessionKey: zoneSessionKey,
      push: (zoneId, pcm, timestampUs) => audioAnalysis.push(zoneId, pcm, timestampUs),
    }),
  );
  const customRadioStore = new CustomRadioStore();
  const spotifyManagerProvider = new SpotifyServiceManagerProvider(configPort);
  const spotifyDeviceRegistry = new SpotifyDeviceRegistry();
  let outputHandlers: OutputHandlers | null = null;
  const requireOutputHandlers = (): OutputHandlers => {
    if (!outputHandlers) {
      throw new Error('output handlers not configured');
    }
    return outputHandlers;
  };
  const outputHandlersProxy: OutputHandlers = {
    onQueueUpdate: (zoneId, items, currentIndex) => {
      requireOutputHandlers().onQueueUpdate(zoneId, items, currentIndex);
    },
    onOutputError: (zoneId, reason, origin) => {
      requireOutputHandlers().onOutputError(zoneId, reason, origin);
    },
    onOutputState: (zoneId, state) => {
      requireOutputHandlers().onOutputState(zoneId, state);
    },
  };
  const outputNotifier = {
    notifyOutputError: outputHandlersProxy.onOutputError,
    notifyOutputState: outputHandlersProxy.onOutputState,
    // Not an output talking back: this is the engine reporting a track length ffmpeg worked out for a
    // source that arrived without one, and it has to reach the zone's clock to end the track.
    notifySourceDuration: (zoneId: number, durationSec: number) =>
      requireZoneManager().applySourceDuration(zoneId, durationSec),
  };
  const streamProviders = createStreamProviders(configPort, outputHandlersProxy.onOutputError);
  const engine = new EngineAdapter(audioStreamEngine);
  const lineInRegistry = new LineInIngestRegistry();
  const mdnsService = new MdnsService();
  const sonnCorePeers = new SonnCorePeerRegistry(mdnsService);
  sonnCorePeers.start();
  const sendspinConnector = new SendspinClientConnector(mdnsService);
  let sendspinServerAdvertiser: SendspinServerAdvertiser | null = null;
  let sonnCoreMdnsService: SonnCoreMdnsService | null = null;
  let snapcastMdnsService: SnapcastMdnsService | null = null;
  let mediaServer: MediaServer | null = null;
  // Shared SSDP advertiser: one UDP socket on :1900 for the MediaServer plus every
  // per-zone DLNA MediaRenderer input. Devices register/deregister themselves.
  const ssdpAdvertiser = new SsdpAdvertiser({ serverHeader: 'Linux/5 UPnP/1.0 SonnAudio/1.0' });
  const dlnaHttpPort = loadEnvironment().httpPort;
  const dlnaInputService = new DlnaInputService(configPort, ssdpAdvertiser, dlnaHttpPort);
  const mdnsServices: MdnsLifecycleService[] = [];
  const streamEvents = new StreamEvents();
  const serverHeartbeat = new ServerHeartbeat(connectionRegistry);
  const sendspinHookRegistry = new SendspinHookRegistry();
  const sendspinLineInService = new SendspinLineInService(lineInRegistry, sendspinHookRegistry, configPort);
  const lineInActivation = new LineInActivationRegistry();
  // One long-lived owner of zone→line-in state, shared by every adapter that can
  // select a source. It must outlive the Loxone processor, which is rebuilt on each
  // connect and would otherwise orphan its ingest listeners.
  const lineInActivationService = createLineInActivationService({
    configPort,
    source: createLineInSourceAdapter({
      ingest: lineInRegistry,
      sendspin: sendspinLineInService,
      activation: lineInActivation,
    }),
  });
  const lineInMetadataService = new LineInMetadataService(lineInRegistry);
  const musicAssistantStreamService = new MusicAssistantStreamService(outputHandlersProxy, configPort);
  const musicAssistantInputService = new MusicAssistantInputService(musicAssistantStreamService);
  let airplayInputService: AirplayInputService | null = null;
  const spotifyInputService = new SpotifyInputService(configPort);
  airplayInputService = new AirplayInputService(
    (zoneId, reason) => {
      spotifyInputService.stopActiveSession(zoneId, reason);
    },
    playerRegistry,
    mdnsService,
  );
  if (!airplayInputService) {
    throw new Error('airplay input service not initialized');
  }
  const bluetoothInputService = new BluetoothInputService(sendspinHookRegistry);
  const inputsAdapter = createInputsAdapter({
    airplay: airplayInputService,
    spotify: spotifyInputService,
    musicAssistant: musicAssistantInputService,
    sendspinLineIn: sendspinLineInService,
    lineInActivation,
    lineInActivationService: () => lineInActivationService,
    dlna: dlnaInputService,
    bluetooth: bluetoothInputService,
  });
  const zoneAudioPrefs = new ZoneAudioPreferences();
  const audioManager = new AudioManager(new PlaybackService(engine), outputNotifier, zoneAudioPrefs);
  const airplayGroupController = createAirplayGroupController(audioManager);
  const snapcastGroupController = createSnapcastGroupController(audioManager);
  const squeezeliteGroupController = createSqueezeliteGroupController();
  const snapcastCore = new SnapcastCore(audioManager);
  const squeezeliteCore = new SqueezeliteCore(configPort);
  const squeezeliteCli = new LmsCliServer(squeezeliteCore, configPort);
  const contentManager = createContentManager({
    notifier: ports.notifier,
    configPort,
    spotifyManagerProvider,
    customRadioStore,
  });
  /*
   * Prepared waveforms, over the library's own sidecar table.
   *
   * One instance for the server: it holds the in-flight set, so a track starting in two rooms at once
   * is decoded once and both get the same stored bytes.
   */
  const waveformService = new WaveformService(contentManager.waveformStore);

  // The library knows every scanned file's native format, from the parse it already does for tags.
  // Handing that to the audio manager is what lets a local FLAC that already matches the output take
  // the bit-perfect bypass instead of being resampled and dithered for nothing. Wired here because
  // the library is built after the audio manager.
  audioManager.setDeclaredFileFormatSource((filePath) => {
    const format = contentManager.sourceFormatLookup(filePath);
    if (!format) {
      return null;
    }
    // The store says `null` for "no depth to preserve" (a lossy codec); the engine source says
    // "absent". Same statement, two spellings — and a literal null here would read as a depth.
    return {
      sampleRate: format.sampleRate,
      channels: format.channels,
      ...(format.bitDepth ? { bitDepth: format.bitDepth } : {}),
      lossless: format.lossless,
      codecName: format.codec,
    };
  });

  const contentAdapter = createContentAdapter(contentManager, streamProviders.resolvers);
  const groupManager = createGroupManager({ notifier: ports.notifier, airplayGroup: airplayGroupController, configPort });
  const mixedGroupController = createMixedGroupController(configPort, audioManager);
  const favoritesManager = createFavoritesManager({ notifier: ports.notifier, contentPort: contentAdapter });
  const recentsManager = createRecentsManager({ notifier: ports.notifier, contentPort: contentAdapter });
  let zoneManagerRef: ZoneManagerFacade | null = null;
  const requireZoneManager = (): ZoneManagerFacade => {
    if (!zoneManagerRef) {
      throw new Error('zone manager not configured');
    }
    return zoneManagerRef;
  };
  const zoneManagerProxy = createZoneManagerProxy(requireZoneManager);
  const outputPorts: OutputPorts = {
    engine,
    audioAnalysis,
    audioManager: {
      getSession: (zoneId) => audioManager.getSession(zoneId),
      getOutputSettings: (zoneId) => audioManager.getOutputSettings(zoneId),
      startExternalPlayback: (zoneId, label, playbackSource, metadata, requiresPcm) =>
        audioManager.startExternalPlayback(zoneId, label, playbackSource, metadata, requiresPcm),
    },
    zoneAudioPrefs: {
      getEffectiveOutputSettings: (zoneId) => zoneAudioPrefs.getEffectiveOutputSettings(zoneId),
    },
    outputStreamEvents: streamEvents,
    airplayGroup: airplayGroupController,
    snapcastCore,
    snapcastGroup: snapcastGroupController,
    sonosGroup: sonosGroupController,
    sendspinGroup: sendspinGroupController,
    sendspinHooks: sendspinHookRegistry,
    sendspinConnector,
    squeezeliteGroup: squeezeliteGroupController,
    squeezeliteCore,
    zoneManager: zoneManagerProxy,
    groupManager,
    groupTracker,
    outputHandlers: outputHandlersProxy,
    config: configPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
  };
  const outputsAdapter = createOutputsAdapter(outputPorts);
  const zoneManager = createZoneManager({
    notifier: ports.notifier,
    inputs: inputsAdapter,
    outputs: outputsAdapter,
    content: contentAdapter,
    config: configPort,
    recents: recentsManager,
    audioManager,
    zoneAudioPrefs,
    mixedGroup: mixedGroupController,
  });
  zoneManagerRef = zoneManager;
  loxoneNotifier.setZoneStateLookup((zoneId) => zoneManager.getState(zoneId));
  // Surface each zone's output protocol in audio_event so our player can hint
  // grouping compatibility (grouping requires matching protocols).
  loxoneNotifier.setOutputProtocolLookup((zoneId) =>
    resolveZoneOutputProtocol(zoneManager.getTechnicalSnapshot(zoneId)),
  );
  loxoneNotifier.setMixedGroupLookup(
    () => configPort.getConfig().groups?.mixedGroupEnabled === true,
  );
  // Loxone-boundary: translate the core's service-native audiopath back to the
  // `spotify@bridge-...` disguise so the native client's now-playing keeps its
  // service/account attribution (isSpotifyPlaying + serviceId regex). No-op on
  // non-bridge paths.
  loxoneNotifier.setAudiopathToLoxone((audiopath) =>
    toLoxoneAudiopath(audiopath, contentManager.getBridgeRegistry()),
  );
  // Let recents fall back to the live now-playing state for titles missing on
  // the queue item (e.g. radio/tunein station names).
  recentsManager.setZoneStateLookup((zoneId) => zoneManager.getState(zoneId));
  lineInMetadataService.initOnce({ zoneManager, configPort });
  lineInActivationService.initOnce({ zoneManager });
  snapcastCore.initOnce({ zoneManager });
  groupManager.initOnce({ zoneManager });
  mixedGroupController.initOnce({ zoneManager });
  favoritesManager.initOnce({ zoneManager });
  alertsManager.initOnce({ zoneManager, configPort });
  fadeController.initOnce({ zoneManager });
  sendspinGroupController.initOnce({ zoneManager });
  const loxoneConfigService = new LoxoneConfigService(
    zoneManager,
    configPort,
    contentManager,
    ports.notifier,
  );
  outputHandlers = zoneManager.getOutputHandlers();

  let httpService: HttpService | null = null;
  let networkService: NetworkService | null = null;
  let loxoneService: LoxoneHttpService | null = null;
  let browserZoneRegistry: BrowserZoneRegistry | null = null;
  let restartInFlight = false;
  let mqttPublisher: MqttPublisher | null = null;
  const lifecycle = new ServerLifecycle();

  async function handleReinitialize(): Promise<boolean> {
    const log = createLogger('Server');
    if (restartInFlight) {
      log.warn('restart already in progress; ignoring reinitialize request');
      return false;
    }
    restartInFlight = true;
    try {
      log.info('light reinitialize requested');
      const cfg = await configPort.load();
      await contentManager.reinitialize();
      await zoneManager.replaceAll(cfg.zones ?? [], cfg.inputs ?? null, cfg.groups ?? null);
      await favoritesManager.primeZones();
      log.info('light reinitialize complete');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('light reinitialize failed', { message });
      return false;
    } finally {
      restartInFlight = false;
    }
  }

  async function handleSoftRestart(): Promise<boolean> {
    const log = createLogger('Server');
    if (restartInFlight) {
      log.warn('restart already in progress; ignoring duplicate request');
      return false;
    }
    restartInFlight = true;
    try {
      log.info('soft restart requested');
      // The HTTP service goes away and comes back, so the server genuinely is not ready
      // during this window. Saying so is what lets a caller poll /ready instead of
      // blocking on a lock and hoping ten minutes is long enough.
      lifecycle.markStarting();
      await stopServices();
      await startServices();
      log.info('soft restart complete');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lifecycle.markFailed(error);
      log.error('soft restart failed', { message });
      return false;
    } finally {
      restartInFlight = false;
    }
  }

  async function startServices(): Promise<void> {
    const storedConfig = await configPort.load();
    const config = loadConfig(storedConfig.system?.audioserver?.macId);
    const logLevel = storedConfig.system?.logging?.consoleLevel ?? config.env.logLevel;
    logManager.configure({ level: logLevel });
    const log = createLogger('Server');

    // "uit is uit": in standalone mode the server exposes no Loxone protocol at
    // all — neither the dedicated Miniserver/native-app server (7091/7095 + UDP
    // discovery) nor the Loxone command dialect on the shared :7090 gateway.
    // Only the neutral surfaces run (DLNA MediaServer, Subsonic, admin API, the
    // /audio/events state mirror). The own player, still a Loxone client today,
    // is knowingly disabled here until it moves to a native API.
    // There is no deployment "mode": the server is just a server, and Loxone is a
    // connection. The stack runs iff Loxone is connected. Config migration seeds
    // `loxoneEnabled` from the old mode/paired, so existing installs are unchanged.
    // The stack can't reach `paired` on its own, so a new Loxone box goes: connect
    // (from the Players modal) → loxoneEnabled=true → soft restart → gate opens →
    // Miniserver pairs.
    const loxoneEnabled = storedConfig.system?.audioserver?.loxoneEnabled === true;

    log.info('bootstrapping audio server', {
      env: config.env.nodeEnv,
      loxoneEnabled,
    });

    await zoneManager.initialize();
    await contentManager.reinitialize();
    // After the zones exist: every idle zone comes up showing its first room favourite, stopped,
    // the way a real Audioserver does. See FavoritesManager.primeZones.
    await favoritesManager.primeZones();

    // Restore manual audio groups that were persisted before the last shutdown.
    const persistedGroups = storedConfig.groups?.audioGroups ?? [];
    for (const g of persistedGroups) {
      if (g.externalId && g.leader > 0 && g.members.length > 0) {
        groupManager.upsert({ leader: g.leader, members: g.members, externalId: g.externalId, backend: 'Unknown', source: 'manual' });
      }
    }
    if (persistedGroups.length) {
      log.info('restored persisted audio groups', { count: persistedGroups.length });
    }

    lineInMetadataService.start();
    sendspinLineInService.start();
    await squeezeliteCore.start();
    await squeezeliteCli.start();

    // The Loxone command engine + protocol servers are a runtime subsystem, not a
    // boot-time gate: connecting/disconnecting Loxone attaches/detaches them while
    // the rest of the server keeps running. Built lazily so a plain server never
    // constructs the engine. (Hoisted so onLoxoneToggle below can reference them.)
    function buildLoxoneProcessor(): LoxoneCommandProcessor {
      return new LoxoneCommandProcessor(config.loxone, {
        onRestart: handleSoftRestart,
        notifier: ports.notifier,
        loxoneNotifier,
        configService: loxoneConfigService,
        zoneManager,
        configPort,
        lineInActivationService,
        spotifyInputService,
        recentsManager,
        favoritesManager,
        groupManager,
        groupTracker,
        fadeController: fadeControllerPort,
        alerts: alertsPort,
        contentManager,
      });
    }

    // Start the Loxone subsystem: attach the command engine to the shared :7090
    // gateway and start the dedicated 7091/7095 servers + UDP discovery. Idempotent.
    // persist=false at boot (the flag is already set); true for a runtime connect.
    async function enableLoxone(persist = true): Promise<void> {
      if (loxoneService) return;
      const processor = buildLoxoneProcessor();
      httpService?.setLoxoneProcessor(processor);
      const service = new LoxoneHttpService(config.loxone, {
        host: config.env.hostname,
        processor,
        connectionRegistry,
        serverHeartbeat,
        notifier: loxoneNotifier,
        zoneManager,
        configPort,
      });
      loxoneService = service;
      try {
        await service.start();
      } catch (error) {
        // Roll back so a retry isn't blocked by a half-started subsystem (and the
        // gateway doesn't keep accepting Loxone commands nothing is serving).
        try {
          await service.stop();
        } catch {
          // Ignore: we're already unwinding a failed start.
        }
        loxoneService = null;
        httpService?.setLoxoneProcessor(null);
        throw error;
      }
      if (persist) {
        await configPort.updateConfig((cfg) => {
          cfg.system.audioserver.loxoneEnabled = true;
        });
      }
      await notifyMiniserverStartup(storedConfig);
      log.info('loxone subsystem enabled');
    }

    // Stop the Loxone subsystem and detach the command engine so :7090 rejects
    // /audio/... again. Idempotent. The rest of the server is untouched.
    async function disableLoxone(persist = true): Promise<void> {
      if (loxoneService) {
        await loxoneService.stop();
        loxoneService = null;
      }
      httpService?.setLoxoneProcessor(null);
      if (persist) {
        await configPort.updateConfig((cfg) => {
          cfg.system.audioserver.loxoneEnabled = false;
        });
      }
      log.info('loxone subsystem disabled');
    }

    browserZoneRegistry = new BrowserZoneRegistry(zoneManager);

    // DLNA/UPnP MediaServer: exposes all browsable content (library, radio,
    // bridges) as ContentDirectory and serves tracks statelessly at
    // /dlna/track/<id>. Gated on content.mediaServer.enabled; its SSDP advertiser
    // is started/stopped alongside the gateway below.
    mediaServer = new MediaServer(
      configPort,
      contentManager,
      contentAdapter,
      engine,
      config.http.port,
      ssdpAdvertiser,
    );

    // MQTT: pushes zone state to a broker so home automation stops polling us. Taps
    // the same event hub the SSE endpoint uses, so both see identical payloads.
    mqttPublisher = new MqttPublisher(
      configPort,
      apiEventHub,
      () =>
        zoneManager.getAllZoneStates().map((state) =>
          toApiZoneState(state, {
            device: resolveOutputDevice,
            outputProtocol: resolveOutputProtocol,
            outputCapabilities: (zoneId) =>
              zoneManager.getOutputCapabilities(zoneId) as ApiOutputCapabilities | null,
            serviceLabel: resolveServiceLabel,
            inputLabel: resolveInputLabel,
            streamFormat: resolveStreamFormat,
            volumeLimits: resolveVolumeLimits(state.id),
            powerState: resolvePowerState,
          }),
        ),
      {
        // The same command engine the Loxone adapter and /api drive, so "pause zone 3"
        // has one implementation regardless of which protocol asked for it.
        handleCommand: (zoneId, command, payload) =>
          zoneManager.handleCommand(zoneId, command, payload),
        // 'mqtt' as the origin, so anything keying on how playback started can tell this
        // apart from a Loxone tap, a favourite or an API call.
        playContent: (zoneId, uri) => zoneManager.playContent(zoneId, uri, 'mqtt'),
        hasZone: (zoneId) => Boolean(zoneManager.getZoneState(zoneId)),
      },
    );

    // Subsonic API: exposes the same browsable content (library, radio, bridges)
    // over the Subsonic REST protocol at /rest/*. Stateless and gated on
    // content.subsonic.enabled, so it needs no lifecycle of its own.
    const subsonicApi = new SubsonicApi(configPort, contentManager, contentAdapter, engine);

    // WebDAV share at /dav: the music folder as a mountable network drive, so an
    // album can be dragged in instead of uploaded a file at a time. Authenticates
    // with the same local accounts over HTTP Basic.
    const webdavServer = new WebdavServer({
      configPort,
      contentManager,
      // Rooted at the local library folder, so a client that mounts the share
      // lands straight in the music instead of one level above it.
      baseDir: path.join(config.http.musicDir, 'local'),
      storagePrefix: 'local',
    });

    httpService = new HttpService(config.http, {
      outputDiscovery,
      ytMusicAdmin,
      soloistAdmin,
      appleMusicAdmin,
      validateTuneInUsername,
      radioAdmin,
      onReinitialize: handleReinitialize,
      onSoftRestart: handleSoftRestart,
      onLoxoneToggle: (enabled) => (enabled ? enableLoxone() : disableLoxone()),
      notifier: ports.notifier,
      loxoneNotifier,
      spotifyManagerProvider,
      customRadioStore,
      zoneManager,
      audioAnalysis,
      /*
       * Prepared waveforms.
       *
       * Constructed here rather than inside the HTTP layer because it owns a decode queue and a cache:
       * one instance per server, shared by every zone and every client, so a track playing in two rooms
       * is scanned once.
       */
      waveforms: waveformService,
      configPort,
      engine,
      streamEvents,
      lineInRegistry,
      lineInActivation,
      lineInActivationService,
      bluetoothInput: bluetoothInputService,
      sendspinLineInService,
      musicAssistantStreamService,
      spotifyInputService,
      snapcastCore,
      squeezeliteCore,
      squeezeliteCli,
      recentsManager,
      favoritesManager,
      groupManager,
      contentManager,
      audioManager,
      zoneAudioPrefs,
      mdnsPort: mdnsService,
      sonnCorePeers,
      alertFiles: alertFilesPort,
      // Attached at runtime via setLoxoneProcessor (enableLoxone), so starts null.
      loxoneProcessor: null,
      connectionRegistry,
      apiEventHub,
      resolveOutputDevice,
      resolveOutputProtocol,
      resolveServiceLabel,
      resolveVolumeLimits,
      resolvePowerState,
      resolveInputLabel,
      resolveStreamFormat,
      resolveZoneSession: (zoneId: number) => zoneSessions.get(zoneId),
      serverVersion: readBuildVersion(),
      lifecycle,
      browserZoneRegistry,
      streamProxyRoutes: streamProviders.proxyRoutes,
      mediaServer,
      mqttPublisher,
      alerts: alertsPort,
      subsonic: subsonicApi,
      webdav: webdavServer,
      dlnaInput: dlnaInputService,
    });
    networkService = new NetworkService({
      lineInRegistry,
      snapcastCore,
    });

    // Not time-bounded, on purpose: these two are the server. A server that cannot open
    // its own sockets has nothing to degrade to, and the error is the right answer.
    await httpService.start();
    await networkService.start();
    // Start the shared SSDP socket, then let the MediaServer register its device.
    // Per-zone renderer devices register via dlnaInputService.syncZones (driven by
    // zoneManager). All share this one advertiser / UDP :1900 socket.
    //
    // Bounded from here on: everything below is a subsystem the server plays music
    // without, and none of them is worth never reporting ready over.
    await startWithTimeout('ssdp', () => ssdpAdvertiser.start(), OPTIONAL_START_TIMEOUT_MS);
    await startWithTimeout('media-server', () => mediaServer!.start(), OPTIONAL_START_TIMEOUT_MS);
    // Deliberately not awaited into the startup path: an unreachable broker must not
    // hold up a server that plays music perfectly well without one. It retries itself.
    void mqttPublisher.start();

    /*
     * Name this server to sendspin clients, and offer the encrypted path.
     *
     * Both matter for a house with more than one audioserver: a client tells servers
     * apart by `server_id`, and every one of ours used to answer "server". The
     * identity's public key is that id under encryption, and the macId keeps it
     * stable for clients still on the unencrypted path.
     *
     * Encryption stays opt-in per connection — a client that opens with
     * `client/hello` instead of `client/init` keeps the transition-mode path — so
     * turning it on here cannot break an existing client. Admission is by the
     * published Sentinel PSK, i.e. unpaired playback: confidential against a passive
     * listener, authenticating nothing. Pairing is not implemented.
     */
    const systemConfig = configPort.getSystemConfig()?.audioserver;
    sendspinCore.configureServer({
      name: systemConfig?.name?.trim() || 'Sonn Audio Server',
      serverId: (systemConfig?.macId ?? '').trim().toUpperCase() || 'server',
    });
    sendspinCore.enableEncryption(loadSendspinIdentity());
    log.info('sendspin server identity', { serverId: sendspinCore.getServerId() });

    sendspinServerAdvertiser = new SendspinServerAdvertiser(
      config.http,
      configPort,
      sendspinConnector,
    );
    sonnCoreMdnsService = new SonnCoreMdnsService(config.http, configPort, mdnsService);
    snapcastMdnsService = new SnapcastMdnsService(
      config.http,
      configPort,
      networkService,
      mdnsService,
    );

    mdnsServices.length = 0;
    mdnsServices.push(sendspinServerAdvertiser, sonnCoreMdnsService, snapcastMdnsService);
    mdnsServices.forEach((service) => service.start());
    // Bring the Loxone subsystem up if it's connected. Same path a runtime connect
    // uses; persist=false because the flag is already set. A plain server skips it.
    if (loxoneEnabled) {
      await startWithTimeout('loxone', () => enableLoxone(false), LOXONE_START_TIMEOUT_MS);
    }

    // Not just a log line: this is what /ready and /health answer from, so a supervisor
    // can tell a slow start from a failed one instead of grepping `docker ps`.
    lifecycle.markReady();
    log.info('startup complete');
  }

  async function stopServices(): Promise<void> {
    const log = createLogger('Server');
    const services: LifecycleService[] = [
      // Tear down ephemeral browser zones before the zone manager shutdown so
      // each one's outputs get cleaned up via the standard removeZone path.
      { name: 'browser-zones', stop: async () => browserZoneRegistry?.shutdown() },
      { name: 'zones', stop: () => zoneManager.shutdown() },
    ];
    services.push({ name: 'linein-metadata', stop: async () => lineInMetadataService.stop() });
    services.push({ name: 'sendspin-linein', stop: async () => sendspinLineInService.stop() });
    services.push({ name: 'squeezelite', stop: async () => squeezeliteCore.stop() });
    services.push({ name: 'squeezelite-cli', stop: async () => squeezeliteCli.stop() });

    if (loxoneService) {
      services.push({ name: 'loxone', stop: () => loxoneService!.stop() });
    }
    services.push({
      name: 'mdns',
      stop: async () => {
        mdnsServices.forEach((service) => service.stop());
        mdnsServices.length = 0;
        sonnCorePeers.stop();
        mdnsService.shutdown();
      },
    });
    if (mediaServer) {
      services.push({ name: 'media-server', stop: () => mediaServer!.stop() });
    }
    services.push({
      name: 'dlna-input',
      stop: async () => {
        dlnaInputService.shutdown();
        await ssdpAdvertiser.stop();
      },
    });
    if (mqttPublisher) {
      // Says goodbye on the availability topic, so consumers see us go rather than
      // waiting for the broker to notice a dropped connection.
      services.push({ name: 'mqtt', stop: () => mqttPublisher!.stop() });
    }
    if (networkService) {
      services.push({ name: 'network', stop: () => networkService!.stop() });
    }
    if (httpService) {
      services.push({ name: 'http', stop: () => httpService!.stop() });
    }

    await Promise.all(
      services.map((service) =>
        stopWithTimeout(service.name, service.stop, 6000, log),
      ),
    );

    httpService = null;
    networkService = null;
    sendspinServerAdvertiser = null;
    sonnCoreMdnsService = null;
    snapcastMdnsService = null;
    mediaServer = null;
    loxoneService = null;
  }

  return {
    // Wrapped rather than passed straight through so a failed boot is recorded before the
    // error propagates. Without this, a server that died during startup would still be
    // reporting `starting` — indistinguishable from one that is merely slow.
    start: async () => {
      try {
        await startServices();
      } catch (error) {
        lifecycle.markFailed(error);
        throw error;
      }
    },
    stop: stopServices,
  };
}

async function notifyMiniserverStartup(config: AudioServerConfig): Promise<void> {
  const log = createLogger('Server');
  const miniserverIp = config.system?.miniserver?.ip?.trim();
  const macId = config.system?.audioserver?.macId?.trim().toUpperCase();

  if (!miniserverIp || !macId) {
    log.debug('miniserver startup ping skipped (missing ip/mac)');
    return;
  }

  const section = findServerSection(config.rawAudioConfig?.raw, macId)
    ?? findServerSection(config.rawAudioConfig?.rawString, macId);
  const uuid = normalizeString(section?.uuid);

  if (!uuid) {
    log.debug('miniserver startup ping skipped (missing uuid)', { macId });
    return;
  }

  const url = `http://${miniserverIp}/dev/sps/devicestartup/${encodeURIComponent(uuid)}`;
  const controller = new AbortController();
  const scheduleTimeout = globalThis.setTimeout as typeof setTimeout;
  const timeout = scheduleTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      log.warn('miniserver startup ping failed', { status: response.status, url });
    } else {
      log.info('miniserver startup ping sent', { url });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('miniserver startup ping failed', { message, url });
  } finally {
    clearTimeout(timeout);
  }
}

function findServerSection(raw: unknown, macId: string): Record<string, unknown> | undefined {
  if (!raw || !macId) {
    return undefined;
  }

  const normalizedMacId = macId.trim().toUpperCase();
  let parsed = raw;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const matchKey = Object.keys(entry).find(
      (key) => key.trim().toUpperCase() === normalizedMacId,
    );
    if (matchKey) {
      return (entry as Record<string, unknown>)[matchKey] as Record<string, unknown>;
    }
  }

  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
