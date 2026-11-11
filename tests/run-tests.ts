import { zoneSessionKey } from '../src/ports/types/SessionKey';
import 'tsconfig-paths/register';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, tests, type TestFn } from './testHarness';
import './sessionKey.test';
import './buildChannel.test';
import './somaFmProvider.test';
import './startWithTimeout.test';
import './loxoneServiceFolders.test';
import './loxoneItemType.test';
import './loxoneScanStatus.test';
import './loxoneMediaFolder.test';
import './serviceNativeIdentity.test';
import './trackIdentity.test';
import './appleMusicNewReleases.test';
import './serviceNativeBoundary.test';
import './spotifyAccountRouting.test';
import './streamingServicesMigration.test';
import './engine/rollingBuffer.test';
import './engine/pcmFrameAligner.test';
import './engine/codecPolicy.test';
import './engine/firstChunkBarrier.test';
import './engine/outputPacer.test';
import './engine/subscriberFanout.test';
import './engine/pcmCrossfade.test';
import './engine/ffmpegArgs.test';
import './engine/ffmpegBinary.test';
import './engine/audioSessionRestart.test';
import './engine/audioSessionLateSubscriber.test';
import './engine/pcmDsp.test';
import './engine/engineDspSession.test';
import './bitPerfectPlayback.test';
import './sendspinFormatReuse.test';
import './sendspinGroupFormat.test';
import './sendspinProtocol.test';
import './sendspinNoise.test';
import './flacFrameSplitter.test';
import './engine/pipeSourceAdapter.test';
import './playbackRefactorSeams.test';
import './playbackCoordinator.characterization.test';
import './playRequestProviderTraits.test';
import './alertClipDuration.test';
import './parseTrackAudiopath.test';
import './bootstrapWiring.test';
import './webdavPaths.test';
import './beoremoteMenu.test';
import './beoremoteApi.test';
import './sonnClientApi.test';
import './beoremoteKeys.test';
import './nodeVersionGuard.test';
import './localLibraryStore.rollup.test';
import './airplayAdvertisement.test';
import './airplaySessionEnd.test';
import './bareSpotifyId.test';
import './airplayLane.test';
import './airplayPcmRing.test';
import './airplayRaopSession.test';
import './mdnsAdvertisedAddresses.test';
import './lineInCommandQueue.test';
import './lineInActivationService.test';
import './libraryUploadFiling.test';
import './adminApiJsonBody.test';
import './transportsDiscovery.test';
import './ytMusicAdminRoutes.test';
import './integrationAdminRoutes.test';
import './sendspinGroupController.test';
import './appleMusicStreamHelpers.test';
import './amazonMusic.test';
import './amazonMusicServiceSave.test';
import './tidalAuth.test';
import './tidalPages.test';
import './tidalNavigation.test';
import './audioServersAndBearer.test';
import './outputFactory.airplay.test';
import './outputFactory.sendspin.test';
import './sendspinVisualizer.test';
import './sendspinClientConnector.test';
import './sendspinHookRegistry.test';
import './sendspinRc1Output.test';
import './sendspinCapacity.test';
import './outputFactory.streamFormat.test';
import './airplayPcmStream.test';
import './airplayVolumeAssert.test';
import './airplayStreamSession.test';
import './airplayHardwareAddress.test';
import './airplayInputPcm.test';
import './audioStreamHandlerIcy.test';
import './audioProxyIcyStream.test';
import './audioProxyResume.test';
import './audioProxyPlaylist.test';
import './queueAuthority.test';
import './queueMutations.test';
import './queueEditIntake.test';
import './ytmusicNative.mock.test';
import './spotifyAccountProvider.playlists.test';
import './spotifyAccountProvider.artist.test';
import './spotifyWebTokens.test';
import './soloistBackend.test';
import './soloistArchive.test';
import './soloistStores.test';
import './pulseSoundCard.test';
import './pulseSoundCardWire.test';
import './soloistTransport.test';
import './deezerRetryStream.test';
import './subsonicIds.test';
import './subsonicResponse.test';
import './subsonicStreamRange.test';
import './localUsers.test';
import './subsonicAuth.test';
import './subsonicApi.test';
import './subsonicAdminApi.test';
import './localLibraryStore.search.test';
import './localLibraryStore.delete.test';
import './localLibraryStore.sourceFormat.test';
import './localLibraryProvider.folders.test';
import './localLibraryProvider.mp4.test';
import './localLibraryResolveItem.test';
import './zonePlayerEndGuard.test';
import './zonePlayerPreDelayClock.test';
import './durationRegression.test';
import './sourceDurationLearned.test';
import './radioBrowserSearch.test';
import './runtimeShutdown.test';
import './sourceResolver.test';
import './beolinkStateController.test';
import './sonosEndpointResolution.test';
import './sonosDiscovery.test';
import './sonosTransportResilience.test';
import './externalStateRouter.test';
import './sonosExternalTakeover.test';
import './equalizerRestartScheduler.test';
import './zoneHeartbeatService.test';
import './inputSourceConfigurator.test';
import './bluetoothInput.test';
import './stateControllerPolicies.test';
import './zoneStateStore.test';
import './isRadioAudiopath.test';
import './inferAudiotype.test';
import './playlistTrackParentContext.test';
import './audioManager.playbackPreDelay.test';
import './audioManager.pauseResumeSession.test';
import './sendspinLineInService.test';
import './audioMeter.test';
import './zoneArtworkColors.test';
import './analysisFeed.test';
import './powerManager.test';
import './sharedPowerGroupManager.test';
import './configClear.test';
import './mdnsService.test';
import './sonnClientClaim.test';
import './configHandlers.volume.test';
import './contentManagerConfigIdentity.test';
import './configHandlers.system.test';
import './equalizer.test';
import './zoneHandlers.serviceplay.test';
import './alertHandlers.playeventfile.test';
import './alertHandlers.zoneRoutes.test';
import './alertStartAlignment.test';
import './alertsCoordinator.test';
import './alertStreamTail.test';
import './playbackErrorOrigin.test';
import './alertsManager.volume.test';
import './ttsProviders.test';
import './loxberryTtsProvider.test';
import './zoneHandlers.roomfavs.test';
import './fadeBuzzerWake.test';
import './favoritesManager.compat.test';
import './favoritesPrimeZones.test';
import './recentsManager.compat.test';
import './contentMetadataHarvestCache.test';
import './contentProviderDispatch.test';
import './queueBuilderArtistFlatten.test';
import './nowPlayingMetadata.test';
import './publicApi.test';
import './dlnaRendererReflection.test';
import './dlnaRendererCast.test';
import './googleCastReconnect.test';
import './googleCastSupersededLoad.test';
import './dlnaLineInService.test';
import './zoneMute.test';
import './zoneVolumeResume.test';
import './sonnCoreDiscovery.test';
import './itemAbout.test';
import './browseContainerIdentity.test';
import './outputDelay.test';
import './outputStreamFormat.test';
import './musicAssistantAnnouncement.test';
import './dlnaPlaybackReadiness.test';
import './dlnaVolumeEcho.test';
import './waveform.test';
import './serverHealth.test';
import './mqttTopics.test';
import './contentItemKind.test';
import './folderPage.test';
import './providerCapabilities.test';
import './loxoneProjectionBoundary.test';
import './loxoneServiceEntries.test';
import './loxoneClientSchemas.test';
import './browseRef.test';
import './libraryProjectionSource.test';
import './streamFormat.test';
import './playbackSourceMapping.test';
import './audioAnalysisService.test';
import './audioMeter.metering.test';
import './sendspinBrowserLead.test';
import './browserZoneNaming.test';
import './mqttCommands.test';
import './squeezeliteReconnect.test';
import './squeezeliteMixedGroup.test';
import './squeezeliteMemberPause.test';
import './squeezelitePlaybackStart.test';
import './squeezeliteAlertSync.test';
import './mixedGroupFanout.test';
import './loxoneZoneProjection.test';
import './loxoneConnectGroupSnapshot.test';
import './loxoneFixedGroups.test';
import './adminZoneStates.test';
import './adminInfo.test';
import './bundleCompat.test';
import './updateCheck.test';
import './coverArtTuneIn.test';
import './tuneinPresets.test';
import './mountDiagnostics.test';
import type { ZoneConfig } from '../src/domain/config/types';
import { applyZonePatch } from '../src/domain/zones/reducer';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { QueueItem } from '../src/ports/types/queueTypes';
import type { PlaybackSession } from '../src/ports/types/playback';
import { StorageAdapter } from '../src/adapters/storage/StorageAdapter';
import type { AirplayGroupCoordinator } from '../src/application/outputs/airplayGroupController';
import { makeOutputPortsFake, noopAirplayGroupController } from './fakes/outputPorts';
import type { ContentPort } from '../src/ports/ContentPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import { makeNotifierFake } from './fakes/notifierPort';
import { makePlaybackServiceFake } from './fakes/playbackService';
import { PlaybackService } from '../src/application/playback/PlaybackService';
import type { EnginePort, EngineSessionStats } from '../src/ports/EnginePort';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import type { GroupManager } from '../src/application/groups/groupManager';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';

type ZoneHarness = {
  tempDir: string;
  zoneManager: ZoneManagerFacade;
  updateQueueFromOutput: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  setNotifier: (notifier: NotifierPort) => void;
  noopNotifier: NotifierPort;
  airplayGroupController: AirplayGroupCoordinator;
  noopAirplayGroupController: AirplayGroupCoordinator;
  groupManager: GroupManager;
  groupTracker: typeof import('../src/application/groups/groupTracker');
  audioManager: import('../src/application/playback/audioManager').AudioManager;
  cleanup: () => Promise<void>;
};

const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  listBrowsableServices: () => [],
  getBridgeRegistry: () => buildBridgeRegistry([]),
  resolveFolder: async () => null,
  resolveMetadata: async () => null,
  resolvePlaybackSource: async () => ({ playbackSource: null, provider: 'library' }),
  configureProviders: () => {},
  providerForAudiopath: () => null,
  getMediaFolder: async () => null,
  getServiceTrack: async () => null,
  getServiceFolder: async () => null,
  buildQueueForUri: async () => [],
};

let zoneHarnessPromise: Promise<ZoneHarness> | null = null;
const noopNotifier = makeNotifierFake();

function purgeModule(modulePath: string): void {
  const resolved = require.resolve(modulePath, { paths: [__dirname] });
  delete require.cache[resolved];
}

function freshRequire<T>(modulePath: string): T {
  purgeModule(modulePath);
  return require(modulePath) as T;
}

async function createZoneHarness(): Promise<ZoneHarness> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-tests-'));
  process.chdir(tempDir);
  try {
    purgeModule('../src/application/config/configRepository');
    purgeModule('../src/application/playback/audioManager');
    purgeModule('../src/application/zones/zoneManager');
    purgeModule('../src/application/zones/createZoneManager');
    purgeModule('../src/application/groups/groupManager');
    purgeModule('../src/application/groups/groupTracker');
    purgeModule('../src/adapters/inputs/InputsAdapter');
    purgeModule('../src/adapters/inputs/spotify/spotifyInputService');
    purgeModule('../src/adapters/inputs/musicassistant/musicAssistantStreamService');
    purgeModule('../src/adapters/inputs/linein/lineInMetadataService');
    purgeModule('../src/adapters/inputs/linein/sendspinLineInService');
    purgeModule('../src/adapters/loxone/services/loxoneConfigService');
    purgeModule('../src/adapters/outputs/OutputsAdapter');

    const configRepositoryModule = require('../src/application/config/configRepository') as typeof import('../src/application/config/configRepository');
    const configAdapterModule = require('../src/adapters/config/ConfigAdapter') as typeof import('../src/adapters/config/ConfigAdapter');
    const storage = new StorageAdapter();
    const configRepository = new configRepositoryModule.ConfigRepository(storage);
    const configPort = new configAdapterModule.ConfigAdapter(configRepository);
    await configPort.load();
    const spotifyManagerModule = require('../src/adapters/content/providers/spotifyServiceManager') as typeof import('../src/adapters/content/providers/spotifyServiceManager');
    const spotifyManagerProvider = new spotifyManagerModule.SpotifyServiceManagerProvider(configPort);
    const spotifyDeviceRegistryModule = require('../src/adapters/outputs/spotify/deviceRegistry') as typeof import('../src/adapters/outputs/spotify/deviceRegistry');
    const spotifyDeviceRegistry = new spotifyDeviceRegistryModule.SpotifyDeviceRegistry();

    let zoneManagerRef: ZoneManagerFacade | null = null;
    const requireZoneManager = (): ZoneManagerFacade => {
      if (!zoneManagerRef) {
        throw new Error('zone manager not configured');
      }
      return zoneManagerRef;
    };
    let outputHandlers: ReturnType<ZoneManagerFacade['getOutputHandlers']> | null = null;
    const requireOutputHandlers = (): ReturnType<ZoneManagerFacade['getOutputHandlers']> => {
      if (!outputHandlers) {
        throw new Error('output handlers not configured');
      }
      return outputHandlers;
    };
    const outputHandlersProxy: ReturnType<ZoneManagerFacade['getOutputHandlers']> = {
      onQueueUpdate: (zoneId, items, currentIndex) => {
        requireOutputHandlers().onQueueUpdate(zoneId, items, currentIndex);
      },
      onOutputError: (zoneId, reason) => {
        requireOutputHandlers().onOutputError(zoneId, reason);
      },
      onOutputState: (zoneId, state) => {
        requireOutputHandlers().onOutputState(zoneId, state);
      },
    };
    const outputNotifier = {
      notifyOutputError: outputHandlersProxy.onOutputError,
      notifyOutputState: outputHandlersProxy.onOutputState,
      notifySourceDuration: (zoneId: number, durationSec: number) =>
        requireZoneManager().applySourceDuration(zoneId, durationSec),
    };
    const { AudioManager } = require('../src/application/playback/audioManager') as typeof import('../src/application/playback/audioManager');
    const { ZoneAudioPreferences } = require('../src/application/playback/ZoneAudioPreferences') as typeof import('../src/application/playback/ZoneAudioPreferences');
    const zoneAudioPrefs = new ZoneAudioPreferences();
    const audioManager = new AudioManager(makePlaybackServiceFake(), outputNotifier, zoneAudioPrefs);

    const lineInRegistryModule = require('../src/adapters/inputs/linein/lineInIngestRegistry') as typeof import('../src/adapters/inputs/linein/lineInIngestRegistry');
    const lineInRegistry = new lineInRegistryModule.LineInIngestRegistry();

    const musicAssistantStreamServiceModule = require('../src/adapters/inputs/musicassistant/musicAssistantStreamService') as typeof import('../src/adapters/inputs/musicassistant/musicAssistantStreamService');
    const musicAssistantStreamService = new musicAssistantStreamServiceModule.MusicAssistantStreamService(
      outputHandlersProxy,
      configPort,
    );
    const musicAssistantInputServiceModule = require('../src/adapters/inputs/musicassistant/musicAssistantInputService') as typeof import('../src/adapters/inputs/musicassistant/musicAssistantInputService');
    const musicAssistantInputService = new musicAssistantInputServiceModule.MusicAssistantInputService(musicAssistantStreamService);

    const spotifyInputServiceModule = require('../src/adapters/inputs/spotify/spotifyInputService') as typeof import('../src/adapters/inputs/spotify/spotifyInputService');
    const airplayInputServiceModule = require('../src/adapters/inputs/airplay/airplayInputService') as typeof import('../src/adapters/inputs/airplay/airplayInputService');
    let airplayInputService: import('../src/adapters/inputs/airplay/airplayInputService').AirplayInputService | null = null;
    const noopPlayerRegistry = { getPlayer: () => null };
    const spotifyInputService = new spotifyInputServiceModule.SpotifyInputService(configPort);
    // No responder in tests: nothing here starts a receiver, so publishing is a no-op.
    const noopMdns = {
      publish: () => ({ stop: () => {} }),
      browse: () => ({ stop: () => {} }),
      shutdown: () => {},
    };
    airplayInputService = new airplayInputServiceModule.AirplayInputService(
      (zoneId, reason) => {
        spotifyInputService.stopActiveSession(zoneId, reason);
      },
      noopPlayerRegistry,
      noopMdns,
    );
    if (!airplayInputService) {
      throw new Error('airplay input service not initialized');
    }

    const lineInMetadataServiceModule = require('../src/adapters/inputs/linein/lineInMetadataService') as typeof import('../src/adapters/inputs/linein/lineInMetadataService');
    const lineInMetadataService = new lineInMetadataServiceModule.LineInMetadataService(lineInRegistry);

    const sendspinHookRegistryModule = require('../src/adapters/outputs/sendspin/sendspinHookRegistry') as typeof import('../src/adapters/outputs/sendspin/sendspinHookRegistry');
    const sendspinHookRegistry = new sendspinHookRegistryModule.SendspinHookRegistry();

    const sendspinLineInServiceModule = require('../src/adapters/inputs/linein/sendspinLineInService') as typeof import('../src/adapters/inputs/linein/sendspinLineInService');
    const sendspinLineInService = new sendspinLineInServiceModule.SendspinLineInService(
      lineInRegistry,
      sendspinHookRegistry,
      configPort,
    );

    const { createZoneManager } = require('../src/application/zones/createZoneManager') as typeof import('../src/application/zones/createZoneManager');
    const { createInputsAdapter } = require('../src/adapters/inputs/InputsAdapter') as typeof import('../src/adapters/inputs/InputsAdapter');
    const { createOutputsAdapter } = require('../src/adapters/outputs/OutputsAdapter') as typeof import('../src/adapters/outputs/OutputsAdapter');
    const groupManagerModule = require('../src/application/groups/groupManager') as typeof import('../src/application/groups/groupManager');
    const inputsAdapter = createInputsAdapter({
      airplay: airplayInputService,
      spotify: spotifyInputService,
      musicAssistant: musicAssistantInputService,
      sendspinLineIn: sendspinLineInService,
      // DLNA became a first-class input after this harness was written. It is a
      // required dep, but the harness loads the adapter through `require`, so the
      // omission type-checked and only surfaced as `undefined.configure` at run
      // time. These zone tests never exercise DLNA, so a no-op is the right stub.
      dlna: {
        configure: () => {},
        syncZones: () => {},
        shutdown: () => {},
      },
      // Same story as DLNA: a zone can have a Bluetooth radio in the room, but none of these tests
      // put a phone in it.
      bluetooth: {
        configure: () => {},
        syncZones: () => {},
        shutdown: () => {},
      },
    } as unknown as Parameters<typeof createInputsAdapter>[0]);
    const airplayGroupController: AirplayGroupCoordinator = {
      ...noopAirplayGroupController,
    };
    const outputPorts = makeOutputPortsFake(configPort, {
      spotifyManagerProvider,
      spotifyDeviceRegistry,
    });
    outputPorts.airplayGroup = airplayGroupController;
    const outputsAdapter = createOutputsAdapter(outputPorts);
    const recentsManager = createRecentsManager({ notifier: noopNotifier, contentPort: noopContentPort });
    const zoneManager = createZoneManager({
      notifier: noopNotifier,
      inputs: inputsAdapter,
      outputs: outputsAdapter,
      content: noopContentPort,
      config: configPort,
      recents: recentsManager,
      audioManager,
      zoneAudioPrefs,
    });
    lineInMetadataService.initOnce({ zoneManager, configPort });
    const groupManager = groupManagerModule.createGroupManager({
      notifier: noopNotifier,
      configPort,
      airplayGroup: airplayGroupController,
    });
    const groupTracker = require('../src/application/groups/groupTracker') as typeof import('../src/application/groups/groupTracker');
    groupManager.initOnce({ zoneManager });
    zoneManagerRef = zoneManager;
    outputHandlers = zoneManager.getOutputHandlers();
    const updateQueueFromOutput = outputHandlers.onQueueUpdate;

    return {
      tempDir,
      zoneManager,
      updateQueueFromOutput,
      setNotifier: (notifier: NotifierPort) => {
        zoneManager.setNotifier(notifier);
        groupManager.setNotifier(notifier);
      },
      noopNotifier,
      airplayGroupController,
      noopAirplayGroupController,
      groupManager,
      groupTracker,
      audioManager,
      cleanup: async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } finally {
    process.chdir(originalCwd);
  }
}

async function getZoneHarness(): Promise<ZoneHarness> {
  if (!zoneHarnessPromise) {
    zoneHarnessPromise = createZoneHarness();
  }
  return zoneHarnessPromise;
}

function createZoneConfig(id: number, name: string): ZoneConfig {
  return {
    id,
    name,
    sourceMac: `00:11:22:33:44:${String(id).padStart(2, '0')}`,
    transports: [],
    volumes: {
      default: 30,
      alarm: 50,
      fire: 50,
      bell: 50,
      buzzer: 50,
      tts: 50,
      volstep: 2,
      fading: 0,
      maxVolume: 100,
    },
    inputs: {
      airplay: { enabled: false },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
  };
}

let queueItemCounter = 0;
function makeQueueItem(overrides: Partial<QueueItem>): QueueItem {
  queueItemCounter += 1;
  return {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    coverurl: '',
    duration: 0,
    qindex: 0,
    station: '',
    title: '',
    unique_id: `queue-${queueItemCounter}`,
    user: 'nouser',
    ...overrides,
  };
}

async function withTempCwd<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-tests-'));
  process.chdir(tempDir);
  try {
    return await fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}


class FakeProcess extends EventEmitter {
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly stdin = new PassThrough();
  public killed = false;
  public readonly signals: string[] = [];

  constructor(private readonly exitOnKill: boolean) {
    super();
  }

  public kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL') {
      this.killed = true;
    }
    if (this.exitOnKill && signal === 'SIGTERM') {
      this.emit('exit', 0, null);
    }
    return true;
  }

  public override removeAllListeners(): this {
    super.removeAllListeners();
    return this;
  }
}

const childProcess = require('node:child_process') as typeof import('node:child_process');
const originalSpawn = childProcess.spawn;
let spawnImpl: (...args: any[]) => FakeProcess = () => new FakeProcess(true);

// Only mock ffmpeg spawns. Other subprocesses (e.g. yt-dlp) should run normally.
childProcess.spawn = ((command: any, ...rest: any[]) => {
  const cmd = typeof command === 'string' ? command : '';
  const base = cmd ? path.basename(cmd).toLowerCase() : '';
  if (base.startsWith('ffmpeg')) {
    return spawnImpl(command, ...rest) as any;
  }
  return (originalSpawn as any)(command, ...rest);
}) as any;

const { AudioSession } = require('../src/engine/audioSession') as typeof import('../src/engine/audioSession');
const { audioOutputSettings } = require('../src/engine/audioFormat') as typeof import('../src/engine/audioFormat');

test('audio session stats report zero subscribers', () => {
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'file', path: '/tmp/fake.wav' },
    'mp3',
    () => undefined,
    audioOutputSettings,
  );
  const stats = session.getStats();
  assert.equal(stats.subscribers, 0);
});

test('pipe source listeners are detached after stop', () => {
  const source = new PassThrough();
  const baseDataListeners = source.listenerCount('data');
  const baseErrorListeners = source.listenerCount('error');
  spawnImpl = () => new FakeProcess(true);
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source, format: 's24le' },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  assert.ok(source.listenerCount('data') > baseDataListeners);
  assert.ok(source.listenerCount('error') > baseErrorListeners);
  session.stop();
  assert.equal(source.listenerCount('data'), baseDataListeners);
  assert.equal(source.listenerCount('error'), baseErrorListeners);
});

test('ffmpeg stop issues SIGKILL after timeout', async () => {
  const source = new PassThrough();
  let proc: FakeProcess | null = null;
  spawnImpl = () => {
    proc = new FakeProcess(false);
    return proc;
  };
  const session = new AudioSession(
    zoneSessionKey(1),
    { kind: 'pipe', path: '/tmp/fake.pcm', stream: source, format: 's24le' },
    'pcm',
    () => undefined,
    audioOutputSettings,
  );
  session.start();
  session.stop();
  await new Promise((resolve) => setTimeout(resolve, 2200));
  if (!proc) {
    throw new Error('ffmpeg process not captured');
  }
  const captured = proc as unknown as { signals: string[] };
  assert.deepEqual(captured.signals, ['SIGTERM', 'SIGKILL']);
});

test('audio manager active local session detection ignores stale no-subscriber sessions', () => {
  let hasEngineSession = true;
  const stats: EngineSessionStats[] = [
    {
      startedAt: 0,
      profile: 'mp3',
      sampleRate: 44100,
      channels: 2,
      pcmBitDepth: 16,
      bitPerfect: false,
      dspApplied: false,
      bps: null,
      bufferedBytes: 0,
      totalBytes: 0,
      lastUpdated: null,
      subscribers: 0,
      restarts: 0,
      lastError: null,
      lastErrorAt: null,
      lastStderr: null,
      lastStderrAt: null,
      lastExitCode: null,
      lastExitSignal: null,
      lastExitAt: null,
      subscriberDrops: 0,
      lastSubscriberDropAt: null,
    },
  ];
  const engine: EnginePort = {
    start: () => {},
    startWithHandoff: () => {},
    stop: () => {},
    createStream: () => null,
    createLocalSession: () => ({
      start: () => {},
      stop: () => {},
      createSubscriber: () => null,
    }),
    waitForFirstChunk: async () => false,
    hasSession: () => hasEngineSession,
    getSessionStats: () => stats,
    setSessionTerminationHandler: () => {},
    restartZoneForEqualizer: () => false,
    inlineCrossfade: async () => false,
  };
  const { AudioManager } = require('../src/application/playback/audioManager') as typeof import('../src/application/playback/audioManager');
  const { ZoneAudioPreferences } = require('../src/application/playback/ZoneAudioPreferences') as typeof import('../src/application/playback/ZoneAudioPreferences');
  const manager = new AudioManager(new PlaybackService(engine), {
    notifyOutputError: () => {},
    notifyOutputState: () => {},
    notifySourceDuration: () => {},
  }, new ZoneAudioPreferences());

  manager.startPlayback(1, 'https://example.com/test.mp3', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
  });
  const session = manager.getSession(1);
  assert.ok(session);
  if (!session) {
    return;
  }

  session.playbackStartedAt = Date.now() - 10_000;
  session.startedAt = Date.now() - 10_000;
  assert.equal(manager.hasActiveLocalSession(1), false);

  stats[0]!.subscribers = 1;
  assert.equal(manager.hasActiveLocalSession(1), true);

  stats[0]!.subscribers = 0;
  session.playbackStartedAt = Date.now() - 1000;
  session.startedAt = Date.now() - 1000;
  assert.equal(manager.hasActiveLocalSession(1), true);

  hasEngineSession = false;
  assert.equal(manager.hasActiveLocalSession(1), false);
});

test('spotify pipe track change after pause restarts engine instead of continuing same source', () => {
  const pipe = new PassThrough();
  let hasSession = false;
  let startCalls = 0;
  const stopCalls: Array<{ zoneId: number; reason?: string }> = [];
  const engine: EnginePort = {
    start: () => {
      hasSession = true;
      startCalls += 1;
    },
    startWithHandoff: () => {},
    stop: (zoneId, reason) => {
      hasSession = false;
      stopCalls.push({ zoneId, reason });
    },
    createStream: () => null,
    createLocalSession: () => ({
      start: () => {},
      stop: () => {},
      createSubscriber: () => null,
    }),
    waitForFirstChunk: async () => true,
    hasSession: () => hasSession,
    getSessionStats: () => [],
    setSessionTerminationHandler: () => {},
    restartZoneForEqualizer: () => false,
    inlineCrossfade: async () => false,
  };
  const { AudioManager } = require('../src/application/playback/audioManager') as typeof import('../src/application/playback/audioManager');
  const { ZoneAudioPreferences } = require('../src/application/playback/ZoneAudioPreferences') as typeof import('../src/application/playback/ZoneAudioPreferences');
  const manager = new AudioManager(new PlaybackService(engine), {
    notifyOutputError: () => {},
    notifyOutputState: () => {},
    notifySourceDuration: () => {},
  }, new ZoneAudioPreferences());

  const playbackSource = {
    kind: 'pipe' as const,
    path: 'spotify-pipe',
    format: 's16le' as const,
    sampleRate: 44100,
    channels: 2 as const,
    stream: pipe,
  };

  manager.startExternalPlayback(1, 'spotify', playbackSource, {
    title: 'Old Track',
    artist: 'Artist',
    album: 'Album',
  });
  manager.pausePlayback(1);
  manager.startExternalPlayback(1, 'spotify', playbackSource, {
    title: 'New Track',
    artist: 'Artist',
    album: 'Album',
  });

  assert.equal(startCalls, 2);
  assert.equal(stopCalls.length, 2);
  assert.equal(stopCalls[0]?.reason, 'switch');
  assert.equal(stopCalls[1]?.reason, 'switch');
});

test('spotify explicit serviceplay restarts same pipe when request uri changed before start', () => {
  const pipe = new PassThrough();
  let hasSession = false;
  let startCalls = 0;
  const stopCalls: Array<{ zoneId: number; reason?: string }> = [];
  const engine: EnginePort = {
    start: () => {
      hasSession = true;
      startCalls += 1;
    },
    startWithHandoff: () => {},
    stop: (zoneId, reason) => {
      hasSession = false;
      stopCalls.push({ zoneId, reason });
    },
    createStream: () => null,
    createLocalSession: () => ({
      start: () => {},
      stop: () => {},
      createSubscriber: () => null,
    }),
    waitForFirstChunk: async () => true,
    hasSession: () => hasSession,
    getSessionStats: () => [],
    setSessionTerminationHandler: () => {},
    restartZoneForEqualizer: () => false,
    inlineCrossfade: async () => false,
  };
  const { AudioManager } = require('../src/application/playback/audioManager') as typeof import('../src/application/playback/audioManager');
  const { ZoneAudioPreferences } = require('../src/application/playback/ZoneAudioPreferences') as typeof import('../src/application/playback/ZoneAudioPreferences');
  const manager = new AudioManager(new PlaybackService(engine), {
    notifyOutputError: () => {},
    notifyOutputState: () => {},
    notifySourceDuration: () => {},
  }, new ZoneAudioPreferences());

  const playbackSource = {
    kind: 'pipe' as const,
    path: 'spotify-pipe',
    format: 's16le' as const,
    sampleRate: 44100,
    channels: 2 as const,
    stream: pipe,
  };

  manager.markPlayRequest(1, { type: 'serviceplay', uri: 'spotify:track:old' });
  manager.startExternalPlayback(1, 'spotify', playbackSource, {
    title: 'Old Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:old',
  });

  manager.updateSessionMetadata(1, {
    title: 'New Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:new',
  });

  manager.markPlayRequest(1, { type: 'serviceplay', uri: 'spotify:track:new' });
  manager.startExternalPlayback(1, 'spotify', playbackSource, {
    title: 'New Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:new',
  });

  assert.equal(startCalls, 2);
  assert.equal(stopCalls.length, 2);
  assert.equal(stopCalls[0]?.reason, 'switch');
  assert.equal(stopCalls[1]?.reason, 'switch');
});

test('applyZonePatch merges fields', () => {
  const state: ZoneState = {
    album: 'Old Album',
    artist: 'Old Artist',
    audiopath: 'spotify:track:old',
    audiotype: 0,
    clientState: 'on',
    muted: false,
    coverurl: '',
    duration: 120,
    eq: [0,0,0,0,0,0,0,0,0,0],
    mode: 'play',
    name: 'Living',
    id: 1,
    plrepeat: 0,
    plshuffle: 0,
    power: 'on',
    qindex: 0,
    queueAuthority: 'local',
    sourceName: 'src',
    station: '',
    time: 0,
    title: 'Old Title',
    type: 3,
    volume: 20,
  };
  const next = applyZonePatch(state, { title: 'New Title', volume: 30 });
  assert.equal(next.title, 'New Title');
  assert.equal(next.volume, 30);
  assert.equal(next.artist, 'Old Artist');
});

test('applyZonePatch does not mutate inputs', () => {
  const state: ZoneState = {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    clientState: 'on',
    muted: false,
    coverurl: '',
    duration: 0,
    eq: [0,0,0,0,0,0,0,0,0,0],
    mode: 'stop',
    name: 'Zone',
    id: 2,
    plrepeat: 0,
    plshuffle: 0,
    power: 'on',
    qindex: 0,
    queueAuthority: 'local',
    sourceName: 'src',
    station: '',
    time: 0,
    title: '',
    type: 3,
    volume: 10,
  };
  const patch = { title: 'Now Playing' };
  const next = applyZonePatch(state, patch);
  assert.equal(state.title, '');
  assert.equal(patch.title, 'Now Playing');
  assert.notEqual(next, state);
});

test('zone queue transitions update state and notify', async () => {
  const harness = await getZoneHarness();
  const {
    zoneManager,
    updateQueueFromOutput,
    setNotifier,
    noopNotifier,
  } = harness;

  const notifications: {
    queue: Array<{ zoneId: number; size: number }>;
    states: Array<{ zoneId: number; audiopath?: string; qindex?: number }>;
  } = { queue: [], states: [] };

  const notifier: NotifierPort = {
    ...noopNotifier,
    notifyQueueUpdated: (zoneId, queueSize) => notifications.queue.push({ zoneId, size: queueSize }),
    notifyZoneStateChanged: (state) =>
      notifications.states.push({ zoneId: state.id, audiopath: state.audiopath, qindex: state.qindex }),
  };
  setNotifier(notifier);

  await zoneManager.replaceAll([createZoneConfig(1, 'Living')], {
    spotify: {},
  });

  const initial = [
    makeQueueItem({ audiopath: 'spotify:track:one', title: 'One', artist: 'Artist', duration: 180, qindex: 0 }),
    makeQueueItem({ audiopath: 'spotify:track:two', title: 'Two', artist: 'Artist', duration: 200, qindex: 1 }),
  ];
  updateQueueFromOutput(1, initial, 0);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:one');
  assert.equal(notifications.queue.at(-1)?.size, 2);

  const added = [
    ...initial,
    makeQueueItem({ audiopath: 'spotify:track:three', title: 'Three', artist: 'Artist', duration: 120, qindex: 2 }),
  ];
  updateQueueFromOutput(1, added, 1);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 3);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:two');
  assert.equal(notifications.queue.at(-1)?.size, 3);

  const reordered = [
    makeQueueItem({ ...added[2], qindex: 0 }),
    makeQueueItem({ ...added[0], qindex: 1 }),
  ];
  updateQueueFromOutput(1, reordered, 0);
  assert.equal(zoneManager.getQueue(1, 0, 10).totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:three');
  assert.equal(notifications.queue.at(-1)?.size, 2);

  const merge = [
    makeQueueItem({ ...reordered[1], title: 'One (Updated)', qindex: 1 }),
  ];
  updateQueueFromOutput(1, merge, 1);
  const queue = zoneManager.getQueue(1, 0, 10);
  assert.equal(queue.totalitems, 2);
  assert.equal(zoneManager.getState(1)?.audiopath, 'spotify:track:one');
  assert.ok(queue.items.some((item) => item.title === 'One (Updated)'));

  setNotifier(noopNotifier);
});

test('queue update with foreign audiopath is rejected while another source plays', async () => {
  const harness = await getZoneHarness();
  const { zoneManager, updateQueueFromOutput, setNotifier, noopNotifier } = harness;

  await zoneManager.replaceAll([createZoneConfig(2, 'Living')], {
    spotify: {},
  });

  // Establish a radio stream as the active state.
  const radioItem = makeQueueItem({
    audiopath: 'tunein:station:abc',
    title: '',
    artist: '',
    qindex: 0,
  });
  updateQueueFromOutput(2, [radioItem], 0);
  zoneManager.applyPatch(2, { title: 'Bayern 1: Cloud Number Nine', artist: 'BAYERN 1' });

  const titleBefore = zoneManager.getState(2)?.title;
  const audiopathBefore = zoneManager.getState(2)?.audiopath;
  assert.equal(titleBefore, 'Bayern 1: Cloud Number Nine');
  assert.equal(audiopathBefore, 'tunein:station:abc');

  // A stale Spotify Connect poll arrives with a track unrelated to the
  // tunein audiopath and not present in the current queue.
  const stalePoll = [
    makeQueueItem({
      audiopath: 'spotify:track:stalefromspotify',
      title: 'High Hopes',
      artist: 'Pink Floyd',
      qindex: 0,
    }),
  ];
  updateQueueFromOutput(2, stalePoll, 0);

  assert.equal(zoneManager.getState(2)?.title, titleBefore);
  assert.equal(zoneManager.getState(2)?.audiopath, audiopathBefore);

  setNotifier(noopNotifier);
});

test('queue refresh of current item does not wipe live metadata', async () => {
  const harness = await getZoneHarness();
  const { zoneManager, updateQueueFromOutput, setNotifier, noopNotifier } = harness;

  await zoneManager.replaceAll([createZoneConfig(3, 'Living')], {
    spotify: {},
  });

  // Initial queue with full metadata.
  const initial = makeQueueItem({
    audiopath: 'tunein:station:def',
    title: '',
    artist: '',
    qindex: 0,
  });
  updateQueueFromOutput(3, [initial], 0);
  // ICY-like live metadata applied externally.
  zoneManager.applyPatch(3, {
    title: 'Live Track',
    artist: 'Live Artist',
    coverurl: 'http://cdn/live.jpg',
    station: 'Live Station',
  });

  // A refresh poll re-asserts the same audiopath but with empty metadata.
  const refresh = makeQueueItem({
    audiopath: 'tunein:station:def',
    title: '',
    artist: '',
    coverurl: '',
    station: '',
    qindex: 0,
  });
  updateQueueFromOutput(3, [refresh], 0);

  const state = zoneManager.getState(3);
  assert.equal(state?.title, 'Live Track');
  assert.equal(state?.artist, 'Live Artist');
  assert.equal(state?.coverurl, 'http://cdn/live.jpg');
  assert.equal(state?.station, 'Live Station');

  setNotifier(noopNotifier);
});

/**
 * Stand in for the squeezelite protocol under the zone tests below: the member-pause
 * control is offered to a group's members, keeps its hold in a set the way the group
 * controller does, and the transport calls are only recorded.
 */
function stubSqueezeliteMemberPause() {
  const { SqueezeliteOutput } = require('../src/adapters/outputs/squeezelite/squeezeliteOutput') as typeof import('../src/adapters/outputs/squeezelite/squeezeliteOutput');
  const proto = SqueezeliteOutput.prototype as unknown as Record<string, unknown>;
  const names = ['pause', 'resume', 'stop', 'memberPause'] as const;
  const original = Object.fromEntries(names.map((name) => [name, proto[name]]));
  const calls: string[] = [];
  const held = new Set<number>();
  proto.pause = async function (this: { zoneId: number }) {
    calls.push(`${this.zoneId}:pause`);
  };
  proto.resume = async function (this: { zoneId: number }) {
    calls.push(`${this.zoneId}:resume`);
  };
  proto.stop = async function (this: { zoneId: number }) {
    calls.push(`${this.zoneId}:stop`);
    held.delete(this.zoneId);
  };
  proto.memberPause = function (this: { zoneId: number }) {
    const zoneId = this.zoneId;
    // As the protocol does: only a member of a group, never its leader. Looked up on the
    // tracker the zone harness loaded, which replaces the one loaded before it.
    const { getGroupByZone } = require('../src/application/groups/groupTracker') as typeof import('../src/application/groups/groupTracker');
    const group = getGroupByZone(zoneId);
    if (!group || group.leader === zoneId) {
      return null;
    }
    return {
      isHeld: () => held.has(zoneId),
      hold: async () => {
        held.add(zoneId);
        calls.push(`${zoneId}:hold`);
      },
      release: async (leaderPlaying: boolean) => {
        held.delete(zoneId);
        calls.push(`${zoneId}:release(${leaderPlaying ? 'leader playing' : 'leader idle'})`);
      },
    };
  };
  return {
    calls,
    held,
    restore: () => {
      for (const name of names) proto[name] = original[name];
    },
  };
}

async function setUpSqueezeliteGroup(leader: number, member: number, externalId: string) {
  const harness = await getZoneHarness();
  const zone = (id: number, name: string): ZoneConfig => ({
    ...createZoneConfig(id, name),
    transports: [{ id: 'squeezelite', playerId: `aa:bb:cc:00:00:${id}` } as never],
  });
  await harness.zoneManager.replaceAll([zone(leader, 'Living'), zone(member, 'Kitchen')], { spotify: {} });
  harness.groupTracker.upsertGroup({
    leader,
    members: [member],
    backend: 'internal',
    externalId,
    source: 'manual',
  });
  return harness;
}

test('the zone manager lets every room of a synced alert wait for the coldest amp (#359)', async () => {
  // Loaded the way the zone harness loads it, so no stale module graph is left behind.
  await getZoneHarness();
  const { ZoneManager } = require('../src/application/zones/zoneManager') as typeof import('../src/application/zones/zoneManager');
  const asked: number[][] = [];
  const syncing = {
    type: 'squeezelite',
    prepareSyncedAlert: (zoneIds: readonly number[]) => {
      asked.push([...zoneIds]);
      return zoneIds.filter((zoneId) => zoneId !== 3);
    },
  };
  const outputsByZone: Record<number, unknown[]> = {
    1: [syncing],
    2: [syncing],
    3: [{ type: 'sendspin' }],
  };
  const manager = {
    zoneRepo: { get: (zoneId: number) => ({ outputs: outputsByZone[zoneId] ?? [] }) },
    log: { debug: () => undefined },
    getAlertStartDelaysMs: () =>
      new Map([
        [1, 0],
        [2, 1500],
        [3, 200],
      ]),
    prepareSyncedAlerts: (ZoneManager.prototype as unknown as { prepareSyncedAlerts: unknown }).prepareSyncedAlerts,
  };
  const prepare = (ZoneManager.prototype as unknown as {
    prepareAlertStart: (zoneIds: number[]) => Map<number, number>;
  }).prepareAlertStart;

  const delays = prepare.call(manager, [1, 2, 3]);
  // The hall shares the kitchen's stream, so it leads with the kitchen's wake-up silence;
  // the sendspin room keeps its own.
  assert.deepEqual([...delays], [
    [1, 1500],
    [2, 1500],
    [3, 200],
  ]);
  assert.deepEqual(asked, [[1, 2, 3]], 'the protocol is asked once, for every zone');

  // One zone has nothing to be in step with.
  asked.length = 0;
  prepare.call(manager, [1]);
  assert.deepEqual(asked, []);
});

test('a squeezelite member paused on its own stays paused through the next track (#409)', async () => {
  // A member of a squeezelite group has no session: it plays the leader's stream. Its
  // pause used to find nothing of its own to pause (or paused the whole group), and the
  // leader's `play` at the next track was mirrored straight back onto it.
  const LEADER = 31;
  const MEMBER = 32;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409');
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'the member follows the leader');

    zoneManager.handleCommand(MEMBER, 'pause');
    assert.deepEqual(stub.calls, [`${MEMBER}:hold`], 'the member alone is paused and held');
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause');
    assert.equal(zoneManager.getState(LEADER)?.mode, 'play', 'the leader plays on');

    // The next track starts on the leader.
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'Two' }, true);
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause', 'the member stays paused');
    assert.equal(zoneManager.getState(MEMBER)?.title, 'Two', 'while still showing the group');

    zoneManager.handleCommand(MEMBER, 'play');
    assert.deepEqual(
      stub.calls,
      [`${MEMBER}:hold`, `${MEMBER}:release(leader playing)`],
      'play brings it back',
    );
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');

    // Back in the group: the leader's state is mirrored again.
    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause');
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');
  } finally {
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a pause of the whole squeezelite group is not a member stepping out', async () => {
  // The grouped pause sends pause to every zone in turn. By the time the member's pause
  // arrives the leader is paused, so the member must not be held out of the group play
  // that follows.
  const LEADER = 33;
  const MEMBER = 34;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409b');
  try {
    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    zoneManager.handleCommand(MEMBER, 'pause');
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(stub.held.size, 0);
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'the group play reaches the member');
  } finally {
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a grouped pause that reaches a member before its leader does not hold it (#409)', async () => {
  // The app sends the grouped pause to its zones in its own order. A member that comes
  // before the leader finds the leader still playing; that is the group pausing, not the
  // member stepping out, and holding it kept it out of the grouped play that followed.
  const LEADER = 35;
  const MEMBER = 36;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409c');
  const { createGroupHandlers } = require('../src/adapters/loxone/commands/handlers/groupHandlers') as typeof import('../src/adapters/loxone/commands/handlers/groupHandlers');
  const handlers = createGroupHandlers(zoneManager, {} as never, {} as never, {} as never);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });

    await handlers.audioGroupedPlayback(`audio/grouped/pause/${MEMBER},${LEADER}`);
    assert.equal(stub.held.size, 0, 'nothing is held');
    assert.ok(!stub.calls.includes(`${MEMBER}:hold`), 'the member was not stepped out');

    // However the zones got there, the leader is paused now. When it plays again the
    // member is part of it, not sitting it out.
    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'the leader play reaches the member');

    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    await handlers.audioGroupedPlayback(`audio/grouped/play/${MEMBER},${LEADER}`);
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'and so does the grouped play');
  } finally {
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a held member played while its leader is not playing waits with the group (#409)', async () => {
  // Playing a held member rejoins it only when the leader plays; otherwise the output
  // drops its stale buffer and it comes along with the group's next start. The zone must
  // say so rather than report `play` for a room that is silent.
  const LEADER = 37;
  const MEMBER = 38;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409d');
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    zoneManager.handleCommand(MEMBER, 'pause');
    assert.ok(stub.held.has(MEMBER));

    // The leader pauses by a path that did not end the hold.
    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    zoneManager.handleCommand(MEMBER, 'play');
    assert.equal(stub.calls.at(-1), `${MEMBER}:release(leader idle)`);
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause', 'waiting with its paused leader');

    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'and playing with it again');
  } finally {
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('the group mirrors the hold the protocol keeps (#409)', async () => {
  // The hold lives in one place, the protocol. When it ends there — the whole group was
  // paused or stopped — the leader's next `play` reaches the member again.
  const LEADER = 39;
  const MEMBER = 40;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409e');
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    zoneManager.handleCommand(MEMBER, 'pause');
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'Two' }, true);
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause');

    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    stub.held.delete(MEMBER); // the group pause released it
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');
  } finally {
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a member still holding a session of its own is paused and played as a member (#409)', async () => {
  // A room that played another Spotify account on its own before it joined keeps that
  // account's paused session: nothing ends it when the account plays elsewhere. That
  // session sent the member's pause down the zone's own path, which paused the whole
  // group, and its play woke the old account up instead of rejoining the group.
  const LEADER = 41;
  const MEMBER = 42;
  const stub = stubSqueezeliteMemberPause();
  const harness = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409f');
  const { zoneManager, groupTracker, audioManager } = harness;
  const ownSession = { zoneId: MEMBER, state: 'paused', source: 'spotify:track:other' };
  const realGetSession = audioManager.getSession.bind(audioManager);
  (audioManager as unknown as { getSession: (zoneId: number) => unknown }).getSession = (zoneId) =>
    zoneId === MEMBER ? ownSession : realGetSession(zoneId);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });

    zoneManager.handleCommand(MEMBER, 'pause');
    assert.deepEqual(stub.calls, [`${MEMBER}:hold`], 'only the member is paused');
    assert.equal(zoneManager.getState(LEADER)?.mode, 'play', 'the leader plays on');

    zoneManager.handleCommand(MEMBER, 'play');
    assert.deepEqual(
      stub.calls,
      [`${MEMBER}:hold`, `${MEMBER}:release(leader playing)`],
      'play brings it back into the group, not to its old session',
    );
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');
  } finally {
    delete (audioManager as unknown as { getSession?: unknown }).getSession;
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

/**
 * Record what reaches the zones' playback after the zone manager has routed a command, and
 * keep it from doing anything: these tests are about where a command goes, not what it does.
 */
function spyZonePlayback(zoneManager: ZoneHarness['zoneManager']) {
  const coordinator = (zoneManager as unknown as {
    playbackCoordinator: {
      handleCommand: (zoneId: number, command: string, payload?: string) => void;
      playContent: (zoneId: number, uri: string, type: string) => Promise<void>;
    };
  }).playbackCoordinator;
  const original = { handleCommand: coordinator.handleCommand, playContent: coordinator.playContent };
  const calls: string[] = [];
  coordinator.handleCommand = (zoneId, command, payload) => {
    calls.push(`${zoneId}:${command}${payload !== undefined ? `(${payload})` : ''}`);
  };
  coordinator.playContent = async (zoneId, uri, type) => {
    calls.push(`${zoneId}:playContent(${uri},${type})`);
  };
  return {
    calls,
    restore: () => {
      coordinator.handleCommand = original.handleCommand;
      coordinator.playContent = original.playContent;
    },
  };
}

test('next, seek, shuffle and repeat on a squeezelite member steer the group through its leader (#409)', async () => {
  // Next on a member stepped the queue the member kept from before it joined and started
  // that track as a session of its own. Its speaker plays the leader's stream, so the room
  // sounded unchanged while it showed another track until the leader moved on.
  const LEADER = 43;
  const MEMBER = 44;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409g');
  const spy = spyZonePlayback(zoneManager);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });
    for (const [command, payload] of [
      ['queueplus', undefined],
      ['queueminus', undefined],
      ['next', undefined],
      ['previous', undefined],
      ['position', '42'],
      ['shuffle', 'on'],
      ['repeat', 'all'],
    ] as const) {
      zoneManager.handleCommand(MEMBER, command, payload);
    }
    assert.deepEqual(spy.calls, [
      `${LEADER}:queueplus`,
      `${LEADER}:queueminus`,
      `${LEADER}:next`,
      `${LEADER}:previous`,
      `${LEADER}:position(42)`,
      `${LEADER}:shuffle(on)`,
      `${LEADER}:repeat(all)`,
    ]);

    spy.calls.length = 0;
    zoneManager.handleCommand(MEMBER, 'volume_set', '30');
    zoneManager.handleCommand(MEMBER, 'mute', 'on');
    assert.deepEqual(spy.calls, [`${MEMBER}:volume_set(30)`, `${MEMBER}:mute(on)`], 'the room keeps its own level');

    spy.calls.length = 0;
    zoneManager.handleCommand(LEADER, 'queueplus');
    assert.deepEqual(spy.calls, [`${LEADER}:queueplus`], 'the leader steps its own queue');
  } finally {
    spy.restore();
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a grouped command that reaches the leader is not sent to it again by a member (#409)', async () => {
  const LEADER = 45;
  const MEMBER = 46;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409h');
  const spy = spyZonePlayback(zoneManager);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play' });
    zoneManager.handleCommand(MEMBER, 'queueplus', undefined, { groupedTargets: [MEMBER, LEADER] });
    assert.deepEqual(spy.calls, [], "the member's copy is dropped");
    zoneManager.handleCommand(MEMBER, 'queueplus', undefined, { groupedTargets: [MEMBER] });
    assert.deepEqual(spy.calls, [`${LEADER}:queueplus`], 'without the leader among the targets it goes there');
  } finally {
    spy.restore();
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a held squeezelite member stays held when next is pressed on it (#409)', async () => {
  const LEADER = 47;
  const MEMBER = 48;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409i');
  const spy = spyZonePlayback(zoneManager);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });
    zoneManager.handleCommand(MEMBER, 'pause');
    zoneManager.handleCommand(MEMBER, 'queueplus');
    assert.deepEqual(spy.calls, [`${LEADER}:queueplus`]);
    assert.ok(stub.held.has(MEMBER), 'still held');
    assert.ok(!stub.calls.some((call) => call.includes('release')), 'its hold was not released');

    // The leader starts the next track.
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'Two' }, true);
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause', 'the member sits it out');
    assert.equal(zoneManager.getState(MEMBER)?.title, 'Two', 'showing the track the group plays');
  } finally {
    spy.restore();
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('content started on a squeezelite member is started on its leader (#409)', async () => {
  // Another Spotify account picked on the member started a session of the member's own,
  // which its speaker never played.
  const LEADER = 49;
  const MEMBER = 50;
  const stub = stubSqueezeliteMemberPause();
  const harness = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409j');
  const { zoneManager, groupTracker } = harness;
  const spy = spyZonePlayback(zoneManager);
  try {
    await zoneManager.playContent(MEMBER, 'spotify:track:abc', 'serviceplay');
    assert.deepEqual(spy.calls, [`${LEADER}:playContent(spotify:track:abc,serviceplay)`]);

    // A queue row picked on the member: the row is from the queue the member shows, so it
    // is that row the group plays, not the leader's current one.
    spy.calls.length = 0;
    const repo = (zoneManager as unknown as {
      zoneRepo: { get: (id: number) => import('../src/application/zones/internal/zoneTypes').ZoneContext | undefined };
    }).zoneRepo;
    repo.get(MEMBER)!.queueController.setItems(
      [
        { audiopath: 'spotify:track:one', title: 'One', unique_id: 'u1' },
        { audiopath: 'spotify:track:two', title: 'Two', unique_id: 'u2' },
      ] as never,
      0,
    );
    assert.ok(zoneManager.queue.seekInQueue(MEMBER, 'u2'));
    zoneManager.handleCommand(MEMBER, 'queueplaycurrent');
    assert.deepEqual(spy.calls, [`${LEADER}:playContent(spotify:track:two,queue)`]);

    groupTracker.removeGroupByLeader(LEADER);
    spy.calls.length = 0;
    await zoneManager.playContent(MEMBER, 'spotify:track:abc', 'serviceplay');
    assert.deepEqual(spy.calls, [`${MEMBER}:playContent(spotify:track:abc,serviceplay)`], 'once it left, on itself');
  } finally {
    spy.restore();
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('play on a squeezelite member that is not held is the group play (#409)', async () => {
  // Its own play started whatever the member's own queue still held, as a session its
  // speaker never played.
  const LEADER = 51;
  const MEMBER = 52;
  const stub = stubSqueezeliteMemberPause();
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409k');
  const spy = spyZonePlayback(zoneManager);
  try {
    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    zoneManager.handleCommand(MEMBER, 'play');
    assert.deepEqual(spy.calls, [`${LEADER}:play`], 'a paused group is played through its leader');

    spy.calls.length = 0;
    zoneManager.handleCommand(MEMBER, 'resume', undefined, { groupedTargets: [MEMBER, LEADER] });
    assert.deepEqual(spy.calls, [], "a grouped play reaches the leader by its own copy");

    zoneManager.applyPatch(LEADER, { mode: 'play' });
    zoneManager.handleCommand(MEMBER, 'play');
    assert.deepEqual(spy.calls, [], 'a playing group has the member playing already');
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');
  } finally {
    spy.restore();
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a zone joining a squeezelite group ends its own session but not its player (#409)', async () => {
  // A room that had another Spotify account on, paused on its own Connect device, kept
  // that session after it joined. Minutes later Soloist picked it up again and played it
  // into the speaker that was meant to follow the leader.
  const LEADER = 53;
  const MEMBER = 54;
  const stub = stubSqueezeliteMemberPause();
  const harness = await getZoneHarness();
  const { zoneManager, groupTracker, audioManager } = harness;
  const zone = (id: number, name: string): ZoneConfig => ({
    ...createZoneConfig(id, name),
    transports: [{ id: 'squeezelite', playerId: `aa:bb:cc:00:00:${id}` } as never],
  });
  await zoneManager.replaceAll([zone(LEADER, 'Kitchen'), zone(MEMBER, 'Utility')], { spotify: {} });
  const repo = (zoneManager as unknown as {
    zoneRepo: { get: (id: number) => import('../src/application/zones/internal/zoneTypes').ZoneContext | undefined };
  }).zoneRepo;
  const inputs = (zoneManager as unknown as {
    inputsPort: { stopSpotifySession: (zoneId: number, reason?: string) => void };
  }).inputsPort;
  const realStopSpotify = inputs.stopSpotifySession;
  const spotifyStops: string[] = [];
  inputs.stopSpotifySession = (zoneId, reason) => {
    spotifyStops.push(`${zoneId}:${reason}`);
  };
  let ownSession: { zoneId: number; state: string; source: string } | null = {
    zoneId: MEMBER,
    state: 'paused',
    source: 'spotify-connect',
  };
  const realGetSession = audioManager.getSession.bind(audioManager);
  (audioManager as unknown as { getSession: (zoneId: number) => unknown }).getSession = (zoneId) =>
    zoneId === MEMBER ? ownSession : realGetSession(zoneId);
  const member = repo.get(MEMBER)!;
  const playerStops: number[] = [];
  const realPlayerStop = member.player.stop.bind(member.player);
  member.player.stop = (reason?: string) => {
    playerStops.push(MEMBER);
    ownSession = null;
    return realPlayerStop(reason);
  };
  try {
    // What the room played on its own before it joined.
    member.activeInput = 'spotify';
    member.inputMode = 'spotify';
    member.activeOutput = 'squeezelite';
    member.queue.authority = 'spotify';
    zoneManager.applyPatch(MEMBER, { mode: 'pause', title: 'Planet Techno' });
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });

    groupTracker.upsertGroup({
      leader: LEADER,
      members: [MEMBER],
      backend: 'internal',
      externalId: 'group-409l',
      source: 'manual',
    });

    assert.deepEqual(spotifyStops, [`${MEMBER}:joined_group`], 'its Spotify session is let go of');
    assert.deepEqual(playerStops, [MEMBER], 'its own playback ends');
    assert.equal(member.inputMode, null);
    assert.equal(member.queue.authority, 'local');
    assert.ok(!stub.calls.includes(`${MEMBER}:stop`), 'its speaker is left to follow the leader');
    assert.equal(zoneManager.getState(MEMBER)?.title, 'One', 'it shows the group');
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play');

    spotifyStops.length = 0;
    playerStops.length = 0;
    groupTracker.upsertGroup({
      leader: LEADER,
      members: [MEMBER],
      backend: 'internal',
      externalId: 'group-409l',
      source: 'manual',
    });
    zoneManager.syncGroupMembersToLeader(LEADER);
    assert.deepEqual(spotifyStops, [], 'with nothing of its own left there is nothing to end');
    assert.deepEqual(playerStops, []);
  } finally {
    inputs.stopSpotifySession = realStopSpotify;
    member.player.stop = realPlayerStop;
    delete (audioManager as unknown as { getSession?: unknown }).getSession;
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('a zone whose speaker went to another source ends its session but leaves the speaker alone (#430)', async () => {
  // A Sonos soundbar switches itself to TV audio. The zone's Spotify session went on, and its next
  // track took the speaker back from the TV. The zone now gives the speaker up the way a stop
  // would - Spotify is let go of, so the phone stops advancing - except that the speaker, which
  // is playing the TV now, is not told to stop.
  const ZONE = 430;
  const stub = stubSqueezeliteMemberPause();
  const harness = await getZoneHarness();
  const { zoneManager, audioManager } = harness;
  await zoneManager.replaceAll(
    [{ ...createZoneConfig(ZONE, 'Living'), transports: [{ id: 'squeezelite', playerId: 'aa:bb:cc:00:04:30' } as never] }],
    { spotify: {} },
  );
  const internals = zoneManager as unknown as {
    zoneRepo: { get: (id: number) => import('../src/application/zones/internal/zoneTypes').ZoneContext | undefined };
    inputsPort: { stopSpotifySession: (zoneId: number, reason?: string) => void };
    externalStateRouter: { deps: { yieldToExternalSource: (zoneId: number) => boolean } };
  };
  const inputs = internals.inputsPort;
  const realStopSpotify = inputs.stopSpotifySession;
  const spotifyStops: string[] = [];
  inputs.stopSpotifySession = (zoneId, reason) => {
    spotifyStops.push(`${zoneId}:${reason}`);
  };
  let ownSession: { zoneId: number; state: string; source: string } | null = {
    zoneId: ZONE,
    state: 'playing',
    source: 'spotify-connect',
  };
  const realGetSession = audioManager.getSession.bind(audioManager);
  (audioManager as unknown as { getSession: (zoneId: number) => unknown }).getSession = (zoneId) =>
    zoneId === ZONE ? ownSession : realGetSession(zoneId);
  const ctx = internals.zoneRepo.get(ZONE)!;
  const playerStops: number[] = [];
  const realPlayerStop = ctx.player.stop.bind(ctx.player);
  ctx.player.stop = (reason?: string) => {
    playerStops.push(ZONE);
    ownSession = null;
    return realPlayerStop(reason);
  };
  try {
    ctx.activeInput = 'spotify';
    ctx.inputMode = 'spotify';
    ctx.activeOutput = 'squeezelite';
    ctx.queue.authority = 'spotify';
    zoneManager.applyPatch(ZONE, { mode: 'play', title: 'Planet Techno' });

    const yieldToExternalSource = internals.externalStateRouter.deps.yieldToExternalSource;
    assert.equal(yieldToExternalSource(ZONE), true);
    assert.deepEqual(spotifyStops, [`${ZONE}:switch_to_external`], 'the Spotify session is let go of');
    assert.deepEqual(playerStops, [ZONE], 'its own playback ends');
    assert.equal(ctx.inputMode, null);
    assert.equal(ctx.queue.authority, 'local');
    assert.ok(!stub.calls.includes(`${ZONE}:stop`), 'the speaker playing the TV is not stopped');

    spotifyStops.length = 0;
    playerStops.length = 0;
    assert.equal(yieldToExternalSource(ZONE), false, 'with nothing of its own left there is nothing to end');
    assert.deepEqual(spotifyStops, []);
    assert.deepEqual(playerStops, []);
  } finally {
    inputs.stopSpotifySession = realStopSpotify;
    ctx.player.stop = realPlayerStop;
    delete (audioManager as unknown as { getSession?: unknown }).getSession;
    stub.restore();
  }
});

test("a squeezelite member's own playback does not reach the speaker that follows its leader (#409)", async () => {
  // A member held out of the group was audible again minutes later: Soloist brought back
  // a Spotify session of the room's own, and its play went to the member's player, which
  // the group had left out, so it played that session on its own.
  const LEADER = 55;
  const MEMBER = 56;
  const stub = stubSqueezeliteMemberPause();
  const { SqueezeliteOutput } = require('../src/adapters/outputs/squeezelite/squeezeliteOutput') as typeof import('../src/adapters/outputs/squeezelite/squeezeliteOutput');
  const proto = SqueezeliteOutput.prototype as unknown as Record<string, unknown>;
  const realPlay = proto.play;
  proto.play = async function (this: { zoneId: number }) {
    stub.calls.push(`${this.zoneId}:play`);
  };
  const { zoneManager, groupTracker } = await setUpSqueezeliteGroup(LEADER, MEMBER, 'group-409m');
  const repo = (zoneManager as unknown as {
    zoneRepo: { get: (id: number) => import('../src/application/zones/internal/zoneTypes').ZoneContext | undefined };
  }).zoneRepo;
  const emit = (zoneId: number, event: string, session: unknown) =>
    (repo.get(zoneId)!.player as unknown as { emit: (event: string, ...args: unknown[]) => void }).emit(
      event,
      session,
    );
  const session = (zoneId: number, extra: Record<string, unknown> = {}) => ({
    zoneId,
    state: 'playing',
    source: 'spotify-connect',
    playbackSource: { kind: 'url', url: 'http://example/own.flac' },
    metadata: { title: 'Planet Techno', artist: '', album: '', ...extra },
  });
  try {
    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One' });
    zoneManager.handleCommand(MEMBER, 'pause');
    assert.deepEqual(stub.calls, [`${MEMBER}:hold`]);

    // The room's own session comes back and runs through its play, pause, resume and stop.
    for (const event of ['started', 'paused', 'resumed', 'stopped']) {
      emit(MEMBER, event, session(MEMBER));
    }
    assert.deepEqual(stub.calls, [`${MEMBER}:hold`], 'none of it reached the member speaker');
    assert.ok(stub.held.has(MEMBER), 'which is still held');
    assert.equal(repo.get(MEMBER)!.activeOutput, null);

    // An alert is still heard in the room.
    emit(MEMBER, 'started', session(MEMBER, { isAlert: true }));
    assert.equal(stub.calls.at(-1), `${MEMBER}:play`, 'an alert plays on the member speaker');

    // The leader drives its own speaker as before.
    stub.calls.length = 0;
    emit(LEADER, 'started', session(LEADER));
    emit(LEADER, 'paused', session(LEADER));
    assert.deepEqual(stub.calls, [`${LEADER}:play`, `${LEADER}:pause`]);

    // Out of the group the room's own playback is its own again.
    groupTracker.removeGroupByLeader(LEADER);
    stub.calls.length = 0;
    emit(MEMBER, 'started', session(MEMBER));
    assert.deepEqual(stub.calls, [`${MEMBER}:play`]);
  } finally {
    proto.play = realPlay;
    groupTracker.removeGroupByLeader(LEADER);
    stub.restore();
  }
});

test('the players of a Loxone fixed group follow the leader the app drives (#434)', async () => {
  // The Loxone app sends every command for a fixed group to its first player only; the
  // other players hear nothing from it. They play along through the same group following a
  // dynamic group uses.
  const LEADER = 14;
  const MEMBER = 15;
  const harness = await getZoneHarness();
  const { zoneManager, groupManager, groupTracker } = harness;
  await zoneManager.replaceAll([createZoneConfig(LEADER, 'Living'), createZoneConfig(MEMBER, 'Kitchen')], {
    spotify: {},
  });
  try {
    zoneManager.applyPatch(LEADER, { volume: 40 });
    zoneManager.applyPatch(MEMBER, { volume: 20 });
    groupManager.reconcileFixedGroups([
      { externalId: '2197102c-0107-dfc5-ffff4decce15e82a', leader: LEADER, members: [LEADER, MEMBER] },
    ]);
    assert.equal(groupTracker.getGroupByZone(MEMBER)?.source, 'fixed');
    assert.deepEqual(zoneManager.getGroupMembership(MEMBER), { leader: LEADER, members: [LEADER, MEMBER] });

    zoneManager.applyPatch(LEADER, { mode: 'play', title: 'One', artist: 'Someone' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'play', 'the member plays with the leader');
    assert.equal(zoneManager.getState(MEMBER)?.title, 'One', 'and shows what the group plays');

    zoneManager.applyPatch(LEADER, { mode: 'pause' });
    assert.equal(zoneManager.getState(MEMBER)?.mode, 'pause');

    // The leader's own volume stays the leader's: the member keeps its level, so the
    // two rooms keep the balance they were set to.
    zoneManager.applyPatch(LEADER, { volume: 60 });
    assert.equal(zoneManager.getState(MEMBER)?.volume, 20);
  } finally {
    groupManager.reconcileFixedGroups([]);
  }
  assert.equal(groupTracker.getGroupByZone(MEMBER), undefined, 'gone once the config no longer has it');
});

test('group join/leave emits audio sync payloads', async () => {
  const harness = await getZoneHarness();
  const {
    zoneManager,
    setNotifier,
    noopNotifier,
    airplayGroupController,
    noopAirplayGroupController,
    groupTracker,
  } = harness;

  const audioSyncEvents: Array<any> = [];
  const syncCalls: number[] = [];
  const stopCalls: Array<{ leader: number; members: number[] }> = [];

  const notifier: NotifierPort = {
    ...noopNotifier,
    notifyAudioSyncEvent: (payload) => audioSyncEvents.push(payload),
  };
  setNotifier(notifier);
  Object.assign(airplayGroupController, {
    ...noopAirplayGroupController,
    syncCurrentGroup: async (leaderId: number) => {
      syncCalls.push(leaderId);
    },
    stopGroupMembers: async (leaderId: number, members: number[]) => {
      stopCalls.push({ leader: leaderId, members });
    },
  });

  await zoneManager.replaceAll([createZoneConfig(1, 'Living'), createZoneConfig(2, 'Kitchen')], {
    spotify: {},
  });

  const { upsertGroup, removeGroupByLeader, getGroupByLeader } = groupTracker;
  upsertGroup({
    leader: 1,
    members: [2],
    backend: 'internal',
    externalId: 'group-1',
    source: 'manual',
  });

  assert.equal(getGroupByLeader(1)?.members.length, 2);
  assert.ok(syncCalls.includes(1));
  const createdPayload = audioSyncEvents.at(-1)?.[0];
  assert.ok(createdPayload);
  assert.equal(createdPayload.group, 'group-1');
  assert.equal(createdPayload.players.length, 2);

  removeGroupByLeader(1);
  assert.ok(stopCalls.some((call) => call.leader === 1));
  const removedPayload = audioSyncEvents.at(-1)?.[0];
  assert.equal(removedPayload.players.length, 0);

  Object.assign(airplayGroupController, noopAirplayGroupController);
  setNotifier(noopNotifier);
});

test('output routing switches active output and stops previous', () => {
  const { dispatchOutputs } = require('../src/application/zones/services/outputOrchestrator') as typeof import('../src/application/zones/services/outputOrchestrator');

  const calls: { sendspin: string[]; dlna: string[] } = { sendspin: [], dlna: [] };
  const makeOutput = (type: 'sendspin' | 'dlna', ready: boolean) => ({
    type,
    isReady: () => ready,
    play: () => {
      calls[type].push('play');
    },
    pause: () => {
      calls[type].push('pause');
    },
    resume: () => {
      calls[type].push('resume');
    },
    stop: () => {
      calls[type].push('stop');
    },
    dispose: () => undefined,
  });

  const sendspin = makeOutput('sendspin', true);
  const dlna = makeOutput('dlna', false);

  const ctx = {
    id: 1,
    name: 'Living',
    config: createZoneConfig(1, 'Living'),
    activeInput: null,
    activeOutput: 'dlna',
    activeOutputTypes: new Set<string>(['dlna']),
  } as any;

  const session = {
    zoneId: 1,
    source: 'queue',
    playbackSource: { kind: 'file', path: '/tmp/fake.wav' },
  } as unknown as PlaybackSession;

  const { createLogger } = require('../src/shared/logging/logger') as typeof import('../src/shared/logging/logger');
  const log = createLogger('Test', 'OutputRouting');
  const noopOutputError = () => undefined;
  dispatchOutputs(ctx, [sendspin, dlna], 'play', session, log, noopOutputError);

  assert.equal(ctx.activeOutput, 'sendspin');
  assert.equal(calls.dlna.filter((entry) => entry === 'stop').length, 1);
  assert.equal(calls.sendspin.filter((entry) => entry === 'play').length, 1);
});

test('favorites/recents recover from missing and corrupt JSON', async () => {
  await withTempCwd(async () => {
    const favoritesStore = freshRequire<typeof import('../src/application/zones/favorites/favoritesStore')>(
      '../src/application/zones/favorites/favoritesStore',
    );
    const recentsStore = freshRequire<typeof import('../src/application/zones/recents/recentsStore')>(
      '../src/application/zones/recents/recentsStore',
    );

    const missingFavorites = await favoritesStore.loadFavorites(1);
    const missingRecents = await recentsStore.loadRecents(1);
    assert.equal(missingFavorites.items.length, 0);
    assert.equal(missingRecents.items.length, 0);

    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.mkdir(path.join(process.cwd(), 'data', 'recents'), { recursive: true });
    await fs.writeFile(path.join(process.cwd(), 'data', 'favorites', '1.json'), '{not-json');
    await fs.writeFile(path.join(process.cwd(), 'data', 'recents', '1.json'), '{not-json');

    const corruptFavorites = await favoritesStore.loadFavorites(1);
    const corruptRecents = await recentsStore.loadRecents(1);
    assert.equal(corruptFavorites.items.length, 0);
    assert.equal(corruptRecents.items.length, 0);
  });
});

test('config loads defaults and ignores env overrides', async () => {
  await withTempCwd(async () => {
    const originalEnv = process.env.AUDIOSERVER_IP;
    process.env.AUDIOSERVER_IP = '203.0.113.123';
    try {
      const configRepositoryModule = freshRequire<typeof import('../src/application/config/configRepository')>(
        '../src/application/config/configRepository',
      );
      const configAdapterModule = freshRequire<typeof import('../src/adapters/config/ConfigAdapter')>(
        '../src/adapters/config/ConfigAdapter',
      );
      const storage = new StorageAdapter();
      const configRepository = new configRepositoryModule.ConfigRepository(storage);
      const configPort = new configAdapterModule.ConfigAdapter(configRepository);
      const cfg = await configPort.load();
      assert.ok(Array.isArray(cfg.zones));
      assert.equal(cfg.zones.length, 0);
      assert.equal(cfg.system.adminHttp.enabled, true);
      // AirPlay used to be a global input toggle; it is per-zone now
      // (`ZoneAirplayConfig`), so there is deliberately no `inputs.airplay`
      // default to assert. Only line-in remains a global input.
      assert.ok(Array.isArray(cfg.inputs?.lineIn?.inputs));
      assert.deepEqual(cfg.content.tts?.provider, { type: 'internal' });
      assert.notEqual(cfg.system.audioserver.ip, '203.0.113.123');
      assert.equal('alertPreDelayMs' in cfg.system.audioserver, false);

      await fs.writeFile(path.join(process.cwd(), 'data', 'config.json'), '{bad-json');
      const next = await configPort.load();
      assert.equal(next.zones.length, 0);
      assert.equal('alertPreDelayMs' in next.system.audioserver, false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.AUDIOSERVER_IP;
      } else {
        process.env.AUDIOSERVER_IP = originalEnv;
      }
    }
  });
});

test('config repository serializes concurrent updates', async () => {
  await withTempCwd(async () => {
    const configRepositoryModule = freshRequire<typeof import('../src/application/config/configRepository')>(
      '../src/application/config/configRepository',
    );
    const storage = new StorageAdapter();
    const repo = new configRepositoryModule.ConfigRepository(storage);
    await repo.load();

    await Promise.all(
      Array.from({ length: 12 }, (_, idx) =>
        repo.update((cfg) => {
          cfg.system.miniserver.serial = `ms-${idx}`;
        }),
      ),
    );

    const cfg = repo.get();
    assert.ok(typeof cfg.system.miniserver.serial === 'string');
    assert.ok(cfg.system.miniserver.serial.startsWith('ms-'));
    const onDisk = JSON.parse(
      await fs.readFile(path.join(process.cwd(), 'data', 'config.json'), 'utf-8'),
    );
    assert.ok(typeof onDisk.system?.miniserver?.serial === 'string');
  });
});

/**
 * A test that awaits something which never settles does not fail — the event loop
 * simply drains and Node exits 0 mid-run, reporting success for every test that
 * never got to run. That silently hid the last 63 tests of this suite for a while
 * (a stubbed ffmpeg spawn that only exits when killed). These two guards make that
 * failure mode loud: a per-test timeout turns a stuck await into one failing test,
 * and the completion flag turns an early exit into a non-zero exit code.
 */
const TEST_TIMEOUT_MS = 30_000;
let runCompleted = false;

process.on('exit', (code) => {
  if (!runCompleted && code === 0) {
    console.error(
      '\nnot ok - test run exited before completing: a test is awaiting something that never settles',
    );
    process.exitCode = 1;
  }
});

async function withTimeout(name: string, fn: TestFn): Promise<void> {
  // Arm the watchdog *before* invoking the test. Some tests swap out
  // `global.setTimeout` to capture the delays their subject schedules, and a
  // watchdog created inside that window would be recorded as one of them.
  let reject!: (error: Error) => void;
  const tripped = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  const timer = setTimeout(
    () => reject(new Error(`test timed out after ${TEST_TIMEOUT_MS} ms: ${name}`)),
    TEST_TIMEOUT_MS,
  );
  try {
    await Promise.race([Promise.resolve(fn()), tripped]);
  } finally {
    clearTimeout(timer);
  }
}

/*
 * When tests/supervise.ts started us there is an IPC channel on fd 3. Announcing
 * each test before it runs is the only way a crash that kills this process — a
 * native addon's segfault, say — can still be attributed to a test: no handler
 * here survives a signal, but the parent has the last breadcrumb. Unref the
 * channel so it does not hold the event loop open, which would turn the
 * never-settles failure above into a hang instead of an early exit.
 */
process.channel?.unref();
const announce = process.send
  ? (index: number, name: string) => {
      process.send?.({ type: 'test:start', index, name, total: tests.length });
    }
  : () => {};

async function run(): Promise<void> {
  let failures = 0;
  for (const [index, { name, fn }] of tests.entries()) {
    try {
      announce(index, name);
      await withTimeout(name, fn);
      console.log(`ok - ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok - ${name}`);
      console.error(error);
    }
  }
  childProcess.spawn = originalSpawn;
  if (zoneHarnessPromise) {
    const harness = await zoneHarnessPromise;
    await harness.cleanup();
  }
  console.log(`\n# ${tests.length - failures}/${tests.length} passed`);
  runCompleted = true;
  if (failures > 0) {
    process.exitCode = 1;
  }

  /*
   * The opposite failure mode to the guards above: a test that leaves a repeating timer or an open
   * socket behind keeps the loop alive after the last result is in, and the run never ends. That is
   * worse in CI than a failing test — `npm test` sits there until the job's own timeout hours later,
   * with a green summary already printed. The verdict is complete at this point, so say it and go.
   * The write callback fires once stdout has drained, so a piped or redirected summary is not cut off.
   */
  process.stdout.write('', () => process.exit(process.exitCode ?? 0));
}

void run();
