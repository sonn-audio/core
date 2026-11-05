import { audioOutputSettings } from '../../src/ports/types/audioFormat';
import { AudioAnalysisService } from '../../src/application/audio/audioAnalysisService';
import type { AirplayGroupCoordinator } from '../../src/application/outputs/airplayGroupController';
import type { GroupTrackerPort } from '../../src/ports/GroupTrackerPort';
import type { ConfigPort } from '../../src/ports/ConfigPort';
import type { EnginePort } from '../../src/ports/EnginePort';
import type { OutputPorts } from '../../src/adapters/outputs/outputPorts';
import type { OutputStreamEventsPort } from '../../src/ports/OutputStreamEventsPort';
import type { SendspinGroupCoordinator } from '../../src/application/outputs/sendspinGroupController';
import type { SnapcastCorePort } from '../../src/ports/SnapcastCorePort';
import type { SnapcastGroupCoordinator } from '../../src/application/outputs/snapcastGroupController';
import type { SonosGroupCoordinator } from '../../src/application/outputs/sonosGroupController';
import type { SqueezeliteGroupCoordinator } from '../../src/application/outputs/squeezeliteGroupController';
import type { SendspinHookRegistryPort } from '../../src/adapters/outputs/sendspin/sendspinHookRegistry';
import { SqueezeliteCore } from '../../src/adapters/outputs/squeezelite/squeezeliteCore';
import { SpotifyServiceManagerProvider } from '../../src/adapters/content/providers/spotifyServiceManager';
import { SpotifyDeviceRegistry } from '../../src/adapters/outputs/spotify/deviceRegistry';

export const noopAudioManager = {
  getSession: () => null,
  getOutputSettings: () => null,
  startExternalPlayback: () => null,
};

export const noopZoneAudioPrefs = {
  getEffectiveOutputSettings: () => audioOutputSettings,
};

export const noopOutputStreamEventsPort: OutputStreamEventsPort = {
  waitForStreamRequest: async () => null,
};

const noopEnginePort: EnginePort = {
  start: () => {
    /* noop */
  },
  startWithHandoff: () => {
    /* noop */
  },
  stop: () => {
    /* noop */
  },
  createStream: () => null,
  createLocalSession: () => ({
    start: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
    createSubscriber: () => null,
  }),
  waitForFirstChunk: async () => false,
  hasSession: () => false,
  getSessionStats: () => [],
  setSessionTerminationHandler: () => {
    /* noop */
  },
  restartZoneForEqualizer: () => false,
  inlineCrossfade: async () => false,
};

export const noopAirplayGroupController: AirplayGroupCoordinator = {
  register: () => {
    /* noop */
  },
  unregister: () => {
    /* noop */
  },
  startSyncedGroup: async () => false,
  tryJoinLeader: async () => false,
  syncGroupMembers: async () => {
    /* noop */
  },
  stopGroupMembers: async () => {
    /* noop */
  },
  detachMember: async () => {
    /* noop */
  },
  syncCurrentGroup: async () => {
    /* noop */
  },
  onLeaderStopped: () => {
    /* noop */
  },
};

export const noopSnapcastCorePort: SnapcastCorePort = {
  listClients: () => [],
  setClientLatency: () => ({ updated: false, connected: false, latency: 0 }),
  setStream: () => {
    /* noop */
  },
  clearStream: () => {
    /* noop */
  },
  setClientStream: () => {
    /* noop */
  },
  setClientVolumes: () => {
    /* noop */
  },
};

export const noopSnapcastGroupController: SnapcastGroupCoordinator = {
  register: () => {
    /* noop */
  },
  unregister: () => {
    /* noop */
  },
  buildPlan: (zoneId, baseStreamId, baseClientIds) => ({
    shouldPlay: true,
    streamId: baseStreamId,
    clientIds: baseClientIds,
    leaderZoneId: zoneId,
    isLeader: true,
  }),
};

export const noopSendspinGroupController: SendspinGroupCoordinator = {
  register: () => {
    /* noop */
  },
  unregister: () => {
    /* noop */
  },
  getMemberDeclaredFormats: () => [],
  notifyStreamStart: () => {
    /* noop */
  },
  notifyStreamPause: () => {
    /* noop */
  },
  notifyStreamEnd: () => {
    /* noop */
  },
  broadcastFrame: () => {
    /* noop */
  },
  broadcastMetadata: () => {
    /* noop */
  },
  broadcastControllerState: () => {
    /* noop */
  },
  broadcastPlaybackState: () => {
    /* noop */
  },
};

const noopSendspinHooks: SendspinHookRegistryPort = {
  register: () => () => {
    /* noop */
  },
};

const noopSendspinConnector: OutputPorts['sendspinConnector'] = {
  watchClient: () => () => {},
  onClientResolved: () => () => {},
  requestPlaybackPriority: () => {},
  advertiseServer: () => {},
  stopAdvertising: () => {},
  markInboundConnected: () => {},
  markInboundDisconnected: () => {},
  notePairingRequired: () => {},
} as any;

const noopZoneManager: OutputPorts['zoneManager'] = {
  getZoneState: () => null,
  handleCommand: () => {
    /* noop */
  },
  applyPatch: () => {
    /* noop */
  },
  queue: {
    setShuffle: () => {},
    setPendingShuffle: () => {},
    setRepeatMode: () => {},
    seekInQueue: () => false,
  },
};

const noopGroupManager: OutputPorts['groupManager'] = {
  applySpecGroupVolume: () => {
    /* noop */
  },
};

export const noopSonosGroupController: SonosGroupCoordinator = {
  register: () => {
    /* noop */
  },
  unregister: () => {
    /* noop */
  },
  tryJoinLeader: async () => false,
  syncGroupMembers: async () => {
    /* noop */
  },
};

export const noopSqueezeliteGroupController: SqueezeliteGroupCoordinator = {
  register: () => {
    /* noop */
  },
  unregister: () => {
    /* noop */
  },
  isSyncGroup: () => false,
  preparePlayback: (zoneId: number) => ({
    grouped: false,
    leaderZoneId: zoneId,
    expectedCount: 1,
  }),
  orchestrateGroupEnqueue: async () => false,
  isZoneResyncing: () => false,
  holdMember: () => {
    /* noop */
  },
  releaseMember: () => false,
  isMemberHeld: () => false,
  orchestrateGroupPlayback: async () => false,
  orchestrateGroupPause: async () => false,
  orchestrateGroupResume: async () => false,
  orchestrateGroupStop: async () => false,
  notifyBufferReady: () => {
    /* noop */
  },
  notifyPlaybackTick: () => {
    /* noop */
  },
};

export const noopGroupTracker: GroupTrackerPort = {
  upsertGroup: (input) => ({ record: { ...input, updatedAt: 0 }, changed: false }),
  removeGroupByLeader: () => false,
  getGroupByZone: () => undefined,
  getGroupByLeader: () => undefined,
  getGroupByExternalId: () => undefined,
  onGroupChanged: () => () => {
    /* noop */
  },
  setJoinedLeader: () => {
    /* noop */
  },
  getJoinedLeader: () => null,
  clearJoinedLeader: () => {
    /* noop */
  },
};

// Real service, fed by an analyzer that swallows everything: the fake needs the
// class's own behaviour (subscribe bookkeeping), not a stubbed shape.
export const noopAudioAnalysis = new AudioAnalysisService(() => ({
  push: () => {
    /* noop */
  },
}));

export const noopOutputHandlers = {
  onQueueUpdate: () => {
    /* noop */
  },
  onOutputError: () => {
    /* noop */
  },
  onOutputState: () => {
    /* noop */
  },
};

export function makeOutputPortsFake(
  configPort: ConfigPort,
  deps: {
    spotifyManagerProvider?: SpotifyServiceManagerProvider;
    spotifyDeviceRegistry?: SpotifyDeviceRegistry;
  } = {},
): OutputPorts {
  const spotifyManagerProvider = deps.spotifyManagerProvider ?? new SpotifyServiceManagerProvider(configPort);
  const spotifyDeviceRegistry = deps.spotifyDeviceRegistry ?? new SpotifyDeviceRegistry();
  const squeezeliteCore = new SqueezeliteCore(configPort);
  return {
    engine: noopEnginePort,
    audioAnalysis: noopAudioAnalysis,
    groupTracker: noopGroupTracker,
    audioManager: noopAudioManager,
    zoneAudioPrefs: noopZoneAudioPrefs,
    outputStreamEvents: noopOutputStreamEventsPort,
    airplayGroup: noopAirplayGroupController,
    snapcastCore: noopSnapcastCorePort,
    snapcastGroup: noopSnapcastGroupController,
    sendspinGroup: noopSendspinGroupController,
    sendspinHooks: noopSendspinHooks,
    sendspinConnector: noopSendspinConnector,
    squeezeliteGroup: noopSqueezeliteGroupController,
    squeezeliteCore,
    zoneManager: noopZoneManager,
    groupManager: noopGroupManager,
    sonosGroup: noopSonosGroupController,
    outputHandlers: noopOutputHandlers,
    config: configPort,
    spotifyManagerProvider,
    spotifyDeviceRegistry,
  };
}
