import { Jimp, JimpMime } from 'jimp';
import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSession } from '@/ports/types/playback';
import {
  audioOutputSettings,
  pcmBitDepthFromFormat,
  type AudioOutputSettings,
  type PcmBitDepth,
} from '@/ports/types/audioFormat';
import { zoneSessionKey } from '@/ports/types/SessionKey';
import {
  AudioCodec,
  MediaCommand,
  PlaybackStateType,
  PlayerCommand,
  RepeatMode,
  sendspinCore,
  serverNowUs,
  type ControllerStatePayload,
  type PlayerFormat,
  type PlayerFormatWithBitDepth,
  type SendspinGroupCommand,
  type SendspinPlayerStateUpdate,
} from '@sonn-audio/node-sendspin';
import type {
  PreferredOutput,
  OutputConfigDefinition,
  OutputSyncStatus,
  ZoneOutput,
} from '@/ports/OutputsTypes';
import type { SendspinSession } from '@sonn-audio/node-sendspin';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { SendspinDeclaredFormat } from '@/application/outputs/sendspinGroupController';
import type { PlaybackSource } from '@/ports/EngineTypes';
import { probeFileFormat, type ProbedSourceFormat } from '@/engine/sourceProbe';
import { FlacFrameSplitter } from '@/engine/flacFrameSplitter';
import { SendspinClientSender } from '@/adapters/outputs/sendspin/sendspinClientSender';
import { artworkService } from '@/application/artwork/artworkService';
import {
  getStoredClientFormat,
  rememberClientFormat,
} from '@/adapters/outputs/sendspin/sendspinFormatStore';
import {
  allDeclareFormat,
  declaresFormat,
} from '@/adapters/outputs/sendspin/sendspinFormatMatch';

type SendspinFormat = PlayerFormatWithBitDepth<PcmBitDepth>;

type ArtworkChannel = Parameters<SendspinSession['sendArtworkStreamStart']>[0][number];

/** One entry of a client's `supported_formats` list from client/hello. */
type ClientDeclaredFormat = SendspinDeclaredFormat;

// Multiple zones can be configured against the same Sendspin client. In that case we need
// a single "controller" zone at a time; otherwise multiple outputs race and the client can
// disconnect due to conflicting metadata/stream commands.
const sendspinClientOwners = new Map<string, number>(); // clientId -> zoneId
const sendspinOutputsByZoneId = new Map<number, SendspinOutput>();
/** The window `leadMinMs` is measured over: long enough to be meaningful, short enough to be now. */
const LEAD_WINDOW_US = 2_000_000;

const STREAM_PLAYER_ROLE = 'player';

/** A listen-only satellite client fed the same audio as the zone (e.g. a subwoofer). */
export interface SendspinSatelliteConfig {
  clientId: string;
  endpointUrl?: string;
  /** Per-satellite static delay (ms); a subwoofer often needs its own phase trim. */
  latencyMs?: number;
}

/** Minimal Sendspin output configuration. */
export interface SendspinOutputConfig {
  clientId: string;
  endpointUrl?: string;
  /**
   * Optional client-side static playback delay (ms). Mapped to the Sendspin protocol's
   * `set_static_delay` PlayerCommand. Clamped to 0-5000 ms by the protocol.
   */
  latencyMs?: number;
  /**
   * Extra listen-only clients (subwoofer, visualizer, …) that receive the same timestamped
   * PCM as the primary client, synced via the shared timestamps. Best-effort: a satellite
   * never throttles the primary and a disconnect leaves the zone playing.
   */
  satellites?: SendspinSatelliteConfig[];
}

const SENDSPIN_MAX_STATIC_DELAY_MS = 5000;

/**
 * Lead for a browser client. Generous because a tab's timing is at the mercy of garbage
 * collection and the event loop, not a real-time scheduler.
 */
const BROWSER_ANCHOR_LEAD_MS = 1000;

/** The send lead in milliseconds for a client; see SendspinOutput.resolveAnchorLeadUs. */
export function resolveAnchorLeadMs(clientId: string): number {
  const defaultMs = isBrowserClientId(clientId) ? BROWSER_ANCHOR_LEAD_MS : 250;
  return Math.max(250, Math.min(8000, Math.round(defaultMs)));
}

/**
 * Whether a client id belongs to a browser tab.
 *
 * The registry mints these as `browser-<zoneId>`, so the prefix is the signal. A dedicated
 * receiver never carries it.
 */
export function isBrowserClientId(clientId: string): boolean {
  return clientId.trim().toLowerCase().startsWith('browser-');
}

function normalizeSendspinLatencyMs(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(SENDSPIN_MAX_STATIC_DELAY_MS, Math.round(num)));
}

/**
 * Translate the zone's `plrepeat` to the sendspin repeat mode.
 *
 * The engine's numbering is 1 = all, 3 = one, anything else off. Shared by the
 * metadata and controller objects, which have to agree: they describe the same
 * group, and the spec now requires the value in the controller state as well.
 */
function resolveRepeatMode(plrepeat: number | undefined): RepeatMode {
  if (plrepeat === 3) return RepeatMode.ONE;
  if (plrepeat === 1) return RepeatMode.ALL;
  return RepeatMode.OFF;
}

export type SendspinMetadataPayload = Parameters<SendspinSession['sendMetadata']>[0];
export type SendspinMetadataProgress = NonNullable<SendspinMetadataPayload['progress']>;

export interface SendspinOutputOptions {
  onMetadata?: (payload: SendspinMetadataPayload) => void;
  ignoreVolumeUpdates?: boolean;
}

const cloneMetadataPayload = (payload: SendspinMetadataPayload): SendspinMetadataPayload => ({
  ...payload,
  progress: payload.progress ? { ...payload.progress } : payload.progress ?? null,
});

export const SENDSPIN_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'sendspin',
  label: 'Sendspin',
  description: 'Streams the PCM output to a Sendspin client over WebSocket.',
  fields: [
    {
      id: 'clientId',
      label: 'Sendspin client ID',
      type: 'text',
      placeholder: 'sendspin-client-1',
      required: true,
      description: 'Identifier announced by the Sendspin client (client/hello).',
    },
    {
      id: 'endpointUrl',
      label: 'Sendspin endpoint URL',
      type: 'text',
      placeholder: 'ws://esphome.local:8928/sendspin',
      required: false,
      advanced: true,
      description: 'Optional direct websocket endpoint from discovery; keeps clientId for identity.',
    },
    {
      id: 'latencyMs',
      label: 'Speaker delay (ms)',
      type: 'number',
      placeholder: '0',
      // Not "sound is later". The client subtracts this from each timestamp, so it plays *earlier*
      // by this much — it exists to cancel delay that happens after its audio port. Raise it for a
      // room that arrives late; a room that arrives early has nothing to declare.
      description:
        'Delay added after this speaker\'s audio output — an amplifier or active speaker, 0-5000 ms. '
        + 'The player compensates by playing that much earlier, so raise it for a room that arrives late.',
    },
    {
      id: 'satellites',
      label: 'Satellite client IDs',
      type: 'text',
      required: false,
      advanced: true,
      placeholder: 'subwoofer-wohnzimmer, ledfx-wohnzimmer',
      description:
        'Optional listen-only clients fed the same audio, time-synced (e.g. a subwoofer or visualizer). Comma-separated; per-satellite latency requires manual config.',
    },
  ],
};

/** Sendspin ZoneOutput implementation: streams audio/state to a Sendspin client. */
export class SendspinOutput implements ZoneOutput {
  public readonly type = 'sendspin';

  /** Grouped zones stay in step here: the leader mirrors its frames to each member's client. */
  public supportsNativeGrouping(): boolean {
    return true;
  }

  private readonly log = createLogger('Output', 'Sendspin');
  /**
   * The configured Sendspin client, driven through a dedicated sender. The accessors below
   * forward the legacy per-client field names to `primary` so existing call sites are
   * unchanged; satellite clients (added in a later step) get their own senders.
   */
  private readonly primary: SendspinClientSender;
  /** Listen-only satellite clients (subwoofer, visualizer) fed the same audio as `primary`. */
  private readonly satellites: SendspinClientSender[];
  private readonly options: SendspinOutputOptions;
  private readonly unwatchClient: (() => void) | null;
  private readonly unwatchResolvedClient: (() => void) | null;
  private currentStream: NodeJS.ReadableStream | null = null;
  private currentCoverUrl: string | null = null;
  /** Subscription to the shared audio-analysis service for visualizer@v1. */
  private unsubscribeAnalysis: (() => void) | null = null;
  private lastProgressPayload: SendspinMetadataProgress | null = null;
  private playbackState: 'playing' | 'paused' | 'stopped' = 'stopped';
  private lastSentPlaybackState: 'playing' | 'paused' | 'stopped' | null = null;
  /** What the client last reported about its clock. Reporting only; see handleClientState. */
  private clientState: 'synchronized' | 'error' | 'external_source' | null = null;
  /**
   * The state whose *transition* has been acted on (the external_source stream teardown).
   * Separate from `clientState` because reacting is gated on the connect guard and reporting is
   * not — a client that only ever says `synchronized` must still be reported as such.
   */
  private reactedClientState: 'synchronized' | 'error' | 'external_source' | null = null;
  private externalSourceActive = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private bufferedChunks: Array<{ data: Buffer; timestampUs: number }> = [];
  private bufferedBytes = 0;
  /** Rolling buffer size to retain for late join / smoothing (bytes). */
  private maxBufferedBytes = audioOutputSettings.prebufferBytes;
  /** Anchor for the Sendspin playback timeline (play_start_time_us). */
  private playStartUs: number | null = null;
  /** When the first chunk was observed (server clock). */
  private wallClockAnchorUs: number | null = null;
  /** Timestamp to assign to the next PCM frame (server time). */
  private nextFrameTimestampUs: number | null = null;
  /** Last wall-clock observation for encoded streams to measure elapsed time. */
  private lastChunkWallUs: number | null = null;
  private lastRestartMs = 0;
  private streamStarting = false;
  private negotiatedFormat: SendspinFormat = {
    codec: AudioCodec.PCM,
    sampleRate: audioOutputSettings.sampleRate,
    channels: audioOutputSettings.channels,
    bitDepth: audioOutputSettings.pcmBitDepth,
  };

  /**
   * Last format the *client* explicitly negotiated (via onFormatChanged).
   * `negotiatedFormat` gets reset to the stream default (often the 44.1 kHz engine
   * default) by onIdentified on every (re)connect, so reading it at play time can
   * report 44.1 kHz even though the client really wants e.g. 48 kHz/24-bit. The
   * engine then starts at 44.1 kHz and immediately restarts (reason=replace) when
   * the client renegotiates — that mid-stream restart races the source and can
   * leave a started-but-starved stream (audible dmix loop / noise). This value
   * survives reconnects so getPreferredOutput() advertises the real rate and the
   * engine starts aligned. See PR description.
   */
  private lastClientNegotiatedFormat: SendspinFormat | null = null;
  /** Actual output format of the current ffmpeg pipeline. */
  private activeOutputFormat: SendspinFormat | null = null;
  private activeCodecHeader: string | null = null;
  private anchorLeadUs: number;
  // Keep target lead aligned with the configured anchor for low-latency playback.
  /**
   * How far ahead of a frame's timestamp it is handed over — derived, not stored.
   *
   * The client's `static_delay_ms` is *subtracted* from the timestamp before it schedules playback
   * (spec: "Clients subtract their static_delay_ms from server timestamps before scheduling
   * playback"), so it does not move when audio is heard — it moves the deadline by which the client
   * must already hold the frame. Leaving the lead alone therefore spends the setting out of our own
   * buffer: at a 200 ms static delay a 250-350 ms lead becomes 50-150 ms of real headroom, and past
   * the lead the deadline is in the past before the frame arrives.
   *
   * So the lead grows with it, which is exactly what the spec asks for — "Servers factor in each
   * client's static_delay_ms when calculating how far ahead to send audio, keeping effective buffer
   * headroom constant" — and the wait loop, the prebuffer and the reported target all follow from
   * here for free.
   *
   * Sized by whichever of the two known values is larger — what we asked for, and what the client
   * last reported. Neither can be trusted to be current: a client reports its own persisted value on
   * connect and (in the reference implementation at least) never mentions it again after applying a
   * `set_static_delay`, so after a write ours is the newer number while its own may be a value we
   * have never seen — an installer's 300 ms for the amplifier it is wired to. Taking the larger
   * over-buffers at worst, which costs a little latency; taking the smaller runs the client dry.
   */
  private get targetLeadUs(): number {
    const configured = this.configuredLatencyMs;
    const reported = this.reportedStaticDelayMs();
    return this.anchorLeadUs + Math.max(configured, reported ?? 0) * 1000;
  }

  /**
   * The static delay the client last declared, or null if it never has.
   *
   * Its own truth, and not the same thing as what we configured: it persists this locally across
   * reboots, may keep a separate value per audio output, and is only obliged to honour a
   * `set_static_delay` it listed in `supported_commands`. Where the two disagree, both are worth
   * seeing — hence a separate field on the public status rather than one "effective" number.
   */
  private reportedStaticDelayMs(): number | null {
    const reported = sendspinCore
      .getSessionByClientId(this.activeClientId())
      ?.getPlayerTiming?.().staticDelayMs;
    return typeof reported === 'number' && reported >= 0 ? reported : null;
  }

  private lastMetadataSignature: string | null = null;
  private lastStreamSignature: string | null = null;
  private pcmRemainder: Buffer | null = null;
  private lastPlayRequestAtMs: number | null = null;
  private firstFrameLogged = false;
  private lastStreamStartSentAtMs: number | null = null;
  /**
   * Timing of the stream in flight, kept for `getSyncStatus`.
   *
   * These numbers are produced by the send loop anyway — it has to know the lead to decide
   * whether to wait — and used to reach nothing but `log.spam` every hundredth frame. Held as
   * one object so a reader can never see the lead from one frame beside the jitter from
   * another, and cleared on teardown so a stopped stream reports nothing rather than the last
   * thing it managed.
   */
  private streamTiming: {
    leadUs: number;
    /** Envelope of the window in progress, and the last completed window's spread. */
    windowStartTsUs: number;
    windowMinUs: number;
    windowMaxUs: number;
    floorUs: number | null;
    driftUs: number | null;
  } | null = null;

  /** The band the send loop holds the lead in: [targetLead, targetLead + this]. See startStream. */
  private leadMarginUs = 100_000;
  private streamToken = 0;
  private hooksStop: (() => void) | null = null;
  private resolvedHooksStop: (() => void) | null = null;
  private paused = false;
  private resumeGate: Promise<void> | null = null;
  private resumeGateResolve: (() => void) | null = null;

  public getProtocolCapabilities(): Record<string, unknown> | null {
    const session = sendspinCore.getSessionByClientId(this.activeClientId());
    if (!session || !this.clientConnected) {
      return null;
    }
    const visualizer = sendspinCore.getVisualizerSupport(this.activeClientId());
    return {
      formats: session.getPlayerSupportedFormats().map((format) => ({
        codec: format.codec,
        sampleRate: format.sample_rate,
        bitDepth: format.bit_depth,
        channels: format.channels,
      })),
      roles: session.getRoles(),
      visualizer: visualizer
        ? {
            types: [...visualizer.types],
            rateMax: visualizer.rate_max,
            spectrum: visualizer.spectrum
              ? {
                  bins: visualizer.spectrum.n_disp_bins,
                  scale: visualizer.spectrum.scale,
                  fMin: visualizer.spectrum.f_min,
                  fMax: visualizer.spectrum.f_max,
                }
              : null,
          }
        : null,
    };
  }

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SendspinOutputConfig,
    options: SendspinOutputOptions = {},
    private readonly ports: OutputPorts,
  ) {
    this.anchorLeadUs = SendspinOutput.resolveAnchorLeadUs(config.clientId ?? '');
    this.primary = new SendspinClientSender(
      config.clientId,
      normalizeSendspinLatencyMs(config.latencyMs),
      zoneId,
    );
    // Volume vanaf de client accepteren. Dit maakt bediening via de client
    // mogelijk: een Beoremote One aan een Pi stuurt zijn volumetoetsen als
    // MPRIS-commando naar de sendspin-daemon, die ze als controller-commando
    // hier aflevert (zie handleGroupCommand).
    //
    // De vlag dekt twee paden. Controller-commando's zijn intenties ("zet op
    // 40") en kunnen geen lus vormen. Client-state is een statusmelding en kan
    // dat wel: server zet volume -> client meldt het terug -> server ziet een
    // nieuwe opdracht. Daarvoor staat hierboven een echo-onderdrukking van 1s.
    // Outputs die hun volume voortdurend rapporteren -- Cast is het voorbeeld --
    // zetten deze vlag daarom expliciet op true.
    this.options = { ignoreVolumeUpdates: false, ...options };
    this.unwatchClient = this.ports.sendspinConnector.watchClient(this.clientId, config.endpointUrl);
    sendspinOutputsByZoneId.set(this.zoneId, this);
    this.ports.sendspinGroup.register(this.zoneId, this);
    const hooks = {
      onIdentified: (sendspinSession: SendspinSession) => {
        // Avoid re-running onIdentified for the same session instance.
        if (this.activeSession === sendspinSession) {
          return;
        }
        this.resolvedClientId = sendspinSession.getClientId() ?? this.resolvedClientId;
        this.ports.sendspinConnector.markInboundConnected(this.activeClientId());
        this.initialClientStateSkipped = false;
        this.lastClientStateSignature = null;
        this.lastLoggedClientState = null;
        this.lastLoggedMuted = null;
        this.lastAppliedMuted = null;
        this.activeSession = sendspinSession;
        this.clientConnected = true;
        this.clientState = null;
        this.reactedClientState = null;
        this.externalSourceActive = false;
        // Reconnect (e.g. Connect churn on track change) seeds the stream default,
        // but if the client already negotiated a real format keep that. After a lox
        // restart the in-memory value is gone, so fall back to the per-client format
        // persisted on disk — otherwise the first play advertises 44.1k, the engine
        // starts there and (on a 48k-only sink) renders noise / restarts mid-stream.
        this.lastClientNegotiatedFormat =
          this.lastClientNegotiatedFormat ?? getStoredClientFormat(this.clientId);
        this.negotiatedFormat =
          this.lastClientNegotiatedFormat ?? this.normalizeFormat(sendspinSession.getStreamFormat());
        if (!this.isOwner()) {
          // Avoid multiple zones fighting over the same Sendspin client.
          return;
        }
        // If there is an active audio session, reflect that state immediately.
        const audioSession = this.ports.audioManager.getSession(this.zoneId);
        if (audioSession?.state) {
          this.playbackState = audioSession.state;
        }
        const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
        const initialZoneVolume =
          typeof zoneState?.volume === 'number'
            ? zoneState.volume
            : this.lastKnownVolume;
        this.setVolume(initialZoneVolume);
        this.sendStaticDelay();
        this.sendControllerState();
        this.sendCurrentSnapshot();
        if (this.playbackState === 'playing') {
          /*
           * No `formatOverride` here, even though `negotiatedFormat` was just settled above. An
           * override means "the client asked for exactly this, do not second-guess it" and so
           * skips native-format matching entirely — but nobody asked for anything on a handshake.
           * That value is a remembered or defaulted one, and passing it as an override made a
           * reconnect (Connect churn on a track change is one) resample a source the client could
           * have taken as it is.
           *
           * `startStream` falls back to `negotiatedFormat` anyway, so this starts from the same
           * format and merely lets it be pulled to the source's rate. The 48k-only sink the
           * comment above worries about is still safe: matching only ever moves to a format the
           * client listed itself, and such a sink never lists 44.1k.
           */
          void this.startStream({ preserveAnchor: false });
        }
        // Push current playback state to the client right away.
        this.pushPlaybackState(this.playbackState);
      },
      onPlayerState: (_session: SendspinSession, update: SendspinPlayerStateUpdate) => this.handleClientState(update),
      onGroupCommand: (_session: SendspinSession, command: SendspinGroupCommand) => this.handleGroupCommand(command),
      /*
       * Say out loud what the session tolerated. These are things a conformant
       * client never does — an undeclared format request, a role object without the
       * role — and they are the kind of deviation that otherwise only surfaces as
       * "the client sounds broken" with nothing in the log to point at it. Fired
       * once per reason, so warning level is safe.
       */
      onNoncompliance: (_session: SendspinSession, reason: string) => {
        this.log.warn('Sendspin client deviated from the spec', {
          zoneId: this.zoneId,
          clientId: this.activeClientId(),
          reason,
        });
      },
      onDisconnected: (sendspinSession: SendspinSession) => {
        // A stale/superseded session can close long after a newer one took over
        // (e.g. an unclean drop the heartbeat only reaps ~30-60s later). React
        // only to the session we currently consider active, otherwise that late
        // close would tear down the live client's state.
        if (this.activeSession !== sendspinSession) {
          return;
        }
        this.clientConnected = false;
        this.activeSession = null;
        this.initialClientStateSkipped = false;
        this.lastClientStateSignature = null;
        this.lastLoggedClientState = null;
        this.lastLoggedMuted = null;
        this.lastAppliedMuted = null;
        this.clientState = null;
        this.reactedClientState = null;
        this.externalSourceActive = false;
        // Invalidate stream signature so the next startStream() rebuilds the
        // pipeline from scratch instead of reusing a stale consumeStream loop.
        this.lastStreamSignature = null;
        this.ports.sendspinConnector.markInboundDisconnected(this.activeClientId());
        this.log.info('Sendspin client disconnected', { zoneId: this.zoneId, clientId: this.clientId });
      },
      onFormatChanged: (_session: SendspinSession, format: PlayerFormat) => {
        this.negotiatedFormat = this.normalizeFormat(format);
        // Remember the client's explicitly-requested format so it survives a later
        // onIdentified reset and getPreferredOutput() can advertise the real rate.
        // Persist it so it also survives a lox restart (first-play-after-restart fix).
        this.lastClientNegotiatedFormat = this.negotiatedFormat;
        rememberClientFormat(this.clientId, this.negotiatedFormat);
        // Restart stream with the newly requested format.
        void this.startStream({ preserveAnchor: false, formatOverride: this.negotiatedFormat });
      },
    };
    this.hooksStop = this.ports.sendspinHooks.register(this.clientId, hooks);
    // Adopt a client that is already here.
    //
    // `onIdentified` fires on a handshake, and assigning a room its speaker does not cause one: the
    // client announced itself minutes ago and has been sitting in the list ever since. Without this
    // the output holds no session, so selecting it plays nothing at all until something makes the
    // client reconnect — which is why restarting it "fixed" the room, and why it looked like the
    // client's fault. It is not; this end simply never picked up the phone.
    //
    // On the next tick rather than now: the hook starts a stream when the room is already playing,
    // and construction has satellites and group registration still to do.
    const existing = sendspinCore.getSessionByClientId(this.clientId);
    if (existing) {
      queueMicrotask(() => {
        // Disposed before the tick came round: hooks are unregistered and this output is nobody's
        // speaker any more.
        if (!this.hooksStop) {
          return;
        }
        this.log.info('Sendspin adopting a client that was already connected', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        hooks.onIdentified(existing);
      });
    }
    // Push the static-delay to any already-connected session right away. onIdentified
    // only fires on a fresh handshake, so without this the value would only land after
    // the client reconnects.
    this.sendStaticDelay();
    this.unwatchResolvedClient = this.ports.sendspinConnector.onClientResolved(this.clientId, (resolvedClientId) => {
      this.resolvedClientId = resolvedClientId;
      if (resolvedClientId === this.clientId || this.resolvedHooksStop) {
        return;
      }
      this.resolvedHooksStop = this.ports.sendspinHooks.register(resolvedClientId, hooks);
    });
    this.satellites = (config.satellites ?? []).map((satellite) => {
      const sender = new SendspinClientSender(
        satellite.clientId,
        normalizeSendspinLatencyMs(satellite.latencyMs),
        zoneId,
      );
      sender.startSatellite(this.ports, satellite.endpointUrl, {
        isPlaying: () => this.playbackState === 'playing' && this.isOwner(),
        currentStreamFormat: () => this.currentStreamStartParams(),
        futureFrames: () => this.getFutureFrames(),
        currentVolume: () => this.lastKnownVolume,
      });
      this.log.info('Sendspin satellite registered', {
        zoneId: this.zoneId,
        clientId: satellite.clientId,
        latencyMs: normalizeSendspinLatencyMs(satellite.latencyMs),
      });
      return sender;
    });
  }

  /** Snapshot of the current stream format for a satellite late-join, or null if idle. */
  private currentStreamStartParams(): Parameters<SendspinClientSender['sendStreamStart']>[0] | null {
    const format = this.activeOutputFormat;
    if (!format) {
      return null;
    }
    const codecHeader = this.activeCodecHeader ?? undefined;
    return {
      codec: format.codec,
      sampleRate: format.sampleRate,
      channels: format.channels,
      bitDepth: format.bitDepth,
      ...(codecHeader ? { codecHeader } : {}),
    };
  }

  /** Run `fn` for each connected satellite, isolating per-satellite send failures. */
  private forEachConnectedSatellite(fn: (satellite: SendspinClientSender) => void): void {
    for (const satellite of this.satellites) {
      if (!satellite.isConnected()) {
        continue;
      }
      try {
        fn(satellite);
      } catch (err) {
        this.log.debug('Sendspin satellite send failed', {
          zoneId: this.zoneId,
          clientId: satellite.clientId,
          message: (err as Error).message,
        });
      }
    }
  }

  // Legacy per-client field names, forwarded to the primary sender. These keep the existing
  // call sites unchanged while the per-client state lives on `primary`.
  private get clientId(): string {
    return this.primary.clientId;
  }

  private get resolvedClientId(): string {
    return this.primary.resolvedClientId;
  }

  private set resolvedClientId(value: string) {
    this.primary.resolvedClientId = value;
  }

  private get activeSession(): SendspinSession | null {
    return this.primary.session;
  }

  private set activeSession(value: SendspinSession | null) {
    this.primary.session = value;
  }

  private get clientConnected(): boolean {
    return this.primary.connected;
  }

  private set clientConnected(value: boolean) {
    this.primary.connected = value;
  }

  private get configuredLatencyMs(): number {
    return this.primary.configuredLatencyMs;
  }

  private set configuredLatencyMs(value: number) {
    this.primary.configuredLatencyMs = value;
  }

  private get lastKnownVolume(): number {
    return this.primary.lastKnownVolume;
  }

  private set lastKnownVolume(value: number) {
    this.primary.lastKnownVolume = value;
  }

  private get lastOutboundVolume(): number | null {
    return this.primary.lastOutboundVolume;
  }

  private set lastOutboundVolume(value: number | null) {
    this.primary.lastOutboundVolume = value;
  }

  private get lastOutboundVolumeAt(): number | null {
    return this.primary.lastOutboundVolumeAt;
  }

  private set lastOutboundVolumeAt(value: number | null) {
    this.primary.lastOutboundVolumeAt = value;
  }

  private get lastClientStateSignature(): string | null {
    return this.primary.lastClientStateSignature;
  }

  private set lastClientStateSignature(value: string | null) {
    this.primary.lastClientStateSignature = value;
  }

  private get initialClientStateSkipped(): boolean {
    return this.primary.initialClientStateSkipped;
  }

  private set initialClientStateSkipped(value: boolean) {
    this.primary.initialClientStateSkipped = value;
  }

  private get lastLoggedClientState(): string | null {
    return this.primary.lastLoggedClientState;
  }

  private set lastLoggedClientState(value: string | null) {
    this.primary.lastLoggedClientState = value;
  }

  private get lastLoggedMuted(): boolean | null {
    return this.primary.lastLoggedMuted;
  }

  private set lastLoggedMuted(value: boolean | null) {
    this.primary.lastLoggedMuted = value;
  }

  private get lastAppliedMuted(): boolean | null {
    return this.primary.lastAppliedMuted;
  }

  private set lastAppliedMuted(value: boolean | null) {
    this.primary.lastAppliedMuted = value;
  }

  /** Whether there is a client connected and ready to receive PCM. */
  public isReady(): boolean {
    return this.clientConnected;
  }

  public getPreferredOutput(): PreferredOutput {
    // Prefer the client's last explicitly-negotiated format. negotiatedFormat is
    // reset to the stream default by onIdentified on (re)connect, so relying on it
    // here makes the engine start at the default rate and then restart on the
    // format mismatch (reason=replace) — which can starve the stream into an
    // audible dmix loop. lastClientNegotiatedFormat survives reconnects; the
    // persisted store survives lox restarts (first-play-after-restart fix).
    const fmt =
      this.lastClientNegotiatedFormat ?? getStoredClientFormat(this.clientId) ?? this.negotiatedFormat;
    const preferredPrebuffer = this.computePrebufferBytes(fmt);
    return {
      profile:
        fmt.codec === AudioCodec.OPUS
          ? 'opus'
          : fmt.codec === AudioCodec.FLAC
            ? 'flac'
            : 'pcm',
      sampleRate: fmt.sampleRate,
      channels: fmt.channels,
      bitDepth: fmt.bitDepth,
      prebufferBytes: preferredPrebuffer,
    };
  }

  /**
   * How long audio keeps playing after the engine stops feeding us — the end guard's input.
   *
   * Just the lead: a frame stamped T is heard at T however early it was handed over, and the lead
   * already includes the client's static delay (see `targetLeadUs`). This used to add the static
   * delay on top of a lead that did not contain it, which came to the same number; it is spelled
   * out here so the two cannot drift apart.
   */
  public getLatencyMs(): number {
    return Math.max(0, Math.round(this.targetLeadUs / 1000));
  }

  /**
   * The timing relationship with this client, for anyone who wants to see it.
   *
   * `state` is the client's own verdict, which is the only party that can give one: the clock is
   * negotiated by it asking us for the time (`client/time`) and running its own filter over the
   * answers, so *we* never compute an offset — we only learn whether it locked on. The rest is our
   * side of the bargain, measured while sending.
   */
  public getSyncStatus(): OutputSyncStatus {
    const timing = this.streamTiming;
    const round = (us: number): number => Math.round(us / 1000);
    return {
      state: this.clientState ?? 'unknown',
      // What this server asked for. Deliberately not the reported value: a client that applies the
      // command without re-announcing its state would make a slider bound to this snap back to the
      // old number, and the reference client does exactly that.
      delayMs: this.configuredLatencyMs,
      deviceDelayMs: this.reportedStaticDelayMs(),
      targetLeadMs: Math.max(0, round(this.targetLeadUs)),
      leadMarginMs: round(this.leadMarginUs),
      leadMs: timing ? round(timing.leadUs) : null,
      leadMinMs: timing && timing.floorUs !== null ? round(timing.floorUs) : null,
      driftMs: timing && timing.driftUs !== null ? round(timing.driftUs) : null,
    };
  }

  /** Hot-update the primary static delay; pushes the new value to the live client. */
  public setLatencyMs(ms: number): void {
    const next = normalizeSendspinLatencyMs(ms);
    if (next === this.configuredLatencyMs) {
      return;
    }
    this.configuredLatencyMs = next;
    this.sendStaticDelay();
  }

  /**
   * Hot-update one satellite's static delay (no stream restart). Returns true when the satellite
   * exists in this output. Adding/removing satellites still needs a rebuild; only the delay value
   * is live here.
   */
  public setSatelliteLatencyMs(clientId: string, ms: number): boolean {
    const satellite = this.satellites.find((sat) => sat.clientId === clientId);
    if (!satellite) {
      return false;
    }
    satellite.setLatencyMs(normalizeSendspinLatencyMs(ms));
    return true;
  }

  /**
   * Push the configured client-side static delay to the connected client. Not gated by
   * ownership — the static delay is benign per-client config that should reflect the
   * latest configured value regardless of which zone currently "owns" the client.
   */
  private sendStaticDelay(): void {
    this.primary.sendStaticDelay();
  }

  /** Push a volume change down to the client (used by zone manager). */
  public setVolume(level: number): void {
    const vol = Math.min(100, Math.max(0, Math.round(level)));
    // [#287] Only trace on an actual change, so a slider drag (a burst of equal
    // or stepped values) doesn't spam the debug log; the volume path stays
    // observable for activation without noise. Compare against lastKnownVolume,
    // which is maintained in both the active and no-session branches.
    const changed = vol !== this.lastKnownVolume;
    if (this.activeSession) {
      this.lastKnownVolume = vol;
      this.lastOutboundVolume = vol;
      this.lastOutboundVolumeAt = Date.now();
      const owner = this.isOwner();
      if (owner) {
        this.activeSession.sendServerCommand(PlayerCommand.VOLUME, { volume: vol });
      }
      if (changed) {
        this.log.debug('Sendspin setVolume', {
          zoneId: this.zoneId,
          clientId: this.clientId,
          vol,
          sent: owner,
          reason: owner ? 'sent' : 'not owner; remembered only',
        });
      }
    } else {
      this.lastKnownVolume = vol;
      if (changed) {
        this.log.debug('Sendspin setVolume', {
          zoneId: this.zoneId,
          clientId: this.clientId,
          vol,
          sent: false,
          reason: 'no active session; remembered only',
        });
      }
    }
    // Keep connected satellites (e.g. a subwoofer) in step with the zone volume.
    this.forEachConnectedSatellite((satellite) => satellite.pushVolume(vol));
  }

  /** Start playback for this zone on the Sendspin client. */
  public async play(session: PlaybackSession): Promise<void> {
    this.lastPlayRequestAtMs = Date.now();
    this.firstFrameLogged = false;
    this.lastStreamStartSentAtMs = null;
    if (!session.playbackSource) {
      this.log.warn('Sendspin output skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    this.claimOwnership();
    this.ports.sendspinConnector.requestPlaybackPriority(this.activeClientId());
    this.log.info('Sendspin play', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
      source: session.source,
    });
    this.sendMetadata(session);
    void this.fetchAndSendArtwork(session);
    this.sendControllerState();
    this.startProgressUpdates();
    // A fresh play request after pause must always release the pause gate,
    // especially when startStream() reuses an existing pipeline.
    if (this.paused) {
      this.paused = false;
      if (this.resumeGateResolve) {
        this.resumeGateResolve();
      }
      this.resumeGateResolve = null;
      this.resumeGate = null;
    }
    await this.startStream();
    this.pushPlaybackState('playing');
  }

  /** Pause playback. End the client stream so it drains its device (no beep). */
  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin pause', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    this.paused = true;
    this.sendProgressUpdate();
    this.pushPlaybackState('paused');
    // End the client stream(s) on pause. Keeping the stream open (the old behaviour)
    // leaves the client's ALSA device RUNNING but unfed, so on a shared dmix it loops
    // the residual ring-buffer = an audible beep while paused. Ending the stream makes
    // the client drain/close the device; resume() re-announces it. Mirrors the
    // external_source enter/return handling above.
    if (this.isOwner()) {
      this.endClientStreams();
    }
  }

  /** Tell the primary client (and satellites) to end + clear the current stream. */
  private endClientStreams(): void {
    sendspinCore.sendStreamEnd(this.activeClientId());
    sendspinCore.sendStreamClear(this.activeClientId(), [STREAM_PLAYER_ROLE]);
    this.forEachConnectedSatellite((satellite) => {
      sendspinCore.sendStreamEnd(satellite.activeClientId());
      sendspinCore.sendStreamClear(satellite.activeClientId(), [STREAM_PLAYER_ROLE]);
    });
  }

  /** Resume playback; if a session is provided, restart as play. */
  public async resume(session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin resume', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    if (this.currentStream && this.paused) {
      this.paused = false;
      if (this.resumeGateResolve) {
        this.resumeGateResolve();
      }
      this.resumeGateResolve = null;
      this.resumeGate = null;
      this.sendProgressUpdate();
      // The client stream was ended on pause to stop the device looping, so re-announce
      // and restart it (fresh anchor) — releasing the gate alone would feed frames the
      // client no longer has an open stream for.
      await this.startStream({ preserveAnchor: false });
      this.pushPlaybackState('playing');
      return;
    }
    if (session) {
      await this.play(session);
    } else {
      this.sendProgressUpdate();
      this.pushPlaybackState('playing');
    }
  }

  private handleClientState(update: { state?: string; volume?: number; muted?: boolean }): void {
    const signature = JSON.stringify({
      state: update.state,
      volume: update.volume,
      muted: update.muted,
    });
    if (signature === this.lastClientStateSignature) {
      return;
    }
    this.lastClientStateSignature = signature;
    const nextState =
      update.state === 'synchronized' || update.state === 'error' || update.state === 'external_source'
        ? update.state
        : null;
    /*
     * Record what the client said before the connect guard below, not after.
     *
     * A client typically reports `synchronized` once — on connect — and then only speaks up again
     * when its volume or mute changes. The guard exists to stop that first message applying the
     * client's volume over the zone's default, but it used to `return` past the state as well, so
     * the reported clock state was thrown away in the one message that carries it and
     * `getSyncStatus` answered "unknown" for a perfectly synchronised speaker.
     */
    if (nextState) {
      this.clientState = nextState;
    }
    /*
     * Ignore the client's opening volume report, not merely its first message.
     *
     * A client comes up at its own default — 100 for the reference clients — and that
     * must not become the zone's volume. The guard used to consume whichever message
     * arrived first, which works only for a client that packs everything into one.
     * sendspin-rs sends availability first and the player object second:
     *
     *   {"available":true,"state":"synchronized"}
     *   {"player":{"volume":100,"muted":false,...}}
     *
     * so the guard was spent on a message carrying no volume at all, and the 100 in
     * the next one was adopted — pulling the whole zone (and every other output in
     * it) to full volume moments after a client connected.
     *
     * A message without a volume cannot override ours, so let it through and keep
     * the guard armed for the one that can.
     */
    if (!this.initialClientStateSkipped && typeof update.volume === 'number') {
      this.initialClientStateSkipped = true;
      // Declining their value obliges us to state ours, or the two sit silently
      // disagreeing: the zone at 12 and the speaker actually playing at 100.
      this.assertZoneVolumeToClient(update.volume);
      return;
    }
    if (nextState && nextState !== this.reactedClientState) {
      this.reactedClientState = nextState;
      this.clientState = nextState;
      if (nextState === 'external_source') {
        this.log.info('Sendspin client entered external_source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        this.externalSourceActive = true;
        sendspinCore.sendStreamEnd(this.activeClientId());
        sendspinCore.sendStreamClear(this.activeClientId(), [STREAM_PLAYER_ROLE]);
      } else if (this.externalSourceActive) {
        this.externalSourceActive = false;
        this.log.info('Sendspin client returned from external_source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        // If we were playing, re-announce current state/stream.
        this.sendControllerState();
        if (this.playbackState === 'playing') {
          void this.startStream({ preserveAnchor: false });
          this.pushPlaybackState('playing');
        }
      }
    }
    const stateLevel =
      update.state === 'error' ? 'warn' : update.state === 'synchronized' ? 'debug' : 'info';
    const stateChanged = update.state != null && update.state !== this.lastLoggedClientState;
    const muteChanged = typeof update.muted === 'boolean' && update.muted !== this.lastLoggedMuted;
    // Only log interesting changes: warn on errors, debug when synchronized, otherwise skip.
    if ((stateLevel === 'warn' || stateLevel === 'debug') && (stateChanged || muteChanged)) {
      this.log[stateLevel]('Sendspin client state update', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        state: update.state,
        volume: update.volume,
        muted: update.muted,
      });
    }
    if (update.state != null) {
      this.lastLoggedClientState = update.state;
    }
    if (typeof update.muted === 'boolean') {
      this.lastLoggedMuted = update.muted;
    }
    if (!this.options.ignoreVolumeUpdates && typeof update.volume === 'number') {
      const vol = Math.min(100, Math.max(0, Math.round(update.volume)));
      const now = Date.now();
      const recentlySent =
        this.lastOutboundVolumeAt != null && now - this.lastOutboundVolumeAt < 1000;
      const outboundMatches =
        this.lastOutboundVolume != null && Math.abs(vol - this.lastOutboundVolume) <= 1;
      if (recentlySent && outboundMatches) {
        this.log.debug('Sendspin client volume echo ignored', {
          zoneId: this.zoneId,
          clientId: this.clientId,
          volume: vol,
        });
      } else if (vol !== this.lastKnownVolume) {
        this.lastKnownVolume = vol;
        this.log.debug('Sendspin adopting the client volume', {
          zoneId: this.zoneId,
          clientId: this.clientId,
          volume: vol,
        });
        this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
      }
    }
    /*
     * Only act when mute actually changed.
     *
     * Clients restate `muted` in every state message, so acting on its presence
     * meant every single update also fired a `volume_set` — which is what produced
     * a second, redundant zone command 1ms after the first. Mute now goes through
     * the zone's own mute command, which remembers the level to come back to
     * instead of routing an unmute through a volume the output happens to have
     * cached.
     */
    if (!this.options.ignoreVolumeUpdates && typeof update.muted === 'boolean') {
      if (update.muted !== this.lastAppliedMuted) {
        this.lastAppliedMuted = update.muted;
        this.ports.zoneManager.handleCommand(
          this.zoneId,
          'mute',
          update.muted ? '1' : '0',
        );
      }
    }
    this.sendControllerState();
  }

  private handleGroupCommand(command: SendspinGroupCommand): void {
    const cmd = command.command;
    this.log.info('Sendspin controller command', { zoneId: this.zoneId, command: cmd, volume: command.volume, mute: command.mute });
    switch (cmd) {
      case 'play':
        this.ports.zoneManager.handleCommand(this.zoneId, 'play');
        break;
      case 'pause':
        this.ports.zoneManager.handleCommand(this.zoneId, 'pause');
        break;
      case 'stop':
        this.ports.zoneManager.handleCommand(this.zoneId, 'stop');
        break;
      case 'next':
        this.ports.zoneManager.handleCommand(this.zoneId, 'next');
        break;
      case 'previous':
        this.ports.zoneManager.handleCommand(this.zoneId, 'previous');
        break;
      case 'volume':
        if (this.options.ignoreVolumeUpdates) {
          break;
        }
        if (typeof command.volume === 'number') {
          const vol = Math.min(100, Math.max(0, Math.round(command.volume)));
          this.lastKnownVolume = vol;
          // Apply group volume per Sendspin spec when in a group; otherwise set zone volume.
          this.ports.groupManager.applySpecGroupVolume(this.zoneId, vol);
          this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(vol));
        }
        break;
      case 'mute':
        if (this.options.ignoreVolumeUpdates) {
          break;
        }
        if (typeof command.mute === 'boolean') {
          if (command.mute) {
            this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', '0');
          } else {
            this.ports.zoneManager.handleCommand(
              this.zoneId,
              'volume_set',
              String(this.lastKnownVolume),
            );
          }
        }
        break;
      case 'repeat_off':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'off');
        break;
      case 'repeat_one':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'one');
        break;
      case 'repeat_all':
        this.ports.zoneManager.queue.setRepeatMode(this.zoneId, 'all');
        break;
      case 'shuffle':
        this.ports.zoneManager.queue.setShuffle(this.zoneId, true);
        break;
      case 'unshuffle':
        this.ports.zoneManager.queue.setShuffle(this.zoneId, false);
        break;
      case 'switch':
        this.handleSwitchCommand();
        break;
      case 'seek':
        if (typeof command.positionMs === 'number') {
          this.seekToMs(command.positionMs);
        }
        break;
      case 'seek_relative':
        if (typeof command.offsetMs === 'number') {
          this.seekToMs(this.currentPositionMs() + command.offsetMs);
        }
        break;
      default:
        this.log.debug('Unsupported Sendspin controller command', { cmd });
    }
  }

  /** Where playback currently stands, in ms — the anchor a relative seek moves from. */
  private currentPositionMs(): number {
    const session = this.ports.audioManager.getSession(this.zoneId);
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const seconds = session?.elapsed ?? zoneState?.time ?? 0;
    return Math.max(0, Math.round(seconds * 1000));
  }

  /**
   * Seek to an absolute position, clamped into the track.
   *
   * The engine's own seek vocabulary is `position` in whole seconds, so this is
   * where sendspin's milliseconds are converted. Clamping matters for
   * `seek_relative`, where an offset can legitimately point past either end.
   */
  private seekToMs(positionMs: number): void {
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const maxMs = this.resolveSeekMaxMs(zoneState);
    if (maxMs === null) {
      this.log.debug('Sendspin seek ignored; nothing seekable playing', { zoneId: this.zoneId });
      return;
    }
    const clampedMs = Math.max(0, Math.min(maxMs, Math.round(positionMs)));
    this.ports.zoneManager.handleCommand(
      this.zoneId,
      'position',
      String(Math.round(clampedMs / 1000)),
    );
  }

  private handleSwitchCommand(): void {
    const result = this.removeZoneFromGroup();
    if (result === 'no_group') {
      this.log.debug('Sendspin switch ignored; no active group', { zoneId: this.zoneId });
      return;
    }
    if (result === 'leader') {
      this.log.debug('Sendspin switch ignored; zone is group leader', { zoneId: this.zoneId });
      return;
    }
    // Clear stream on this client so it can operate solo.
    sendspinCore.sendStreamEnd(this.activeClientId());
    sendspinCore.sendStreamClear(this.activeClientId(), [STREAM_PLAYER_ROLE]);
    this.pushPlaybackState('stopped');
  }

  /** Stop playback and fully tear down the stream. */
  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.log.info('Sendspin stop', {
      zoneId: this.zoneId,
      zoneName: this.zoneName,
      clientId: this.clientId,
    });
    this.teardown();
    if (this.isOwner()) {
      this.sendStopMetadata();
      this.pushPlaybackState('stopped');
      this.releaseOwnership();
    }
  }

  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    const current = session ?? this.ports.audioManager.getSession(this.zoneId);
    if (!current) {
      return;
    }
    this.sendMetadata(current);
  }

  /** Dispose output resources and unregister hooks. */
  public async dispose(): Promise<void> {
    this.teardown();
    if (this.hooksStop) {
      this.hooksStop();
      this.hooksStop = null;
    }
    if (this.resolvedHooksStop) {
      this.resolvedHooksStop();
      this.resolvedHooksStop = null;
    }
    sendspinCore.clearLeadStats(this.activeClientId());
    for (const satellite of this.satellites) {
      satellite.disposeSatellite();
    }
    this.ports.sendspinGroup.unregister(this.zoneId);
    if (this.unwatchClient) {
      this.unwatchClient();
    }
    if (this.unwatchResolvedClient) {
      this.unwatchResolvedClient();
    }
    if (this.isOwner()) {
      this.releaseOwnership();
    }
    sendspinOutputsByZoneId.delete(this.zoneId);
  }

  private async startStream(
    options: {
      preserveAnchor?: boolean;
      formatOverride?: Partial<SendspinFormat>;
    } = {},
  ): Promise<void> {
    if (!this.isOwner()) {
      return;
    }
    if (!this.clientConnected || !this.activeSession) {
      this.log.debug('Sendspin stream start skipped; client not connected yet', {
        zoneId: this.zoneId,
        clientId: this.clientId,
      });
      return;
    }
    if (this.streamStarting) {
      this.log.debug('Sendspin stream start skipped; already starting', { zoneId: this.zoneId });
      return;
    }
    let token = this.streamToken;
    const preserveAnchor = options.preserveAnchor === true;
    this.streamStarting = true;
    try {

      // Ensure there is an active PCM session for this zone; start one if missing.
      const current = this.ports.audioManager.getSession(this.zoneId);
      if (!current?.playbackSource) {
        this.log.debug('Sendspin stream start skipped; no playback source', {
          zoneId: this.zoneId,
          clientId: this.clientId,
        });
        return;
      }
      let chosenFormat = this.normalizeFormat(options.formatOverride ?? this.negotiatedFormat);
      // Prefer the source's native rate/depth when the client can accept it, so a
      // lossless file reaches the speaker without a resample. Explicit overrides
      // (a client-driven stream/request-format) win — the client asked for that
      // format specifically, so we must not second-guess it.
      if (!options.formatOverride) {
        chosenFormat = await this.applyBitPerfectFormat(chosenFormat, current.playbackSource);
      }
      this.negotiatedFormat = chosenFormat;
      // A group leader streams PCM so every member can decode the shared audio
      // regardless of its own preferred codec (PCM is the universal sendspin
      // baseline; mirroring an OPUS/FLAC stream to a PCM-only member breaks it).
      // The client's real preference stays in negotiatedFormat and is restored
      // on the next stream start once the group dissolves.
      if (this.isGroupLeaderWithMembers() && chosenFormat.codec !== AudioCodec.PCM) {
        chosenFormat = { ...chosenFormat, codec: AudioCodec.PCM };
      }
      const prebufferBytes = this.computePrebufferBytes(chosenFormat);
      this.log.debug('Sendspin stream prebuffer config', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        codec: chosenFormat.codec,
        sampleRate: chosenFormat.sampleRate,
        channels: chosenFormat.channels,
        bitDepth: chosenFormat.bitDepth,
        targetLeadMs: Math.round(this.targetLeadUs / 1000),
        requestedPrebufferBytes: prebufferBytes,
        configuredDefaultPrebufferBytes: audioOutputSettings.prebufferBytes,
      });
      const sendspinOutputSettings: AudioOutputSettings = {
        ...audioOutputSettings,
        sampleRate: chosenFormat.sampleRate,
        channels: chosenFormat.channels,
        pcmBitDepth: chosenFormat.bitDepth,
        prebufferBytes,
      };
      this.maxBufferedBytes = prebufferBytes;
      const profile: 'pcm' | 'opus' | 'flac' =
        chosenFormat.codec === AudioCodec.OPUS
          ? 'opus'
          : chosenFormat.codec === AudioCodec.FLAC
            ? 'flac'
            : 'pcm';
      const streamSignature = this.buildStreamSignature(current, profile);
      const formatMatchesActive =
        this.activeOutputFormat &&
        this.activeOutputFormat.codec === chosenFormat.codec &&
        this.activeOutputFormat.sampleRate === chosenFormat.sampleRate &&
        this.activeOutputFormat.channels === chosenFormat.channels &&
        this.activeOutputFormat.bitDepth === chosenFormat.bitDepth;
      const sessionOutput = this.ports.audioManager.getOutputSettings(this.zoneId);
      const outputMismatch =
        this.activeOutputFormat === null &&
        sessionOutput != null &&
        (sessionOutput.sampleRate !== chosenFormat.sampleRate ||
          sessionOutput.channels !== chosenFormat.channels ||
          sessionOutput.pcmBitDepth !== chosenFormat.bitDepth);
      const shouldRestartForFormat =
        outputMismatch || (this.activeOutputFormat !== null && !formatMatchesActive);
      if (outputMismatch) {
        this.log.info('Sendspin output format mismatch; restarting engine', {
          zoneId: this.zoneId,
          clientId: this.clientId,
          current: sessionOutput,
          requested: {
            sampleRate: chosenFormat.sampleRate,
            channels: chosenFormat.channels,
            pcmBitDepth: chosenFormat.bitDepth,
          },
        });
      }

      // If a stream already exists and is healthy, reuse it and just re-announce to the client.
      if (
        this.currentStream &&
        !(this.currentStream as { destroyed?: boolean }).destroyed &&
        !(this.currentStream as { readableEnded?: boolean }).readableEnded &&
        this.lastStreamSignature === streamSignature &&
        this.activeOutputFormat &&
        this.activeOutputFormat.codec === chosenFormat.codec &&
        this.activeOutputFormat.sampleRate === chosenFormat.sampleRate &&
        this.activeOutputFormat.channels === chosenFormat.channels &&
        this.activeOutputFormat.bitDepth === chosenFormat.bitDepth
      ) {
        this.log.debug('Sendspin stream reusing existing pipeline', {
          zoneId: this.zoneId,
          activeFormat: this.activeOutputFormat,
          requestedFormat: chosenFormat,
        });
        const { sampleRate, channels, pcmBitDepth } = sendspinOutputSettings;
        const codecHeader = this.activeCodecHeader ?? undefined;
        const reuseStreamParams = {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        };
        this.primary.sendStreamStart(reuseStreamParams);
        this.ports.sendspinGroup.notifyStreamStart(this.zoneId, reuseStreamParams);
        this.forEachConnectedSatellite((satellite) => satellite.sendStreamStart(reuseStreamParams));
        // Reaffirm playback state to the client when reusing a stream.
        this.pushPlaybackState(this.playbackState);
        this.sendCurrentSnapshot();
        this.lastStreamSignature = streamSignature;
        return;
      }

      // If a previous stream object exists but is ended/destroyed, clean it up first.
      if (this.currentStream) {
        this.teardown({ preserveAnchor, invalidateToken: false });
      }
      this.streamToken += 1;
      token = this.streamToken;

      const sessionStats = this.ports.engine.getSessionStats(zoneSessionKey(this.zoneId));
      // Match the *format*, not just the profile. A leftover 48 kHz FLAC session
      // satisfies `profile === 'flac'` for a 96 kHz request, so the engine was not
      // restarted and kept emitting 48 kHz frames while stream/start announced
      // 96 kHz — every packet then failed to decode on the client. This is why
      // 96 kHz sessions only broke when they followed a 48 kHz one.
      const hasTargetProfile = sessionStats.some(
        (s) =>
          s.profile === profile &&
          s.sampleRate === chosenFormat.sampleRate &&
          s.channels === chosenFormat.channels &&
          s.pcmBitDepth === chosenFormat.bitDepth,
      );
      let startedEngine = false;
      if ((shouldRestartForFormat || !hasTargetProfile) && current?.playbackSource) {
        this.ports.engine.start(zoneSessionKey(this.zoneId), current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
      }

      let pcmStream = this.ports.engine.createStream(zoneSessionKey(this.zoneId), profile, {
        primeWithBuffer: true,
        label: 'sendspin',
      });
      // Fallback: if we expected an existing session but couldn't attach, start a fresh one.
      if (!pcmStream && !startedEngine && current?.playbackSource) {
        this.ports.engine.start(zoneSessionKey(this.zoneId), current.playbackSource, [profile], sendspinOutputSettings);
        startedEngine = true;
        pcmStream = this.ports.engine.createStream(zoneSessionKey(this.zoneId), profile, {
          primeWithBuffer: true,
          label: 'sendspin',
        });
      }
      if (!pcmStream) {
        this.log.warn('Sendspin stream unavailable (profile missing)', { zoneId: this.zoneId, profile });
        return;
      }
      const { sampleRate, channels, pcmBitDepth } = sendspinOutputSettings;
      // Delay anchoring until the first real chunk arrives to keep the full lead even if the pipeline needs time to warm up.
      this.playStartUs = null;
      this.wallClockAnchorUs = null;
      this.nextFrameTimestampUs = null;
      this.lastChunkWallUs = null;
      this.bufferedChunks = [];
      this.bufferedBytes = 0;
      this.activeCodecHeader = null;

      let chunkCount = 0;
      let modeledTimelineUs = 0; // Sum of durations we think we sent (for drift visibility).
      let codecHeaderSent = false;
      let streamStartSent = false;
      const isFlac = chosenFormat.codec === AudioCodec.FLAC;
      let flacHeaderBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      const bytesPerSample = (pcmBitDepth / 8) * channels;
      const isPcm = chosenFormat.codec === AudioCodec.PCM;
      const frameSamples = Math.max(1, Math.floor(sampleRate * 0.025));
      const frameBytes = frameSamples * bytesPerSample;
      let pcmFrameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      // Splits ffmpeg's byte chunks back into individual FLAC frames so each
      // binary message carries exactly one, as the protocol describes.
      const flacSplitter = new FlacFrameSplitter();
      let flacBlocksizeSamples = 0;
      let lastSendWallUs: number | null = null;
      let jitterSumUs = 0;
      let jitterMaxUs = 0;
      let jitterSamples = 0;
      let waitLeadUs = 0;
      let waitCapacityUs = 0;
      const parseFlacBlocksize = (headerBuf: Buffer): number => {
        // STREAMINFO: min blocksize @8-9, max blocksize @10-11 (big-endian)
        try {
          const minBs = headerBuf.readUInt16BE(8);
          const maxBs = headerBuf.readUInt16BE(10);
          const bs = maxBs || minBs || 0;
          return bs;
        } catch {
          return 0;
        }
      };
      const extractCompleteFlacHeader = (
        source: Buffer,
      ): { header: Buffer<ArrayBufferLike> | null; remainder: Buffer<ArrayBufferLike> } => {
        if (source.length < 4) {
          return { header: null, remainder: source };
        }
        if (source.subarray(0, 4).toString('ascii') !== 'fLaC') {
          return { header: null, remainder: source };
        }
        let offset = 4;
        while (true) {
          if (source.length < offset + 4) {
            return { header: null, remainder: source };
          }
          const blockHeader = source[offset]!;
          const isLast = (blockHeader & 0x80) !== 0;
          const blockLength =
            (source[offset + 1]! << 16) | (source[offset + 2]! << 8) | source[offset + 3]!;
          const nextOffset = offset + 4 + blockLength;
          if (source.length < nextOffset) {
            return { header: null, remainder: source };
          }
          offset = nextOffset;
          if (isLast) {
            return {
              header: source.subarray(0, offset),
              remainder: source.subarray(offset),
            };
          }
        }
      };
      // FLAC: we encode with `-frame_size 512`, so start from that rather than
      // libFLAC's 4096 default — an 8x-too-long frame duration would skew the
      // modelled timeline until STREAMINFO is parsed and the real blocksize known.
      let encodedFrameDurationUs =
        chosenFormat.codec === AudioCodec.OPUS
          ? Math.floor(1_000_000 / 50) // 20 ms frames
          : chosenFormat.codec === AudioCodec.FLAC
            ? Math.floor((512 * 1_000_000) / sampleRate)
            : 0;
      const overbufferMarginUs = this.leadMarginUs; // keep lead tight around target
      const prepareBufferMarginUs = Math.max(500_000, Math.min(2_500_000, this.targetLeadUs));
      const sendTransmissionMarginUs = 100_000; // align with MA send margin (network + client processing)
      const targetBufferUs = this.targetLeadUs;
      this.primary.beginStream(
        sendspinCore.getPlayerBufferCapacity(this.activeClientId()) || this.maxBufferedBytes || 0,
      );

      const shiftTimeline = (deltaUs: number): void => {
        if (this.playStartUs !== null) {
          this.playStartUs += deltaUs;
        }
        if (this.nextFrameTimestampUs !== null) {
          this.nextFrameTimestampUs += deltaUs;
        }
        this.bufferedChunks = this.bufferedChunks.map((f) => ({
          data: f.data,
          timestampUs: f.timestampUs + deltaUs,
        }));
        this.primary.shiftCapacity(deltaUs);
      };

      const computeAdjustForStale = (tsUs: number, durationUs: number): number => {
        const nowUs = serverNowUs();
        const headroomShortfallUs = nowUs + prepareBufferMarginUs - tsUs;
        const currentBufferEndUs = this.nextFrameTimestampUs ?? tsUs + durationUs;
        const currentBufferUs = Math.max(0, currentBufferEndUs - nowUs);
        const bufferShortfallUs = targetBufferUs - currentBufferUs;
        return bufferShortfallUs > 0
          ? Math.max(headroomShortfallUs, bufferShortfallUs)
          : headroomShortfallUs;
      };

      const waitUntilLeadInRange = async (tsUs: number): Promise<void> => {
        // Match MA behaviour: do not advance timestamps; simply backpressure the source
        // so the effective lead cannot grow beyond targetLead + margin.
        while (tsUs - serverNowUs() > this.targetLeadUs + overbufferMarginUs) {
          const deltaUs = tsUs - serverNowUs() - this.targetLeadUs;
          const waitMs = Math.max(5, Math.min(200, Math.floor(deltaUs / 1000)));
          if (this.targetLeadUs > 2_000_000) {
            pcmStream.pause();
          }
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          if (this.targetLeadUs > 2_000_000) {
            pcmStream.resume();
          }
        }
      };

      const emitFrame = (frameTsUs: number, frameData: Buffer, durationUs: number): void => {
        // pause() can race an in-flight lead/capacity wait. Do not let the frame that was
        // waiting at that moment become the small audible burst after the pause command.
        if (token !== this.streamToken || this.paused) {
          return;
        }
        const canSendToClient = this.isOwner() && this.clientConnected && !this.externalSourceActive;
        if (!this.firstFrameLogged && canSendToClient) {
          this.firstFrameLogged = true;
          const now = Date.now();
          this.log.info('Sendspin first audio frame sent', {
            zoneId: this.zoneId,
            clientId: this.clientId,
            sincePlayMs: this.lastPlayRequestAtMs ? now - this.lastPlayRequestAtMs : null,
            sinceStreamStartMs: this.lastStreamStartSentAtMs ? now - this.lastStreamStartSentAtMs : null,
          });
        }
        if (lastSendWallUs !== null) {
          const nowUs = serverNowUs();
          const intervalUs = nowUs - lastSendWallUs;
          const expectedUs = durationUs;
          const deltaUs = Math.abs(intervalUs - expectedUs);
          jitterSumUs += deltaUs;
          jitterMaxUs = Math.max(jitterMaxUs, deltaUs);
          jitterSamples += 1;
        }
        lastSendWallUs = serverNowUs();
        // Feed the shared analyzer from the same scheduled PCM frame so
        // visualizer events carry the exact timestamp of the audio on wire.
        // The public API can subscribe to this timeline even when the Sendspin client did not
        // negotiate visualizer@v1 (the web player currently does not). The central analyzer is
        // therefore independent from the optional Sendspin visualizer role.
        if (isPcm && canSendToClient) {
          this.ports.audioAnalysis.push(this.zoneId, frameData, frameTsUs, 'scheduled-output');
        }
        const targetLeadUs = this.targetLeadUs;
        const lead = frameTsUs - serverNowUs();
        const frame = { data: frameData, timestampUs: frameTsUs };
        this.primary.deliverFrame(frame, durationUs, {
          canSend: canSendToClient,
          leadUs: lead,
          targetLeadUs,
          bufferedBytes: this.bufferedBytes,
        });
        this.ports.sendspinGroup.broadcastFrame(this.zoneId, frame);
        this.forEachConnectedSatellite((satellite) =>
          satellite.deliverFrame(frame, durationUs, {
            canSend: true,
            leadUs: lead,
            targetLeadUs,
            bufferedBytes: this.bufferedBytes,
          }),
        );

        this.bufferedChunks.push(frame);
        this.bufferedBytes += frameData.length;
        const maxBuffered = this.maxBufferedBytes;
        while (maxBuffered > 0 && this.bufferedBytes > maxBuffered && this.bufferedChunks.length > 0) {
          const removed = this.bufferedChunks.shift();
          if (removed) {
            this.bufferedBytes -= removed.data.length;
          }
        }

        chunkCount += 1;
        // Every frame, not every hundredth: this is what `getSyncStatus` reports, and a reader
        // asking "is it in sync right now" must not be answered with a number from 2 seconds ago.
        /*
         * Track how far the lead *wanders*, not how irregular the sends are.
         *
         * The send loop bursts frames until the lead fills its band and then sleeps up to 200 ms on
         * purpose, so the interval between sends deviates by more than 100 ms as a matter of design
         * — reporting that as "jitter" said "your audio is unsteady" about a sender working exactly
         * as intended. What a reader actually wants to know is whether the lead is being held: it
         * measured a 6 ms spread over 12 s on a healthy stream, and a sender falling behind widens
         * that immediately.
         */
        const leadNowUs = frameTsUs - serverNowUs();
        const previous = this.streamTiming;
        const driftUs =
          this.playStartUs !== null ? frameTsUs - this.playStartUs - modeledTimelineUs : null;
        /*
         * A rolling window, and what comes out of it is the *floor*.
         *
         * The lead sweeps its whole band by design — the loop bursts until it reaches the top, then
         * waits — so the widest-minus-narrowest spread is just the band width and says nothing. The
         * lowest lead does say something: while it stays at or above the target the client never runs
         * out of audio. A window rather than the whole stream, so the number answers "is it holding
         * now" instead of reporting the start-up ramp forever; the last completed window is reported,
         * so the value does not depend on how far into one a reader happens to look.
         */
        if (!previous || frameTsUs - previous.windowStartTsUs >= LEAD_WINDOW_US) {
          this.streamTiming = {
            leadUs: leadNowUs,
            windowStartTsUs: frameTsUs,
            windowMinUs: leadNowUs,
            windowMaxUs: leadNowUs,
            floorUs: previous ? previous.windowMinUs : null,
            driftUs,
          };
        } else {
          this.streamTiming = {
            leadUs: leadNowUs,
            windowStartTsUs: previous.windowStartTsUs,
            windowMinUs: Math.min(previous.windowMinUs, leadNowUs),
            windowMaxUs: Math.max(previous.windowMaxUs, leadNowUs),
            floorUs: previous.floorUs,
            driftUs,
          };
        }
        if (chunkCount <= 3 || chunkCount % 100 === 0) {
          const avgJitterUs = jitterSamples ? Math.round(jitterSumUs / jitterSamples) : 0;
          const leadNow = frameTsUs - serverNowUs();
          const logPayload: Record<string, number | string | null> = {
            zoneId: this.zoneId,
            chunkCount,
            tsUs: frameTsUs,
            leadUs: leadNow,
            playStartUs: this.playStartUs,
            modeledDriftUs:
              this.playStartUs !== null ? frameTsUs - this.playStartUs - modeledTimelineUs : null,
            leadErrorUs: leadNow - this.targetLeadUs,
            jitterAvgUs: avgJitterUs,
            jitterMaxUs,
            waitLeadUs,
            waitCapacityUs,
          };
          if (isPcm) {
            logPayload.frames = Math.floor(frameData.length / bytesPerSample);
            logPayload.durationUs = Math.floor((logPayload.frames as number * 1_000_000) / sampleRate);
            logPayload.sampleRate = sampleRate;
          }
          this.log.spam('Sendspin frame ts', logPayload);
        }
      };

      const ensureStreamStart = (codecHeader?: string): void => {
        if (streamStartSent) {
          return;
        }
        const streamParams = {
          codec: chosenFormat.codec,
          sampleRate,
          channels,
          bitDepth: pcmBitDepth,
          ...(codecHeader ? { codecHeader } : {}),
        };
        if (!this.externalSourceActive) {
          this.primary.sendStreamStart(streamParams);
        }
        this.ports.sendspinGroup.notifyStreamStart(this.zoneId, streamParams);
        this.forEachConnectedSatellite((satellite) => satellite.sendStreamStart(streamParams));
        streamStartSent = true;
        this.lastStreamStartSentAtMs = Date.now();
      };

      const sendScheduledFrame = async (
        frameData: Buffer<ArrayBufferLike>,
        durationUs: number,
        options: { skipLeadGate?: boolean } = {},
      ): Promise<void> => {
        if (token !== this.streamToken || this.paused) {
          return;
        }
        if (this.nextFrameTimestampUs === null) {
          this.playStartUs = serverNowUs() + this.anchorLeadUs;
          this.nextFrameTimestampUs = this.playStartUs;
          this.wallClockAnchorUs = serverNowUs();
          this.log.debug('Sendspin anchor set', {
            zoneId: this.zoneId,
            leadMs: Math.round(this.anchorLeadUs / 1000),
            sampleRate,
          });
        }
        let timestampUs = this.nextFrameTimestampUs;

        if (timestampUs < serverNowUs() + sendTransmissionMarginUs) {
          const adjustUs = computeAdjustForStale(timestampUs, durationUs);
          if (adjustUs > 0) {
            this.log.info('Sendspin timeline adjusted to avoid stale send', {
              zoneId: this.zoneId,
              adjustMs: Math.round(adjustUs / 1000),
            });
            shiftTimeline(adjustUs);
            timestampUs += adjustUs;
          }
        }
        if (!options.skipLeadGate) {
          const before = serverNowUs();
          await waitUntilLeadInRange(timestampUs);
          waitLeadUs += Math.max(0, serverNowUs() - before);
        }
        if (token !== this.streamToken || this.paused) {
          return;
        }
        const capBefore = serverNowUs();
        await this.primary.waitForCapacity(frameData.length);
        waitCapacityUs += Math.max(0, serverNowUs() - capBefore);
        if (token !== this.streamToken || this.paused) {
          return;
        }
        // Only consume the audio timeline once the frame is actually going to be sent.
        // A pause may win during either async wait above; reserving it earlier creates a
        // gap when the existing stream resumes.
        this.nextFrameTimestampUs = timestampUs + durationUs;
        modeledTimelineUs += durationUs;
        ensureStreamStart();
        emitFrame(timestampUs, frameData, durationUs);
      };

      const processFrame = async (frameData: Buffer<ArrayBufferLike>, durationUs: number): Promise<void> => {
        if (token !== this.streamToken) {
          return;
        }
        await sendScheduledFrame(frameData, durationUs);
      };

      const sendPcmFrame = async (
        frameData: Buffer<ArrayBufferLike>,
        samplesInFrame: number,
      ): Promise<void> => {
        const durationUs = Math.floor((samplesInFrame * 1_000_000) / sampleRate);
        await processFrame(frameData, durationUs);
      };

      const sendLiveChunk = async (chunk: Buffer) => {
        if (token !== this.streamToken) {
          return;
        }
        let payload = chunk;
        const nowUs = serverNowUs();
        if (this.wallClockAnchorUs === null) {
          this.wallClockAnchorUs = nowUs;
        }

        if (isPcm) {
          if (this.pcmRemainder?.length) {
            payload = Buffer.concat([this.pcmRemainder, payload]);
            this.pcmRemainder = null;
          }
          const remainder = payload.length % bytesPerSample;
          if (remainder > 0) {
            this.pcmRemainder = payload.subarray(payload.length - remainder);
            payload = payload.subarray(0, payload.length - remainder);
          }
          if (payload.length === 0) {
            return;
          }
          pcmFrameBuffer = pcmFrameBuffer.length
            ? (Buffer.concat([pcmFrameBuffer, payload]) as Buffer<ArrayBufferLike>)
            : payload;
          while (pcmFrameBuffer.length >= frameBytes) {
            const frame = pcmFrameBuffer.subarray(0, frameBytes);
            pcmFrameBuffer = pcmFrameBuffer.subarray(frameBytes);
            await sendPcmFrame(frame, frameSamples);
          }
          return;
        } else {
          if (this.lastChunkWallUs === null) {
            this.lastChunkWallUs = nowUs;
          }
          const wallElapsedUs = Math.max(0, nowUs - this.lastChunkWallUs);
          const appliedDurationUs =
            encodedFrameDurationUs || wallElapsedUs || Math.floor(1_000_000 / 50);
          this.lastChunkWallUs = nowUs;
          const durationUs:number = appliedDurationUs;
          if (!codecHeaderSent && payload.length) {
            if (isFlac) {
              flacHeaderBuffer = flacHeaderBuffer.length
                ? (Buffer.concat([flacHeaderBuffer, payload]) as Buffer<ArrayBufferLike>)
                : payload;
              const extracted = extractCompleteFlacHeader(flacHeaderBuffer);
              if (!extracted.header) {
                if (flacHeaderBuffer.length >= 4 && flacHeaderBuffer.subarray(0, 4).toString('ascii') !== 'fLaC') {
                  // Unexpected FLAC stream framing; fallback to first packet behavior instead of stalling.
                  const codecHeader = payload.toString('base64');
                  this.activeCodecHeader = codecHeader;
                  ensureStreamStart(codecHeader);
                  codecHeaderSent = true;
                }
                return;
              }
              const codecHeader = extracted.header.toString('base64');
              this.activeCodecHeader = codecHeader;
              const bs = parseFlacBlocksize(extracted.header);
              if (bs > 0) {
                flacBlocksizeSamples = bs;
                encodedFrameDurationUs = Math.floor((flacBlocksizeSamples * 1_000_000) / sampleRate);
              }
              ensureStreamStart(codecHeader);
              codecHeaderSent = true;
              flacHeaderBuffer = Buffer.alloc(0);
              payload = extracted.remainder;
              if (!payload.length) {
                return;
              }
            } else {
              const codecHeader = payload.toString('base64');
              this.activeCodecHeader = codecHeader;
              ensureStreamStart(codecHeader);
              codecHeaderSent = true;
            }
          }
          if (isFlac) {
            // One binary message must carry exactly one FLAC frame. ffmpeg hands us
            // arbitrary chunks (32 KB+ = a dozen frames or more), and libavcodec
            // clients decode only the first frame of a packet and discard the rest
            // — losing audio until the decoder resynchronises. The effect scales
            // with sample rate, since a fixed blocksize packs twice as many frames
            // into a 96 kHz chunk as a 48 kHz one.
            for (const frame of flacSplitter.push(payload)) {
              // Duration is per *frame* (blocksize/rate), not per chunk, or the
              // modelled timeline would run ahead by the frames-per-chunk factor.
              await processFrame(frame, encodedFrameDurationUs || durationUs);
            }
            return;
          }
          await processFrame(payload, durationUs);
        }
      };

      // Stream PCM with pull-based backpressure: wait for each chunk to be sent before reading more.
      const streamRef = pcmStream;
      const localToken = token;
      const consumeStream = async (): Promise<void> => {
        try {
          for await (const chunk of pcmStream) {
            if (localToken !== this.streamToken || streamRef !== this.currentStream) {
              return;
            }
            while (this.paused && localToken === this.streamToken && streamRef === this.currentStream) {
              if (!this.resumeGate) {
                this.resumeGate = new Promise<void>((resolve) => {
                  this.resumeGateResolve = resolve;
                });
              }
              await this.resumeGate;
            }
            if (!chunk?.length) {
              continue;
            }
            await sendLiveChunk(chunk as Buffer);
          }
          if (localToken !== this.streamToken || streamRef !== this.currentStream) {
            return;
          }
          // A FLAC frame's length is only known once the next frame's header
          // appears, so the final frame is still held back here.
          if (isFlac) {
            for (const frame of flacSplitter.flush()) {
              await processFrame(frame, encodedFrameDurationUs || 0);
            }
          }
          this.log.debug('Sendspin stream closed', { zoneId: this.zoneId });
          this.teardown();
          this.scheduleRestart();
        } catch (error) {
          if (localToken !== this.streamToken || streamRef !== this.currentStream) {
            return;
          }
          this.log.warn('Sendspin stream error', {
            zoneId: this.zoneId,
            message: (error as Error).message,
          });
          this.teardown();
          this.scheduleRestart();
        }
      };
      void consumeStream();


      this.log.info('Sendspin stream started', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        sampleRate,
        channels,
        bitDepth: pcmBitDepth,
        sincePlayMs: this.lastPlayRequestAtMs ? Date.now() - this.lastPlayRequestAtMs : null,
      });

      this.lastStreamSignature = streamSignature;
      this.activeOutputFormat = {
        codec: chosenFormat.codec,
        sampleRate,
        channels,
        bitDepth: pcmBitDepth,
      };

      this.setupVisualizer(isPcm, sampleRate, channels, pcmBitDepth);

      // Reaffirm playback state to the client when (re)starting a stream.
      this.pushPlaybackState(this.playbackState);
      this.sendCurrentSnapshot();

      this.currentStream = pcmStream;
    } finally {
      this.streamStarting = false;
    }
  }

  private teardown(options: { preserveAnchor?: boolean; invalidateToken?: boolean } = {}): void {
    const preserveAnchor = options.preserveAnchor === true;
    if (options.invalidateToken !== false) {
      this.streamToken += 1;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.bufferedChunks = [];
    this.bufferedBytes = 0;
    this.maxBufferedBytes = audioOutputSettings.prebufferBytes;
    this.activeOutputFormat = null;
    this.activeCodecHeader = null;
    // No stream, no timing: the alternative is reporting the last frame of a finished stream as
    // if it were the current state of one.
    this.streamTiming = null;
    this.unsubscribeAnalysis?.();
    this.unsubscribeAnalysis = null;
    if (!preserveAnchor) {
      this.playStartUs = null;
      this.wallClockAnchorUs = null;
      this.nextFrameTimestampUs = null;
      this.lastChunkWallUs = null;
      this.lastMetadataSignature = null;
      this.currentCoverUrl = null;
    }
    if (this.currentStream) {
      this.currentStream.removeAllListeners();
      const destroyable = this.currentStream as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      this.currentStream = null;
    }
    if (this.resumeGateResolve) {
      this.resumeGateResolve();
    }
    this.paused = false;
    this.resumeGateResolve = null;
    this.resumeGate = null;
    this.stopProgressUpdates();
    // Notify client to clear/end only when we are really stopping; skip during keep-alive restarts.
    if (!preserveAnchor) {
      this.primary.endStream();
      this.ports.sendspinGroup.notifyStreamEnd(this.zoneId);
      this.forEachConnectedSatellite((satellite) => satellite.endStream());
      this.lastStreamSignature = null;
    }
  }

  /**
   * Rebuild the leader's live stream for the group it now drives, before members are fed.
   *
   * A solo stream is negotiated for exactly one client, and members get it verbatim, so two
   * things can be wrong with it the moment a group forms: the codec (an OPUS/FLAC stream a
   * PCM-only member cannot decode) and the rate — including the source's own native rate,
   * which this zone is free to follow while it plays alone but a member may never have
   * declared. Restarting settles both, because the choice is made again in `startStream`
   * with the group in place.
   *
   * No-op if not the playing owner, not a group leader, or the live format already suits
   * every member. Called by the group controller on membership changes.
   */
  public async ensureGroupFormat(): Promise<void> {
    if (!this.isOwner() || !this.clientConnected || this.playbackState !== 'playing') {
      return;
    }
    if (!this.isGroupLeaderWithMembers()) {
      return;
    }
    const active = this.activeOutputFormat;
    if (active && active.codec === AudioCodec.PCM && this.groupMembersAccept(active)) {
      return;
    }
    await this.startStream({ preserveAnchor: false });
  }

  public async reanchorForGroup(): Promise<void> {
    // Hard restart stream with fresh anchor so grouped members can align to leader.
    this.teardown({ preserveAnchor: false });
    const session = this.ports.audioManager.getSession(this.zoneId);
    if (session?.playbackSource && this.playbackState === 'playing') {
      await this.startStream({ preserveAnchor: false });
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) {
      return;
    }
    if (this.playbackState !== 'playing') {
      return;
    }
    const session = this.ports.audioManager.getSession(this.zoneId);
    if (!session?.playbackSource) {
      return;
    }
    const source = session.playbackSource;
    if (source.kind !== 'pipe' && source.kind !== 'url') {
      return;
    }
    if (source.kind === 'url' && source.restartOnFailure !== true) {
      return;
    }
    // Avoid rapid restart loops if the source keeps closing.
    const now = Date.now();
    if (now - this.lastRestartMs < 3000) {
      return;
    }
    this.lastRestartMs = now;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.startStream({ preserveAnchor: true });
    }, 500);
  }

  private sendMetadata(session: PlaybackSession): void {
    const payload = this.buildMetadataPayload(session);
    if (!payload) {
      return;
    }
    this.log.spam('Sendspin metadata update', {
      zoneId: this.zoneId,
      clientId: this.clientId,
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
    });
    this.lastProgressPayload = payload.progress ?? null;
    sendspinCore.setClientMetadata(this.activeClientId(), payload);
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    this.ports.sendspinGroup.broadcastMetadata(this.zoneId, payload);
  }

  private sendControllerState(): void {
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const vol = typeof zoneState?.volume === 'number' ? zoneState.volume : this.lastKnownVolume;
    this.lastKnownVolume = vol;
    const supportedCommands: MediaCommand[] = [
      MediaCommand.PLAY,
      MediaCommand.PAUSE,
      MediaCommand.STOP,
      MediaCommand.NEXT,
      MediaCommand.PREVIOUS,
      MediaCommand.VOLUME,
      MediaCommand.MUTE,
      MediaCommand.SWITCH,
    ];
    // Repeat/shuffle only if zoneManager exposes those controls.
    if (typeof zoneState?.plrepeat === 'number') {
      supportedCommands.push(MediaCommand.REPEAT_OFF, MediaCommand.REPEAT_ONE, MediaCommand.REPEAT_ALL);
    }
    if (typeof zoneState?.plshuffle === 'number') {
      supportedCommands.push(MediaCommand.SHUFFLE, MediaCommand.UNSHUFFLE);
    }
    /*
     * Seek is only offered for a track with a known extent.
     *
     * A live stream has `duration` 0 or absent, and `seek_max_ms` is what tells the
     * client where the bar ends — offering `seek` without it would put a scrubber on
     * something that cannot be scrubbed.
     *
     * This says what the server can do, not what a given client can be told: a peer
     * whose library predates these two enum values would reject the whole
     * `server/state` over them, and node-sendspin filters that per connection on the
     * way out. Nothing to gate here.
     */
    const seekMaxMs = this.resolveSeekMaxMs(zoneState);
    if (seekMaxMs !== null) {
      supportedCommands.push(MediaCommand.SEEK, MediaCommand.SEEK_RELATIVE);
    }
    const controllerState: ControllerStatePayload = {
      supported_commands: supportedCommands,
      volume: vol,
      muted: false,
      repeat: resolveRepeatMode(zoneState?.plrepeat),
      shuffle: zoneState?.plshuffle === 1,
      ...(seekMaxMs !== null ? { seek_max_ms: seekMaxMs } : {}),
    };
    sendspinCore.setClientControllerState(this.activeClientId(), controllerState);
    this.ports.sendspinGroup.broadcastControllerState(this.zoneId, controllerState);
  }

  /** Track extent in ms for `seek_max_ms`, or null when nothing seekable is playing. */
  private resolveSeekMaxMs(zoneState: { duration?: number | null } | null | undefined): number | null {
    const session = this.ports.audioManager.getSession(this.zoneId);
    const durationSeconds = session?.metadata?.duration ?? zoneState?.duration ?? null;
    if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }
    return Math.round(durationSeconds * 1000);
  }

  private startProgressUpdates(): void {
    // Single-shot progress push; avoid per-second updates.
    this.sendProgressUpdate();
  }

  private stopProgressUpdates(): void {
    // No-op now that we do single-shot progress updates.
  }

  private sendProgressUpdate(): void {
    const session = this.ports.audioManager.getSession(this.zoneId);
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const now = Date.now();
    const baseElapsed =
      session && session.state === 'playing' && session.startedAt
        ? session.elapsed + (now - session.startedAt) / 1000
        : session?.elapsed ?? zoneState?.time ?? 0;
    const durationSec =
      session?.duration ??
      session?.metadata?.duration ??
      zoneState?.duration ??
      0;
    const coverUrl =
      session?.metadata?.coverurl ??
      session?.stream?.coverUrl ??
      zoneState?.coverurl ??
      null;

    const playbackSpeed = session?.state === 'playing' ? 1000 : 0;
    const payload = this.buildMetadataPayload(
      session,
      Math.max(0, Math.floor(baseElapsed * 1000)),
      Math.max(0, Math.floor(durationSec * 1000)),
      playbackSpeed,
    );
    const nextProgress = payload?.progress ?? null;
    const metadataSignature = payload ? this.buildMetadataSignature(payload) : null;
    const metadataChanged =
      !!metadataSignature && metadataSignature !== this.lastMetadataSignature;
    const normalizedCover = coverUrl ?? null;
    const coverChanged = normalizedCover !== this.currentCoverUrl;
    const progressChanged =
      !this.lastProgressPayload ||
      !nextProgress ||
      this.lastProgressPayload.track_progress !== nextProgress.track_progress ||
      this.lastProgressPayload.track_duration !== nextProgress.track_duration ||
      this.lastProgressPayload.playback_speed !== nextProgress.playback_speed;

    if (payload && (metadataChanged || coverChanged)) {
      this.lastProgressPayload = nextProgress;
      this.lastMetadataSignature = metadataSignature;
      this.currentCoverUrl = normalizedCover;
      sendspinCore.setClientMetadata(this.activeClientId(), payload);
      this.options.onMetadata?.(cloneMetadataPayload(payload));
      if (coverUrl && coverChanged) {
        void this.fetchAndSendArtwork({ metadata: session?.metadata, stream: session?.stream });
      }
    } else if (nextProgress && progressChanged) {
      this.lastProgressPayload = nextProgress;
      sendspinCore.setClientMetadata(this.activeClientId(), { progress: nextProgress });
      const progressPayload: SendspinMetadataPayload = { progress: nextProgress };
      this.options.onMetadata?.(cloneMetadataPayload(progressPayload));
    }
  }

  private sendStopMetadata(): void {
    const duration = this.lastProgressPayload?.track_duration ?? 0;
    const payload: SendspinMetadataPayload = {
      title: null,
      artist: null,
      album_artist: null,
      album: null,
      artwork_url: null,
      track: null,
      year: null,
      shuffle: null,
      repeat: null,
      progress: {
        track_progress: 0,
        track_duration: duration,
        playback_speed: 0,
      },
    };
    this.lastProgressPayload = payload.progress ?? null;
    this.lastMetadataSignature = this.buildMetadataSignature(payload);
    this.currentCoverUrl = null;
    sendspinCore.setClientMetadata(this.activeClientId(), payload);
    this.options.onMetadata?.(cloneMetadataPayload(payload));
    this.ports.sendspinGroup.broadcastMetadata(this.zoneId, payload);
  }

  private pushPlaybackState(state: 'playing' | 'paused' | 'stopped'): void {
    this.playbackState = state;
    if (this.lastSentPlaybackState === state) {
      return;
    }
    if (!this.isOwner()) {
      this.lastSentPlaybackState = state;
      return;
    }
    const { groupId, groupName } = this.getGroupInfo();
    const mappedState =
      state === 'playing'
        ? PlaybackStateType.PLAYING
        : state === 'paused'
          ? PlaybackStateType.PAUSED
          : PlaybackStateType.STOPPED;
    sendspinCore.setClientPlaybackState(this.activeClientId(), mappedState, groupId, groupName);
    this.ports.sendspinGroup.broadcastPlaybackState(this.zoneId, mappedState, groupId, groupName);
    this.lastSentPlaybackState = state;
  }

  private isOwner(): boolean {
    return sendspinClientOwners.get(this.clientId) === this.zoneId;
  }

  /**
   * Tell a client the zone's volume after refusing the one it reported.
   *
   * `onIdentified` normally does this, but it returns early when this output does not
   * own the client — and ownership is only claimed once a stream starts. So a client
   * connecting to an idle zone was told nothing and stayed at its own default, which
   * is 100 on the reference clients: the zone read 12 while the speaker was ready to
   * play at full volume.
   *
   * Unlike `setVolume` this is not gated on ownership, because it is a reply to the
   * client that just spoke rather than an unsolicited claim on it. It is still
   * withheld when a *different* zone owns the client, since that zone's volume is
   * the one that should reach it.
   */
  private assertZoneVolumeToClient(reportedVolume: number): void {
    const owner = sendspinClientOwners.get(this.clientId);
    if (typeof owner === 'number' && owner !== this.zoneId) {
      return;
    }
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const zoneVolume =
      typeof zoneState?.volume === 'number' ? zoneState.volume : this.lastKnownVolume;
    this.log.debug('Sendspin ignored the client opening volume', {
      zoneId: this.zoneId,
      clientId: this.clientId,
      clientVolume: reportedVolume,
      zoneVolume,
    });
    if (!this.activeSession) {
      return;
    }
    this.lastKnownVolume = zoneVolume;
    this.lastOutboundVolume = zoneVolume;
    this.lastOutboundVolumeAt = Date.now();
    this.activeSession.sendServerCommand(PlayerCommand.VOLUME, { volume: zoneVolume });
  }

  private claimOwnership(): void {
    const existing = sendspinClientOwners.get(this.clientId);
    if (existing === this.zoneId) {
      return;
    }
    if (typeof existing === 'number') {
      const prev = sendspinOutputsByZoneId.get(existing);
      // Best-effort: stop previous zone's stream to prevent racing commands.
      try {
        prev?.teardown({ preserveAnchor: false });
      } catch {
        /* ignore */
      }
    }
    sendspinClientOwners.set(this.clientId, this.zoneId);
  }

  private releaseOwnership(): void {
    if (sendspinClientOwners.get(this.clientId) === this.zoneId) {
      sendspinClientOwners.delete(this.clientId);
    }
  }

  private sendCurrentSnapshot(): void {
    // Push latest playback state + metadata to a newly connected client.
    this.pushPlaybackState(this.playbackState);
    const session = this.ports.audioManager.getSession(this.zoneId);
    const payload = this.buildMetadataPayload(session);
    if (payload) {
      this.lastMetadataSignature = this.buildMetadataSignature(payload);
      this.currentCoverUrl = payload.artwork_url ?? null;
      sendspinCore.setClientMetadata(this.activeClientId(), payload);
      this.options.onMetadata?.(cloneMetadataPayload(payload));
      if (payload.artwork_url) {
        void this.fetchAndSendArtwork(session ?? ({} as PlaybackSession));
      }
    }
    this.sendProgressUpdate();
  }

  private buildMetadataPayload(
    session: PlaybackSession | null,
    trackProgressMs?: number,
    trackDurationMs?: number,
    playbackSpeed?: number,
  ): SendspinMetadataPayload | null {
    const zoneState = this.ports.zoneManager.getZoneState(this.zoneId);
    const meta = session?.metadata;
    const title = meta?.title ?? zoneState?.title ?? this.zoneName ?? 'Sendspin';
    const artist = meta?.artist ?? zoneState?.artist ?? null;
    const albumArtist = (meta as { album_artist?: string | null } | undefined)?.album_artist ?? null;
    const album = meta?.album ?? zoneState?.album ?? null;
    const cover = meta?.coverurl ?? session?.stream?.coverUrl ?? zoneState?.coverurl ?? null;
    const durationMs =
      typeof trackDurationMs === 'number'
        ? trackDurationMs
        : meta?.duration != null
          ? meta.duration * 1000
          : zoneState?.duration != null
            ? zoneState.duration * 1000
            : null;
    const trackNumber =
      typeof meta?.trackId === 'number'
        ? meta.trackId
        : Number.isFinite(Number(meta?.trackId))
          ? Number(meta?.trackId)
          : null;
    const repeatMode = resolveRepeatMode(zoneState?.plrepeat);
    const shuffleMode: boolean | null =
      typeof zoneState?.plshuffle === 'number' ? zoneState.plshuffle === 1 : null;

    return {
      title,
      artist,
      album,
      artwork_url: cover,
      track: trackNumber,
      album_artist: albumArtist,
      year: typeof (meta as { year?: number } | undefined)?.year === 'number' ? (meta as { year?: number }).year! : null,
      shuffle: shuffleMode,
      repeat: repeatMode,
      progress: {
        track_progress: trackProgressMs ?? 0,
        track_duration: durationMs ?? 0,
        playback_speed: playbackSpeed ?? (this.playbackState === 'playing' ? 1000 : 0),
      },
    };
  }

  private buildMetadataSignature(payload: SendspinMetadataPayload): string {
    return JSON.stringify({
      title: payload.title ?? null,
      artist: payload.artist ?? null,
      album_artist: payload.album_artist ?? null,
      album: payload.album ?? null,
      year: payload.year ?? null,
      track: payload.track ?? null,
      artwork: payload.artwork_url ?? null,
    });
  }

  private buildStreamSignature(session: PlaybackSession | null, profile: 'pcm' | 'opus' | 'flac'): string {
    if (!session) {
      return 'none';
    }
    const source = session.playbackSource;
    const base =
      source?.kind === 'pipe'
        ? `pipe:${(source as { path?: string }).path ?? ''}`
        : source?.kind === 'file'
          ? `file:${(source as { path?: string }).path ?? ''}`
          : source?.kind === 'url'
            ? `url:${(source as { url?: string }).url ?? ''}`
            : session.source ?? 'unknown';
    const streamId = session.stream?.id ?? '';
    const pcmId = session.pcmStream?.id ?? '';
    return `${base}|${profile}|${streamId}|${pcmId}`;
  }

  /**
   * Stand up the visualizer@v1 DSP for this stream. Only runs for PCM output
   * (option A: tap the frames already flowing, no extra decode) and only for
   * the types the client negotiated that we can compute from the audio
   * (loudness, spectrum, f_peak, peak, pitch — beat has no source, so skipped).
   */
  private setupVisualizer(isPcm: boolean, sampleRate: number, channels: number, bitDepth: number): void {
    this.unsubscribeAnalysis?.();
    this.unsubscribeAnalysis = null;
    if (!isPcm) {
      return;
    }
    const clientId = this.activeClientId();
    const support = sendspinCore.getVisualizerSupport(clientId);
    if (!support) {
      return;
    }
    const wantLoudness = support.types.includes('loudness');
    const spectrumSupport = support.types.includes('spectrum') ? support.spectrum : undefined;
    const wantFpeak = support.types.includes('f_peak');
    const wantPeak = support.types.includes('peak');
    const wantPitch = support.types.includes('pitch');
    if (!wantLoudness && !spectrumSupport && !wantFpeak && !wantPeak && !wantPitch) {
      return;
    }
    const types: Array<'loudness' | 'spectrum' | 'f_peak' | 'peak' | 'pitch'> = [];
    if (wantLoudness) types.push('loudness');
    if (spectrumSupport) types.push('spectrum');
    if (wantFpeak) types.push('f_peak');
    if (wantPeak) types.push('peak');
    if (wantPitch) types.push('pitch');

    sendspinCore.sendVisualizerStreamStartV1(clientId, {
      types,
      rate_max: support.rate_max,
      spectrum: spectrumSupport,
    });

    this.unsubscribeAnalysis = this.ports.audioAnalysis.subscribe(this.zoneId, {
      sampleRate,
      channels,
      bitDepth,
      rateMax: support.rate_max,
      feed: 'scheduled-output',
      loudness: wantLoudness,
      fPeak: wantFpeak,
      peak: wantPeak,
      pitch: wantPitch,
      spectrum: spectrumSupport
        ? {
            n_disp_bins: spectrumSupport.n_disp_bins,
            scale: spectrumSupport.scale as 'lin' | 'log' | 'mel',
            f_min: spectrumSupport.f_min,
            f_max: spectrumSupport.f_max,
          }
        : undefined,
    }, (event) => {
      switch (event.type) {
        case 'loudness':
          sendspinCore.sendVisualizerLoudness(clientId, event.value, event.timestampUs);
          break;
        case 'spectrum':
          sendspinCore.sendVisualizerSpectrum(clientId, event.bins, event.timestampUs);
          break;
        case 'f_peak':
          sendspinCore.sendVisualizerFpeak(clientId, event.frequencyHz, event.amplitude, event.timestampUs);
          break;
        case 'peak':
          sendspinCore.sendVisualizerPeak(clientId, event.strength, event.timestampUs);
          break;
        case 'pitch':
          sendspinCore.sendVisualizerPitch(clientId, event.midiQ88, event.confidence, event.timestampUs);
          break;
      }
    });
    this.log.debug('Sendspin visualizer@v1 active', {
      zoneId: this.zoneId,
      clientId,
      types,
      rateMax: support.rate_max,
      bins: spectrumSupport?.n_disp_bins ?? 0,
    });
  }


  private async fetchAndSendArtwork(session?: { metadata?: PlaybackSession['metadata']; stream?: PlaybackSession['stream'] }): Promise<void> {
    const clientId = this.activeClientId();
    const preferredChannels: ArtworkChannel[] =
      sendspinCore.getArtworkChannels(clientId) ??
      [
        { source: 'album', format: 'jpeg', width: 800, height: 800 },
      ];
    // Clear every channel: stream/start re-arms the client's artwork stream, then a
    // header-only frame per channel collapses to "no image" on the receiver. The
    // color@v1 palette is derived from the same artwork, so clear it in lockstep
    // (no-op for clients that did not negotiate the color role). The zone's own
    // `artworkColors` is not touched here — it follows `coverurl` for every zone,
    // Sendspin or not, and clearing it from one client's stream would fight that.
    const clearAll = (): void => {
      sendspinCore.sendArtworkStreamStart(clientId, preferredChannels);
      preferredChannels.forEach((_channel, idx) => {
        sendspinCore.sendArtwork(clientId, idx as 0 | 1 | 2 | 3, null);
      });
      sendspinCore.sendColor(clientId, {
        background_dark: null,
        background_light: null,
        primary: null,
        accent: null,
        on_dark: null,
        on_light: null,
      });
    };
    try {
      const coverUrl =
        session?.metadata?.coverurl ??
        session?.stream?.coverUrl ??
        null;
      if (!coverUrl) {
        clearAll();
        return;
      }
      // The artwork@v1 spec has the server deliver each channel an image in the
      // requested format at the requested dimensions, not the raw origin bytes.
      // Decode once, then letterbox + re-encode per channel so clients (which only
      // decode known formats) always receive something they can render. The fetch
      // and decode are shared with the zone's palette, so the cover is downloaded
      // once no matter which of the two asks first.
      const artwork = await artworkService.getImage(coverUrl);
      if (!artwork) {
        clearAll();
        return;
      }
      const source = artwork.image;
      sendspinCore.sendArtworkStreamStart(clientId, preferredChannels);
      for (const [idx, channel] of preferredChannels.entries()) {
        if (channel.source === 'none') {
          sendspinCore.sendArtwork(clientId, idx as 0 | 1 | 2 | 3, null);
          continue;
        }
        const encoded = await this.encodeArtwork(source, channel);
        sendspinCore.sendArtwork(clientId, idx as 0 | 1 | 2 | 3, encoded);
      }
      // color@v1: push the palette derived from the same artwork so display
      // clients can theme their UI. No-op for clients without the color role.
      sendspinCore.sendColor(clientId, artwork.palette);
    } catch (error) {
      this.log.debug('Sendspin artwork fetch failed', {
        zoneId: this.zoneId,
        message: (error as Error).message,
      });
    }
  }

  /**
   * Letterbox + re-encode a decoded image to a single artwork channel's spec.
   * Mirrors the reference server's _letterbox_image / _process_and_encode_image:
   * scale to fit while preserving aspect ratio, center on a black canvas at the
   * requested dimensions, then encode to the requested format.
   */
  private async encodeArtwork(
    source: Awaited<ReturnType<typeof Jimp.read>>,
    channel: ArtworkChannel,
  ): Promise<Buffer> {
    const width = channel.width > 0 ? channel.width : source.width;
    const height = channel.height > 0 ? channel.height : source.height;
    const fitted = source.clone().scaleToFit({ w: width, h: height });
    const canvas = new Jimp({ width, height, color: 0x000000ff });
    const x = Math.floor((width - fitted.width) / 2);
    const y = Math.floor((height - fitted.height) / 2);
    canvas.composite(fitted, x, y);
    if (channel.format === 'png') {
      return canvas.getBuffer(JimpMime.png, { deflateLevel: 6 });
    }
    if (channel.format === 'bmp') {
      return canvas.getBuffer(JimpMime.bmp);
    }
    return canvas.getBuffer(JimpMime.jpeg, { quality: 85 });
  }

  /** Identifier of the configured Sendspin client. */
  public getClientId(): string {
    return this.activeClientId();
  }

  /** Configured satellite client IDs fed the same audio as the primary (empty if none). */
  public getSatelliteClientIds(): string[] {
    return this.satellites.map((satellite) => satellite.clientId);
  }

  /** Indicates whether the configured Sendspin client is currently connected. */
  public isClientConnected(): boolean {
    return this.clientConnected;
  }

  private activeClientId(): string {
    return this.primary.activeClientId();
  }

  /** True when this zone leads a group that has at least one other member.
   *  (`members` always includes the leader, so length > 1 means real members.) */
  private isGroupLeaderWithMembers(): boolean {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    return !!group && group.leader === this.zoneId && group.members.length > 1;
  }

  private getGroupInfo(): { groupId: string; groupName: string } {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (group) {
      const groupId = group.externalId ?? `group-${group.leader}`;
      const groupName =
        this.ports.zoneManager.getZoneState(group.leader)?.name ??
        this.ports.zoneManager.getZoneState(this.zoneId)?.name ??
        this.zoneName;
      return { groupId, groupName };
    }
    return { groupId: String(this.zoneId), groupName: this.zoneName };
  }

  private removeZoneFromGroup(): 'removed' | 'no_group' | 'leader' {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (!group) {
      return 'no_group';
    }
    if (group.leader === this.zoneId) {
      return 'leader';
    }
    const remainingMembers = group.members.filter((id) => id !== this.zoneId);
    this.ports.groupTracker.upsertGroup({
      leader: group.leader,
      members: remainingMembers,
      backend: group.backend,
      externalId: group.externalId,
      source: group.source,
    });
    return 'removed';
  }

  /**
   * Expose the buffered frames that are still in the future so new grouped members can
   * start with a shared timeline. Frames are already timestamped in server time.
   */
  public getFutureFrames(minFutureMs = 300): Array<{ data: Buffer; timestampUs: number }> {
    const nowUs = serverNowUs();
    const guardUs = Math.max(0, Math.floor(minFutureMs * 1000));
    return this.bufferedChunks
      .filter((f) => f.timestampUs > nowUs + guardUs)
      .map((f) => ({ data: f.data, timestampUs: f.timestampUs }));
  }

  /** Compute the requested rolling prebuffer based on target lead and format. */
  private computePrebufferBytes(format: SendspinFormat): number {
    const bytesPerSample = Math.max(1, Math.floor(format.bitDepth / 8));
    const leadSeconds = this.targetLeadUs / 1_000_000;
    const targetPrebufferBytes = Math.round(
      format.sampleRate * format.channels * bytesPerSample * (leadSeconds + 0.5),
    );
    return Math.min(Math.max(audioOutputSettings.prebufferBytes, targetPrebufferBytes), 2_000_000);
  }

  private normalizeBitDepth(bitDepth: number): PcmBitDepth {
    if (bitDepth === 24 || bitDepth === 32) {
      return bitDepth;
    }
    return 16;
  }

  /**
   * Aligns the session format with the source's native rate (and depth, when the
   * source declares one) so the audio reaches the player untouched by us.
   *
   * Every source kind wins, verified by measurement:
   *  - lossless (local FLAC/ALAC): matching rate *and* depth passes the original
   *    samples through unchanged — bit-identical to the file.
   *  - lossy (Apple Music AAC): resampling 44.1→48k and padding 16→24 bits alters
   *    every sample and inflates the stream ~2.7x for nothing. At the native rate
   *    we hand the provider's decode to the player exactly as delivered.
   *  - pipe (Spotify via Soloist, line-in, Bluetooth, AirPlay): raw PCM at a rate
   *    the producer already fixed. Whatever a pipe hands us is final, so a resample
   *    here is pure loss with nothing gained on either end.
   *
   * Deliberately conservative — it only ever moves to a format every client that will hear
   * this stream listed in its own `supported_formats`, and returns `format` untouched when:
   *  - the source format is unknown (no declaration, no probe),
   *  - the client never declared a matching entry,
   *  - the zone leads a group and a member never declared one either.
   *
   * That last case used to be "the zone leads a group", full stop, which is a rate rise the
   * ear pays for whenever the group could have taken the source as it is: two rooms that
   * both play 44.1 kHz untouched on their own were resampled to 48 kHz purely for being
   * grouped. One format for the whole group is the real constraint — that it be the
   * *leader's* negotiated one never was.
   */
  private async applyBitPerfectFormat(
    format: SendspinFormat,
    source: PlaybackSource,
  ): Promise<SendspinFormat> {
    const native = await this.probeSourceFormat(source);
    if (!native) {
      return format;
    }
    // For a lossy source there is no original depth to preserve, so keep whatever
    // depth was negotiated rather than inventing bits. Only the rate is aligned.
    const targetBitDepth =
      native.lossless && native.bitDepth !== null ? this.normalizeBitDepth(native.bitDepth) : format.bitDepth;
    if (
      native.sampleRate === format.sampleRate &&
      targetBitDepth === format.bitDepth &&
      native.channels === format.channels
    ) {
      return format;
    }
    const target: SendspinFormat = {
      ...format,
      sampleRate: native.sampleRate,
      channels: native.channels,
      bitDepth: targetBitDepth,
    };
    const declared = this.getDeclaredFormats();
    if (!declaresFormat(declared, target)) {
      this.log.debug('Sendspin native-format match skipped; client does not declare it', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        source: { sampleRate: native.sampleRate, bitDepth: targetBitDepth, channels: native.channels },
        declaredCount: declared.length,
      });
      return format;
    }
    // No leader-check needed: a zone that leads nobody has no member lists to fail.
    if (!this.groupMembersAccept(target)) {
      this.log.debug('Sendspin native-format match skipped; a grouped member does not declare it', {
        zoneId: this.zoneId,
        clientId: this.clientId,
        source: { sampleRate: native.sampleRate, bitDepth: targetBitDepth, channels: native.channels },
      });
      return format;
    }
    this.log.info('Sendspin matching source format to avoid resampling', {
      zoneId: this.zoneId,
      clientId: this.clientId,
      codecName: native.codecName,
      lossless: native.lossless,
      grouped: this.isGroupLeaderWithMembers(),
      from: { sampleRate: format.sampleRate, bitDepth: format.bitDepth },
      to: { sampleRate: native.sampleRate, bitDepth: targetBitDepth },
    });
    return target;
  }

  /** Whether every connected member of this zone's group declared the given format. */
  private groupMembersAccept(format: SendspinFormat): boolean {
    return allDeclareFormat(this.ports.sendspinGroup.getMemberDeclaredFormats(this.zoneId), format);
  }

  /**
   * The formats the connected client declared in client/hello, in its own priority
   * order, or an empty list when unavailable.
   *
   * `getPlayerSupportedFormats` was added to node-sendspin for this and is absent
   * from older published builds, so the lookup is duck-typed rather than relying on
   * the module's type surface. An empty list simply means we keep the negotiated
   * format instead of moving to the source's native one.
   *
   * Asked of the core by client id, exactly as `getProtocolCapabilities` does, and not of the
   * stored `activeSession`. Two ways to ask one question is one too many, and the stored field is
   * the unreliable one: it is filled by the identify hook and cleared on disconnect, so a client
   * this output adopted rather than shook hands with leaves it null — and a null one silently
   * answers "declares nothing", which reads as "cannot play the source's rate". The API kept
   * listing the formats all along, because it was already asking the other way.
   *
   * Public because a group leader asks its members for theirs: they are handed its stream
   * without a say, so their lists are part of the leader's choice.
   */
  public getDeclaredFormats(): ClientDeclaredFormat[] {
    const session = sendspinCore.getSessionByClientId(this.activeClientId()) as
      | { getPlayerSupportedFormats?: () => ClientDeclaredFormat[] }
      | null
      | undefined;
    if (typeof session?.getPlayerSupportedFormats !== 'function') {
      return [];
    }
    try {
      const formats = session.getPlayerSupportedFormats();
      return Array.isArray(formats) ? formats : [];
    } catch {
      return [];
    }
  }

  /**
   * Probes a playback source for its native format. URL sources need the same
   * headers/decryption key/input format that playback uses, or ffprobe cannot open
   * them (Apple Music segments are encrypted `mov` behind a local proxy).
   */
  private async probeSourceFormat(source: PlaybackSource): Promise<ProbedSourceFormat | null> {
    // A provider-declared format always wins: it costs nothing and is the only
    // safe option for URLs. Probing a stream URL would mean a second HTTP request,
    // which for DRM-protected or single-use segment URLs is wasteful at best and
    // can fail outright (an expired proxy session returns 404).
    if (source.kind === 'url') {
      const declared = source.nativeFormat;
      if (!declared) {
        return null;
      }
      return {
        sampleRate: declared.sampleRate,
        channels: declared.channels,
        bitDepth: declared.bitDepth ?? null,
        lossless: declared.lossless,
        codecName: declared.codecName ?? '',
      };
    }
    if (source.kind === 'file') {
      /*
       * The library already knows: it parsed every scanned file's format for its tags, and the audio
       * manager attaches it to the source (see `declareFileFormat`). Reading it here is free and, more
       * to the point, it works — the probe below shells out to `ffprobe`, and `ffmpeg-static` ships
       * ffmpeg *only*, so on any install without a system ffmpeg there is no ffprobe to run. Every
       * local file then came back "format unknown" and a 96 kHz/24-bit FLAC was resampled to whatever
       * the client had negotiated, silently, because a failed probe degrades to exactly that.
       *
       * The probe stays as the fallback for files the library never scanned — alert sounds, anything
       * outside a configured share — where there is nothing declared to read.
       */
      const declared = source.nativeFormat;
      if (declared) {
        return {
          sampleRate: declared.sampleRate,
          channels: declared.channels,
          bitDepth: declared.bitDepth ?? null,
          lossless: declared.lossless,
          codecName: declared.codecName ?? '',
        };
      }
      return probeFileFormat(source.path);
    }
    if (source.kind === 'pipe') {
      /*
       * A pipe declares its own format, and that declaration is worth exactly as much as any
       * probe: the engine hands the very same numbers to ffmpeg as `-f s24le -ar 44100 -ac 2`,
       * so a wrong one would already be audible as a pitch shift long before it reached here.
       *
       * This branch used to be "pipes declare their format; there is nothing to probe", which
       * read as done and behaved as unknown — the declaration was never read, so every pipe fell
       * through to "format unknown" and kept whatever the client had negotiated. Spotify through
       * Soloist is a 44.1 kHz/24-bit pipe and a client that asks for 48 kHz got the resampler on
       * an input that needed nothing, which is precisely what this function exists to prevent.
       *
       * `lossless` here is a claim about these samples, not about wherever they came from: raw
       * PCM in, so the declared depth is the real one and padding it wider adds no information.
       * For a 16-bit pipe that means the output drops to 16-bit — same samples, less wire.
       */
      if (!source.sampleRate || !source.channels || !source.format) {
        return null;
      }
      return {
        sampleRate: source.sampleRate,
        channels: source.channels,
        // What the samples carry outranks how wide the words are. A decoder that hands over float
        // says 32 by its container while the content is 24 at most, and a client that declares no
        // 32-bit format then fails this comparison on the depth — taking the sample rate down with
        // it, and putting a resampler in front of a stream that needed none.
        bitDepth: source.bitDepth ?? pcmBitDepthFromFormat(source.format),
        lossless: true,
        codecName: 'pcm',
      };
    }
    return null;
  }

  private normalizeFormat(format: Partial<PlayerFormat>): SendspinFormat {
    const sampleRate = Number.isFinite(format.sampleRate) ? format.sampleRate! : audioOutputSettings.sampleRate;
    const channels = Number.isFinite(format.channels) ? format.channels! : audioOutputSettings.channels;
    const bitDepth = this.normalizeBitDepth(
      Number.isFinite(format.bitDepth) ? (format.bitDepth as number) : audioOutputSettings.pcmBitDepth,
    );
    // Force PCM for Sendspin output stability.
    //
    // FLAC was tried and reverted after it proved audibly bad in practice. What we
    // know for certain:
    //  - The wire format we emit is correct: valid frames, one per binary message,
    //    STREAMINFO consistent with the frame headers, each frame decodable
    //    standalone. All verified byte-for-byte.
    //  - The client reported 81+ 'Invalid data found' errors from
    //    avcodec_send_packet(), i.e. essentially every packet failed to decode,
    //    while the same frames decoded cleanly in isolation.
    //  - Server-side send metrics are NOT meaningfully worse for FLAC than for
    //    PCM. Compared on live streams (FLAC 44.1 kHz vs PCM 192 kHz): both spend
    //    ~98% of wall-clock in waitUntilLeadInRange (that is real-time pacing, not
    //    overhead), both emit in ~2.7-frame bursts, and both hold a constant
    //    one-frame modelled drift with no accumulation.
    //
    // So the root cause was never established. It is not the framing and, on the
    // evidence, not the send scheduler either — it sits somewhere in the
    // client/decoder interaction that we could not reproduce outside sendspin.
    //
    // PCM costs bandwidth but is already uncompressed, so bit-perfect playback
    // (see applyBitPerfectFormat) does not need FLAC at all — FLAC only ever
    // bought bandwidth. Do not re-enable it without a reproducible explanation for
    // the decode failures. Note also that the visualizer taps PCM frames only
    // (see emitFrame), so FLAC silently disables it.
    const codec: AudioCodec = AudioCodec.PCM;
    return { codec, sampleRate, channels, bitDepth };
  }

  /**
   * How far ahead of the play clock frames are sent.
   *
   * 250 ms suits a dedicated receiver — a Pi on ethernet whose scheduler is predictable. A
   * browser tab is not that: measured against one, jitter reached 194 ms against a 246 ms
   * lead, leaving 52 ms of margin. One garbage collection or a scheduler hiccup past that and
   * the frame arrives too late to place, which is what a listener hears as a stutter.
   *
   * A browser therefore gets a second of lead. The cost is latency on a play or a seek, which
   * for local playback in a tab nobody is synchronising against is the cheaper of the two.
   *
   * Note this is not the same knob as the client's `latencyMs` static delay, which tells the
   * *client* to play later. That was already set to 1500 ms for browser zones with a comment
   * about giving the player a head start — but a client-side delay does nothing for a frame
   * the server sent too late to begin with.
   */
  private static resolveAnchorLeadUs(clientId: string): number {
    return resolveAnchorLeadMs(clientId) * 1000;
  }
}
