import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createGroupManager } from '../src/application/groups/groupManager';
import { LoxoneHttpService } from '../src/adapters/loxone/http/loxoneHttpService';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ZoneState } from '../src/domain/zones/zoneState';

// Groups are announced when they change. A group restored from config at startup
// changes before any Loxone client is connected, so unless the connect snapshot
// carries the group list the app never learns the group exists: it shows
// "No group available" and cannot dissolve it (#433).

const LEADER = 41;
const MEMBER = 42;

function state(id: number, name: string): ZoneState {
  return { id, name, volume: 30, mode: 'stop', power: 'on' } as unknown as ZoneState;
}

function connectTo(service: LoxoneHttpService): string[] {
  const sent: string[] = [];
  const connection = {
    sendUTF: (data: string) => sent.push(data),
    on: () => {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  (service as any).handleWebSocket(
    { name: 'appHttp', port: 0, identification: 'LWSS V 2.3.9.2 | ~API:1.6~' },
    connection,
  );
  return sent;
}

function syncEvents(sent: string[]): unknown[] {
  return sent
    .map((frame) => JSON.parse(frame.startsWith('{') ? frame : 'null'))
    .filter((msg) => msg && 'audio_sync_event' in msg)
    .map((msg) => msg.audio_sync_event);
}

test('a client that connects after a group was restored is sent the group list', () => {
  const zones = new Map<number, ZoneState>([
    [LEADER, state(LEADER, 'Living')],
    [MEMBER, state(MEMBER, 'Kitchen')],
  ]);
  const zoneManager = {
    getState: (id: number) => zones.get(id),
    getAllZoneStates: () => [...zones.values()],
    syncGroupMembersToLeader: () => {},
    applyPatch: () => {},
    handleCommand: () => {},
  } as unknown as ZoneManagerFacade;

  const broadcasts: string[] = [];
  const registry = {
    registerConnection: () => {},
    unregisterConnection: () => {},
    broadcastMessage: (msg: string) => broadcasts.push(msg),
  } as any;
  const wsNotifier = new LoxoneWsNotifier(registry, { getGroupByZone: () => undefined } as any);
  wsNotifier.setZoneStateLookup((id) => zones.get(id));

  const groupManager = createGroupManager({
    notifier: { notifyAudioSyncEvent: () => {} } as unknown as NotifierPort,
    airplayGroup: {
      syncCurrentGroup: async () => {},
      stopGroupMembers: async () => {},
    } as any,
    configPort: { updateConfig: async () => ({}) } as unknown as ConfigPort,
  });
  groupManager.initOnce({ zoneManager });

  const service = new LoxoneHttpService({ servers: [] } as any, {
    host: 'localhost',
    processor: {} as any,
    connectionRegistry: registry,
    serverHeartbeat: { emit: () => {} } as any,
    notifier: wsNotifier,
    zoneManager,
    groups: groupManager,
    configPort: {} as ConfigPort,
  });

  // Before there is a group, a connecting client gets no sync event, just as the
  // change broadcast sends nothing for an empty list.
  assert.deepEqual(syncEvents(connectTo(service)), []);

  // What bootstrap does with config.json groups.audioGroups at startup.
  groupManager.upsert({
    leader: LEADER,
    members: [LEADER, MEMBER],
    externalId: 'restored-433',
    backend: 'Unknown',
    source: 'manual',
  });

  try {
    const events = syncEvents(connectTo(service));
    assert.deepEqual(events, [
      [
        {
          group: 'restored-433',
          mastervolume: 30,
          players: [
            { id: `zone-${LEADER}`, playerid: LEADER, name: 'Living' },
            { id: `zone-${MEMBER}`, playerid: MEMBER, name: 'Kitchen' },
          ],
          type: 'dynamic',
        },
      ],
    ]);
    assert.deepEqual(
      events[0],
      groupManager.getGroupSyncPayload(),
      'the snapshot sends the same list the change broadcast does',
    );
    assert.equal(
      broadcasts.filter((m) => m.includes('audio_sync_event')).length,
      0,
      'the snapshot goes to the connecting client only, not to everyone',
    );
  } finally {
    groupManager.removeGroup(LEADER);
  }
});
