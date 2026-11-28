import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSession } from '@/ports/types/playback';
import { pcmCodecFromBitDepth, audioOutputSettings } from '@/ports/types/audioFormat';
import { zoneSessionKey } from '@/ports/types/SessionKey';
import type { PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

export interface SnapcastOutputConfig {
  /** Optional list of client IDs that should be mapped to this stream. */
  clientIds?: string | string[];
  /**
   * Optional fixed output latency (ms). For Snapcast this maps to snapclient latency,
   * and will be applied to all configured clientIds.
   */
  latencyMs?: number;
}

export const SNAPCAST_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'snapcast',
  label: 'Snapcast',
  description: 'Built-in Snapcast-compatible WebSocket stream at /snapcast (same HTTP port).',
  fields: [
    {
      id: 'clientIds',
      label: 'Client ID',
      type: 'text',
      required: true,
      description: 'Snapclient Hello ID/MAC to map to this zone (comma-separated allowed for multiroom).',
    },
    {
      id: 'latencyMs',
      label: 'Latency (ms)',
      type: 'number',
      placeholder: '0',
      advanced: true,
      description: 'Overrides the delay snapclient applies on the configured clients.',
    },
  ],
};

export class SnapcastOutput implements ZoneOutput {
  public readonly type = 'snapcast';

  /** Grouped zones stay in step here: all member clients are mapped onto one stream. */
  public supportsNativeGrouping(): boolean {
    return true;
  }

  private readonly log = createLogger('Output', 'Snapcast');
  private currentStream: NodeJS.ReadableStream | null = null;
  // Bumped by every start and stop, so a start still waiting for its first audio knows it was
  // overtaken; see `startStream`.
  private streamGeneration = 0;
  private activeOutputSettings = audioOutputSettings;
  private readonly baseStreamId: string;
  private readonly baseClientIds: string[];
  private configuredLatencyMs: number | null;
  private effectiveStreamId: string;
  private effectiveClientIds: string[];

  constructor(
    private readonly zoneId: number,
    _zoneName: string,
    config: SnapcastOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.baseStreamId = String(zoneId);
    this.baseClientIds = Array.isArray(config.clientIds)
      ? config.clientIds.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
      : typeof config.clientIds === 'string'
        ? config.clientIds
            .split(',')
            .map((c: string) => c.trim())
            .filter(Boolean)
        : [];
    this.configuredLatencyMs = normalizeLatencyMs((config as { latencyMs?: number }).latencyMs);
    this.effectiveStreamId = this.baseStreamId;
    this.effectiveClientIds = [...this.baseClientIds];

    this.applyConfiguredLatency(this.baseClientIds);

    this.ports.snapcastGroup.register({
      zoneId,
      baseStreamId: this.baseStreamId,
      baseClientIds: this.baseClientIds,
      refresh: () => this.refreshGrouping(),
    });
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Snapcast output skipped; no playback source', { zoneId: this.zoneId });
      return;
    }
    await this.startStream(session);
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.stopStream();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.stopStream();
  }

  public setVolume(level: number): void {
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    const targetClientIds = this.baseClientIds.length > 0 ? this.baseClientIds : this.effectiveClientIds;
    if (targetClientIds.length === 0) {
      return;
    }
    this.ports.snapcastCore.setClientVolumes(targetClientIds, clamped);
  }

  public getPreferredOutput(): PreferredOutput {
    // Snapclient defaults: PCM, 48kHz/16-bit stereo.
    return { profile: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 };
  }

  public getLatencyMs(): number | null {
    const ids = this.baseClientIds.length > 0 ? this.baseClientIds : this.effectiveClientIds;
    if (ids.length === 0) {
      return this.configuredLatencyMs;
    }
    try {
      const clients = this.ports.snapcastCore.listClients();
      const byId = new Map(clients.map((client) => [client.clientId, client.latency]));
      const latencies = ids
        .map((id) => byId.get(id))
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (latencies.length === 0) {
        return this.configuredLatencyMs;
      }
      return latencies.reduce((max, value) => Math.max(max, value), 0);
    } catch {
      return this.configuredLatencyMs;
    }
  }

  public async dispose(): Promise<void> {
    this.stopStream();
    this.ports.snapcastGroup.unregister(this.zoneId);
  }

  /** Hot-update the snapclient latency; pushes the new value to the configured clients. */
  public setLatencyMs(ms: number): void {
    const normalized = normalizeLatencyMs(ms);
    if (normalized === this.configuredLatencyMs) {
      return;
    }
    this.configuredLatencyMs = normalized;
    const clientIds = this.baseClientIds.length > 0 ? this.baseClientIds : this.effectiveClientIds;
    this.applyConfiguredLatency(clientIds);
  }

  private async startStream(session: PlaybackSession | null): Promise<void> {
    this.stopStream();
    const generation = this.streamGeneration;
    const plan = this.ports.snapcastGroup.buildPlan(
      this.zoneId,
      this.baseStreamId,
      this.baseClientIds,
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    if (!plan.shouldPlay) {
      this.log.info('snapcast grouped member, skipping local stream', {
        zoneId: this.zoneId,
        leaderZoneId: plan.leaderZoneId,
      });
      return;
    }

    const pcmStream = this.ports.engine.createStream(zoneSessionKey(this.zoneId), 'pcm', {
      label: 'snapcast',
      primeWithBuffer: false,
    });
    if (!pcmStream) {
      this.log.warn('Snapcast stream unavailable (pcm profile missing)', { zoneId: this.zoneId });
      return;
    }
    // Snapcast timestamps audio against the server clock. If we register the stream before the first PCM
    // bytes exist, snapclient can briefly see "old" chunks and drop them. Waiting here keeps the initial
    // timeline aligned without delaying the main playback pipeline.
    const ready = await this.ports.engine.waitForFirstChunk(zoneSessionKey(this.zoneId), 'pcm', 1500);
    if (generation !== this.streamGeneration) {
      // A play and the resume right behind it both started a stream while neither had registered
      // one yet. Both then registered the zone's stream, the second replaced the first, and the
      // client was left with neither: Spotify Connect played with no sound (#457). Only the
      // latest start goes on.
      (pcmStream as { destroy?: () => void }).destroy?.();
      return;
    }
    if (!ready) {
      this.log.debug('Snapcast stream started without first chunk', { zoneId: this.zoneId });
    }
    const outputSettings = session?.outputSettings
      ? { ...audioOutputSettings, ...session.outputSettings }
      : audioOutputSettings;
    // Keep prebuffer moderate to reduce jitter while avoiding drift spikes.
    const prebufferMs = 250;
    const bytesPerSecond =
      outputSettings.sampleRate * outputSettings.channels * (outputSettings.pcmBitDepth / 8);
    const targetPrebufferBytes = Math.round((bytesPerSecond * prebufferMs) / 1000);
    // Snapcast already buffers on the client; keep our rolling prebuffer small to reduce latency.
    outputSettings.prebufferBytes = Math.max(8 * 1024, targetPrebufferBytes);
    this.activeOutputSettings = outputSettings;
    const codec = pcmCodecFromBitDepth(outputSettings.pcmBitDepth);
    this.log.debug('serving PCM to Snapclients (ws)', {
      zoneId: this.zoneId,
      codec,
      sampleRate: outputSettings.sampleRate,
      channels: outputSettings.channels,
      streamId: this.effectiveStreamId,
      clientIds: this.effectiveClientIds,
    });

    this.ports.snapcastCore.setStream(
      this.effectiveStreamId,
      this.zoneId,
      outputSettings,
      pcmStream,
      this.effectiveClientIds,
    );
    this.currentStream = pcmStream;
  }

  private stopStream(): void {
    this.streamGeneration += 1;
    this.ports.snapcastCore.clearStream(this.zoneId);
    if (this.currentStream) {
      const destroyable = this.currentStream as { destroy?: () => void };
      if (typeof destroyable.destroy === 'function') {
        destroyable.destroy();
      }
      this.currentStream = null;
    }
  }

  private refreshGrouping(): void {
    const plan = this.ports.snapcastGroup.buildPlan(
      this.zoneId,
      this.baseStreamId,
      this.baseClientIds,
    );
    this.effectiveStreamId = plan.streamId;
    this.effectiveClientIds = plan.clientIds;
    // Keep client mappings in sync even when this output is not actively streaming.
    for (const clientId of this.baseClientIds) {
      this.ports.snapcastCore.setClientStream(clientId, this.effectiveStreamId);
    }
    this.applyConfiguredLatency(this.effectiveClientIds);
    if (!this.currentStream) {
      return;
    }
    if (!plan.shouldPlay) {
      this.stopStream();
      return;
    }
    // Re-register stream with updated client mapping.
    if (this.currentStream) {
      this.ports.snapcastCore.setStream(
        this.effectiveStreamId,
        this.zoneId,
        this.activeOutputSettings,
        this.currentStream,
        this.effectiveClientIds,
      );
    }
  }

  private applyConfiguredLatency(clientIds: string[]): void {
    if (this.configuredLatencyMs === null) {
      return;
    }
    for (const clientId of clientIds) {
      if (!clientId) continue;
      this.ports.snapcastCore.setClientLatency(clientId, this.configuredLatencyMs);
    }
  }
}

function normalizeLatencyMs(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return null;
  // Snapcast latency cannot be negative; clamp to a sane range.
  return Math.max(0, Math.min(10_000, Math.round(num)));
}
