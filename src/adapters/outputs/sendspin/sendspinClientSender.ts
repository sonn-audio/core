import { createLogger } from '@/shared/logging/logger';
import {
  PlayerCommand,
  sendspinCore,
  type SendspinSession,
  type SendspinSessionHooks,
} from '@sonn-audio/node-sendspin';
import { ClientCapacityGate } from '@/adapters/outputs/sendspin/clientCapacityGate';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

const STREAM_PLAYER_ROLE = 'player';

type StreamStartParams = Parameters<typeof sendspinCore.sendStreamStart>[1];
type PcmFrame = { data: Buffer; timestampUs: number };

/** Zone-level hooks a listen-only satellite needs when it (re)connects mid-playback. */
export interface SatelliteHandlers {
  /** Whether the owning zone is actively playing right now. */
  isPlaying(): boolean;
  /** The current stream format to announce, or null when no stream is active. */
  currentStreamFormat(): StreamStartParams | null;
  /** Buffered frames still in the future, for a synced late join. */
  futureFrames(): PcmFrame[];
  /** The zone's current volume, pushed so the satellite joins at the right level. */
  currentVolume(): number;
  /** The satellite joined a running stream; start whatever else it asked for (visualizer@v1). */
  joined(): void;
  /** The satellite went away; stop producing anything for it. */
  left(): void;
}

/** Context for a single frame delivery, supplied by the per-zone pipeline. */
export interface FrameDeliveryContext {
  /** Whether this client should actually receive the frame (owner, connected, not external). */
  canSend: boolean;
  leadUs: number;
  targetLeadUs: number;
  bufferedBytes: number;
}

/**
 * Per-client Sendspin transport: identity, live connection, send-ahead capacity and the
 * per-client server commands (static delay).
 *
 * One instance represents exactly one Sendspin client. A zone's primary speaker — and, in
 * a later step, each satellite (subwoofer, visualizer) — gets its own sender so clients
 * connect, pace and (dis)connect independently; synchronisation is carried by the shared
 * frame timestamps, not by any per-client pacing. The playback timeline, rolling buffer and
 * zone-level orchestration stay in `SendspinOutput`; this owns only what is genuinely
 * per-client.
 */
export class SendspinClientSender {
  private readonly log = createLogger('Output', 'Sendspin');

  public readonly clientId: string;
  /** Real identity reported by the handshake once known, else the configured id. */
  public resolvedClientId: string;
  public session: SendspinSession | null = null;
  public connected = false;
  /** Configured client-side static playback delay (ms), pushed via `set_static_delay`. */
  public configuredLatencyMs: number;

  /** Per-client volume + inbound client-state echo bookkeeping. */
  public lastKnownVolume = 50;
  public lastOutboundVolume: number | null = null;
  public lastOutboundVolumeAt: number | null = null;
  public lastClientStateSignature: string | null = null;
  public initialClientStateSkipped = false;
  public lastLoggedClientState: string | null = null;
  public lastLoggedMuted: boolean | null = null;
  /**
   * The mute state we last acted on, so a client restating `muted` in every update
   * does not re-issue a zone command each time. Null until the client has reported
   * one, and reset with the rest of the per-session state on disconnect.
   */
  public lastAppliedMuted: boolean | null = null;

  /** Send-ahead capacity model for the in-flight stream; recreated on each (re)start. */
  private capacityGate: ClientCapacityGate | null = null;

  /** Disposers for satellite-mode connection watchers/hooks; empty for the primary. */
  private satelliteDisposers: Array<() => void> = [];

  constructor(
    clientId: string,
    configuredLatencyMs: number,
    private readonly zoneId: number,
  ) {
    this.clientId = clientId;
    this.resolvedClientId = clientId;
    this.configuredLatencyMs = configuredLatencyMs;
  }

  /** Resolved client id once the handshake reports its real identity, else the configured id. */
  public activeClientId(): string {
    return this.resolvedClientId || this.clientId;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Run this sender as a listen-only satellite: watch its client, track the live session, and
   * on (re)connect push the static delay and — if the zone is already playing — announce the
   * stream and replay the still-future buffered frames for a synced late join. The satellite
   * never feeds back transport/volume/group commands and never gates the zone's pacing.
   */
  public startSatellite(
    ports: OutputPorts,
    endpointUrl: string | undefined,
    handlers: SatelliteHandlers,
  ): void {
    const hooks: SendspinSessionHooks = {
      onIdentified: (session: SendspinSession) => {
        if (this.session === session) {
          return;
        }
        this.resolvedClientId = session.getClientId() ?? this.resolvedClientId;
        ports.sendspinConnector.markInboundConnected(this.activeClientId());
        this.session = session;
        this.connected = true;
        this.sendStaticDelay();
        this.pushVolume(handlers.currentVolume());
        if (handlers.isPlaying()) {
          const format = handlers.currentStreamFormat();
          if (format) {
            this.sendStreamStart(format);
            for (const frame of handlers.futureFrames()) {
              sendspinCore.sendPcmFrameToClient(this.activeClientId(), frame);
            }
            handlers.joined();
          }
        }
        this.log.info('Sendspin satellite connected', {
          zoneId: this.zoneId,
          clientId: this.activeClientId(),
        });
      },
      onDisconnected: (session: SendspinSession) => {
        if (this.session !== session) {
          return;
        }
        this.connected = false;
        this.session = null;
        handlers.left();
        ports.sendspinConnector.markInboundDisconnected(this.activeClientId());
        this.log.info('Sendspin satellite disconnected', {
          zoneId: this.zoneId,
          clientId: this.activeClientId(),
        });
      },
    };
    this.satelliteDisposers.push(ports.sendspinConnector.watchClient(this.clientId, endpointUrl));
    this.satelliteDisposers.push(ports.sendspinHooks.register(this.clientId, hooks));
    this.satelliteDisposers.push(
      ports.sendspinConnector.onClientResolved(this.clientId, (resolvedId) => {
        this.resolvedClientId = resolvedId;
        if (resolvedId !== this.clientId) {
          this.satelliteDisposers.push(ports.sendspinHooks.register(resolvedId, hooks));
        }
      }),
    );
  }

  /** Tear down satellite watchers/hooks. */
  public disposeSatellite(): void {
    for (const dispose of this.satelliteDisposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    this.satelliteDisposers = [];
    sendspinCore.clearLeadStats(this.activeClientId());
  }

  /** Push a volume level to this client (used to keep a satellite in step with the zone). */
  public pushVolume(level: number): void {
    this.lastKnownVolume = level;
    this.session?.sendServerCommand(PlayerCommand.VOLUME, { volume: level });
  }

  /** Hot-update this client's static delay (no stream restart) and push it to the live session. */
  public setLatencyMs(ms: number): void {
    if (ms === this.configuredLatencyMs) {
      return;
    }
    this.configuredLatencyMs = ms;
    this.sendStaticDelay();
  }

  /**
   * Push the configured client-side static delay to the connected client. Not gated by
   * ownership — the static delay is benign per-client config that should reflect the latest
   * configured value regardless of which zone currently "owns" the client.
   */
  public sendStaticDelay(): void {
    const session =
      this.session ?? sendspinCore.getSessionByClientId?.(this.activeClientId()) ?? null;
    if (!session) {
      this.log.debug('Sendspin set_static_delay skipped; no live session', {
        zoneId: this.zoneId,
        clientId: this.activeClientId(),
      });
      return;
    }
    session.sendServerCommand(PlayerCommand.SET_STATIC_DELAY, {
      static_delay_ms: this.configuredLatencyMs,
    });
    this.log.info('Sendspin set_static_delay sent', {
      zoneId: this.zoneId,
      clientId: this.activeClientId(),
      staticDelayMs: this.configuredLatencyMs,
    });
  }

  /** Begin a fresh stream: size the send-ahead capacity for this client. */
  public beginStream(capacityBytes: number): void {
    this.capacityGate = new ClientCapacityGate(capacityBytes);
  }

  /** Record an emitted frame against this client's in-flight capacity. */
  public registerCapacity(endUs: number, byteCount: number): void {
    this.capacityGate?.register(endUs, byteCount);
  }

  /** Block until `bytesNeeded` more bytes fit within this client's buffer capacity. */
  public async waitForCapacity(bytesNeeded: number): Promise<void> {
    if (this.capacityGate) {
      await this.capacityGate.waitForCapacity(bytesNeeded);
    }
  }

  /** Shift in-flight capacity bookkeeping when the playback timeline re-anchors. */
  public shiftCapacity(deltaUs: number): void {
    this.capacityGate?.shift(deltaUs);
  }

  /** Announce a (re)started stream to this client. */
  public sendStreamStart(format: StreamStartParams): void {
    sendspinCore.sendStreamStart(this.activeClientId(), format);
  }

  /** End and clear this client's player stream. */
  public endStream(): void {
    sendspinCore.sendStreamEnd(this.activeClientId());
    sendspinCore.sendStreamClear(this.activeClientId(), [STREAM_PLAYER_ROLE]);
  }

  /**
   * Deliver one timestamped frame: push it to the client when allowed, and always account
   * it against this client's send-ahead capacity. Synchronisation rides on the frame's
   * timestamp, so a non-owning/disconnected client simply skips the send while staying
   * capacity-consistent for when it resumes.
   */
  public deliverFrame(frame: PcmFrame, durationUs: number, ctx: FrameDeliveryContext): void {
    if (ctx.canSend) {
      sendspinCore.setLeadStats(this.activeClientId(), {
        leadUs: ctx.leadUs,
        targetLeadUs: ctx.targetLeadUs,
        bufferedBytes: ctx.bufferedBytes,
      });
      sendspinCore.sendPcmFrameToClient(this.activeClientId(), frame);
    }
    this.registerCapacity(frame.timestampUs + durationUs, frame.data.length);
  }
}
