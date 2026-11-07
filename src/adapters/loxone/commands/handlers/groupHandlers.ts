import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { GroupManager } from '@/application/groups/groupManager';
import type { GroupTrackerPort } from '@/ports/GroupTrackerPort';

// grp-{leaderId}-{protocol}-{base36timestamp}
const GROUP_ID_LEADER_RE = /^grp-(\d+)-/;
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import { normalizeOutputProtocol } from '@/application/zones/outputProtocol';
import { createLogger } from '@/shared/logging/logger';

function clampVolume(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

const GROUP_UPDATE_RE = /^audio\/cfg\/dgroup\/update\/([^/]+)(?:\/([^/]+))?$/;
const MASTER_VOLUME_RE = /^audio\/(\d+)\/mastervolume\/(-?\d+)(?:\/.*)?$/;
const GROUP_VOLUME_RE = /^audio\/grouped\/volume\/([^/]+)\/([^/]+)(?:\/.*)?$/;
const GROUP_PLAYBACK_RE = /^audio\/grouped\/(pause|play|resume|stop)\/([^/]+)(?:\/.*)?$/;

export function createGroupHandlers(
  zoneManager: ZoneManagerFacade,
  groupManager: GroupManager,
  configPort: ConfigPort,
  groupTracker: GroupTrackerPort,
) {
  return {
    audioCfgDynamicGroup: (command: string) =>
      audioCfgDynamicGroup(groupManager, zoneManager, configPort, groupTracker, command),
    audioMasterVolume: (command: string) =>
      audioMasterVolume(groupManager, zoneManager, groupTracker, command),
    audioGroupedVolume: (command: string) =>
      audioGroupedVolume(groupManager, zoneManager, command),
    audioGroupedPlayback: (command: string) => audioGroupedPlayback(zoneManager, command),
  };
}

function resolveOutputProtocol(zoneManager: ZoneManagerFacade, zoneId: number): string {
  const snapshot = zoneManager.getTechnicalSnapshot(zoneId);
  if (!snapshot) {
    return 'unknown';
  }
  const fallback = snapshot.transports[0] ?? null;
  // Normalize to the protocol family (sendspin-cast/-dlna/-sonos → sendspin) so
  // the grouping match agrees with what the player shows; otherwise a Cast/DLNA
  // member is wrongly dropped from a sendspin group.
  return normalizeOutputProtocol(snapshot.activeOutput ?? fallback) ?? 'unknown';
}

async function audioCfgDynamicGroup(
  groupManager: GroupManager,
  zoneManager: ZoneManagerFacade,
  configPort: ConfigPort,
  groupTracker: GroupTrackerPort,
  command: string,
) {
  const match = command.match(GROUP_UPDATE_RE);
  if (!match) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'invalid-url' });
  }

  const groupIdRaw = match[1] ?? '';
  const zoneListRaw = match[2];

  if (!zoneListRaw) {
    let existing = groupTracker.getGroupByExternalId(groupIdRaw);
    if (!existing) {
      // After a server restart the leaderByExternalId map is empty but the group
      // may still be tracked under its leader zone. Parse the leader from the ID.
      const leaderMatch = groupIdRaw.match(GROUP_ID_LEADER_RE);
      if (leaderMatch) {
        const leaderId = Number(leaderMatch[1]);
        existing = groupTracker.getGroupByLeader(leaderId);
        if (existing) {
          createLogger('Groups', 'Handlers').debug('dgroup unsync: resolved group by leader (externalId not found)', {
            groupIdRaw,
            leaderId,
            externalId: existing.externalId,
          });
        }
      }
    }
    if (existing) {
      groupManager.removeGroup(existing.externalId ?? existing.leader);
    } else {
      createLogger('Groups', 'Handlers').debug('dgroup unsync: no group found', { groupIdRaw });
    }
    return buildResponse(command, 'dgroup_update', { id: groupIdRaw });
  }

  const zoneIds = zoneListRaw
    .split(',')
    .map(Number)
    .filter((id) => Number.isFinite(id) && id > 0);

  if (!zoneIds.length) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'no-zones' });
  }

  const [leader, ...members] = zoneIds as [number, ...number[]];
  const leaderState = zoneManager.getState(leader);
  if (!leaderState) {
    return buildResponse(command, 'dgroup_update', { success: false, error: 'leader-missing' });
  }
  const allowMixedGroup = configPort.getConfig()?.groups?.mixedGroupEnabled === true;
  const leaderProtocol = resolveOutputProtocol(zoneManager, leader);
  const memberProtocols = members.map((memberId) => ({
    id: memberId,
    protocol: resolveOutputProtocol(zoneManager, memberId),
  }));
  const filteredMembers = allowMixedGroup
    ? members
    : memberProtocols.filter((member) => member.protocol === leaderProtocol).map((member) => member.id);
  const droppedMembers = allowMixedGroup
    ? []
    : members.filter((memberId) => !filteredMembers.includes(memberId));
  if (droppedMembers.length) {
    createLogger('Groups', 'Handlers').debug('dropped group members (protocol mismatch)', {
      leader,
      droppedMembers,
    });
  }

  const existing = groupTracker.getGroupByExternalId(groupIdRaw) ?? groupTracker.getGroupByLeader(leader);
  if (existing) {
    groupTracker.removeGroupByLeader(existing.leader);
  }

  const protocols = new Set([leaderProtocol, ...memberProtocols.map((member) => member.protocol)]);
  const groupProtocol = allowMixedGroup && protocols.size > 1 ? 'mixedgroup' : leaderProtocol;
  const externalId =
    groupIdRaw === 'new'
      ? `grp-${leader}-${groupProtocol}-${Date.now().toString(36)}`
      : groupIdRaw;
  groupManager.upsert({
    leader,
    members: filteredMembers,
    backend: 'Unknown',
    externalId,
    source: 'manual',
  });

  return buildResponse(command, 'dgroup_update', { id: externalId });
}

async function audioMasterVolume(
  groupManager: GroupManager,
  zoneManager: ZoneManagerFacade,
  groupTracker: GroupTrackerPort,
  command: string,
) {
  const match = command.match(MASTER_VOLUME_RE);
  if (!match) {
    return buildResponse(command, 'mastervolume', { success: false, error: 'invalid-url' });
  }

  const zoneId = Number(match[1]);
  const target = clampVolume(match[2]);
  const leaderState = zoneManager.getState(zoneId);

  if (!leaderState) {
    return buildResponse(command, 'mastervolume', { success: false, error: 'zone-not-found' });
  }

  await groupManager.applyMasterVolume(zoneId, target);
  const group = groupTracker.getGroupByZone(zoneId);

  return buildResponse(command, 'mastervolume', {
    success: true,
    target,
    group: group?.externalId ?? null,
  });
}

async function audioGroupedVolume(
  groupManager: GroupManager,
  zoneManager: ZoneManagerFacade,
  command: string,
) {
  const players: Array<{ playerid: number; volume: number }> = [];
  const match = command.match(GROUP_VOLUME_RE);
  if (!match) {
    return buildResponse(command, 'grouped_volume', { players });
  }

  const valueToken = decodeURIComponent(match[1] ?? '');
  const zonesToken = decodeURIComponent(match[2] ?? '');
  const zoneIds = zonesToken
    .split(',')
    .map(Number)
    .filter((id) => id > 0);

  const plus = new Set(['+', 'plus', 'up']);
  const minus = new Set(['-', 'minus', 'down']);

  for (const zoneId of zoneIds) {
    const state = zoneManager.getState(zoneId);
    if (!state) {
      continue;
    }

    const current = clampVolume(state.volume);
    const isPlus = plus.has(valueToken);
    const isMinus = minus.has(valueToken);
    let next = current;
    let payload: string;
    if (isPlus || isMinus) {
      payload = isPlus ? '+1' : '-1';
      next = clampVolume(current + (isPlus ? 1 : -1));
    } else {
      next = clampVolume(Number(valueToken));
      payload = String(next);
    }

    try {
      zoneManager.handleCommand(zoneId, 'volume_set', payload);
      const updated = zoneManager.getState(zoneId);
      players.push({ playerid: zoneId, volume: clampVolume(updated?.volume ?? next) });
    } catch {
      // zone refused the volume change — omit from the result set
    }
  }

  if (players.length > 0) {
    groupManager.broadcastGroupState();
  }

  return buildResponse(command, 'grouped_volume', { players });
}

async function audioGroupedPlayback(zoneManager: ZoneManagerFacade, command: string) {
  const match = command.match(GROUP_PLAYBACK_RE);
  const action = (match?.[1] ?? '') as 'pause' | 'play' | 'resume' | 'stop' | '';
  // The v17 client only sends pause/play; the response envelope is keyed per action
  // (`grouped_pause_result` / `grouped_play_result`) and `mode` literally echoes the URL action.
  const responseName =
    action === 'pause' || action === 'play' || action === 'resume' || action === 'stop'
      ? `grouped_${action}`
      : 'grouped_play';
  const responseMode = action === 'pause' ? 'pause' : 'play';

  const players: Array<{ playerid: number; mode: 'pause' | 'play' }> = [];
  if (!match) {
    return buildResponse(command, responseName, { players });
  }

  const targets = decodeURIComponent(match[2] ?? '')
    .split(',')
    .map(Number)
    .filter((id) => id > 0);

  const cmdMap: Record<string, 'pause' | 'resume' | 'stop'> = {
    pause: 'pause',
    stop: 'stop',
    play: 'resume',
    resume: 'resume',
  };
  const mapped = cmdMap[action];
  if (!mapped) {
    return buildResponse(command, responseName, { players });
  }

  for (const zoneId of targets) {
    if (!zoneManager.getState(zoneId)) {
      continue;
    }
    try {
      // The zones learn it is the group's command: a member's pause in it is the group
      // pausing, not that member stepping out on its own (#409).
      zoneManager.handleCommand(zoneId, mapped, undefined, { groupedTargets: targets });
      players.push({ playerid: zoneId, mode: responseMode });
    } catch {
      // zone refused the action — omit from the result set
    }
  }

  return buildResponse(command, responseName, { players });
}
