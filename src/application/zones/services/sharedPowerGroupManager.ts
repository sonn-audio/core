import type { PowerGroupConfig, ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ComponentLogger } from '@/shared/logging/logger';
import {
  type NormalizedPowerConfig,
  type PowerManagerExecutor,
  type PowerSignal,
  SystemPowerManagerExecutor,
  isPowerOnMode,
  normalizePlaybackPreDelayMs,
  normalizePowerManagerConfig,
} from '@/application/zones/services/powerManager';

type GroupRuntime = {
  id: string;
  name: string;
  config: NormalizedPowerConfig;
  /** Silence a member zone prepends while the group's amp is still waking up. */
  wakeUpMs: number;
  desiredSignal: PowerSignal;
  currentSignal: PowerSignal | null;
  offTimer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void>;
  activeZoneIds: Set<number>;
};

type ZoneGroupBinding = {
  groupId: string;
  activeModes: ReadonlySet<'play' | 'pause'>;
};

export class SharedPowerGroupManager {
  private readonly groups = new Map<string, GroupRuntime>();
  private readonly zoneBindings = new Map<number, ZoneGroupBinding>();

  constructor(
    private readonly log: ComponentLogger,
    private readonly executor: PowerManagerExecutor = new SystemPowerManagerExecutor(),
  ) {}

  public configure(powerGroups: PowerGroupConfig[] | null | undefined, zones: ZoneConfig[]): void {
    this.clearAll();

    const configuredGroups = Array.isArray(powerGroups) ? powerGroups : [];
    for (const group of configuredGroups) {
      const id = group.id?.trim();
      if (!id) {
        continue;
      }
      const runtime: GroupRuntime = {
        id,
        name: group.name?.trim() || id,
        config: normalizePowerManagerConfig(group.powerManager ?? null),
        wakeUpMs: normalizePlaybackPreDelayMs(group.powerManager?.playbackPreDelayMs) ?? 0,
        desiredSignal: 0,
        currentSignal: null,
        offTimer: null,
        inflight: Promise.resolve(),
        activeZoneIds: new Set<number>(),
      };
      this.groups.set(id, runtime);
    }

    for (const zone of zones) {
      const groupId = zone.powerManager?.powerGroupId?.trim();
      if (!groupId) {
        continue;
      }
      const runtime = this.groups.get(groupId);
      if (!runtime) {
        this.log.warn('shared power group referenced by zone is missing', {
          zoneId: zone.id,
          zoneName: zone.name,
          groupId,
        });
        continue;
      }
      this.zoneBindings.set(zone.id, {
        groupId,
        activeModes: normalizePowerManagerConfig(zone.powerManager ?? null).activeModes,
      });
    }
  }

  public onStatePatch(zoneId: number, patch: Partial<ZoneState>, nextState: ZoneState): void {
    if (!('mode' in patch)) {
      return;
    }
    const binding = this.zoneBindings.get(zoneId);
    if (!binding) {
      return;
    }
    const runtime = this.groups.get(binding.groupId);
    if (!runtime) {
      return;
    }
    const shouldBeActive = isPowerOnMode(binding.activeModes, nextState.mode);
    if (shouldBeActive) {
      runtime.activeZoneIds.add(zoneId);
    } else {
      runtime.activeZoneIds.delete(zoneId);
    }
    const desiredSignal: PowerSignal = runtime.activeZoneIds.size > 0 ? 1 : 0;
    this.log.debug('shared power group state update', {
      groupId: runtime.id,
      groupName: runtime.name,
      zoneId,
      mode: nextState.mode,
      desiredSignal,
      activeZoneIds: Array.from(runtime.activeZoneIds),
      actions: runtime.config.actions.map((action) => action.type),
    });
    this.setDesired(runtime, desiredSignal);
  }

  /** Whether the zone's group amp is switched on, or null when the zone is in no group. */
  public isZoneGroupOn(zoneId: number): boolean | null {
    const runtime = this.getZoneGroup(zoneId);
    return runtime ? runtime.currentSignal === 1 : null;
  }

  /** The wake-up delay of the zone's group, 0 when it has none or the zone is in no group. */
  public getZoneWakeUpMs(zoneId: number): number {
    return this.getZoneGroup(zoneId)?.wakeUpMs ?? 0;
  }

  public clearAll(): void {
    for (const runtime of this.groups.values()) {
      if (runtime.offTimer) {
        clearTimeout(runtime.offTimer);
        runtime.offTimer = null;
      }
    }
    this.groups.clear();
    this.zoneBindings.clear();
  }

  private getZoneGroup(zoneId: number): GroupRuntime | null {
    const binding = this.zoneBindings.get(zoneId);
    return binding ? (this.groups.get(binding.groupId) ?? null) : null;
  }

  private setDesired(runtime: GroupRuntime, desiredSignal: PowerSignal): void {
    const previousDesired = runtime.desiredSignal;
    runtime.desiredSignal = desiredSignal;
    if (previousDesired === desiredSignal) {
      return;
    }
    this.log.debug('shared power group desired signal changed', {
      groupId: runtime.id,
      previousDesired,
      desiredSignal,
    });
    this.driveSignal(runtime, desiredSignal);
  }

  /** Take the group towards `desiredSignal`: on at once, off after its idle delay. */
  private driveSignal(runtime: GroupRuntime, desiredSignal: PowerSignal): void {
    if (desiredSignal === 1) {
      if (runtime.offTimer) {
        clearTimeout(runtime.offTimer);
        runtime.offTimer = null;
        this.log.spam('shared power group cancelled pending off timer', {
          groupId: runtime.id,
        });
      }
      if (runtime.currentSignal === 1) {
        return;
      }
      this.applySignal(runtime, 1);
      return;
    }
    if (runtime.currentSignal === 0) {
      return;
    }
    if (runtime.offTimer) {
      clearTimeout(runtime.offTimer);
      runtime.offTimer = null;
    }
    const delayMs = runtime.config.offDelayMs;
    if (delayMs <= 0) {
      this.applySignal(runtime, 0);
      return;
    }
    this.log.debug('shared power group scheduled off signal', {
      groupId: runtime.id,
      delayMs,
    });
    runtime.offTimer = setTimeout(() => {
      runtime.offTimer = null;
      const fresh = this.groups.get(runtime.id);
      if (!fresh || fresh.desiredSignal !== 0) {
        return;
      }
      this.applySignal(fresh, 0);
    }, delayMs);
    runtime.offTimer.unref?.();
  }

  private applySignal(runtime: GroupRuntime, signal: PowerSignal): void {
    runtime.inflight = runtime.inflight
      .then(async () => {
        const fresh = this.groups.get(runtime.id);
        if (!fresh || fresh.desiredSignal !== signal || fresh.currentSignal === signal) {
          return;
        }
        this.log.info('shared power group applying signal', {
          groupId: fresh.id,
          groupName: fresh.name,
          signal,
          actions: fresh.config.actions.map((action) => action.type),
        });
        let allSucceeded = true;
        for (const action of fresh.config.actions) {
          try {
            await this.executor.execute(action, signal);
          } catch (error: unknown) {
            allSucceeded = false;
            const message = error instanceof Error ? error.message : String(error);
            this.log.warn('shared power group action failed', {
              groupId: fresh.id,
              action: action.type,
              signal,
              message,
            });
          }
        }
        const active = this.groups.get(runtime.id);
        // Only mark the group as switched when every action succeeded. Latching
        // currentSignal after a failed crelay call would leave a physically energized
        // relay looking off, and the desired/current guards would never retry it (#293).
        //
        // On success it is marked whatever the group wants by now, because that is what
        // the relay is doing. A zone flipping back mid-switch otherwise left the books
        // disagreeing with the hardware, and the equality guards then suppressed the
        // command that would have corrected it (#359).
        if (active && allSucceeded) {
          active.currentSignal = signal;
          if (active.desiredSignal !== signal) {
            this.log.debug('shared power group re-driving signal after a mid-switch change', {
              groupId: active.id,
              appliedSignal: signal,
              desiredSignal: active.desiredSignal,
            });
            this.driveSignal(active, active.desiredSignal);
          }
        } else if (active && !allSucceeded) {
          this.log.debug('shared power group leaving signal unconfirmed after failure', {
            groupId: active.id,
            signal,
            currentSignal: active.currentSignal,
          });
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('shared power group signal failed', {
          groupId: runtime.id,
          signal,
          message,
        });
      });
  }
}
