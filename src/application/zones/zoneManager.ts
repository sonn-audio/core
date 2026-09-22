import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneConfig, InputConfig, GroupConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import { ZonePlayer } from '@/application/playback/zonePlayer';
import { PlaybackQueueNavigator } from '@/application/playback/PlaybackQueueNavigator';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { GroupingCoordinator } from '@/application/zones/GroupingCoordinator';
import { PlaybackCoordinator } from '@/application/zones/PlaybackCoordinator';
import { AlertsCoordinator } from '@/application/zones/AlertsCoordinator';
import { InputAdapter } from '@/application/playback/inputAdapter';
import { SpotifyInputAdapter } from '@/application/playback/adapters/SpotifyInputAdapter';
import { registerPlayer, unregisterPlayer, clearPlayers } from '@/application/playback/playerRegistry';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { MixedGroupCoordinator } from '@/application/groups/mixedGroupController';
import { getGroupByZone } from '@/application/groups/groupTracker';
import type { OutputsPort } from '@/ports/OutputsPort';
import type { OutputSyncStatus, ZoneOutput } from '@/ports/OutputsTypes';
import type { InputsPort } from '@/ports/InputsPort';
import type { PlaybackErrorOrigin, PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type {
  QueueItem,
  QueueState,
  ZoneContext,
} from '@/application/zones/internal/zoneTypes';
import { ZoneStateStore } from '@/application/zones/ZoneStateStore';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import { StateControllerManager } from '@/application/zones/state/StateControllerManager';
import { ExternalStateRouter } from '@/application/zones/state/ExternalStateRouter';
import {
  resolveZoneStateControllerId,
  shouldUseStateControllerForCommand,
  isVolumeOwnedByStateController,
} from '@/application/zones/state/authorityPolicies';
import type { AlertMediaResource } from '@/application/alerts/types';
import {
  PowerManager,
  SystemPowerManagerExecutor,
  type PowerSignal,
} from '@/application/zones/services/powerManager';
import { SharedPowerGroupManager } from '@/application/zones/services/sharedPowerGroupManager';
import { ZoneHeartbeatService } from '@/application/zones/services/ZoneHeartbeatService';
import { ZoneArtworkColorService } from '@/application/artwork/zoneArtworkColorService';
import { artworkService } from '@/application/artwork/artworkService';
import { InputSourceConfigurator } from '@/application/zones/services/InputSourceConfigurator';
import {
  buildInitialState,
  getZoneDefaultVolume,
} from '@/application/zones/helpers/stateHelpers';
import {
  computeAlertStartDelays,
  type AlertZoneLead,
} from '@/application/zones/helpers/alertStartAlignment';
import {
  formatEqualizerSettings,
  normalizeEqualizerBands,
  type EqualizerBands,
} from '@/domain/zones/equalizer';
import {
  createZoneAudioHelpers,
  type ZoneAudioHelpers,
} from '@/application/zones/internal/zoneAudioHelpers';
import { getMusicAssistantUserId } from '@/application/zones/internal/musicAssistantProvider';

export type {
  AlertSnapshot,
  QueueItem,
  QueueAuthority,
  QueueState,
  ZoneContext,
} from '@/application/zones/internal/zoneTypes';

type QueueUpdateHandler = (zoneId: number, items: QueueItem[], currentIndex: number) => void;

type OutputState = {
  status?: 'playing' | 'paused' | 'stopped';
  position?: number;
  duration?: number;
  uri?: string;
};

type OutputErrorHandler = (zoneId: number, reason?: string, origin?: PlaybackErrorOrigin) => void;

type OutputStateHandler = (zoneId: number, state: OutputState) => void;

type OutputHandlers = {
  onQueueUpdate: QueueUpdateHandler;
  onOutputError: OutputErrorHandler;
  onOutputState: OutputStateHandler;
};

export type EqualizerUpdateResult = {
  zoneId: number;
  bands: EqualizerBands;
  equalizerSettings: string;
};

export type ZoneInputController = Pick<
  PlaybackCoordinator,
  | 'playInputSource'
  | 'stopInputSource'
  | 'pauseInputSource'
  | 'resumeInputSource'
  | 'updateInputMetadata'
  | 'updateRadioMetadata'
  | 'updateInputCover'
  | 'updateInputVolume'
  | 'updateInputTiming'
>;

export type ZoneQueueOps = Pick<
  ZoneQueueController,
  | 'setShuffle'
  | 'setPendingShuffle'
  | 'setRepeatMode'
  | 'seekInQueue'
  | 'appendUri'
  | 'insertUriAfterCurrent'
  | 'selectIndex'
  | 'removeByUniqueId'
  | 'moveBeforeUniqueId'
  | 'clear'
  | 'undo'
>;

export class ZoneManager {
  private readonly log = createLogger('Zones', 'Manager');
  private readonly zoneRepo = new ZoneRepository();
  private readonly stateStore: ZoneStateStore;
  private readonly queueController: ZoneQueueController;
  private readonly outputRouter: OutputRouter;
  private readonly groupingCoordinator: GroupingCoordinator;
  private readonly playbackCoordinator: PlaybackCoordinator;
  public readonly inputs!: ZoneInputController;
  public readonly queue!: ZoneQueueOps;
  private readonly alertsCoordinator: AlertsCoordinator;
  private readonly inputsPort: InputsPort;
  private readonly audioHelpers: ZoneAudioHelpers;
  private readonly stateControllers: StateControllerManager;
  private readonly externalStateRouter: ExternalStateRouter;
  private readonly outputsPort: OutputsPort;
  private readonly contentPort: ContentPort;
  private readonly configPort: ConfigPort;
  private readonly audioManager: AudioManager;
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly powerManager: PowerManager;
  private readonly sharedPowerGroupManager: SharedPowerGroupManager;
  private readonly heartbeat: ZoneHeartbeatService;
  private readonly artworkColors: ZoneArtworkColorService;
  private readonly inputConfigurator: InputSourceConfigurator;
  private initialized = false;
  private notifier: NotifierPort;
  // Last full input config seen via replaceAll. Partial re-syncs (replaceZones,
  // e.g. when a dynamic browser/sendspin zone registers) don't carry the global
  // input config; without this fallback they would pass null and disable global
  // inputs like AirPlay/Spotify, tearing down every receiver.
  private lastInputs: InputConfig | null = null;

  /** Read-only snapshot of the current zone state for external consumers (e.g. outputs). */
  public getZoneState(zoneId: number): ZoneState | null {
    return this.stateStore.getZoneState(zoneId);
  }

  private outputsRequirePcm(outputs: ZoneOutput[]): boolean {
    return outputs.some((output) => this.outputTypeRequiresPcm(output.type));
  }

  private outputTypeRequiresPcm(type: string): boolean {
    return type === 'airplay' || type === 'sendspin' || type === 'sendspin-cast' || type === 'snapcast';
  }

  constructor(
    notifier: NotifierPort,
    inputsPort: InputsPort,
    outputsPort: OutputsPort,
    contentPort: ContentPort,
    configPort: ConfigPort,
    recentsManager: RecentsManager,
    audioManager: AudioManager,
    zoneAudioPrefs: ZoneAudioPreferences,
    mixedGroup: MixedGroupCoordinator | null = null,
  ) {
    this.notifier = notifier;
    this.inputsPort = inputsPort;
    this.outputsPort = outputsPort;
    this.contentPort = contentPort;
    this.configPort = configPort;
    this.audioManager = audioManager;
    this.externalStateRouter = new ExternalStateRouter({
      zones: this.zoneRepo,
      audioManager: this.audioManager,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      notifyQueueUpdated: (zoneId, count) => this.notifier.notifyQueueUpdated(zoneId, count),
      log: this.log,
    });
    this.stateControllers = new StateControllerManager({
      onStatePatch: (zoneId, patch) => this.externalStateRouter.onStatePatch(zoneId, patch),
      onQueueMirror: (zoneId, items, currentIndex) =>
        this.externalStateRouter.onQueueMirror(zoneId, items, currentIndex),
      configPort,
    });
    this.zoneAudioPrefs = zoneAudioPrefs;
    // Share one executor so crelay/HID access is serialized across both the per-zone and
    // shared-group managers — two managers driving channels on the same relay card must not
    // open the device concurrently (#293).
    const powerExecutor = new SystemPowerManagerExecutor();
    this.powerManager = new PowerManager(this.log, powerExecutor, (zoneId, signal) => {
      // `ZoneState.power` is also exposed by the public API. Keep it aligned with the
      // last successfully applied physical power signal for configured power actions.
      if (this.powerManager.hasConfiguredActions(zoneId)) {
        this.applyPatch(zoneId, { power: signal === 1 ? 'on' : 'off' });
      }
    });
    this.sharedPowerGroupManager = new SharedPowerGroupManager(this.log, powerExecutor);
    this.zoneAudioPrefs.setZonePowerStateResolver((zoneId) => this.powerManager.isSignalOn(zoneId));
    this.zoneAudioPrefs.setZoneEqualizerResolver((zoneId) => this.resolveBuiltinEqualizerBands(zoneId));
    this.audioHelpers = createZoneAudioHelpers(contentPort, configPort);
    const audioHelpers = this.audioHelpers;
    const notifierProxy: NotifierPort = {
      notifyZoneStateChanged: (state) => this.notifier.notifyZoneStateChanged(state),
      notifyQueueUpdated: (zoneId, queueSize) =>
        this.notifier.notifyQueueUpdated(zoneId, queueSize),
      notifyRoomFavoritesChanged: (zoneId, count) =>
        this.notifier.notifyRoomFavoritesChanged(zoneId, count),
      notifyRecentlyPlayedChanged: (zoneId, timestamp) =>
        this.notifier.notifyRecentlyPlayedChanged(zoneId, timestamp),
      notifyRescan: (status, folders, files) =>
        this.notifier.notifyRescan(status, folders, files),
      notifyReloadMusicApp: (action, provider, userId) =>
        this.notifier.notifyReloadMusicApp(action, provider, userId),
      notifyAudioSyncEvent: (payload) => this.notifier.notifyAudioSyncEvent(payload),
    };
    this.groupingCoordinator = new GroupingCoordinator({
      getState: (zoneId) => this.getState(zoneId),
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
    });
    this.artworkColors = new ZoneArtworkColorService({
      getPalette: (coverUrl) => artworkService.getPalette(coverUrl),
      applyPatch: (zoneId, patch) => this.applyPatch(zoneId, patch),
    });
    this.stateStore = new ZoneStateStore(this.zoneRepo, {
      isRadioAudiopath: audioHelpers.isRadioAudiopath,
      isLineInAudiopath: audioHelpers.isLineInAudiopath,
      syncGroupMembersPatch: (leaderId, patch, force) =>
        this.groupingCoordinator.syncGroupMembersPatch(leaderId, patch, force),
      onStatePatch: (zoneId, patch, nextState) => {
        mixedGroup?.handleStatePatch(zoneId, patch, nextState);
        this.artworkColors.onStatePatch(zoneId, patch);
        const ctx = this.zoneRepo.get(zoneId);
        if (ctx) {
          this.powerManager.onStatePatch(zoneId, ctx.config, patch, nextState);
          this.sharedPowerGroupManager.onStatePatch(zoneId, patch, nextState);
        }
      },
      notifyOutputMetadata: (zoneId, ctx, patch) =>
        this.notifyOutputMetadata(zoneId, ctx, patch),
      notifier: notifierProxy,
      audioManager: this.audioManager,
    });
    this.queueController = new ZoneQueueController(this.zoneRepo, {
      log: this.log,
      contentPort: this.contentPort,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      isRadioAudiopath: audioHelpers.isRadioAudiopath,
      isSpotifyAudiopath: audioHelpers.isSpotifyAudiopath,
      isMusicAssistantAudiopath: audioHelpers.isMusicAssistantAudiopath,
      providerForAudiopath: audioHelpers.providerForAudiopath,
      resolveBridgeProvider: audioHelpers.resolveBridgeProvider,
      getMusicAssistantUserId,
      getStateAudiotype: audioHelpers.getStateAudiotype,
      getStateFileType: audioHelpers.getStateFileType,
      resolveSourceName: audioHelpers.resolveSourceName,
      notifier: notifierProxy,
    });
    this.outputRouter = new OutputRouter(this.log, (zoneId, reason) => {
      this.playbackCoordinator.handlePlaybackError(zoneId, reason, 'output');
    }, this.audioManager);
    this.playbackCoordinator = new PlaybackCoordinator({
      zones: this.zoneRepo,
      queueController: this.queueController,
      outputRouter: this.outputRouter,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      stopAlert: (zoneId) => this.stopAlert(zoneId),
      log: this.log,
      notifier: notifierProxy,
      inputsPort: this.inputsPort,
      audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      recentsManager,
      audioManager: this.audioManager,
      zoneAudioPrefs: this.zoneAudioPrefs,
    });
    this.alertsCoordinator = new AlertsCoordinator({
      zones: this.zoneRepo,
      playbackCoordinator: this.playbackCoordinator,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      log: this.log,
      audioHelpers,
      zoneAudioPrefs: this.zoneAudioPrefs,
      configPort: this.configPort,
    });
    this.heartbeat = new ZoneHeartbeatService({
      listZones: () => this.zoneRepo.list(),
      notifier: { notifyZoneStateChanged: (state) => this.notifier.notifyZoneStateChanged(state) },
    });
    this.inputConfigurator = new InputSourceConfigurator({
      inputsPort: this.inputsPort,
      zoneRepo: this.zoneRepo,
      playback: this.playbackCoordinator,
      outputRouter: this.outputRouter,
      stateStore: this.stateStore,
      applyPatch: (zoneId, patch, force) => this.applyPatch(zoneId, patch, force),
      updateQueue: (zoneId, items, currentIndex) =>
        this.updateQueueFromOutput(zoneId, items, currentIndex),
    });
    this.inputs = this.playbackCoordinator;
    this.queue = this.queueController;
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public getOutputHandlers(): OutputHandlers {
    return {
      onQueueUpdate: (zoneId, items, currentIndex) => {
        this.updateQueueFromOutput(zoneId, items, currentIndex);
      },
      onOutputError: (zoneId, reason, origin) => {
        this.playbackCoordinator.handlePlaybackError(zoneId, reason, 'output', undefined, origin);
      },
      onOutputState: (zoneId, state) => {
        this.playbackCoordinator.updateOutputState(zoneId, state);
      },
    };
  }

  /**
   * A track length that arrived after playback started, on its way to the zone's clock.
   *
   * The engine learns it from ffmpeg for sources nobody could describe up front; see
   * `AudioManager.watchSourceDuration` for why anything at all has to be learned this late.
   */
  public applySourceDuration(zoneId: number, durationSec: number): void {
    this.playbackCoordinator.applySourceDuration(zoneId, durationSec);
  }

  /**
   * Re-read every content provider's configuration.
   *
   * The single place that knows the list. Both zone-replacement paths call it rather than
   * repeating the calls: the copy in `replaceZones` had drifted and left out YT Music and
   * YouTube, so a config save that named its zones never refreshed those two while the
   * other four were refreshed on the same request.
   */
  public refreshContentProviders(): void {
    this.contentPort.configureProviders();
    this.playbackCoordinator.refreshMusicAssistantProviderId();
  }

  public async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.configPort.load();
      const cfg = this.configPort.getConfig();
      await this.replaceAll(cfg.zones, cfg.inputs, cfg.groups ?? null);
      this.heartbeat.start();
      this.initialized = true;
    }
  }

  public async replaceAll(
    zoneConfigs: ZoneConfig[],
    inputs?: InputConfig | null,
    groups?: GroupConfig | null,
  ): Promise<void> {
    this.lastInputs = inputs ?? null;
    this.powerManager.clearAll();
    this.sharedPowerGroupManager.clearAll();
    this.disposeAllOutputs();
    this.clearZoneContexts();
    clearPlayers();
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));
    this.sharedPowerGroupManager.configure(groups?.powerGroups, zoneConfigs);
    this.inputConfigurator.configure();
    const inputsPort = this.inputsPort;
    inputsPort.syncAirplayZones(zoneConfigs);
    inputsPort.syncDlnaZones(zoneConfigs);
    inputsPort.syncBluetoothZones(zoneConfigs);
    inputsPort.syncSpotifyZones(zoneConfigs, inputs?.spotify ?? null);
    inputsPort.configureMusicAssistant(this.playbackCoordinator.getMusicAssistantInputHandlers());
    this.refreshContentProviders();
    await inputsPort.syncMusicAssistantZones(zoneConfigs);
    await this.stateControllers.replaceAll(zoneConfigs);
    const contexts = this.zoneRepo.list();
    this.log.info('zones registered', { count: contexts.length });
    // Broadcast initial states so clients get defaults (including volume).
    for (const ctx of contexts) {
      const controllerId = resolveZoneStateControllerId(ctx.config);
      const externalOwnsVolume = isVolumeOwnedByStateController(controllerId);
      const patch = externalOwnsVolume
        ? { ...ctx.state }
        : { ...ctx.state, volume: getZoneDefaultVolume(ctx.config) };
      // Broadcast initial state using the same path as patches.
      this.applyPatch(ctx.id, patch, true);
      if (!externalOwnsVolume) {
        // Push default volume to outputs so they start at the configured level.
        this.outputRouter.dispatchVolume(ctx, ctx.outputs, patch.volume ?? getZoneDefaultVolume(ctx.config));
      }
    }
  }

  public async replaceZones(
    zoneConfigs: ZoneConfig[],
    inputs?: InputConfig | null,
    groups?: GroupConfig | null,
  ): Promise<void> {
    if (!zoneConfigs || zoneConfigs.length === 0) {
      return;
    }

    // Tear down existing contexts for the affected zones.
    for (const cfg of zoneConfigs) {
      await this.stateControllers.stopForZone(cfg.id);
      this.powerManager.clearZone(cfg.id);
      await this.disposeZone(cfg.id);
    }

    // Register the new/updated zones.
    zoneConfigs.forEach((cfg) => this.registerZone(cfg));
    await this.stateControllers.replaceZones(zoneConfigs);

    // Refresh input services using the full current set.
    const allZones = this.zoneRepo.list().map((ctx) => ctx.config);
    this.sharedPowerGroupManager.configure(groups?.powerGroups, allZones);
    this.inputConfigurator.configure();
    // Partial re-syncs (e.g. dynamic browser zone registration) call this without
    // the input config; fall back to the last full one so Spotify keeps its accounts.
    // Receivers themselves are per-zone, so they can't be lost by a partial re-sync.
    const effectiveInputs = inputs ?? this.lastInputs;
    const inputsPort = this.inputsPort;
    inputsPort.syncAirplayZones(allZones);
    inputsPort.syncDlnaZones(allZones);
    inputsPort.syncBluetoothZones(allZones);
    inputsPort.syncSpotifyZones(allZones, effectiveInputs?.spotify ?? null);
    inputsPort.configureMusicAssistant(this.playbackCoordinator.getMusicAssistantInputHandlers());
    this.refreshContentProviders();
    await inputsPort.syncMusicAssistantZones(allZones);

    // Push initial state for the updated zones.
    for (const cfg of zoneConfigs) {
      const ctx = this.zoneRepo.get(cfg.id);
      if (!ctx) {
        continue;
      }
      const controllerId = resolveZoneStateControllerId(ctx.config);
      const externalOwnsVolume = isVolumeOwnedByStateController(controllerId);
      const patch = externalOwnsVolume
        ? { ...ctx.state }
        : { ...ctx.state, volume: getZoneDefaultVolume(ctx.config) };
      this.applyPatch(ctx.id, patch, true);
      if (!externalOwnsVolume) {
        this.outputRouter.dispatchVolume(ctx, ctx.outputs, patch.volume ?? getZoneDefaultVolume(ctx.config));
      }
    }
  }

  /**
   * Public remove for runtime-registered zones (e.g. ephemeral browser zones).
   * Tears down playback, outputs, state controller and removes the zone from
   * the registry. The original config file is untouched.
   */
  public async removeZone(zoneId: number): Promise<void> {
    await this.stateControllers.stopForZone(zoneId);
    await this.disposeZone(zoneId);
  }

  private async disposeZone(zoneId: number): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    this.zoneAudioPrefs.setPlaybackPreDelayMs(zoneId, null);
    this.powerManager.clearZone(zoneId);
    try {
      const session = ctx.player.stop('reconfigure');
      await this.stopOutputs(ctx.outputs, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('zone dispose failed', { zoneId, message });
    }
    // The outputs die with their context — registerAll already disposed before rebuilding, but
    // this path (replaceZones/removeZone) only stopped them. The replaced DLNA output survived
    // as a zombie: its GENA subscription kept renewing, and every volume echo it heard was
    // re-injected into the zone as a user change, sustaining the oscillation of issue #358.
    this.outputRouter.disposeOutputs(zoneId, ctx.outputs);
    unregisterPlayer(zoneId);
    this.zoneRepo.delete(zoneId);
  }

  public async shutdown(): Promise<void> {
    this.heartbeat.stop();
    await this.stateControllers.stopAll();
    this.powerManager.clearAll();
    this.sharedPowerGroupManager.clearAll();
    await Promise.all(
      this.zoneRepo.list().map(async (ctx) => {
        const session = ctx.player.stop('shutdown');
        await this.stopOutputs(ctx.outputs, session);
        unregisterPlayer(ctx.id);
      }),
    );
    this.disposeAllOutputs();
    await this.inputsPort.shutdownAirplay();
    await this.inputsPort.shutdownSpotify();
    this.inputsPort.shutdownMusicAssistant();
    this.clearZoneContexts();
    this.initialized = false;
  }

  public getState(zoneId: number): ZoneState | undefined {
    return this.stateStore.getState(zoneId);
  }

  public getAllZoneStates(): ZoneState[] {
    const states: ZoneState[] = [];
    for (const ctx of this.zoneRepo.list()) {
      if (ctx.state) {
        states.push(ctx.state);
      }
    }
    return states;
  }

  public getQueue(zoneId: number, start: number, limit: number) {
    return this.queueController.getQueue(zoneId, start, limit);
  }

  /** The queue without the Loxone-facing rewrites; see QueueController.getRawQueue. */
  public getRawQueue(zoneId: number, start: number, limit: number) {
    return this.queueController.getRawQueue(zoneId, start, limit);
  }

  public getZoneVolumes(zoneId: number): ZoneConfig['volumes'] | undefined {
    return this.zoneRepo.get(zoneId)?.config?.volumes;
  }

  /**
   * Keep the level the zone already carries when the next play starts.
   *
   * The fade-in needs this. A gentle wake mutes the room and ramps back up, but the start of
   * playback lands in the middle of that ramp and would otherwise put the zone default on the
   * outputs as its own first act -- the one loud second the fade exists to avoid (#392). Marking
   * the zone says the level is already someone's decision.
   *
   * One-shot: `onPlayerStarted` consumes it. See `ZoneContext.startAtCurrentVolume`.
   */
  public keepVolumeOnNextStart(zoneId: number, keep: boolean): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (ctx) {
      ctx.startAtCurrentVolume = keep ? true : undefined;
    }
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ): Promise<void> {
    return this.playbackCoordinator.playContent(zoneId, uri, type, metadata, options);
  }

  /**
   * Hand off playback from one zone to another: move the full queue (order +
   * current index) to the target, resume it at the source's elapsed position,
   * then stop and clear the source. Returns false if either zone is unknown,
   * they are the same, or the source has nothing queued.
   */
  public async handoff(sourceId: number, targetId: number): Promise<boolean> {
    if (sourceId === targetId) return false;
    const src = this.zoneRepo.get(sourceId);
    const tgt = this.zoneRepo.get(targetId);
    if (!src || !tgt) return false;
    const items = src.queue.items.slice();
    if (items.length === 0) return false;
    const startIndex = Math.min(Math.max(0, src.queue.currentIndex ?? 0), items.length - 1);
    const startAtSec = Math.max(0, src.state.time ?? 0);
    const cur = items[startIndex];
    if (!cur) return false;

    // Carry the queue + playback flags to the target.
    tgt.queue.shuffle = src.queue.shuffle;
    tgt.queue.repeat = src.queue.repeat;
    tgt.queue.authority = src.queue.authority;
    tgt.queueController.setItems(items, startIndex);

    // Empty the source — silent, queue-less and with a clean now-playing state.
    src.player.stop('handoff');
    src.queueController.setItems([], 0);
    this.applyPatch(
      sourceId,
      { mode: 'stop', title: '', artist: '', album: '', coverurl: '', station: '', duration: 0, time: 0 },
      true,
    );

    // Resume the current track on the target at the same position.
    const metadata: PlaybackMetadata = {
      title: cur.title,
      artist: cur.artist,
      album: cur.album,
      coverurl: cur.coverurl,
      duration: cur.duration,
      audiopath: cur.audiopath,
      station: cur.station,
    };
    await this.playbackCoordinator.startQueuePlayback(tgt, cur.audiopath, metadata, { startAtSec });
    this.log.info('handoff', { from: sourceId, to: targetId, items: items.length, startIndex, startAtSec });
    return true;
  }

  /**
   * Hot-update the configured output latency for a zone. Calls `setLatencyMs` on each
   * live output that supports it. Returns true if at least one output applied the value.
   */
  public setOutputLatency(zoneId: number, latencyMs: number, clientId?: string): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    let applied = false;
    for (const output of ctx.outputs) {
      try {
        // A clientId targets a specific Sendspin satellite; otherwise the primary output.
        if (clientId) {
          const setSatellite = (output as { setSatelliteLatencyMs?: (id: string, ms: number) => boolean })
            .setSatelliteLatencyMs;
          if (typeof setSatellite === 'function') {
            applied = setSatellite.call(output, clientId, latencyMs) || applied;
          }
        } else if (typeof output.setLatencyMs === 'function') {
          void output.setLatencyMs(latencyMs);
          applied = true;
        }
      } catch (err) {
        // Keep going; one output failing shouldn't prevent the others.
        this.log.warn('setOutputLatency failed for output', {
          zoneId,
          outputType: output.type,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return applied;
  }

  public renameZone(zoneId: number, name: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed || ctx.name === trimmed) {
      return;
    }
    ctx.name = trimmed;
    const patch: Partial<ZoneState> = { name: trimmed };
    const current = ctx.queueController.current();
    const sourceName = this.audioHelpers.resolveSourceName(
      ctx.state.audiotype ?? this.audioHelpers.getInputAudioType(ctx),
      ctx,
      current,
    );
    if (sourceName) {
      patch.sourceName = sourceName;
    }
    this.applyPatch(zoneId, patch);
    void this.inputsPort.renameAirplayZone(zoneId, trimmed);
    void this.inputsPort.renameSpotifyZone(zoneId, trimmed);
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (ctx) {
      const controllerId = resolveZoneStateControllerId(ctx.config);
      // For routing, a paused session whose engine is still alive must stay with
      // the playback coordinator so resume/next/etc. reuse the engine rather than
      // being deflected to an external state controller that may not own the
      // current output path.
      const hasActiveLocalSession =
        this.audioManager.hasActiveLocalSession(zoneId) ||
        this.audioManager.hasLocalEngineSession(zoneId);
      const shouldUseExternalController = shouldUseStateControllerForCommand(
        controllerId,
        hasActiveLocalSession,
        command,
      );
      if (shouldUseExternalController && this.stateControllers.handleCommand(zoneId, command, payload)) {
        return;
      }
    }
    this.playbackCoordinator.handleCommand(zoneId, command, payload);
  }

  public setPower(zoneId: number, signal: PowerSignal): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return false;
    }
    this.powerManager.forceSignal(zoneId, ctx.config, signal);
    return true;
  }

  /** Stops playback and switches the configured physical power action off immediately. */
  public powerOffImmediately(zoneId: number): boolean {
    if (!this.setPower(zoneId, 0)) {
      return false;
    }
    this.handleCommand(zoneId, 'off');
    return true;
  }

  public getPowerState(zoneId: number): {
    power: 'on' | 'off';
    target: 'on' | 'off';
    managed: boolean;
    idleTimeoutMs: number | null;
  } | null {
    const ctx = this.zoneRepo.get(zoneId);
    const state = this.getState(zoneId);
    if (!ctx || !state) {
      return null;
    }
    const snapshot = this.powerManager.getState(zoneId, ctx.config, state.power === 'on' ? 1 : 0);
    return {
      power: snapshot.power === 1 ? 'on' : 'off',
      target: snapshot.target === 1 ? 'on' : 'off',
      managed: snapshot.managed,
      idleTimeoutMs: snapshot.idleTimeoutMs,
    };
  }

  public async startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
    startDelayMs = 0,
  ): Promise<void> {
    return this.alertsCoordinator.startAlert(zoneId, type, media, volume, startDelayMs);
  }

  /**
   * Wake-up silence (ms) per zone that makes a multi-zone alert land in every
   * room at the same moment.
   *
   * Two things sit between "the alert started" and "the alert is heard": a cold
   * amp needs its configured wake-up delay before it passes anything, and the
   * output itself holds a buffer — a sendspin or Snapcast client plays what it
   * was handed some hundreds of ms ago. Only the first used to be counted, and
   * only when a zone was cold: with music already playing everywhere no amp is
   * cold, every zone got a floor of 0, and each room rang on its own output's
   * schedule instead of together (#359).
   *
   * So every zone is padded up to the slowest one — prepend `slowest lead minus
   * my own output buffer`, never less than my own amp's wake-up delay. A single
   * zone, or zones whose outputs report the same buffer, resolve to exactly the
   * delay they had before.
   */
  public getAlertStartDelaysMs(zoneIds: number[]): Map<number, number> {
    const leads: AlertZoneLead[] = [];
    for (const zoneId of zoneIds) {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx) {
        continue;
      }
      const rawWakeUp = this.powerManager.isSignalOn(zoneId)
        ? 0
        : (this.zoneAudioPrefs.getPlaybackPreDelayMs(zoneId) ?? 0);
      const rawLatency = this.playbackCoordinator.getRoomLagMs(ctx);
      leads.push({
        zoneId,
        wakeUpMs: Number.isFinite(rawWakeUp) ? Math.max(0, Math.round(rawWakeUp)) : 0,
        outputLatencyMs: Number.isFinite(rawLatency) ? Math.max(0, Math.round(rawLatency)) : 0,
      });
    }
    return computeAlertStartDelays(leads);
  }

  public async stopAlert(zoneId: number): Promise<void> {
    return this.alertsCoordinator.stopAlert(zoneId);
  }

  public applyPatch(zoneId: number, patch: Partial<ZoneState>, force = false): void {
    this.stateStore.patch(zoneId, patch, force);
  }

  public async setEqualizerBands(zoneId: number, bands: unknown): Promise<EqualizerUpdateResult | null> {
    const normalized = normalizeEqualizerBands(bands);
    if (!normalized) {
      return null;
    }

    let found = false;
    await this.configPort.updateConfig((cfg) => {
      const zone = cfg.zones.find((entry) => entry.id === zoneId);
      if (!zone) {
        return;
      }
      found = true;
      zone.equalizer = { ...(zone.equalizer ?? {}), bands: [...normalized] };
    });

    if (!found) {
      return null;
    }

    const equalizerSettings = formatEqualizerSettings(normalized);
    const ctx = this.zoneRepo.get(zoneId);
    if (ctx) {
      ctx.config.equalizer = { ...(ctx.config.equalizer ?? {}), bands: [...normalized] };
    }
    this.applyPatch(zoneId, { eq: [...normalized] as EqualizerBands }, true);

    if (ctx?.config.equalizer?.provider === 'builtin') {
      this.audioManager.equalizerScheduler.schedule(zoneId);
    }

    return {
      zoneId,
      bands: [...normalized] as EqualizerBands,
      equalizerSettings,
    };
  }

  /**
   * Returns the EQ bands to bake into the ffmpeg pipeline for this zone, or null when EQ
   * handling is off or delegated to a forwarder.
   */
  private resolveBuiltinEqualizerBands(zoneId: number): ReadonlyArray<number> | null {
    const ctx = this.zoneRepo.get(zoneId);
    const eq = ctx?.config.equalizer;
    if (!eq || eq.provider !== 'builtin' || !Array.isArray(eq.bands)) {
      return null;
    }
    return eq.bands;
  }

  public syncGroupMembersToLeader(leaderId: number): void {
    this.groupingCoordinator.syncGroupMembersToLeader(leaderId);
  }

  public getMetadata(zoneId: number): Record<string, unknown> | undefined {
    return this.stateStore.getMetadata(zoneId);
  }

  public getTechnicalSnapshot(zoneId: number): {
    inputMode: ZoneContext['inputMode'];
    activeInput: string | null;
    activeOutput: string | null;
    transports: string[];
    outputs: string[];
  } | null {
    return this.stateStore.getTechnicalSnapshot(zoneId);
  }

  public getOutputCapabilities(zoneId: number): Record<string, unknown> | null {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) return null;
    const output =
      ctx.outputs.find((candidate) => candidate.type === ctx.activeOutput) ?? ctx.outputs[0];
    return output ? this.outputsPort.getCapabilities(output).protocolCapabilities ?? null : null;
  }

  /**
   * Which zones play as one, leader first, or null when this zone plays on its own.
   *
   * From the group tracker — the same authority the grouping commands and the Loxone projection use.
   * It is deliberately not read off `ZoneState`: `syncedzones` is typed there but never assigned, so
   * anything trusting it reports "not grouped" for every zone forever.
   */
  public getGroupMembership(zoneId: number): { leader: number; members: number[] } | null {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length <= 1) {
      return null;
    }
    return { leader: group.leader, members: [...group.members] };
  }

  /**
   * Whether this zone's active output can hold a group together by itself.
   *
   * False for a protocol that just hands bytes to one renderer — DLNA, Cast, Music
   * Assistant. Grouping such a zone needs the mixed group controller to feed each member,
   * which is why this is asked per zone rather than assumed from the protocol name.
   */
  public supportsNativeGrouping(zoneId: number): boolean {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) return false;
    const output =
      ctx.outputs.find((candidate) => candidate.type === ctx.activeOutput) ?? ctx.outputs[0];
    return output?.supportsNativeGrouping?.() === true;
  }

  /**
   * How the active output is timed against its device, or null when the protocol cannot say.
   *
   * The active output rather than all of them: a zone plays through one, and reporting a list
   * would imply a choice the caller does not have. See [[OutputSyncStatus]] for what it carries.
   */
  public getOutputSyncStatus(zoneId: number): OutputSyncStatus | null {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) return null;
    const output =
      ctx.outputs.find((candidate) => candidate.type === ctx.activeOutput) ?? ctx.outputs[0];
    return output?.getSyncStatus?.() ?? null;
  }

  private registerZone(config: ZoneConfig): void {
    this.zoneAudioPrefs.setPlaybackPreDelayMs(
      config.id,
      normalizeZonePlaybackPreDelayMs(config.powerManager?.playbackPreDelayMs),
    );
    const outputs = this.outputsPort.buildOutputs(config);
    const requiresPcm = this.outputsRequirePcm(outputs);
    const player = new ZonePlayer(this.audioManager, config.id, config.name, config.sourceMac, requiresPcm);
    this.playbackCoordinator.setupPlayerListeners(player, outputs, config.id, config.name, config.sourceMac);
    const queue: QueueState = {
      items: [],
      shuffle: false,
      repeat: 0,
      currentIndex: 0,
      authority: 'local',
    };
    const queueController = new PlaybackQueueNavigator(queue);
    registerPlayer(config.id, player);
    const inputAdapter = new InputAdapter({
      player,
      zoneName: config.name,
      sourceMac: config.sourceMac,
      replaceQueue: (items, startIndex = 0) => {
        queueController.setItems(items, startIndex);
        queue.shuffle = false;
        // Repeat stays, for the same reason it stays across a queue built here: it belongs to the
        // zone rather than to the list, and the client is never told it was cleared. See #371.
        return queueController.current();
      },
      applyPatch: (patch) => this.applyPatch(config.id, patch),
      getDefaultSpotifyAccountId: () => this.contentPort.getDefaultSpotifyAccountId(),
    });
    const spotifyAdapter = new SpotifyInputAdapter(inputAdapter, {
      startPlayback: (_zoneId, label, source, metadata) =>
        this.playbackCoordinator.playInputSource(config.id, label, source, metadata),
      updateMetadata: (zoneId, metadata) => this.playbackCoordinator.updateInputMetadata(zoneId, metadata),
      updateCover: (zoneId, cover) => this.playbackCoordinator.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => this.playbackCoordinator.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) =>
        this.playbackCoordinator.updateInputTiming(zoneId, elapsed, duration),
      pausePlayback: (zoneId) => this.playbackCoordinator.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => this.playbackCoordinator.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => this.playbackCoordinator.stopInputSource(zoneId),
    }, config.id);
    const context: ZoneContext = {
      id: config.id,
      name: config.name,
      sourceMac: config.sourceMac,
      config,
      state: buildInitialState(config),
      metadata: {},
      queue,
      queueController,
      inputAdapter,
      spotifyAdapter,
      outputs,
      player,
      outputTimingActive: false,
      lastOutputTimingAt: 0,
      lastZoneBroadcastAt: 0,
      lastPositionUpdateAt: 0,
      lastPositionValue: 0,
      lastPlaybackErrorAt: 0,
      lastPlaybackErrorReason: undefined,
      lastMetadataDispatchAt: 0,
      activeOutputTypes: new Set(),
      activeOutput: null,
      activeInput: null,
      inputMode: null,
      alert: undefined,
    };
    this.zoneRepo.set(config.id, context);
    this.stateStore.setInitial(config.id, context.state);
  }

  private disposeAllOutputs(): void {
    this.outputRouter.disposeAllOutputs(this.zoneRepo);
  }

  private clearZoneContexts(): void {
    for (const ctx of this.zoneRepo.list()) {
      this.zoneAudioPrefs.setPlaybackPreDelayMs(ctx.id, null);
      this.zoneRepo.delete(ctx.id);
    }
  }

  private notifyOutputMetadata(
    zoneId: number,
    ctx: ZoneContext,
    patch: Partial<ZoneState>,
  ): void {
    this.outputRouter.notifyOutputMetadata(zoneId, ctx, patch);
  }

  private updateQueueFromOutput(zoneId: number, items: QueueItem[], currentIndex: number): void {
    this.queueController.updateQueueFromOutput(zoneId, items, currentIndex);
  }

  private async stopOutputs(
    outputs: ZoneOutput[],
    session: PlaybackSession | null | undefined,
  ): Promise<void> {
    await this.outputRouter.stopOutputs(outputs, session);
  }

}

function normalizeZonePlaybackPreDelayMs(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : null;
}
