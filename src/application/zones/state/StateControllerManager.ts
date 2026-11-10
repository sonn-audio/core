import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig } from '@/domain/config/types';
import type { ExternalTakeover, ZoneStateController } from '@/application/zones/state/StateController';
import type { ZoneState } from '@/domain/zones/zoneState';
import { InternalStateController } from '@/application/zones/state/InternalStateController';
import { BeoLinkStateController } from '@/application/zones/state/BeoLinkStateController';
import { SonosStateController } from '@/application/zones/state/SonosStateController';
import { MusicAssistantStateController } from '@/application/zones/state/MusicAssistantStateController';
import { resolveZoneStateControllerId } from '@/application/zones/state/authorityPolicies';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { QueueItem } from '@/ports/types/queueTypes';

type StateControllerManagerOptions = {
  onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
  onQueueMirror?: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  onExternalTakeover?: (zoneId: number, takeover: ExternalTakeover) => void;
  configPort: ConfigPort;
};

export class StateControllerManager {
  private readonly log = createLogger('Zones', 'StateControllers');
  private readonly controllers = new Map<number, ZoneStateController>();
  private readonly onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
  private readonly onQueueMirror?: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
  private readonly onExternalTakeover?: (zoneId: number, takeover: ExternalTakeover) => void;
  private readonly configPort: ConfigPort;

  constructor(options: StateControllerManagerOptions) {
    this.onStatePatch = options.onStatePatch;
    this.onQueueMirror = options.onQueueMirror;
    this.onExternalTakeover = options.onExternalTakeover;
    this.configPort = options.configPort;
  }

  public handleCommand(zoneId: number, command: string, payload?: string): boolean {
    const controller = this.controllers.get(zoneId);
    if (!controller?.handleCommand) {
      return false;
    }
    try {
      const result = controller.handleCommand(command, payload);
      if (typeof result === 'boolean') {
        return result;
      }
      void Promise.resolve(result).catch((err) => {
        this.log.warn('state controller command failed', {
          zoneId,
          command,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      // Async handlers return true to prevent duplicate internal handling.
      return true;
    } catch (err) {
      this.log.warn('state controller command dispatch failed', {
        zoneId,
        command,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  public async replaceAll(zones: ZoneConfig[]): Promise<void> {
    await this.stopAll();
    // Start zones in parallel. Each controller's start() already swallows its
    // own errors via startForZone, but allSettled is the explicit contract: a
    // single hanging zone (e.g. a Sonos speaker stuck in TLS handshake) must
    // not block any other zone's controller from coming online.
    await Promise.allSettled(zones.map((zone) => this.startForZone(zone)));
  }

  public async replaceZones(zones: ZoneConfig[]): Promise<void> {
    await Promise.allSettled(
      zones.map(async (zone) => {
        await this.stopForZone(zone.id);
        await this.startForZone(zone);
      }),
    );
  }

  public async stopForZone(zoneId: number): Promise<void> {
    const existing = this.controllers.get(zoneId);
    if (!existing) return;
    this.controllers.delete(zoneId);
    await this.stopControllerSafely(zoneId, existing);
  }

  public async stopAll(): Promise<void> {
    const entries = Array.from(this.controllers.entries());
    this.controllers.clear();
    await Promise.all(
      entries.map(async ([zoneId, controller]) => {
        await this.stopControllerSafely(zoneId, controller);
      }),
    );
  }

  private async stopControllerSafely(zoneId: number, controller: ZoneStateController): Promise<void> {
    try {
      await Promise.resolve(controller.stop());
    } catch (err) {
      this.log.warn('state controller stop failed', {
        zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async startForZone(zone: ZoneConfig): Promise<void> {
    const controllerId = resolveZoneStateControllerId(zone);
    const controller = this.createController(zone, controllerId);
    this.controllers.set(zone.id, controller);
    this.log.info('state controller starting', { zoneId: zone.id, controller: controllerId });
    try {
      await Promise.resolve(controller.start());
      this.log.info('state controller started', { zoneId: zone.id, controller: controllerId });
    } catch (err) {
      this.controllers.delete(zone.id);
      this.log.warn('state controller start failed', {
        zoneId: zone.id,
        controller: controllerId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private createController(zone: ZoneConfig, controllerId: string): ZoneStateController {
    if (controllerId === 'internal') {
      return new InternalStateController();
    }
    if (controllerId === 'beolink') {
      return new BeoLinkStateController({
        zone,
        onStatePatch: this.onStatePatch,
      });
    }
    if (controllerId === 'sonos') {
      return new SonosStateController({
        zone,
        configPort: this.configPort,
        onStatePatch: this.onStatePatch,
        onExternalTakeover: this.onExternalTakeover,
      });
    }
    if (controllerId === 'musicassistant') {
      return new MusicAssistantStateController({
        zone,
        configPort: this.configPort,
        onStatePatch: this.onStatePatch,
        onQueueMirror: this.onQueueMirror,
      });
    }
    // Unknown controllers fall back to internal behavior until implemented.
    this.log.warn('unknown state controller; falling back to internal', { controller: controllerId });
    return new InternalStateController();
  }
}
