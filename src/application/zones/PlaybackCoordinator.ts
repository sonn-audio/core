import type { ComponentLogger } from '@/shared/logging/logger';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { ZoneState } from '@/domain/zones/zoneState';
import { toServiceNative } from '@/domain/zones/bridgeIdentity';
import { hasSlowStreamResolution } from '@/domain/zones/audiopath';
import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { InputsPort, MusicAssistantInputHandlers } from '@/ports/InputsPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { NotifierPort } from '@/ports/NotifierPort';
import { audioOutputSettings } from '@/ports/types/audioFormat';
import { computePreferredPlaybackSettings } from '@/application/playback/policies/OutputFormatPolicy';
import { applyPreferredPlaybackSettings } from '@/application/playback/PlaybackSettingsApplier';
import { buildPlaybackPlan } from '@/application/playback/buildPlaybackPlan';
import { executePlaybackPlan } from '@/application/playback/executePlaybackPlan';
import type { ProviderKind } from '@/application/playback/types/PlaybackPlan';
import { OutputRouter } from '@/application/zones/OutputRouter';
import { QueueController as ZoneQueueController } from '@/application/zones/QueueController';
import { type ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import {
  setMusicAssistantProviderId,
  MUSIC_ASSISTANT_PROVIDER_DEFAULT,
} from '@/application/zones/internal/musicAssistantProvider';
import { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { CoverArtPayload, PlaybackErrorOrigin, PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import { attachPlayerListeners } from '@/application/zones/playback/playerListeners';
import { handleZoneCommand } from '@/application/zones/playback/commandHandlers';
import { QueueStepDispatcher } from '@/application/zones/playback/QueueStepDispatcher';
import { CrossfadeController } from '@/application/zones/playback/crossfadeController';
import { PlayRequestService } from '@/application/zones/playback/playRequestService';
import { QueueAdvanceController } from '@/application/zones/playback/queueAdvanceController';
import {
  pauseInputSource as handlePauseInputSource,
  playInputSource as handlePlayInputSource,
  resumeInputSource as handleResumeInputSource,
  stopInputSource as handleStopInputSource,
  updateInputCover as handleUpdateInputCover,
  updateInputMetadata as handleUpdateInputMetadata,
  updateInputTiming as handleUpdateInputTiming,
  updateInputVolume as handleUpdateInputVolume,
  updateRadioMetadata as handleUpdateRadioMetadata,
} from '@/application/zones/playback/inputHandlers';
import { handlePlaybackError as handlePlaybackErrorTransition } from '@/application/zones/playback/playbackErrors';
import { updateOutputState as handleUpdateOutputState } from '@/application/zones/playback/outputStateUpdater';
import { RadioParadiseBlockService } from '@/application/zones/radioparadise/radioParadiseBlockService';
import { normalizeSpotifyAudiopath, resolveSpotifyAccountId } from '@/application/zones/helpers/queueHelpers';

type PlaybackCoordinatorDeps = {
  zones: ZoneRepository;
  queueController: ZoneQueueController;
  outputRouter: OutputRouter;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  stopAlert: (zoneId: number) => Promise<void>;
  log: ComponentLogger;
  notifier: NotifierPort;
  inputsPort: InputsPort;
  audioHelpers: ZoneAudioHelpers;
  contentPort: ContentPort;
  configPort: ConfigPort;
  recentsManager: RecentsManager;
  audioManager: AudioManager;
  zoneAudioPrefs: ZoneAudioPreferences;
};

/**
 * What to assume a room is holding when its output cannot say.
 *
 * Most renderers buffer somewhere between half a second and two. Guessing high is nearly
 * free — the extra wait falls while the previous audio is still sounding — where guessing
 * zero is the assumption that cannot be recovered from.
 */
const UNKNOWN_OUTPUT_LAG_MS = 1000;
/** How long a measured playout lag stays worth using. */
const PLAYOUT_LAG_MAX_AGE_MS = 30_000;

/**
 * What a listener is told when a bridged service's stream never arrives.
 *
 * Only the name differs for most of them. The exception is a service whose
 * stream service has already recorded a specific reason for this same attempt —
 * Apple's missing Widevine, SoundCloud's DRM note — where the generic error is
 * suppressed so one track produces one playback error instead of two.
 */
type StreamFailureReport = {
  provider: ProviderKind;
  label: string;
  /** True when a more specific reason for this attempt was already recorded. */
  reasonAlreadyRecorded?: (lastError: string | undefined) => boolean;
};

const STREAM_FAILURE_REPORTS: ReadonlyArray<StreamFailureReport> = [
  {
    provider: 'applemusic',
    label: 'apple music',
    reasonAlreadyRecorded: (lastError) => lastError === 'widevine missing',
  },
  { provider: 'deezer', label: 'deezer' },
  { provider: 'tidal', label: 'tidal' },
  { provider: 'ytmusic', label: 'ytmusic' },
  { provider: 'youtube', label: 'youtube' },
  {
    provider: 'soundcloud',
    label: 'soundcloud',
    reasonAlreadyRecorded: (lastError) => lastError?.startsWith('soundcloud') === true,
  },
];

/** Music Assistant is selected by its external label, not by a provider kind. */
const MUSIC_ASSISTANT_FAILURE_REPORT: StreamFailureReport = {
  provider: null,
  label: 'music assistant',
};

export class PlaybackCoordinator {
  private readonly zoneRepo: ZoneRepository;
  private readonly queueController: ZoneQueueController;
  private readonly outputRouter: OutputRouter;
  private readonly applyPatch: (
    zoneId: number,
    patch: Partial<ZoneState>,
    force?: boolean,
  ) => void;

  private readonly stopAlert: (zoneId: number) => Promise<void>;
  private readonly log: ComponentLogger;
  private readonly notifier: NotifierPort;
  private readonly inputsPort: InputsPort;
  private readonly audioHelpers: ZoneAudioHelpers;
  private readonly contentPort: ContentPort;
  private readonly configPort: ConfigPort;
  private readonly recentsManager: RecentsManager;
  private readonly audioManager: AudioManager;
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly radioParadise: RadioParadiseBlockService;
  private readonly queueStepDispatcher: QueueStepDispatcher;
  private readonly zonesMissingOutput = new Set<number>();
  private readonly crossfade: CrossfadeController;
  private readonly playRequest: PlayRequestService;
  private readonly queueAdvance: QueueAdvanceController;
  private readonly musicAssistantInputHandlers: MusicAssistantInputHandlers = {
    startPlayback: (zoneId: number, label: string, source: PlaybackSource, metadata?: PlaybackMetadata) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.playInputSource(zoneId, label, source, metadata);
    },
    stopPlayback: (zoneId: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.stopInputSource(zoneId);
    },
    updateMetadata: (zoneId: number, metadata: Partial<PlaybackMetadata>) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputMetadata(zoneId, metadata);
    },
    updateVolume: (zoneId: number, volume: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputVolume(zoneId, volume);
    },
    updateTiming: (zoneId: number, elapsed: number, duration: number) => {
      const ctx = this.zoneRepo.get(zoneId);
      if (!ctx || (ctx.activeInput && ctx.activeInput !== 'musicassistant')) {
        return;
      }
      this.updateInputTiming(zoneId, elapsed, duration);
    },
  };

  constructor(deps: PlaybackCoordinatorDeps) {
    this.zoneRepo = deps.zones;
    this.queueController = deps.queueController;
    this.outputRouter = deps.outputRouter;
    this.applyPatch = deps.applyPatch;
    this.stopAlert = deps.stopAlert;
    this.log = deps.log;
    this.notifier = deps.notifier;
    this.inputsPort = deps.inputsPort;
    this.audioHelpers = deps.audioHelpers;
    this.contentPort = deps.contentPort;
    this.configPort = deps.configPort;
    this.recentsManager = deps.recentsManager;
    this.audioManager = deps.audioManager;
    this.zoneAudioPrefs = deps.zoneAudioPrefs;
    this.radioParadise = new RadioParadiseBlockService({
      getZone: (zoneId) => this.zoneRepo.get(zoneId),
      updateRadioMetadata: (zoneId, metadata) => this.updateRadioMetadata(zoneId, metadata),
    });
    this.queueStepDispatcher = new QueueStepDispatcher({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      dispatchOutputs: this.dispatchOutputs.bind(this),
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      prefetchPlaybackSource: this.prefetchPlaybackSource.bind(this),
      advanceTrack: (ctx) => this.queueAdvance.advanceTrack(ctx),
    });
    this.crossfade = new CrossfadeController({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      inputsPort: this.inputsPort,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
    });
    this.playRequest = new PlayRequestService({
      zoneRepo: this.zoneRepo,
      queueController: this.queueController,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      notifier: this.notifier,
      recentsManager: this.recentsManager,
      log: this.log,
      applyPatch: this.applyPatch,
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      stopExternalInputSessions: this.stopExternalInputSessions.bind(this),
      prefetchNextQueueItem: (ctx) => this.queueAdvance.prefetchNext(ctx),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      consumeMissingOutputFlag: (zoneId) => {
        const had = this.zonesMissingOutput.has(zoneId);
        if (had) this.zonesMissingOutput.delete(zoneId);
        return had;
      },
    });
    this.queueAdvance = new QueueAdvanceController({
      zoneRepo: this.zoneRepo,
      audioManager: this.audioManager,
      audioHelpers: this.audioHelpers,
      contentPort: this.contentPort,
      configPort: this.configPort,
      recentsManager: this.recentsManager,
      radioParadise: this.radioParadise,
      crossfade: this.crossfade,
      log: this.log,
      applyPatch: this.applyPatch,
      isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
      dispatchOutputs: this.dispatchOutputs.bind(this),
      startQueuePlayback: (...args) => this.startQueuePlayback(...args),
      prefetchInputSource: (zoneId, audiopath, queueUser) => {
        // Mirror executePlaybackPlan's account handling so the prefetched source
        // is keyed identically to the real start.
        const accountId = resolveSpotifyAccountId(audiopath, queueUser);
        void this.inputsPort
          .prefetchPlaybackSourceForUri(zoneId, normalizeSpotifyAudiopath(audiopath), accountId)
          .catch(() => undefined);
      },
      updateRadioMetadata: this.updateRadioMetadata.bind(this),
    });
  }

  public getMusicAssistantInputHandlers(): MusicAssistantInputHandlers {
    return this.musicAssistantInputHandlers;
  }

  /** Keep Music Assistant provider detection in sync with the configured bridge. */
  public refreshMusicAssistantProviderId(): void {
    try {
      const providerId = this.inputsPort.getMusicAssistantProviderId();
      setMusicAssistantProviderId(providerId);
    } catch {
      setMusicAssistantProviderId(MUSIC_ASSISTANT_PROVIDER_DEFAULT);
    }
  }

  private buildInputCoordinator() {
    return {
      getZone: (id: number) => this.zoneRepo.get(id),
      log: this.log,
      audioHelpers: this.audioHelpers,
      applyPatch: this.applyPatch,
      setInputMode: this.setInputMode.bind(this),
      stopExternalInputSessions: this.stopExternalInputSessions.bind(this),
      stopSpotifyOutputs: this.stopSpotifyOutputs.bind(this),
      requestLineInStop: (inputId: string) => this.inputsPort.requestLineInStop(inputId),
      seekExistingQueueInternal: this.queueController.seekExistingQueueInternal.bind(this.queueController),
      recentsRecord: this.recentsManager.record.bind(this.recentsManager),
      buildAbsoluteCoverUrl: this.buildAbsoluteCoverUrl.bind(this),
      updateInputMetadata: this.updateInputMetadata.bind(this),
    };
  }

  public playInputSource(
    zoneId: number,
    label: string,
    playbackSource: PlaybackSource,
    metadata?: PlaybackMetadata,
  ): void {
    // Align the engine output format with the target output's preferred format BEFORE starting.
    this.alignOutputFormat(zoneId, metadata?.audiopath ?? label);
    handlePlayInputSource({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      label,
      playbackSource,
      metadata,
    });
  }

  /**
   * Align the zone's effective output settings with the target output's preferred
   * format BEFORE the engine session is created. The queue path does this; paths
   * that go straight through playUri/startPlayback (Spotify Connect, and ALERTS like
   * the doorbell bell) skipped it, so the engine started at the default 44.1 kHz and
   * then restarted mid-stream to match the sink (e.g. a sendspin client at 48 kHz/
   * 24-bit). That format-mismatch restart races the source and can leave a
   * started-but-starved stream — an audible dmix loop / noise. Call this just before
   * playing so ffmpeg spawns at the sink's rate the first time, no restart.
   */
  public alignOutputFormat(zoneId: number, audiopath: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    const settings = computePreferredPlaybackSettings({
      zoneId,
      zoneName: ctx.name,
      audiopath,
      isRadio: false,
      queueAuthority: ctx.queue?.authority,
      outputs: ctx.outputs,
      activeOutputType: ctx.activeOutput,
      defaults: audioOutputSettings,
    });
    applyPreferredPlaybackSettings(this.zoneAudioPrefs, zoneId, settings);
  }

  public stopInputSource(zoneId: number): void {
    handleStopInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public pauseInputSource(zoneId: number): void {
    handlePauseInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public resumeInputSource(zoneId: number): void {
    handleResumeInputSource({ coordinator: this.buildInputCoordinator(), zoneId });
  }

  public updateInputMetadata(zoneId: number, metadata: Partial<PlaybackMetadata>): void {
    handleUpdateInputMetadata({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      metadata,
    });
  }

  public updateRadioMetadata(
    zoneId: number,
    metadata: { title: string; artist: string; coverurl?: string; duration?: number; controllable?: boolean },
  ): void {
    handleUpdateRadioMetadata({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      metadata,
    });

    // Keep audio session metadata in sync so HTTP clients (e.g. Squeezelite)
    // can receive dynamic "now playing" updates via ICY metadata blocks.
    const session = this.audioManager.getSession(zoneId);
    if (!session) {
      return;
    }
    const prev = session.metadata;
    const next: PlaybackMetadata = {
      title: metadata.title?.trim() || prev?.title || '',
      artist: metadata.artist?.trim() || '',
      album: prev?.album || '',
      coverurl: metadata.coverurl || prev?.coverurl,
      duration: typeof metadata.duration === 'number' ? metadata.duration : prev?.duration,
      isRadio: prev?.isRadio ?? true,
      audiopath: prev?.audiopath,
      trackId: prev?.trackId,
      station: prev?.station,
      stationIndex: prev?.stationIndex,
      queue: prev?.queue,
      queueIndex: prev?.queueIndex,
    };
    // Avoid overwriting sessions with empty mandatory fields.
    if (!next.title) {
      return;
    }
    this.audioManager.updateSessionMetadata(zoneId, next);
  }

  public updateInputCover(zoneId: number, cover?: CoverArtPayload): string | undefined {
    return handleUpdateInputCover({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      cover,
    });
  }

  public updateInputVolume(zoneId: number, volume: number): void {
    handleUpdateInputVolume({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      volume,
    });
  }

  public updateInputTiming(zoneId: number, elapsed: number, duration: number): void {
    handleUpdateInputTiming({
      coordinator: this.buildInputCoordinator(),
      zoneId,
      elapsed,
      duration,
    });
  }

  public async playContent(
    zoneId: number,
    uri: string,
    type: string,
    metadata?: PlaybackMetadata,
    options?: { startAtSec?: number },
  ): Promise<void> {
    // Loxone-boundary intake: a play request from the native client arrives in
    // the disguised `spotify@bridge-...` form (also for room-favs). Translate it
    // to the service-native core identity here so everything downstream is
    // service-native. Idempotent on already-native / non-bridge paths.
    const nativeUri = toServiceNative(uri, this.contentPort.getBridgeRegistry());
    return this.playRequest.play(zoneId, nativeUri, type, metadata, options);
  }

  public async startQueuePlayback(
    ctx: ZoneContext,
    audiopath: string,
    metadata?: PlaybackMetadata,
    options?: { skipExternalStop?: boolean; startAtSec?: number },
  ): Promise<PlaybackSession | null> {
    this.crossfade.clear(ctx.id);
    const hasRadioParadise =
      this.radioParadise.isRadioParadiseAudiopath(audiopath) ||
      this.radioParadise.isRadioParadiseAudiopath(metadata?.audiopath ?? '') ||
      this.radioParadise.isRadioParadiseAudiopath(ctx.state.audiopath ?? '');
    if (!hasRadioParadise) {
      this.radioParadise.stop(ctx.id);
    }
    let resolvedAudiopath = audiopath;
    let resolvedMetadata = metadata;
    let startAtSec = options?.startAtSec;
    if (this.radioParadise.isRadioParadiseAudiopath(audiopath)) {
      const stationId = this.radioParadise.parseStationId(audiopath);
      if (!stationId) {
        this.log.warn('radio paradise station id missing', { zoneId: ctx.id, audiopath });
        return null;
      }
      const resolved = await this.radioParadise.resolveStart(ctx.id, stationId);
      if (!resolved) {
        this.log.warn('radio paradise block resolve failed', { zoneId: ctx.id, stationId });
        return null;
      }
      resolvedAudiopath = resolved.url;
      startAtSec = resolved.startAtSec;
      const base = resolvedMetadata ?? { title: '', artist: '', album: '' };
      resolvedMetadata = {
        ...base,
        isRadio: resolved.isRadio,
        title: resolved.track?.title ?? base.title ?? '',
        artist: resolved.track?.artist ?? base.artist ?? '',
        album: resolved.track?.album ?? base.album ?? '',
        coverurl: resolved.track?.coverurl ?? base.coverurl ?? '',
        animatedCoverUrl: base.animatedCoverUrl,
        duration: resolved.track?.durationSec ?? base.duration,
        station: base.station ?? resolved.stationLabel,
        audiopath,
      };
    }
    const radioContextAudiopath = resolvedMetadata?.audiopath ?? audiopath;
    const isRadioAudiopath = this.audioHelpers.isRadioAudiopath(radioContextAudiopath);
    if (isRadioAudiopath) {
      ctx.metadata.radioControllable = this.radioParadise.isRadioParadiseAudiopath(radioContextAudiopath)
        ? true
        : resolvedMetadata?.isRadio === false;
    } else if (ctx.metadata.radioControllable) {
      ctx.metadata.radioControllable = false;
    }
    const classification = this.classifyAudiopath(audiopath);
    // Broadcast Loading… immediately so the app shows feedback while the stream
    // URL is still being resolved.
    if (hasSlowStreamResolution(classification.provider)) {
      this.notifier.notifyZoneStateChanged({
        ...ctx.state,
        mode: 'play',
        title: 'Loading…',
        artist: '',
        album: '',
        coverurl: '',
        duration: 0,
        time: 0,
        audiotype: 5,
        audiopath,
      });
    }
    if (!this.hasPlaybackOutput(ctx)) {
      this.zonesMissingOutput.add(ctx.id);
      this.handlePlaybackError(ctx.id, 'No output configured', 'output');
      this.log.warn('playback blocked; no output configured', {
        zoneId: ctx.id,
        audiopath,
      });
      this.audioManager.clearPlayRequest(ctx.id);
      return null;
    }
    this.zonesMissingOutput.delete(ctx.id);
    // Apply preferred output from the primary target output so we can resample/format accordingly.
    const outputTargets = this.resolvePlaybackOutputs(ctx);
    this.applyOutputEndGuard(ctx, outputTargets);
    const isRadio = this.audioHelpers.isRadioAudiopath(audiopath);
    const settings = computePreferredPlaybackSettings({
      zoneId: ctx.id,
      zoneName: ctx.name,
      audiopath: resolvedAudiopath,
      isRadio,
      queueAuthority: ctx.queue.authority,
      outputs: ctx.outputs,
      activeOutputType: ctx.activeOutput,
      defaults: audioOutputSettings,
    });
    this.applyPlaybackInputTransition(ctx, classification.nextInput, {
      skipExternalStop: options?.skipExternalStop,
    });
    const enrichedMetadata = this.buildEnrichedPlaybackMetadata(audiopath, resolvedMetadata);
    const provider: ProviderKind = classification.provider;
    const plan = buildPlaybackPlan({
      ctx,
      audiopath: resolvedAudiopath,
      metadata: enrichedMetadata,
      isRadio,
      preferredSettings: settings,
      classification: {
        isSpotify: classification.isSpotify,
        isMusicAssistant: classification.isMusicAssistant,
        provider,
      },
    });
    const session = await executePlaybackPlan({
      ctx,
      plan,
      content: this.contentPort,
      inputs: this.inputsPort,
      log: this.log,
      zoneAudioPrefs: this.zoneAudioPrefs,
      startAtSec,
    });
    if (!session) {
      this.audioManager.clearPlayRequest(ctx.id);
      const report =
        plan.playExternalLabel === 'musicassistant'
          ? MUSIC_ASSISTANT_FAILURE_REPORT
          : STREAM_FAILURE_REPORTS.find((candidate) => candidate.provider === plan.provider);
      if (report) {
        const lastError = ctx.lastPlaybackErrorReason?.trim().toLowerCase();
        const alreadyRecorded =
          this.hasRecentPlaybackError(ctx) && report.reasonAlreadyRecorded?.(lastError) === true;
        if (!alreadyRecorded) {
          this.handlePlaybackError(ctx.id, `${report.label} stream unavailable`, 'output');
        }
        this.log.warn(`${report.label} stream not ready; skipping playback`, { zoneId: ctx.id });
      }
      return null;
    }
    this.queueAdvance.prefetchNext(ctx);
    return session;
  }

  private hasPlaybackOutput(ctx: ZoneContext): boolean {
    return ctx.outputs.length > 0;
  }

  /**
   * How far this zone's playback outputs lag behind the server, in ms.
   *
   * The largest buffer among them, because that is the one the room waits for;
   * 0 when no output reports a figure. Used to line up an alert with the moment
   * it is actually heard — both to align sibling zones and to time the
   * announcement volume (#359).
   */
  public getOutputLatencyMs(ctx: ZoneContext): number {
    return this.computeOutputLatencyMs(this.resolvePlaybackOutputs(ctx));
  }

  /**
   * How far behind the server this zone's room is, in ms.
   *
   * Asked three ways, because no single one covers every output: what the output states
   * about itself, what it last revealed by reporting its own playback position, and — when
   * it says nothing either way — a conservative assumption. Taking silence for "no buffer"
   * is what let a doorbell raise the volume while the room was still on the outgoing track
   * (#359), so the unknown case errs towards waiting.
   */
  public getRoomLagMs(ctx: ZoneContext): number {
    const reportedMs = Math.max(0, this.getOutputLatencyMs(ctx));

    let measuredMs = 0;
    const measuredAt = ctx.outputPlayoutLagAt ?? 0;
    if (measuredAt > 0 && Date.now() - measuredAt <= PLAYOUT_LAG_MAX_AGE_MS) {
      const value = ctx.outputPlayoutLagMs;
      measuredMs = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
    }

    const known = Math.max(reportedMs, measuredMs);
    return known > 0 ? Math.round(known) : UNKNOWN_OUTPUT_LAG_MS;
  }

  private computeOutputLatencyMs(outputs: ZoneOutput[]): number {
    return outputs
      .map((output) => output.getLatencyMs?.())
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .reduce((max, value) => Math.max(max, value), 0);
  }

  /** The outputs a play command will actually reach for this zone. */
  private resolvePlaybackOutputs(ctx: ZoneContext): ZoneOutput[] {
    return ctx.activeOutput !== null
      ? ctx.outputs.filter((output) => output.type === ctx.activeOutput)
      : this.selectPlayOutputs(ctx.outputs, null);
  }

  /**
   * Let the zone clock run past `duration` by however long the output lags behind the
   * server, so a track (or an alert) is only declared over once the room has heard it.
   * Every start goes through here — the guard is per-playback state and a previous track
   * may have zeroed it to force an end-of-track.
   */
  public applyOutputEndGuard(ctx: ZoneContext, outputs = this.resolvePlaybackOutputs(ctx)): void {
    ctx.player.setEndGuardMs(this.computeOutputLatencyMs(outputs));
  }

  /**
   * Who owns this audiopath, and what that means for the zone's input mode.
   *
   * Spotify and Music Assistant are named because they *are* input modes; every
   * other service is answered as a `provider` and asked about by property (see
   * SLOW_STREAM_RESOLUTION_PROVIDERS) rather than by name.
   */
  private classifyAudiopath(audiopath: string): {
    isSpotify: boolean;
    isMusicAssistant: boolean;
    provider: ProviderKind;
    nextInput: ZoneContext['inputMode'];
  } {
    const isSpotify = this.audioHelpers.isSpotifyAudiopath(audiopath);
    const isMusicAssistant = this.audioHelpers.isMusicAssistantAudiopath(audiopath);
    const provider = this.audioHelpers.providerForAudiopath(audiopath) as ProviderKind;
    const nextInput: ZoneContext['inputMode'] =
      isSpotify
        ? 'spotify'
        : isMusicAssistant
          ? 'musicassistant'
          : 'queue';
    return { isSpotify, isMusicAssistant, provider, nextInput };
  }

  private applyPlaybackInputTransition(
    ctx: ZoneContext,
    nextInput: ZoneContext['inputMode'],
    options?: { skipExternalStop?: boolean },
  ): void {
    const prevInput = ctx.inputMode;
    this.setInputMode(ctx, nextInput);
    if (!options?.skipExternalStop) {
      this.stopExternalInputSessions(ctx.id, prevInput, nextInput);
    }
    if (nextInput !== 'spotify') {
      this.stopSpotifyOutputs(ctx.outputs);
    }
  }

  private buildEnrichedPlaybackMetadata(
    audiopath: string,
    metadata?: PlaybackMetadata,
  ): PlaybackMetadata {
    if (metadata && metadata.audiopath) {
      return metadata;
    }
    return { ...(metadata ?? { title: '', artist: '', album: '' }), audiopath };
  }

  public handleCommand(zoneId: number, command: string, payload?: string): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }
    if (command === 'next' || command === 'previous' || command === 'queueplus' || command === 'queueminus') {
      const currentAudiopath = ctx.queueController.current()?.audiopath ?? ctx.state.audiopath ?? '';
      if (this.radioParadise.isRadioParadiseAudiopath(currentAudiopath) && this.radioParadise.canSkip(ctx.id)) {
        const delta = command === 'previous' || command === 'queueminus' ? -1 : 1;
        void this.queueAdvance.radioParadiseSkip(ctx, delta);
        return;
      }
    }
    handleZoneCommand({
      coordinator: {
        log: this.log,
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        dispatchVolume: this.dispatchVolume.bind(this),
        setInputMode: this.setInputMode.bind(this),
        setShuffle: this.queueController.setShuffle.bind(this.queueController),
        stepQueue: this.queueStepDispatcher.stepQueue.bind(this.queueStepDispatcher),
        isLocalQueueAuthority: this.isLocalQueueAuthority.bind(this),
        startQueuePlayback: (...args) => this.startQueuePlayback(...args),
        audioHelpers: this.audioHelpers,
        remoteControl: (id, cmd) => this.inputsPort.remoteControl(id, cmd),
        remoteVolume: (id, volume) => this.inputsPort.remoteVolume(id, volume),
        playerCommand: (id, cmd, args) => this.inputsPort.playerCommand(id, cmd, args),
        requestLineInControl: (inputId, cmd) => this.inputsPort.requestLineInControl(inputId, cmd),
        requestLineInStop: (inputId) => this.inputsPort.requestLineInStop(inputId),
        stopSpotifySession: (id, reason) => this.inputsPort.stopSpotifySession(id, reason),
      },
      ctx,
      zoneId,
      command,
      payload,
    });
  }

  public updateOutputState(
    zoneId: number,
    state: {
      status?: 'playing' | 'paused' | 'stopped';
      position?: number;
      duration?: number;
      uri?: string;
    },
  ): void {
    handleUpdateOutputState({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        audioHelpers: this.audioHelpers,
        applyPatch: this.applyPatch,
      },
      zoneId,
      state,
    });
  }

  /**
   * Hand the zone a track length that only turned up after playback began.
   *
   * Reaches the player rather than only the zone state, because the player's clock is what ends a
   * track: it was started with a 0 and would otherwise run past the end of a track forever, leaving
   * the queue sitting on it. Patching `duration` as well is what moves the progress bar.
   *
   * Only ever called for a track that started without a length — see `AudioManager.watchSourceDuration`.
   */
  public applySourceDuration(zoneId: number, durationSec: number): void {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx || !Number.isFinite(durationSec) || durationSec <= 0) {
      return;
    }
    const player = ctx.player.getState();
    if (player.duration > 0) {
      return;
    }
    const elapsed = Math.max(0, Math.min(player.time, durationSec));
    ctx.player.updateTiming(elapsed, Math.round(durationSec));
    this.applyPatch(zoneId, { duration: Math.round(durationSec) });
    this.log.debug('source duration applied to zone', { zoneId, durationSec, elapsed });
  }

  public handlePlaybackError(
    zoneId: number,
    reason: string | undefined,
    source: 'player' | 'output',
    extraLog?: Record<string, unknown>,
    origin?: PlaybackErrorOrigin,
  ): void {
    const ctx = this.zoneRepo.get(zoneId);
    const normalized = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
    if (ctx && normalized.includes('end_of_track') && this.isLocalQueueAuthority(ctx.queue.authority)) {
      this.log.debug('treating end_of_track as queue advance', {
        zoneId,
        reason,
        source,
      });
      void this.queueStepDispatcher.handleEndOfTrack(ctx);
      return;
    }
    if (ctx) {
      ctx.lastPlaybackErrorAt = Date.now();
      ctx.lastPlaybackErrorReason = typeof reason === 'string' ? reason.trim() : undefined;
    }
    handlePlaybackErrorTransition({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        applyPatch: this.applyPatch,
        log: this.log,
      },
      zoneId,
      reason,
      source,
      extraLog,
      origin,
    });
  }

  private hasRecentPlaybackError(ctx: ZoneContext, windowMs = 2000): boolean {
    if (!ctx.lastPlaybackErrorAt) return false;
    if (Date.now() - ctx.lastPlaybackErrorAt > windowMs) return false;
    return Boolean(ctx.lastPlaybackErrorReason && ctx.lastPlaybackErrorReason.trim());
  }

  public setupPlayerListeners(
    player: ZoneContext['player'],
    outputs: ZoneOutput[],
    zoneId: number,
    zoneName: string,
    sourceMac: string,
  ): void {
    attachPlayerListeners({
      coordinator: {
        getZone: (id) => this.zoneRepo.get(id),
        applyPatch: this.applyPatch,
        dispatchOutputs: this.dispatchOutputs.bind(this),
        dispatchVolume: this.dispatchVolume.bind(this),
        spotifyVolume: (id, volume) => this.inputsPort.spotifyVolume(id, volume),
        buildAbsoluteCoverUrl: this.buildAbsoluteCoverUrl.bind(this),
        audioHelpers: this.audioHelpers,
        stopAlert: this.stopAlert,
        handleEndOfTrack: this.queueStepDispatcher.handleEndOfTrack.bind(this.queueStepDispatcher),
        handlePlaybackError: this.handlePlaybackError.bind(this),
        onCrossfadePosition: this.onCrossfadePosition.bind(this),
      },
      player,
      outputs,
      zoneId,
      zoneName,
      sourceMac,
    });
  }

  public setInputMode(ctx: ZoneContext | undefined, mode: ZoneContext['inputMode']): void {
    if (!ctx) {
      return;
    }
    ctx.activeInput = mode;
    ctx.inputMode = mode;
  }

  private stopSpotifyOutputs(outputs: ZoneOutput[]): void {
    outputs
      .filter((t) => t.type === 'spotify')
      .forEach((t) => {
        try {
          t.stop?.(null);
        } catch {
          /* ignore */
        }
      });
  }

  private stopExternalInputSessions(
    zoneId: number,
    prevInput: ZoneContext['inputMode'],
    nextInput: ZoneContext['inputMode'],
  ): void {
    // Released ahead of the guard below and keyed off the audiopath rather than prevInput: a line-in
    // that was selected but never started streaming (a source still waiting to be switched on) has
    // inputMode null, so it would otherwise never be told to stop and would stay powered on.
    if (nextInput !== 'linein') {
      const ctx = this.zoneRepo.get(zoneId);
      const inputId = this.audioHelpers.parseLineInInputId(ctx?.state.audiopath);
      if (inputId) {
        this.inputsPort.requestLineInStop(inputId);
      }
    }
    if (!prevInput || prevInput === nextInput) {
      return;
    }
    const reason = `switch_to_${nextInput ?? 'queue'}`;
    if (prevInput === 'airplay') {
      this.inputsPort.stopAirplaySession(zoneId, reason);
    }
    if (prevInput === 'spotify') {
      this.inputsPort.stopSpotifySession(zoneId, reason);
    }
    if (prevInput === 'musicassistant') {
      void this.inputsPort.switchAway(zoneId);
    }
  }

  private isLocalQueueAuthority(authority: QueueAuthority | undefined | null): boolean {
    return this.queueController.isLocalQueueAuthority(authority);
  }

  private buildAbsoluteCoverUrl(pathname: string): string {
    if (!pathname) {
      return '';
    }
    if (/^https?:\/\//i.test(pathname)) {
      return pathname;
    }
    const sys = this.configPort.getSystemConfig();
    const host = sys.audioserver.ip?.trim() || '127.0.0.1';
    const port = 7090;
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return `http://${host}:${port}${normalized}`;
  }

  private dispatchOutputs(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    action: 'play' | 'pause' | 'resume' | 'stop',
    payload: PlaybackSession | null | undefined,
  ): void {
    this.outputRouter.dispatchOutputs(ctx, outputs, action, payload);
  }

  private dispatchVolume(
    ctx: ZoneContext,
    outputs: ZoneOutput[],
    volume: number,
  ): void {
    this.outputRouter.dispatchVolume(ctx, outputs, volume);
  }

  private selectPlayOutputs(
    outputs: ZoneOutput[],
    _session: PlaybackSession | null,
  ): ZoneOutput[] {
    return this.outputRouter.selectPlayOutputs(outputs, _session);
  }

  private prefetchPlaybackSource(ctx: ZoneContext, audiopath: string): void {
    if (this.audioHelpers.isRadioAudiopath(audiopath)) {
      return;
    }
    // SoundCloud is absent on purpose: it was absent from this list before, and adding it
    // would start prefetching a service that never was. See the note in ParentContextPolicy.
    const owner = this.audioHelpers.providerForAudiopath(audiopath);
    if (!owner || owner === 'soundcloud') {
      return;
    }
    if (!this.isTrackAudiopath(audiopath)) {
      return;
    }
    void this.contentPort.resolvePlaybackSource({
      audiopath,
      prefetch: true,
      requester: { kind: 'zone', zoneId: ctx.id },
    }).catch((error) => {
      this.log.debug('step prefetch failed', {
        zoneId: ctx.id,
        audiopath,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  public onCrossfadePosition(zoneId: number, time: number, duration: number): void {
    this.crossfade.onPosition(zoneId, time, duration);
  }


  private isTrackAudiopath(audiopath: string): boolean {
    return /:track:|:library-track:/i.test(audiopath);
  }
}
