import { createLogger } from '@/shared/logging/logger';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { AirplayGroupCoordinator } from '@/application/outputs/airplayGroupController';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { AudioServerConfig } from '@/domain/config/types';
import {
  getAllGroups,
  getGroupByLeader,
  getGroupByZone,
  onGroupChanged,
  removeGroupByLeader,
  upsertGroup,
} from '@/application/groups/groupTracker';
import type { AudioSyncEventPlayer } from '@/application/groups/types/audioSyncEventPlayer';
import type { AudioSyncGroupPayload } from '@/application/groups/types/AudioSyncGroupPayload';
import type { GroupRecord } from '@/application/groups/types/groupRecord';

type GroupChangeEvent = 'new' | 'update' | 'remove';

function clampVolume(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

export class GroupManager {
  private readonly log = createLogger('Groups', 'Manager');
  private readonly lastSyncAt = new Map<number, number>();
  private notifier: NotifierPort;
  private zoneManager: ZoneManagerFacade | null = null;
  private readonly airplayGroup: AirplayGroupCoordinator;
  private readonly configPort: ConfigPort;

  constructor(notifier: NotifierPort, airplayGroup: AirplayGroupCoordinator, configPort: ConfigPort) {
    this.notifier = notifier;
    this.airplayGroup = airplayGroup;
    this.configPort = configPort;
    onGroupChanged((event: GroupChangeEvent, leader: number, record?: GroupRecord): void => {
      const context = { leader, externalId: record?.externalId };
      switch (event) {
        case 'new':
          this.log.info('group created', context);
          this.syncAirplayGroup(leader);
          this.zones.syncGroupMembersToLeader(leader);
          this.refreshZoneEmit(leader);
          break;
        case 'update':
          this.log.info('group updated', context);
          this.syncAirplayGroup(leader);
          this.zones.syncGroupMembersToLeader(leader);
          this.refreshZoneEmit(leader);
          break;
        case 'remove': {
          this.log.info('group removed', context);
          if (record?.members?.length) {
            void this.airplayGroup.stopGroupMembers(record.leader, record.members);
            const membersToStop = record.members.filter((memberId) => memberId !== record.leader);
            membersToStop.forEach((memberId) => {
              try {
                this.zones.handleCommand(memberId, 'stop');
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.log.warn('failed to stop zone after group removal', {
                  zoneId: memberId,
                  message,
                });
              }
            });
          }
          const groupId = record?.externalId ?? `group-${leader}`;
          const emptyPayload: AudioSyncGroupPayload = {
            group: groupId,
            mastervolume: 0,
            players: [],
            type: 'dynamic',
          };
          this.notifier.notifyAudioSyncEvent([emptyPayload]);
          // Force a re-broadcast so audio_event payloads pick up the now-empty syncedzones.
          this.refreshZoneEmit(leader);
          record?.members?.forEach((memberId) => this.refreshZoneEmit(memberId));
          break;
        }
        default:
          this.log.warn('unknown group change event', { event, leader });
          break;
      }

      try {
        this.broadcastGroupState();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.warn('group broadcast failed', { leader, message });
      }
    });
  }

  /**
   * Forces a re-broadcast of a zone's audio_event so the payload picks up
   * fresh `syncedzones` / `mastervolume` after a group composition change.
   */
  private refreshZoneEmit(zoneId: number): void {
    if (!this.zoneManager) return;
    if (!this.zoneManager.getState(zoneId)) return;
    try {
      this.zoneManager.applyPatch(zoneId, {}, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('failed to refresh zone emit', { zoneId, message });
    }
  }

  /**
   * The current groups as the `audio_sync_event` list. Built here once so the
   * change broadcast below and a client's connect snapshot send the same thing.
   */
  public getGroupSyncPayload(): AudioSyncGroupPayload[] {
    return getAllGroups()
      .map((record) => this.buildGroupPayload(record))
      .filter((p): p is AudioSyncGroupPayload => Boolean(p));
  }

  public broadcastGroupState(): void {
    const payload = this.getGroupSyncPayload();

    if (!payload.length) {
      this.log.debug('no groups to broadcast');
      return;
    }

    this.notifier.notifyAudioSyncEvent(payload);
    this.log.debug('broadcasted groups', { count: payload.length });
  }

  public setNotifier(notifier: NotifierPort): void {
    this.notifier = notifier;
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('group manager already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('group manager missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  private syncAirplayGroup(leader: number): void {
    const now = Date.now();
    const last = this.lastSyncAt.get(leader) ?? 0;
    if (now - last < 1000) {
      this.log.debug('airplay group sync skipped (debounced)', { leader, delayMs: now - last });
      return;
    }
    this.lastSyncAt.set(leader, now);
    void this.airplayGroup.syncCurrentGroup(leader);
  }

  private buildGroupPayload(record: GroupRecord): AudioSyncGroupPayload | null {
    const leaderState = this.zones.getState(record.leader);
    if (!leaderState) {
      return null;
    }

    const masterVolume = clampVolume(leaderState.volume);
    const zoneIds = Array.from(new Set<number>([record.leader, ...record.members]));

    const players: AudioSyncEventPlayer[] = zoneIds
      .map((zoneId) => {
        const state = this.zones.getState(zoneId);
        if (!state) {
          return null;
        }
        return {
          id: `zone-${zoneId}`,
          playerid: zoneId,
          name: state.name ?? `Zone ${zoneId}`,
        };
      })
      .filter((p): p is AudioSyncEventPlayer => Boolean(p));

    if (!players.length) {
      return null;
    }

    return {
      group: record.externalId ?? `group-${record.leader}`,
      mastervolume: masterVolume,
      players,
      type: 'dynamic',
    };
  }

  public async applyMasterVolume(zoneId: number, target: number): Promise<void> {
    const group = getGroupByZone(zoneId);
    if (!group) {
      this.log.debug('no group found for zone', { zoneId });
      return;
    }

    const leaderState = this.zones.getState(group.leader);
    if (!leaderState) {
      this.log.warn('leader state missing', { leader: group.leader });
      return;
    }

    const currentLeaderVolume = clampVolume(leaderState.volume);
    const delta = target - currentLeaderVolume;

    const memberIds = new Set<number>([group.leader, ...group.members]);
    for (const memberId of memberIds) {
      const state = this.zones.getState(memberId);
      if (!state) {
        this.log.debug('skip volume sync for unknown zone', { memberId });
        continue;
      }
      const current = clampVolume(state.volume);
      const next = clampVolume(current + delta);
      this.setZoneVolume(memberId, next);
    }

    this.broadcastGroupState();
  }

  /**
   * Apply the Sendspin group volume algorithm: move all players by the same delta,
   * clamp to [0,100], redistribute any lost delta across unclamped players until
   * either the target group volume is achieved as closely as possible or all players
   * are clamped.
   */
  public applySpecGroupVolume(zoneId: number, target: number): void {
    const group = getGroupByZone(zoneId);
    const memberIds = group ? new Set<number>([group.leader, ...group.members]) : new Set([zoneId]);
    const players = [...memberIds].map((id) => {
      const state = this.zones.getState(id);
      return { id, volume: clampVolume(state?.volume) };
    });
    if (!players.length) return;

    const currentGroupVolume =
      players.reduce((acc, p) => acc + p.volume, 0) / Math.max(players.length, 1);
    let remainingDelta = clampVolume(target) - currentGroupVolume;

    // Iteratively redistribute lost delta.
    for (let i = 0; i < 10; i += 1) {
      let lostDelta = 0;
      const unclamped: number[] = [];
      const nextVolumes: number[] = [];
      players.forEach((p, idx) => {
        const proposed = p.volume + remainingDelta;
        const clamped = clampVolume(proposed);
        nextVolumes[idx] = clamped;
        if (clamped !== proposed) {
          lostDelta += proposed - clamped;
        } else {
          unclamped.push(idx);
        }
      });

      players.forEach((p, idx) => {
        p.volume = nextVolumes[idx] ?? 0;
      });

      if (Math.abs(lostDelta) < 0.0001 || !unclamped.length) {
        break;
      }

      remainingDelta = lostDelta / unclamped.length;
    }

    players.forEach((p) => {
      this.setZoneVolume(p.id, p.volume);
    });
    this.broadcastGroupState();
  }

  private setZoneVolume(zoneId: number, volume: number): void {
    try {
      this.zones.handleCommand(zoneId, 'volume_set', String(volume));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('failed to update zone volume', { zoneId, message });
    }
  }

  public removeGroup(identifier: number | string): void {
    const groups = getAllGroups();
    if (!groups.length) {
      this.log.debug('no groups registered');
      return;
    }

    const record =
      typeof identifier === 'number'
        ? groups.find((g) => g.leader === identifier)
        : groups.find((g) => g.externalId === String(identifier).trim());

    if (!record) {
      this.log.debug('no group found for identifier', { identifier });
      return;
    }

    const removed = removeGroupByLeader(record.leader);
    if (!removed) {
      this.log.warn('failed to remove group', { identifier });
      return;
    }
    if (record.source === 'manual') {
      void this.unpersistGroup(record.leader);
    }
  }

  public upsert(record: Omit<GroupRecord, 'updatedAt'>): void {
    const previous = getGroupByLeader(record.leader);
    const { changed } = upsertGroup(record);
    if (changed) {
      if (record.source === 'manual' && record.externalId) {
        void this.persistGroup(record.leader, record.members, record.externalId);
      }
      // Stop members that were removed compared to previous state; keep leader playing.
      if (previous) {
        const prevMembers = new Set<number>(previous.members);
        const nextMembers = new Set<number>(record.members);
        prevMembers.forEach((memberId) => {
          if (memberId === record.leader) return;
          if (!nextMembers.has(memberId)) {
            void this.airplayGroup.stopGroupMembers(record.leader, [memberId]);
            try {
              this.zones.handleCommand(memberId, 'stop');
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this.log.warn('failed to stop zone after member removal', { zoneId: memberId, message });
            }
          }
        });
      }
    }
  }

  public getAllGroups(): ReadonlyArray<GroupRecord> {
    return getAllGroups();
  }

  private persistGroup(leader: number, members: number[], externalId: string): Promise<AudioServerConfig> {
    return this.configPort.updateConfig((cfg) => {
      if (!cfg.groups) cfg.groups = { mixedGroupEnabled: false, powerGroups: [], audioGroups: [] };
      if (!Array.isArray(cfg.groups.audioGroups)) cfg.groups.audioGroups = [];
      const idx = cfg.groups.audioGroups.findIndex((g) => g.externalId === externalId || g.leader === leader);
      const entry = { leader, members, externalId };
      if (idx >= 0) {
        cfg.groups.audioGroups[idx] = entry;
      } else {
        cfg.groups.audioGroups.push(entry);
      }
    });
  }

  private unpersistGroup(leader: number): Promise<AudioServerConfig> {
    return this.configPort.updateConfig((cfg) => {
      if (!Array.isArray(cfg.groups?.audioGroups)) return;
      cfg.groups!.audioGroups = cfg.groups!.audioGroups.filter((g) => g.leader !== leader);
    });
  }
}

export type GroupManagerReadPort = Pick<GroupManager, 'getAllGroups'>;

/** The group list a Loxone client is sent on connect, as the change broadcast sends it. */
export type GroupSyncSnapshotPort = Pick<GroupManager, 'getGroupSyncPayload'>;

/**
 * Grouping as the public API needs it. Kept separate from the read port so a consumer
 * that only lists groups still cannot change them.
 */
export type GroupManagerWritePort = Pick<GroupManager, 'upsert' | 'removeGroup'>;

type GroupManagerDeps = {
  notifier: NotifierPort;
  airplayGroup: AirplayGroupCoordinator;
  configPort: ConfigPort;
};

export function createGroupManager(deps: GroupManagerDeps): GroupManager {
  return new GroupManager(deps.notifier, deps.airplayGroup, deps.configPort);
}
