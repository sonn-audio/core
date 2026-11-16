import { createLogger } from '@/shared/logging/logger';
import { bestEffort, bestEffortSync } from '@/shared/bestEffort';
import type { ZoneConfig } from '@/domain/config/types';
import type { AirplayController } from '@/ports/InputsPort';
import { AirplayInstance } from '@/adapters/inputs/airplay/airplayInstance';
import type { ZonePlayer } from '@/ports/types/zonePlayer';
import type { PlayerRegistryPort } from '@/ports/PlayerRegistryPort';
import type { MdnsPort } from '@/ports/MdnsPort';

type SpotifySessionStopper = (zoneId: number, reason?: string) => void;

export class AirplayInputService {
  private readonly log = createLogger('Audio', 'AirPlayService');
  private readonly instances = new Map<number, AirplayInstance>();
  private controller: AirplayController | null = null;
  constructor(
    private readonly spotifySessionStopper: SpotifySessionStopper,
    private readonly playerRegistry: PlayerRegistryPort,
    private readonly mdns: MdnsPort,
  ) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => this.markAllInstancesStopping());
    }
  }

  public configure(controller: AirplayController): void {
    this.controller = controller;
  }

  public setPlayerResolver(_resolver: (zoneId: number) => ZonePlayer | null): void {
    // resolver currently unused; retained for compatibility with bootstrap wiring.
  }

  /** AirPlay is opt-in per player: a zone gets a receiver iff its own input is on. */
  public syncZones(zones: ZoneConfig[]): void {
    if (!this.controller) {
      this.log.debug('airplay controller not configured; skipping sync');
      return;
    }
    const desired = new Set<number>();
    for (const zone of zones) {
      const airplay = zone.inputs?.airplay;
      if (!airplay?.enabled) {
        this.removeInstance(zone.id);
        continue;
      }
      desired.add(zone.id);
      const existing = this.instances.get(zone.id);
      if (existing) {
        existing.updateConfig(airplay).catch((error) => {
          this.log.warn('failed to update airplay instance', {
            zoneId: zone.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        continue;
      }
      const instance = new AirplayInstance(
        zone.id,
        zone.name,
        zone.sourceMac,
        airplay,
        this.controller,
        this.playerRegistry,
        this.mdns,
      );
      this.instances.set(zone.id, instance);
      instance.start().catch((error) => {
        this.log.error('failed to start airplay instance', {
          zoneId: zone.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }

    for (const zoneId of this.instances.keys()) {
      if (!desired.has(zoneId)) {
        this.removeInstance(zoneId);
      }
    }
  }

  public async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.instances.values()).map((instance) =>
        // Best-effort stop; shutdown should continue even if a receiver fails to stop.
        bestEffort(() => instance.stop(), {
          fallback: undefined,
          onError: 'debug',
          log: this.log,
          label: 'airplay instance stop failed',
        }),
      ),
    );
    this.instances.clear();
  }

  public async renameZone(zoneId: number, name: string): Promise<void> {
    const instance = this.instances.get(zoneId);
    if (!instance) {
      return;
    }
    try {
      await instance.updateZoneName(name);
    } catch (error) {
      this.log.warn('failed to rename airplay instance', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public remoteControl(
    zoneId: number,
    command: 'Play' | 'Pause' | 'PlayPause' | 'Stop' | 'Next' | 'Previous' | 'ToggleMute',
  ): void {
    if (command === 'Play') {
      // Best-effort: switching inputs should not fail if Spotify stop throws.
      const stopSpotifySession = this.spotifySessionStopper;
      bestEffortSync(() => stopSpotifySession(zoneId, 'switch_to_airplay'), {
        fallback: undefined,
        onError: 'debug',
        log: this.log,
        label: 'spotify stop after airplay switch failed',
        context: { zoneId },
      });
    }
    const instance = this.instances.get(zoneId);
    instance?.sendRemoteCommand(command);
  }

  public remoteVolume(zoneId: number, volumePercent: number): void {
    const instance = this.instances.get(zoneId);
    instance?.setRemoteVolume(volumePercent);
  }

  /**
   * Force-stop any active AirPlay stream for a zone while keeping the receiver running.
   * Useful when switching inputs (e.g. to Spotify).
   */
  public stopActiveSession(zoneId: number, reason?: string): void {
    const instance = this.instances.get(zoneId);
    instance?.stopActiveSession(reason);
  }

  /** Reattach a zone's running AirPlay session to the zone; false when it has none. */
  public resumeSession(zoneId: number): boolean {
    return this.instances.get(zoneId)?.resumeSession() ?? false;
  }

  private removeInstance(zoneId: number): void {
    const existing = this.instances.get(zoneId);
    if (!existing) {
      return;
    }
    existing.stop().catch((error) => {
      this.log.warn('failed to stop airplay instance', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.instances.delete(zoneId);
  }

  private markAllInstancesStopping(): void {
    for (const instance of this.instances.values()) {
      instance.markStopping();
    }
  }
}
