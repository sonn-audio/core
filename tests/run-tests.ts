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
import './localLibraryStore.rollup.test';
import './airplayAdvertisement.test';
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
import './audioServersAndBearer.test';
import './outputFactory.airplay.test';
import './outputFactory.sendspin.test';
import './outputFactory.streamFormat.test';
import './airplayPcmStream.test';
import './airplayVolumeAssert.test';
import './airplayStreamSession.test';
import './airplayHardwareAddress.test';
import './audioStreamHandlerIcy.test';
import './audioProxyIcyStream.test';
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
import './sonosTransportResilience.test';
import './externalStateRouter.test';
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
import './configHandlers.system.test';
import './equalizer.test';
import './zoneHandlers.serviceplay.test';
import './alertHandlers.playeventfile.test';
import './alertHandlers.zoneRoutes.test';
import './alertStartAlignment.test';
import './alertsCoordinator.test';
import './playbackErrorOrigin.test';
import './alertsManager.volume.test';
import './ttsProviders.test';
import './loxberryTtsProvider.test';
import './zoneHandlers.roomfavs.test';
import './favoritesManager.compat.test';
import './recentsManager.compat.test';
import './contentMetadataHarvestCache.test';
import './contentProviderDispatch.test';
import './queueBuilderArtistFlatten.test';
import './nowPlayingMetadata.test';
import './publicApi.test';
import './dlnaRendererReflection.test';
import './dlnaRendererCast.test';
import './zoneMute.test';
import './sonnCoreDiscovery.test';
import './itemAbout.test';
import './browseContainerIdentity.test';
import './outputDelay.test';
import './outputStreamFormat.test';
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
import './mixedGroupFanout.test';
import './loxoneZoneProjection.test';
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

async function run(): Promise<void> {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
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
