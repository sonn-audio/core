import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import { PlaybackCoordinator } from '../src/application/zones/PlaybackCoordinator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import { normalizeSpotifyAudiopath } from '../src/application/zones/helpers/queueHelpers';
import { applyZonePatch } from '../src/domain/zones/reducer';
import { createZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { ZoneConfig, AudioServerConfig, RawAudioConfig } from '../src/domain/config/types';
import type { QueueItem } from '../src/ports/types/queueTypes';
import type { ZoneContext, QueueAuthority } from '../src/application/zones/internal/zoneTypes';
import type {
  InputsPort,
  InputStreamResult,
  LineInControlCommand,
  SpotifyConnectController,
} from '../src/ports/InputsPort';
import type { ContentPort } from '../src/ports/ContentPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ZoneOutput } from '../src/ports/OutputsTypes';
import type { AudioManager } from '../src/application/playback/audioManager';
import type { PlaybackSource } from '../src/ports/EngineTypes';
import type { CoverArtPayload, PlaybackMetadata, PlaybackSession } from '../src/ports/types/playback';
import type { OutputRouter } from '../src/application/zones/OutputRouter';
import type { ZoneAudioHelpers } from '../src/application/zones/internal/zoneAudioHelpers';
import type { RecentsManager } from '../src/application/zones/recents/recentsManager';
import type { ComponentLogger } from '../src/shared/logging/logger';

const baseConfig: AudioServerConfig = {
  system: {
    miniserver: { ip: '127.0.0.1', serial: 'miniserver' },
    audioserver: {
      ip: '127.0.0.1',
      name: 'audioserver',
      uuid: 'uuid',
      macId: '00:00:00:00:00:00',
      paired: false,
      extensions: [],
    },
    logging: { consoleLevel: 'info', fileLevel: 'info' },
    adminHttp: { enabled: true },
  },
  content: { radio: {}, spotify: { accounts: [], bridges: [] } },
  zones: [],
  rawAudioConfig: {} as RawAudioConfig,
};

class FakeConfigPort implements ConfigPort {
  private readonly config: AudioServerConfig;

  constructor(config: AudioServerConfig) {
    this.config = config;
  }

  public async load(): Promise<AudioServerConfig> {
    return this.config;
  }

  public getConfig(): AudioServerConfig {
    return this.config;
  }

  public getSystemConfig(): AudioServerConfig['system'] {
    return this.config.system;
  }

  public getRawAudioConfig(): RawAudioConfig {
    return this.config.rawAudioConfig;
  }

  public ensureInputs(): void {
    /* noop */
  }

  public async updateConfig(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    await mutator(this.config);
    return this.config;
  }
}

class FakeInputsPort implements InputsPort {
  public readonly stopSpotifyCalls: Array<{ zoneId: number; reason?: string }> = [];
  public readonly stopAirplayCalls: Array<{ zoneId: number; reason?: string }> = [];
  public readonly switchAwayCalls: number[] = [];
  public readonly remoteControlCalls: Array<{ zoneId: number; command: string }> = [];
  public readonly remoteVolumeCalls: Array<{ zoneId: number; volume: number }> = [];
  public readonly spotifyVolumeCalls: Array<{ zoneId: number; volume: number }> = [];
  public readonly playerCommandCalls: Array<{ zoneId: number; command: string; args?: Record<string, unknown> }> = [];
  public readonly requestLineInStopCalls: string[] = [];
  public readonly requestLineInControlCalls: Array<{ inputId: string; command: LineInControlCommand }> = [];
  public readonly markSessionCalls: Array<{ zoneId: number; metadata?: PlaybackMetadata | null }> = [];
  public spotifyController: SpotifyConnectController | null = null;
  public playbackSource: PlaybackSource | null = null;
  public streamResult: InputStreamResult = { playbackSource: null };

  public configureAirplay(): void {
    /* noop */
  }

  public setAirplayPlayerResolver(): void {
    /* noop */
  }

  public syncAirplayZones(): void {
    /* noop */
  }

  public async renameAirplayZone(): Promise<void> {
    /* noop */
  }

  public async shutdownAirplay(): Promise<void> {
    /* noop */
  }

  public configureDlna(): void {
    /* noop */
  }

  public syncDlnaZones(): void {
    /* noop */
  }

  public shutdownDlna(): void {
    /* noop */
  }

  public configureBluetooth(): void {
    /* noop */
  }

  public syncBluetoothZones(): void {
    /* noop */
  }

  public shutdownBluetooth(): void {
    /* noop */
  }

  public async prefetchPlaybackSourceForUri(): Promise<void> {
    /* noop */
  }

  public async startCrossfadeStream(): Promise<null> {
    return null;
  }

  public stopCrossfadeStream(): void {
    /* noop */
  }

  public releaseCrossfadeStream(): void {
    /* noop */
  }

  public configureSpotify(controller: SpotifyConnectController): void {
    this.spotifyController = controller;
  }

  public syncSpotifyZones(): void {
    /* noop */
  }

  public async renameSpotifyZone(): Promise<void> {
    /* noop */
  }

  public async shutdownSpotify(): Promise<void> {
    /* noop */
  }

  public configureMusicAssistant(): void {
    /* noop */
  }

  public async syncMusicAssistantZones(): Promise<void> {
    /* noop */
  }

  public shutdownMusicAssistant(): void {
    /* noop */
  }

  public getMusicAssistantProviderId(): string {
    return 'musicassistant';
  }

  public async startStreamForAudiopath(): Promise<InputStreamResult> {
    return this.streamResult;
  }

  public async getPlaybackSourceForUri(): Promise<PlaybackSource | null> {
    return this.playbackSource;
  }

  public getPlaybackSource(): PlaybackSource | null {
    return this.playbackSource;
  }

  public markSessionActive(zoneId: number, metadata?: PlaybackMetadata | null): void {
    this.markSessionCalls.push({ zoneId, metadata });
  }

  public stopAirplaySession(zoneId: number, reason?: string): void {
    this.stopAirplayCalls.push({ zoneId, reason });
  }

  public stopSpotifySession(zoneId: number, reason?: string): void {
    this.stopSpotifyCalls.push({ zoneId, reason });
  }

  public async switchAway(zoneId: number): Promise<void> {
    this.switchAwayCalls.push(zoneId);
  }

  public remoteControl(zoneId: number, command: string): void {
    this.remoteControlCalls.push({ zoneId, command });
  }

  public remoteVolume(zoneId: number, volumePercent: number): void {
    this.remoteVolumeCalls.push({ zoneId, volume: volumePercent });
  }

  public spotifyVolume(zoneId: number, volumePercent: number): void {
    this.spotifyVolumeCalls.push({ zoneId, volume: volumePercent });
  }

  public async playerCommand(
    zoneId: number,
    command: string,
    args?: Record<string, unknown>,
  ): Promise<boolean> {
    this.playerCommandCalls.push({ zoneId, command, args });
    return true;
  }

  public requestLineInStop(inputId: string): void {
    this.requestLineInStopCalls.push(inputId);
  }

  public requestLineInControl(inputId: string, command: LineInControlCommand): void {
    this.requestLineInControlCalls.push({ inputId, command });
  }
}

class FakeOutputRouter {
  public readonly outputCalls: Array<{ zoneId: number; action: string; session: PlaybackSession | null | undefined }> = [];
  public readonly volumeCalls: Array<{ zoneId: number; volume: number }> = [];
  public trace: string[] | null = null;

  public dispatchOutputs(
    ctx: ZoneContext,
    _outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    this.trace?.push(`dispatchOutputs:${action}`);
    this.outputCalls.push({ zoneId: ctx.id, action, session: payload ?? null });
  }

  public dispatchVolume(ctx: ZoneContext, _outputs: ZoneOutput[], volume: number): void {
    this.trace?.push('dispatchVolume');
    this.volumeCalls.push({ zoneId: ctx.id, volume });
  }

  public selectPlayOutputs(outputs: ZoneOutput[]): ZoneOutput[] {
    return outputs;
  }
}

class FakeRecentsManager {
  public readonly records: Array<{ zoneId: number; item: QueueItem }> = [];

  public async record(zoneId: number, item: QueueItem): Promise<void> {
    this.records.push({ zoneId, item });
  }
}

class FakeZoneAudioPreferences {
  public readonly preferred: Array<{ zoneId: number; settings: unknown }> = [];
  public readonly httpPrefs: Array<{ zoneId: number; prefs: unknown }> = [];
  public readonly inputPrefs: Array<{ zoneId: number; prefs: unknown }> = [];

  public setPreferredOutputSettings(zoneId: number, settings: unknown): void {
    this.preferred.push({ zoneId, settings });
  }

  public setHttpPreferences(zoneId: number, prefs: unknown): void {
    this.httpPrefs.push({ zoneId, prefs });
  }

  public setInputPreferences(zoneId: number, prefs: unknown): void {
    this.inputPrefs.push({ zoneId, prefs });
  }
}

class FakeAudioManager {
  public readonly playRequests: Array<{ zoneId: number; req: { uri: string; type: string } }> = [];
  public readonly clearedPlayRequests: number[] = [];
  public readonly sessionMetadataUpdates: Array<{ zoneId: number; metadata: PlaybackMetadata }> = [];
  public session: PlaybackSession | null = null;

  public markPlayRequest(zoneId: number, req: { uri: string; type: string }): void {
    this.playRequests.push({ zoneId, req });
  }

  public clearPlayRequest(zoneId: number): void {
    this.clearedPlayRequests.push(zoneId);
  }

  public async waitForFirstChunk(): Promise<boolean> {
    return true;
  }

  public getSession(_zoneId: number): PlaybackSession | null {
    return this.session;
  }

  public updateSessionMetadata(zoneId: number, metadata: PlaybackMetadata): PlaybackSession | null {
    this.sessionMetadataUpdates.push({ zoneId, metadata });
    if (this.session && this.session.zoneId === zoneId) {
      this.session.metadata = metadata;
    }
    return this.session;
  }
}

class FakePlayer extends EventEmitter {
  public volume = 0;
  public timing = { elapsed: 0, duration: 0 };
  public metadata: PlaybackMetadata | null = null;
  public endGuardMs = 0;
  public state: { mode: 'playing' | 'paused' | 'stopped'; playbackSource: PlaybackSource | null } = {
    mode: 'stopped',
    playbackSource: null,
  };
  public session: PlaybackSession | null = null;
  public readonly stopReasons: string[] = [];

  private buildSession(source: string, playbackSource: PlaybackSource | null, metadata?: PlaybackMetadata): PlaybackSession {
    const now = Date.now();
    return {
      zoneId: 1,
      source,
      metadata,
      stream: {
        id: 'stream',
        url: 'http://example.com/stream',
        coverUrl: '',
        createdAt: now,
      },
      state: 'playing',
      elapsed: 0,
      duration: Math.round(metadata?.duration ?? 0),
      startedAt: now,
      updatedAt: now,
      playbackSource,
    };
  }

  public playUri(audiopath: string, metadata?: PlaybackMetadata): PlaybackSession {
    const session = this.buildSession(audiopath, null, metadata);
    this.session = session;
    this.state = { mode: 'playing', playbackSource: null };
    this.metadata = metadata ?? null;
    return session;
  }

  public playExternal(
    label: string,
    playbackSource: PlaybackSource | null,
    metadata?: PlaybackMetadata,
  ): PlaybackSession {
    const session = this.buildSession(label, playbackSource, metadata);
    this.session = session;
    this.state = { mode: 'playing', playbackSource };
    this.metadata = metadata ?? null;
    return session;
  }

  public pause(): PlaybackSession | null {
    if (this.session) {
      this.session.state = 'paused';
    }
    this.state.mode = 'paused';
    return this.session;
  }

  public resume(): PlaybackSession | null {
    if (this.session) {
      this.session.state = 'playing';
    }
    this.state.mode = 'playing';
    return this.session;
  }

  public stop(reason?: string): PlaybackSession | null {
    if (reason) {
      this.stopReasons.push(reason);
    }
    if (this.session) {
      this.session.state = 'stopped';
    }
    this.state.mode = 'stopped';
    return this.session;
  }

  public updateMetadata(metadata: PlaybackMetadata): void {
    this.metadata = { ...this.metadata, ...metadata };
    if (this.session) {
      this.session.metadata = this.metadata;
    }
  }

  public updateCover(cover?: CoverArtPayload): string | undefined {
    if (!cover) {
      return undefined;
    }
    if (this.session) {
      this.session.cover = cover;
    }
    return '/covers/zone.jpg';
  }

  public setVolume(level: number): void {
    this.volume = level;
    // Mirror the real ZonePlayer: setVolume *is* an emit, and that event is what
    // patches state and dispatches to outputs.
    this.emit('volume', level);
  }

  public updateTiming(elapsed: number, duration: number): void {
    this.timing = { elapsed, duration };
  }

  public setEndGuardMs(ms: number): void {
    this.endGuardMs = ms;
  }

  public getState(): { mode: 'playing' | 'paused' | 'stopped'; playbackSource: PlaybackSource | null } {
    return this.state;
  }

  public getSession(): PlaybackSession | null {
    return this.session;
  }
}

class FakeQueueController {
  public readonly reorderCalls: Array<{ mode: 'shuffle' | 'unshuffle' }> = [];
  public readonly setShuffleCalls: Array<{ zoneId: number; enabled: boolean }> = [];

  public isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return !authority || authority === 'local';
  }

  public seekExistingQueueInternal(ctx: ZoneContext, target: string): boolean {
    if (!target || ctx.queue.items.length === 0) {
      return false;
    }
    const normalizedTarget = normalizeSpotifyAudiopath(target);
    const idx = ctx.queue.items.findIndex(
      (item) =>
        normalizeSpotifyAudiopath(item.audiopath) === normalizedTarget ||
        normalizeSpotifyAudiopath(item.unique_id) === normalizedTarget,
    );
    if (idx < 0) {
      return false;
    }
    ctx.queueController.setCurrentIndex(idx);
    return true;
  }

  public setShuffle(zoneId: number, enabled: boolean): void {
    this.setShuffleCalls.push({ zoneId, enabled });
  }

  public reorderQueue(_ctx: ZoneContext, mode: 'shuffle' | 'unshuffle'): void {
    this.reorderCalls.push({ mode });
  }

  public async fillQueueInBackground(): Promise<void> {
    /* noop */
  }

  public async buildQueueForUri(): Promise<QueueItem[]> {
    return [];
  }
}

const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  listBrowsableServices: () => [],
  getBridgeRegistry: () => ({
    byServiceSlug: new Map(),
    byBridgeId: new Map(),
    accountCountByService: new Map(),
  }),
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

const noopNotifier: NotifierPort = {
  notifyZoneStateChanged: () => {},
  notifyQueueUpdated: () => {},
  notifyRoomFavoritesChanged: () => {},
  notifyRecentlyPlayedChanged: () => {},
  notifyRescan: () => {},
  notifyReloadMusicApp: () => {},
  notifyAudioSyncEvent: () => {},
};

function makeNotifierTracker(): {
  notifier: NotifierPort;
  queueUpdated: Array<{ zoneId: number; queueSize: number }>;
} {
  const queueUpdated: Array<{ zoneId: number; queueSize: number }> = [];
  return {
    notifier: {
      notifyZoneStateChanged: () => {},
      notifyQueueUpdated: (zoneId, queueSize) => {
        queueUpdated.push({ zoneId, queueSize });
      },
      notifyRoomFavoritesChanged: () => {},
      notifyRecentlyPlayedChanged: () => {},
      notifyRescan: () => {},
      notifyReloadMusicApp: () => {},
      notifyAudioSyncEvent: () => {},
    },
    queueUpdated,
  };
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  spam: () => {},
  isEnabled: () => false,
} as unknown as ComponentLogger;

function makeZoneConfig(id: number, name: string): ZoneConfig {
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

function makeOutput(type: string, stopCalls: Array<PlaybackSession | null>): ZoneOutput {
  return {
    type,
    play: () => {},
    pause: () => {},
    resume: () => {},
    stop: (session) => {
      stopCalls.push(session ?? null);
    },
    dispose: () => {},
  };
}

function createHarness(options?: {
  notifier?: NotifierPort;
  contentPort?: ContentPort;
  trace?: string[];
}) {
  const zoneRepo = new ZoneRepository();
  const inputsPort = new FakeInputsPort();
  const outputRouter = new FakeOutputRouter();
  if (options?.trace) {
    outputRouter.trace = options.trace;
  }
  const queueController = new FakeQueueController();
  const recentsManager = new FakeRecentsManager();
  const audioManager = new FakeAudioManager();
  const zoneAudioPrefs = new FakeZoneAudioPreferences();
  const configPort = new FakeConfigPort(baseConfig);
  const contentPort = options?.contentPort ?? noopContentPort;
  const audioHelpers: ZoneAudioHelpers = createZoneAudioHelpers(contentPort, configPort);
  const notifier = options?.notifier ?? noopNotifier;

  const patches: Array<{ zoneId: number; patch: Record<string, unknown> }> = [];
  const applyPatch = (zoneId: number, patch: Record<string, unknown>): void => {
    if (options?.trace) {
      options.trace.push('applyPatch');
    }
    patches.push({ zoneId, patch });
    const ctx = zoneRepo.get(zoneId);
    if (ctx) {
      ctx.state = applyZonePatch(ctx.state, patch as any);
    }
  };

  const stopAlert = async () => {};

  const config = makeZoneConfig(1, 'Zone');
  const queue = {
    items: [],
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local' as QueueAuthority,
  };
  const playbackQueue = new PlaybackQueueNavigator(queue);
  const player = new FakePlayer();
  const stopCalls: Array<PlaybackSession | null> = [];
  const outputs: ZoneOutput[] = [
    makeOutput('spotify', stopCalls),
    makeOutput('local', stopCalls),
  ];

  const ctx: ZoneContext = {
    id: config.id,
    name: config.name,
    sourceMac: config.sourceMac,
    config,
    state: buildInitialState(config),
    metadata: {},
    queue,
    queueController: playbackQueue,
    inputAdapter: { playInput: () => {} } as any,
    spotifyAdapter: {} as any,
    outputs,
    player: player as any,
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set(),
    activeOutput: null,
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: null,
    alert: undefined,
  };

  zoneRepo.set(ctx.id, ctx);

  const coordinator = new PlaybackCoordinator({
    zones: zoneRepo,
    queueController: queueController as unknown as any,
    outputRouter: outputRouter as unknown as OutputRouter,
    applyPatch: (zoneId, patch, _force) => applyPatch(zoneId, patch as any),
    stopAlert,
    log: noopLogger,
    notifier,
    inputsPort: inputsPort as unknown as InputsPort,
    audioHelpers,
    contentPort,
    configPort,
    recentsManager: recentsManager as unknown as RecentsManager,
    audioManager: audioManager as unknown as AudioManager,
    zoneAudioPrefs: zoneAudioPrefs as any,
  });
  // Speed up queue stepping for tests (otherwise waits 150ms).
  (coordinator as any).queueStepDispatcher.queueStepCoalesceMs = 0;
  /*
   * Wire the player listeners here, exactly once, because production does: a zone's
   * player is created and its listeners attached on adjacent lines in registerZone,
   * so a zone without them does not exist. Leaving them off made the harness assert
   * behaviour that only the (now removed) duplicate volume dispatch provided.
   */
  coordinator.setupPlayerListeners(ctx.player as any, ctx.outputs, ctx.id, ctx.name, ctx.sourceMac);

  return {
    coordinator,
    ctx,
    patches,
    inputsPort,
    outputRouter,
    recentsManager,
    audioManager,
    stopCalls,
    playbackQueue,
    notifier,
  };
}

async function flushAsync(): Promise<void> {
  // PlaybackCoordinator queue stepping is coalesced using setTimeout; prefer timers-phase flushing.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('input switching gates callbacks and stops prior sessions', async () => {
  const { coordinator, ctx, patches, inputsPort, stopCalls } = createHarness();
  const source: PlaybackSource = { kind: 'url', url: 'http://spotify.local/stream' };

  coordinator.playInputSource(ctx.id, 'spotify', source, {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:one',
  });

  const handlers = coordinator.getMusicAssistantInputHandlers();
  handlers.updateMetadata?.(ctx.id, { title: 'Ignored' });
  assert.equal(patches.length, 0);

  await coordinator.startQueuePlayback(ctx, 'tunein:station:abc', {
    title: 'Station',
    artist: '',
    album: '',
    audiopath: 'tunein:station:abc',
  });

  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
  assert.equal(inputsPort.stopSpotifyCalls[0]?.reason, 'switch_to_queue');
  assert.equal(stopCalls.length, 1);

  coordinator.updateInputMetadata(ctx.id, { title: 'Stale update' });
  assert.equal(patches.length, 0);

  inputsPort.spotifyController?.updateMetadata(ctx.id, { title: 'Still stale' });
  assert.equal(patches.length, 0);

  coordinator.playInputSource(ctx.id, 'musicassistant', source, {
    title: 'MA Track',
    artist: 'MA',
    album: 'MA',
    audiopath: 'musicassistant://track/1',
  });

  handlers.updateMetadata?.(ctx.id, { title: 'Now Playing', artist: 'MA' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.title, 'Now Playing');
});

test('duplicate end_of_track signals advance queue only once', async () => {
  const { coordinator, ctx } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ title: 'One', audiopath: 'spotify:track:one', unique_id: 'id-1' }),
      makeQueueItem({ title: 'Two', audiopath: 'spotify:track:two', unique_id: 'id-2' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';
  ctx.activeInput = 'queue';

  let startCount = 0;
  (coordinator as any).startQueuePlayback = async () => {
    startCount += 1;
    return {
      zoneId: ctx.id,
      source: 'spotify:track:two',
      metadata: { title: 'Two', artist: 'Artist', album: 'Album', audiopath: 'spotify:track:two' },
      stream: { id: 'stream-2', url: 'http://example.com/stream-2', coverUrl: '', createdAt: Date.now() },
      state: 'playing',
      elapsed: 0,
      duration: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      playbackSource: null,
    } as PlaybackSession;
  };

  coordinator.handlePlaybackError(ctx.id, 'end_of_track', 'output');
  (ctx.player as unknown as EventEmitter).emit('ended', null);
  await flushAsync();

  assert.equal(startCount, 1);
  assert.equal(ctx.queueController.currentIndex(), 1);
});

test('end_of_track cooldown blocks a second queue advance after current item changes', async () => {
  const { coordinator, ctx } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ title: 'One', audiopath: 'spotify:track:one', unique_id: 'id-1' }),
      makeQueueItem({ title: 'Two', audiopath: 'spotify:track:two', unique_id: 'id-2' }),
      makeQueueItem({ title: 'Three', audiopath: 'spotify:track:three', unique_id: 'id-3' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';
  ctx.activeInput = 'queue';

  let startCount = 0;
  (coordinator as any).startQueuePlayback = async (_ctx: ZoneContext, audiopath: string) => {
    startCount += 1;
    return {
      zoneId: ctx.id,
      source: audiopath,
      metadata: { title: audiopath, artist: 'Artist', album: 'Album', audiopath },
      stream: { id: `stream-${startCount}`, url: `http://example.com/stream-${startCount}`, coverUrl: '', createdAt: Date.now() },
      state: 'playing',
      elapsed: 0,
      duration: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      playbackSource: null,
    } as PlaybackSession;
  };

  await (coordinator as any).queueStepDispatcher.handleEndOfTrack(ctx);
  assert.equal(startCount, 1);
  assert.equal(ctx.queueController.currentIndex(), 1);

  await (coordinator as any).queueStepDispatcher.handleEndOfTrack(ctx);
  assert.equal(startCount, 1);
  assert.equal(ctx.queueController.currentIndex(), 1);
});

test('playback error clears stale spotify metadata fields', () => {
  const { coordinator, ctx } = createHarness();
  ctx.state = {
    ...ctx.state,
    title: 'Spotify Track',
    artist: 'Spotify Artist',
    album: 'Spotify Album',
    coverurl: 'http://example.com/cover.jpg',
    audiopath: 'spotify:track:stale',
    sourceName: 'Spotify',
    mode: 'play',
  };

  coordinator.handlePlaybackError(ctx.id, 'spotify no pcm after 1500ms', 'output');

  assert.equal(ctx.state.mode, 'stop');
  assert.equal(ctx.state.coverurl, '');
  assert.equal(ctx.state.audiopath, '');
  assert.equal(ctx.state.artist, '');
  assert.equal(ctx.state.album, '');
  assert.equal(ctx.state.duration, 0);
  assert.equal(ctx.state.sourceName, ctx.sourceMac);
});

test('queue next/prev advances qindex and qid', async () => {
  const { coordinator, ctx, patches, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
    makeQueueItem({ title: 'Three', audiopath: 'library://track/three', unique_id: 'id-3' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';

  coordinator.handleCommand(ctx.id, 'queueplus');
  await flushAsync();

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 1);
  assert.equal(patches[0]?.patch.qid, 'id-2');
  assert.equal(patches[0]?.patch.queueAuthority, 'local');

  patches.length = 0;
  coordinator.handleCommand(ctx.id, 'queueminus');
  await flushAsync();

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 0);
  assert.equal(patches[0]?.patch.qid, 'id-1');
});

test('music assistant metadata seek updates qindex/qid', () => {
  const { coordinator, ctx, patches, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'musicassistant://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'musicassistant://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.queue.authority = 'musicassistant';
  ctx.inputMode = 'musicassistant';

  coordinator.updateInputMetadata(ctx.id, {
    title: 'Two',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'musicassistant://track/two',
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.qindex, 1);
  assert.equal(patches[0]?.patch.qid, 'id-2');
  assert.equal(patches[0]?.patch.queueAuthority, 'musicassistant');
});

test('output URI mismatch is ignored before first audio chunk for local queue', () => {
  const { coordinator, ctx, patches, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';
  const player = ctx.player as unknown as FakePlayer;
  player.playUri(items[0]!.audiopath, {
    title: items[0]!.title,
    artist: items[0]!.artist,
    album: items[0]!.album,
    audiopath: items[0]!.audiopath,
    duration: items[0]!.duration,
  });

  coordinator.updateOutputState(ctx.id, {
    status: 'playing',
    uri: items[1]!.audiopath,
  });

  assert.equal(ctx.queueController.currentIndex(), 0);
  assert.equal((patches[0]?.patch as any).qindex, undefined);
  assert.equal((patches[0]?.patch as any).qid, undefined);

  const session = player.getSession();
  assert.ok(session);
  session.firstAudioReadyAt = Date.now();

  coordinator.updateOutputState(ctx.id, {
    status: 'playing',
    uri: items[1]!.audiopath,
  });

  assert.equal(ctx.queueController.currentIndex(), 1);
  assert.equal(patches.length, 2);
  assert.equal(patches[1]?.patch.qindex, 1);
  assert.equal(patches[1]?.patch.qid, 'id-2');
});

test('an output that reports its position reveals how far the room is behind (#359)', () => {
  // Only a few outputs can state a buffer figure up front. The ones that report where
  // they are answer the same question from the other end: the gap to the server's clock
  // is the audio still in flight to that room.
  const { coordinator, ctx } = createHarness();
  const player = ctx.player as unknown as FakePlayer;
  player.state.mode = 'playing';
  (player.state as { time?: number }).time = 12.5;

  coordinator.updateOutputState(ctx.id, { status: 'playing', position: 11.7 });

  assert.equal(ctx.outputPlayoutLagMs, 800);
  assert.equal(coordinator.getRoomLagMs(ctx), 800);
});

test('a position that is not from the track we are playing is ignored (#359)', () => {
  // An output that reports itself ahead of our own clock is on another track — a queue
  // advance, a seek. There is nothing to learn from the gap, and taking it would park a
  // nonsense lag on the zone.
  const { coordinator, ctx } = createHarness();
  const player = ctx.player as unknown as FakePlayer;
  player.state.mode = 'playing';
  (player.state as { time?: number }).time = 3;

  coordinator.updateOutputState(ctx.id, { status: 'playing', position: 41 });

  assert.equal(ctx.outputPlayoutLagMs, undefined);
});

test('an output that says nothing is assumed to be holding a buffer, not none (#359)', () => {
  // Reading silence as "instantaneous" is the assumption that cannot be recovered from:
  // it is what let a doorbell raise the volume while the room was still on the old track.
  const { coordinator, ctx } = createHarness();
  assert.equal(coordinator.getRoomLagMs(ctx), 1000);
});

test('a stale playout measurement falls back to the assumption (#359)', () => {
  const { coordinator, ctx } = createHarness();
  ctx.outputPlayoutLagMs = 250;
  ctx.outputPlayoutLagAt = Date.now() - 60_000;

  assert.equal(coordinator.getRoomLagMs(ctx), 1000);
});

test('a stopped output does not wind the queue back onto the track that finished', () => {
  // The engine session of a track that has ended is torn down after the queue has already moved
  // on, and it reports itself stopped with that track's uri. Read as "this is the current entry",
  // it put the queue back on a track the room had left: `next` then replayed what was playing.
  const { coordinator, ctx, playbackQueue } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 1);
  ctx.queue.authority = 'local';
  ctx.inputMode = 'queue';

  coordinator.updateOutputState(ctx.id, {
    status: 'stopped',
    uri: items[0]!.audiopath,
  });

  assert.equal(ctx.queueController.currentIndex(), 1);
});

test('output stopped near end does not force end timing for controllable radio', () => {
  const { coordinator, ctx } = createHarness();
  const player = ctx.player as unknown as FakePlayer;
  player.state.mode = 'playing';
  ctx.metadata.radioControllable = true;

  coordinator.updateOutputState(ctx.id, {
    status: 'stopped',
    position: 179.2,
    duration: 180,
  });

  assert.equal(player.endGuardMs, 0);
  assert.deepEqual(player.timing, { elapsed: 0, duration: 0 });
});

test('output playing duration is ignored for controllable radio', () => {
  const { coordinator, ctx, patches } = createHarness();
  ctx.metadata.radioControllable = true;
  ctx.state.duration = 0;

  coordinator.updateOutputState(ctx.id, {
    status: 'playing',
    duration: 3114,
  });

  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'play');
  assert.equal(Object.prototype.hasOwnProperty.call(patches[0]?.patch ?? {}, 'duration'), false);
});

test('stop command for music assistant stops output and session', () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';
  ctx.activeInput = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'stop');

  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'stop');
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
  assert.equal(ctx.inputMode, null);
});

test('metadata update patches cover/title/artist/album/duration/audiopath', () => {
  const { coordinator, ctx, patches, playbackQueue, recentsManager } = createHarness();
  const item = makeQueueItem({
    title: '',
    artist: '',
    album: '',
    coverurl: '',
    audiopath: 'spotify:track:one',
    duration: 200,
    unique_id: 'id-1',
  });
  playbackQueue.setItems([item], 0);
  ctx.state.icontype = 7 as any;
  ctx.queue.authority = 'spotify';

  coordinator.updateInputMetadata(ctx.id, {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://covers/1.jpg',
    duration: 120,
    audiopath: 'spotify:track:one',
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.title, 'Song');
  assert.equal(patches[0]?.patch.artist, 'Artist');
  assert.equal(patches[0]?.patch.album, 'Album');
  assert.equal(patches[0]?.patch.coverurl, 'http://covers/1.jpg');
  assert.equal(patches[0]?.patch.audiopath, 'spotify:track:one');
  assert.equal(patches[0]?.patch.duration, 120);
  assert.equal(patches[0]?.patch.audiotype, undefined);
  assert.equal(patches[0]?.patch.icontype, undefined);
  assert.equal(patches[0]?.patch.queueAuthority, 'spotify');
  assert.equal(recentsManager.records.length, 1);
});

test('volume_set applies step, patches volume, and notifies inputs/outputs', () => {
  const { coordinator, ctx, patches, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'volume_set', '33');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 34);
  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'volume_set');
  assert.equal((inputsPort.playerCommandCalls[0]?.args ?? {}).volume_level, 34);
  assert.equal(outputRouter.volumeCalls.length, 1);
  assert.equal(outputRouter.volumeCalls[0]?.volume, 34);
});

test('volume command rounds relative steps and forwards airplay volume', () => {
  const { coordinator, ctx, patches, inputsPort } = createHarness();
  ctx.inputMode = 'airplay';
  ctx.state.volume = 30;

  coordinator.handleCommand(ctx.id, 'volume', '+3');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 34);
  assert.equal(inputsPort.remoteVolumeCalls.length, 1);
  assert.equal(inputsPort.remoteVolumeCalls[0]?.volume, 34);

  patches.length = 0;
  ctx.state.volume = 30;
  coordinator.handleCommand(ctx.id, 'volume', '-3');

  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.patch.volume, 26);
});

test('queueplus steps the queue we drive, and leaves an externally owned one alone', () => {
  const { coordinator, ctx } = createHarness();
  ctx.inputMode = 'queue';
  let stepCalled = false;
  (coordinator as any).queueStepDispatcher.stepQueue = () => {
    stepCalled = true;
  };

  ctx.queue.authority = 'musicassistant';
  coordinator.handleCommand(ctx.id, 'queueplus');
  assert.equal(stepCalled, false);

  ctx.queue.authority = 'local';
  coordinator.handleCommand(ctx.id, 'queueplus');
  assert.equal(stepCalled, true);
});

test('next/previous commands map to queue stepping fallback', () => {
  const { coordinator, ctx } = createHarness();
  ctx.inputMode = 'queue';
  ctx.queue.authority = 'local';
  const deltas: number[] = [];
  (coordinator as any).queueStepDispatcher.stepQueue = (_zoneId: number, delta: number) => {
    deltas.push(delta);
  };

  coordinator.handleCommand(ctx.id, 'next');
  coordinator.handleCommand(ctx.id, 'previous');

  assert.deepEqual(deltas, [1, -1]);
});

test('position command forwards seek to music assistant without dispatching outputs', () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  ctx.inputMode = 'musicassistant';

  coordinator.handleCommand(ctx.id, 'position', '12');

  assert.equal(inputsPort.playerCommandCalls.length, 1);
  assert.equal(inputsPort.playerCommandCalls[0]?.command, 'seek');
  assert.deepEqual(inputsPort.playerCommandCalls[0]?.args, { position: 12 });
  assert.equal(outputRouter.outputCalls.length, 0);
});

test('position command seeks current queue item for local playback', async () => {
  const { coordinator, ctx, playbackQueue, inputsPort } = createHarness();
  ctx.inputMode = 'queue';
  playbackQueue.setItems(
    [makeQueueItem({ title: 'Track', audiopath: 'library://track/one', duration: 180, unique_id: 'id-1' })],
    0,
  );
  const seekCalls: Array<{ audiopath: string; startAtSec?: number; skipExternalStop?: boolean }> = [];
  (coordinator as any).startQueuePlayback = async (
    _ctx: ZoneContext,
    audiopath: string,
    _metadata: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ) => {
    seekCalls.push({
      audiopath,
      startAtSec: options?.startAtSec,
      skipExternalStop: options?.skipExternalStop,
    });
    return {} as PlaybackSession;
  };

  coordinator.handleCommand(ctx.id, 'position', '220');
  await flushAsync();

  assert.equal(seekCalls.length, 1);
  assert.equal(seekCalls[0]?.audiopath, 'library://track/one');
  assert.equal(seekCalls[0]?.startAtSec, 180);
  assert.equal(seekCalls[0]?.skipExternalStop, true);
  assert.equal(inputsPort.playerCommandCalls.length, 0);
});

test('position command ignores radio seek requests', async () => {
  const { coordinator, ctx, playbackQueue } = createHarness();
  ctx.inputMode = 'queue';
  playbackQueue.setItems(
    [makeQueueItem({ title: 'Station', audiopath: 'tunein:station:abc', audiotype: 1, unique_id: 'id-1' })],
    0,
  );
  let seeked = false;
  (coordinator as any).startQueuePlayback = async () => {
    seeked = true;
    return {} as PlaybackSession;
  };

  coordinator.handleCommand(ctx.id, 'position', '30');
  await flushAsync();

  assert.equal(seeked, false);
});

test('shuffle and repeat parsing preserves existing behavior', () => {
  const { coordinator, ctx } = createHarness();
  const queueController = (coordinator as any).queueController as FakeQueueController;

  ctx.queue.shuffle = false;
  coordinator.handleCommand(ctx.id, 'shuffle', 'on');
  assert.equal(queueController.setShuffleCalls.length, 1);
  assert.equal(queueController.setShuffleCalls[0]?.enabled, true);

  coordinator.handleCommand(ctx.id, 'shuffle', 'off');
  assert.equal(queueController.setShuffleCalls.length, 2);
  assert.equal(queueController.setShuffleCalls[1]?.enabled, false);

  ctx.queue.shuffle = false;
  coordinator.handleCommand(ctx.id, 'shuffle', 'invalid');
  assert.equal(queueController.setShuffleCalls.length, 3);
  assert.equal(queueController.setShuffleCalls[2]?.enabled, true);

  coordinator.handleCommand(ctx.id, 'repeat', 'off');
  assert.equal(ctx.queue.repeat, 0);

  ctx.queue.repeat = 0;
  coordinator.handleCommand(ctx.id, 'repeat');
  assert.equal(ctx.queue.repeat, 1);
});

test('playContent seek fast-path starts current item and notifies queue', async () => {
  const notifierTracker = makeNotifierTracker();
  const { coordinator, ctx, playbackQueue, recentsManager } = createHarness({
    notifier: notifierTracker.notifier,
  });
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'library://track/one', unique_id: 'id-1' }),
    makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
  ];
  playbackQueue.setItems(items, 0);
  ctx.state.mode = 'play';
  let startedAudiopath: string | null = null;
  (coordinator as any).startQueuePlayback = async (_ctx: ZoneContext, audiopath: string) => {
    startedAudiopath = audiopath;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'library://track/two', 'track', { title: 'Two', artist: '', album: '' });

  assert.equal(startedAudiopath, 'library://track/two');
  assert.equal(recentsManager.records.length, 1);
  assert.equal(notifierTracker.queueUpdated.length, 1);
  assert.equal(notifierTracker.queueUpdated[0]?.queueSize, ctx.queue.items.length);
});

test('playContent rebuild path starts playback and records recents', async () => {
  const notifierTracker = makeNotifierTracker();
  const { coordinator, ctx, recentsManager } = createHarness({
    notifier: notifierTracker.notifier,
  });
  ctx.state.mode = 'stop';
  let startedAudiopath: string | null = null;
  (coordinator as any).startQueuePlayback = async (_ctx: ZoneContext, audiopath: string) => {
    startedAudiopath = audiopath;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'library://track/one', 'track', { title: 'One', artist: '', album: '' });

  assert.equal(startedAudiopath, ctx.queueController.current()?.audiopath ?? null);
  assert.equal(recentsManager.records.length, 1);
  assert.equal(notifierTracker.queueUpdated.length, 1);
});

test('playContent rebuild keeps the zone\'s repeat mode', async () => {
  // #371: repeat-one looked broken because the queue rebuild cleared it without telling the
  // client, so switching repeat on and then picking the track to repeat turned it off again.
  const { coordinator, ctx } = createHarness();
  ctx.state.mode = 'stop';
  (coordinator as any).startQueuePlayback = async () => ({}) as PlaybackSession;

  coordinator.handleCommand(ctx.id, 'repeat', 'one');
  assert.equal(ctx.queue.repeat, 3);

  await coordinator.playContent(ctx.id, 'library://track/one', 'track', { title: 'One', artist: '', album: '' });

  assert.equal(ctx.queue.repeat, 3);
});

test('playContent unplayable path stops outputs and applies stop patch', async () => {
  const { coordinator, ctx, patches, outputRouter } = createHarness();
  ctx.state.mode = 'stop';
  (coordinator as any).startQueuePlayback = async () => null;

  await coordinator.playContent(ctx.id, 'spotify:track:one', 'track', { title: 'One', artist: '', album: '' });

  const lastPatch = patches[patches.length - 1]?.patch ?? {};
  assert.equal((lastPatch as any).mode, 'stop');
  assert.equal((lastPatch as any).clientState, 'on');
  assert.equal((lastPatch as any).power, 'on');
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('playContent ignores MA serviceplay when already playing target', async () => {
  const { coordinator, ctx, inputsPort, outputRouter } = createHarness();
  const items = [
    makeQueueItem({ title: 'One', audiopath: 'musicassistant://track/one', unique_id: 'id-1' }),
  ];
  ctx.queueController.setItems(items, 0);
  ctx.state.mode = 'play';
  ctx.inputMode = 'musicassistant';
  ctx.activeInput = 'musicassistant';
  let started = false;
  (coordinator as any).startQueuePlayback = async () => {
    started = true;
    return {} as PlaybackSession;
  };

  await coordinator.playContent(ctx.id, 'musicassistant://track/one', 'serviceplay');

  assert.equal(started, false);
  assert.equal(inputsPort.stopSpotifyCalls.length, 0);
  assert.equal(inputsPort.stopAirplayCalls.length, 0);
  assert.equal(outputRouter.outputCalls.length, 0);
});

test('player started dispatches outputs, volume, and patch in order', () => {
  const trace: string[] = [];
  const { ctx, patches, outputRouter } = createHarness({ trace });
  ctx.state.volume = 42;
  ctx.queueController.setItems([makeQueueItem({ title: 'Track', audiopath: 'library://one', unique_id: 'id-1' })], 0);
  const session = {
    metadata: { title: 'Track', artist: 'Artist', album: 'Album', audiopath: 'library://one', duration: 120 },
  } as PlaybackSession;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('started', session);

  assert.deepEqual(trace, ['dispatchOutputs:play', 'dispatchVolume', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal(outputRouter.volumeCalls[0]?.volume, 30);
  assert.equal((patches[0]?.patch as any).mode, 'play');
  assert.equal((patches[0]?.patch as any).volume, 30);
  assert.equal((patches[0]?.patch as any).queueAuthority, 'local');
});

test('player started keeps current volume when already active', () => {
  const { ctx, patches, outputRouter } = createHarness();
  ctx.state.mode = 'pause';
  ctx.state.volume = 42;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('started', null);

  assert.equal(outputRouter.volumeCalls[0]?.volume, 42);
  assert.equal((patches[0]?.patch as any).volume, 42);
});

/**
 * Between two queue tracks the output runs dry and echoes STOPPED back into the zone, so `state.mode`
 * reads 'stop' while the zone is in fact mid-queue. Reading that as a cold start put the zone default
 * back on the outputs after every single song (#322). The player is the one that knows better: a
 * queue advance never calls `ZonePlayer.stop()`.
 */
test('player started keeps current volume across a queue step that left the output stopped', () => {
  const { ctx, patches, outputRouter } = createHarness();
  ctx.state.mode = 'stop';
  ctx.state.volume = 42;
  ctx.playerActive = true;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('started', null);

  assert.equal(outputRouter.volumeCalls[0]?.volume, 42);
  assert.equal((patches[0]?.patch as any).volume, 42);
});

test('player started preserves alert volume even when zone was stopped', () => {
  const { ctx, patches, outputRouter } = createHarness();
  // AlertsCoordinator sets state.volume to the per-event slider value before playUri starts.
  ctx.state.mode = 'stop';
  ctx.state.volume = 66;
  ctx.alert = {
    type: 'tts',
    title: 'tts',
    url: 'http://localhost/tts.mp3',
    snapshot: { queue: { currentIndex: 0 } } as any,
  } as any;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('started', null);

  assert.equal(outputRouter.volumeCalls[0]?.volume, 66);
  assert.equal((patches[0]?.patch as any).volume, 66);
});

test('player resumed dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { ctx, patches } = createHarness({ trace });

  const player = ctx.player as unknown as EventEmitter;
  player.emit('resumed', null);

  assert.deepEqual(trace, ['dispatchOutputs:resume', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'play');
});

test('player paused dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { ctx, patches } = createHarness({ trace });

  const player = ctx.player as unknown as EventEmitter;
  player.emit('paused', null);

  assert.deepEqual(trace, ['dispatchOutputs:pause', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'pause');
});

test('player stopped dispatches outputs before patch', () => {
  const trace: string[] = [];
  const { ctx, patches } = createHarness({ trace });

  const player = ctx.player as unknown as EventEmitter;
  player.emit('stopped', null);

  assert.deepEqual(trace, ['dispatchOutputs:stop', 'applyPatch']);
  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).mode, 'stop');
});

test('player position forces radio time/duration to zero', () => {
  const { ctx, patches } = createHarness();
  ctx.state.audiopath = 'tunein:station:abc';
  ctx.state.audiotype = 1 as any;
  ctx.state.time = 5;
  ctx.state.duration = 10;

  const player = ctx.player as unknown as EventEmitter;
  player.emit('position', 12, 34);

  assert.equal(patches.length, 1);
  assert.equal((patches[0]?.patch as any).time, 0);
  assert.equal((patches[0]?.patch as any).duration, 0);
});

test('player position throttles identical updates', () => {
  const { ctx, patches } = createHarness();
  ctx.state.audiopath = 'library://track/one';
  ctx.state.duration = 100;
  const now = Date.now();
  ctx.lastPositionUpdateAt = now;
  ctx.lastPositionValue = 10;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const player = ctx.player as unknown as EventEmitter;
    player.emit('position', 10, 100);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(patches.length, 0);
});

test('handleEndOfTrack stops when queue ends', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems([makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' })], 0);
  ctx.queue.authority = 'local';
  ctx.queue.repeat = 0;
  ctx.queue.shuffle = false;

  await (coordinator as any).queueStepDispatcher.handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_end'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('handleEndOfTrack stops on invalid next item', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'library://two', unique_id: 'id-2' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  (ctx.queueController as any).current = () => null;

  await (coordinator as any).queueStepDispatcher.handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_invalid_next'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('handleEndOfTrack stops when next track fails to start', async () => {
  const { coordinator, ctx, outputRouter } = createHarness();
  ctx.queueController.setItems(
    [
      makeQueueItem({ audiopath: 'library://one', unique_id: 'id-1' }),
      makeQueueItem({ audiopath: 'library://two', unique_id: 'id-2' }),
    ],
    0,
  );
  ctx.queue.authority = 'local';
  (coordinator as any).startQueuePlayback = async () => null;

  await (coordinator as any).queueStepDispatcher.handleEndOfTrack(ctx);

  const player = ctx.player as unknown as FakePlayer;
  assert.equal(player.stopReasons.includes('queue_next_failed'), true);
  assert.equal(outputRouter.outputCalls.length, 1);
  assert.equal(outputRouter.outputCalls[0]?.action, 'stop');
});

test('startQueuePlayback transitions input and stops external sessions once', async () => {
  const { coordinator, ctx, inputsPort, stopCalls } = createHarness();
  ctx.inputMode = 'spotify';
  ctx.activeInput = 'spotify';

  await coordinator.startQueuePlayback(ctx, 'library://track/one', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'library://track/one',
  });

  assert.equal(ctx.inputMode, 'queue');
  assert.equal(ctx.activeInput, 'queue');
  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
  assert.equal(inputsPort.stopSpotifyCalls[0]?.reason, 'switch_to_queue');
  assert.equal(stopCalls.length, 1);
});

test('radio metadata updates propagate into audio session metadata (ICY)', () => {
  const { coordinator, ctx, audioManager } = createHarness();
  ctx.state.mode = 'play' as any;
  ctx.state.audiopath = 'tunein:station:abc';
  ctx.state.audiotype = 1 as any;

  const now = Date.now();
  audioManager.session = {
    zoneId: ctx.id,
    source: 'tunein:station:abc',
    metadata: {
      title: 'Station',
      artist: '',
      album: '',
      audiopath: 'tunein:station:abc',
      isRadio: true,
    },
    stream: {
      id: 'stream',
      url: 'http://example.com/stream',
      coverUrl: '',
      createdAt: now,
    },
    state: 'playing',
    elapsed: 0,
    duration: 0,
    startedAt: now,
    updatedAt: now,
    playbackSource: { kind: 'url', url: 'http://example.com/radio' },
  };

  coordinator.updateRadioMetadata(ctx.id, { title: 'Track', artist: 'Artist' });

  assert.equal(audioManager.sessionMetadataUpdates.length, 1);
  assert.equal(audioManager.sessionMetadataUpdates[0]?.metadata.title, 'Track');
  assert.equal(audioManager.sessionMetadataUpdates[0]?.metadata.artist, 'Artist');
});

test('playContent does not double-stop external sessions', async () => {
  const { coordinator, ctx, inputsPort } = createHarness();
  ctx.inputMode = 'spotify';
  ctx.activeInput = 'spotify';

  await coordinator.playContent(ctx.id, 'library://track/one', 'track', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
  });

  assert.equal(inputsPort.stopSpotifyCalls.length, 1);
});

/*
 * A DLNA control point drives the zone over two SOAP services, and both used to stop at the
 * coordinator: RenderingControl's SetVolume was dropped by the input-volume guard (dlna was not in
 * it), and AVTransport's Seek — which the renderer replays as the same URI at an offset — looked
 * like the track already playing and was skipped. Issue #339.
 */
test('a dlna cast can be seeked and its volume set, without losing the same-track skip', () => {
  const { coordinator, ctx } = createHarness();
  const player = ctx.player as unknown as FakePlayer;
  const played: Array<{ source: PlaybackSource }> = [];
  // Stand in for the real InputAdapter, which parks the audiopath on the zone — that is the state
  // the same-track shortcut reads, so a stub that skips it would make this test prove nothing.
  ctx.inputAdapter = {
    playInput: (_label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => {
      played.push({ source });
      ctx.state = applyZonePatch(ctx.state, { audiopath: metadata?.audiopath, mode: 'play' } as any);
    },
  } as any;

  const cast: PlaybackSource = { kind: 'url', url: 'http://127.0.0.1:7090/streams/proxy?u=song' };
  const metadata: PlaybackMetadata = {
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'dlna-renderer://1/8f14e45fceea',
  };

  coordinator.playInputSource(ctx.id, 'dlna', cast, metadata);
  assert.equal(played.length, 1);

  // 35 lands on 36: a control point's slider is free-running, the zone's volume step is not.
  coordinator.updateInputVolume(ctx.id, 35);
  assert.equal(player.volume, 36);

  // Still the same track and still no offset: nothing to do, the shortcut holds.
  coordinator.playInputSource(ctx.id, 'dlna', cast, metadata);
  assert.equal(played.length, 1);

  // A seek: same URI, same audiopath, 61 seconds in. It has to reach the engine.
  coordinator.playInputSource(ctx.id, 'dlna', { ...cast, startAtSec: 61 }, metadata);
  assert.equal(played.length, 2);
  assert.equal((played[1]?.source as { startAtSec?: number }).startAtSec, 61);
});

// ── Reporting a stream that never arrived ─────────────────────────────────────
// Six services used to have a branch each here, differing only in the name in
// the message — except Apple and SoundCloud, which stay quiet when their stream
// service has already recorded a more specific reason for the same attempt. That
// suppression is the part worth pinning: it is what keeps one failed track from
// producing two playback errors.

function providerContentPort(provider: string): ContentPort {
  return { ...noopContentPort, providerForAudiopath: () => provider };
}

test('a bridged service that yields no stream is reported by name', async () => {
  const { coordinator, ctx } = createHarness({ contentPort: providerContentPort('deezer') });

  await coordinator.startQueuePlayback(ctx, 'deezer:track:t1', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'deezer:track:t1',
  });

  assert.equal(ctx.lastPlaybackErrorReason, 'deezer stream unavailable');
});

test('apple music stays quiet when widevine already explained the failure', async () => {
  const { coordinator, ctx } = createHarness({ contentPort: providerContentPort('applemusic') });
  ctx.lastPlaybackErrorAt = Date.now();
  ctx.lastPlaybackErrorReason = 'widevine missing';

  await coordinator.startQueuePlayback(ctx, 'applemusic:track:t1', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'applemusic:track:t1',
  });

  // The specific reason survives; no generic one is written over it.
  assert.equal(ctx.lastPlaybackErrorReason, 'widevine missing');
});

test('soundcloud stays quiet when its stream service already said why', async () => {
  const { coordinator, ctx } = createHarness({ contentPort: providerContentPort('soundcloud') });
  ctx.lastPlaybackErrorAt = Date.now();
  ctx.lastPlaybackErrorReason = 'soundcloud track is DRM protected';

  await coordinator.startQueuePlayback(ctx, 'soundcloud:track:t1', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'soundcloud:track:t1',
  });

  assert.equal(ctx.lastPlaybackErrorReason, 'soundcloud track is DRM protected');
});

test('a stale specific reason does not silence the next failure', async () => {
  const { coordinator, ctx } = createHarness({ contentPort: providerContentPort('applemusic') });
  // Older than the 2 s window hasRecentPlaybackError allows.
  ctx.lastPlaybackErrorAt = Date.now() - 10_000;
  ctx.lastPlaybackErrorReason = 'widevine missing';

  await coordinator.startQueuePlayback(ctx, 'applemusic:track:t1', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'applemusic:track:t1',
  });

  assert.equal(ctx.lastPlaybackErrorReason, 'apple music stream unavailable');
});

test('a service with no reported failure of its own is left alone', async () => {
  const { coordinator, ctx } = createHarness({ contentPort: providerContentPort('spotify') });

  await coordinator.startQueuePlayback(ctx, 'spotify:track:t1', {
    title: 'Track',
    artist: 'Artist',
    album: 'Album',
    audiopath: 'spotify:track:t1',
  });

  assert.notEqual(ctx.lastPlaybackErrorReason, 'spotify stream unavailable');
});

test('a queue row nothing can play is dropped, so the zone is not stuck on it (#417)', () => {
  const { coordinator, ctx, playbackQueue } = createHarness();
  playbackQueue.setItems(
    [
      makeQueueItem({ title: 'Zone', audiopath: 'nothing:knows-this', unique_id: 'dead' }),
      makeQueueItem({ title: 'Two', audiopath: 'library://track/two', unique_id: 'id-2' }),
    ],
    0,
  );

  assert.equal(coordinator.dropUnplayableQueueItem(ctx, 'nothing:knows-this'), true);
  assert.deepEqual(ctx.queue.items.map((item) => item.unique_id), ['id-2']);
  assert.equal(ctx.queueController.current()?.unique_id, 'id-2');

  // The only row going leaves an empty queue rather than a dead one.
  playbackQueue.setItems([makeQueueItem({ audiopath: 'nothing:knows-this', unique_id: 'dead' })], 0);
  assert.equal(coordinator.dropUnplayableQueueItem(ctx, 'nothing:knows-this'), true);
  assert.equal(ctx.queue.items.length, 0);
});

test('a row that can fail for reasons that pass is never dropped (#417)', () => {
  const { coordinator, ctx, playbackQueue } = createHarness();
  const paths = [
    'spotify:track:11hcBLPtbMp4aQI6zGQLub',
    'library://track/two',
    'http://example.com/stream.mp3',
  ];
  playbackQueue.setItems(paths.map((audiopath, idx) => makeQueueItem({ audiopath, unique_id: `id-${idx}` })), 0);
  for (const path of paths) {
    assert.equal(coordinator.dropUnplayableQueueItem(ctx, path), false, path);
  }
  assert.equal(ctx.queue.items.length, paths.length);
});
