import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createGroupManager } from '../src/application/groups/groupManager';
import { createGroupTrackerPort } from '../src/application/groups/groupTrackerPort';
import { getAllGroups, getGroupByZone, onGroupChanged } from '../src/application/groups/groupTracker';
import { LoxoneConfigService } from '../src/adapters/loxone/services/loxoneConfigService';
import { extractFixedGroupsFromLoxoneConfig } from '../src/adapters/loxone/services/loxoneFixedGroups';
import { createGroupHandlers } from '../src/adapters/loxone/commands/handlers/groupHandlers';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ContentManager } from '../src/adapters/content/contentManager';
import type { AudioServerConfig } from '../src/domain/config/types';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { AudioSyncGroupPayload } from '../src/ports/types/groups';

// A Loxone fixed group ("Audio Player Gruppe fixed") is configured in Loxone Config only. The
// Miniserver hands it to us in its audioserver config (audio/cfg/setconfig), and the app sends
// every command for it to the first player. sonn ignored the `groups` in that config, so the
// first player played while the others stayed stopped (#434).

const OUR_MAC = '000C29678C56';
const FOREIGN_MAC = '000C290E5497';
const GROUP = '2197102c-0107-dfc5-ffff4decce15e82a';
const OTHER_GROUP = '3a00aa00-0107-dfc5-ffff4decce15e82a';

function payload(groups: Array<{ uuid: string; players: number[] }>, foreignGroups = groups): unknown {
  const player = (playerid: number, group?: string) => ({
    uuid: `uuid-${playerid}`,
    playerid,
    bt: 'off',
    ...(group ? { playerGroup: group } : {}),
    outputs: [],
  });
  return [
    {
      [OUR_MAC]: {
        master: '504F9411157A',
        host: '192.168.1.252',
        uuid: '1a14f479-0000',
        players: [player(20), player(19), player(14, GROUP), player(15, GROUP), player(16)],
        extensions: [],
        groups: groups.map((g) => ({ uuid: g.uuid, bt: 'on', players: g.players })),
      },
    },
    {
      [FOREIGN_MAC]: {
        master: '504F9411157A',
        players: [player(30), player(31)],
        extensions: [],
        groups: [
          ...foreignGroups.map((g) => ({ uuid: g.uuid, bt: 'on', players: g.players })),
          { uuid: OTHER_GROUP, bt: 'on', players: [30, 31] },
        ],
      },
    },
  ];
}

function setUp() {
  const zones = new Map<number, ZoneState>(
    [14, 15, 16, 19, 20].map((id) => [
      id,
      { id, name: `Zone ${id}`, volume: 30, mode: 'stop', power: 'on' } as unknown as ZoneState,
    ]),
  );
  const commands: string[] = [];
  const zoneManager = {
    getState: (id: number) => zones.get(id),
    getAllZoneStates: () => [...zones.values()],
    getTechnicalSnapshot: () => null,
    syncGroupMembersToLeader: () => {},
    applyPatch: () => {},
    handleCommand: (id: number, command: string) => commands.push(`${id}:${command}`),
    replaceAll: async () => {},
  } as unknown as ZoneManagerFacade;

  const cfg = {
    system: { audioserver: { macId: OUR_MAC, extensions: [] }, miniserver: {} },
    rawAudioConfig: { raw: null, rawString: null, crc32: null },
    zones: [],
    groups: { mixedGroupEnabled: false, powerGroups: [], audioGroups: [] },
  } as unknown as AudioServerConfig;
  const configPort = {
    getConfig: () => cfg,
    updateConfig: async (fn: (c: AudioServerConfig) => unknown) => {
      await fn(cfg);
      return cfg;
    },
  } as unknown as ConfigPort;

  const syncEvents: AudioSyncGroupPayload[][] = [];
  const notifier = {
    notifyAudioSyncEvent: (p: AudioSyncGroupPayload[]) => syncEvents.push(p),
  } as unknown as NotifierPort;
  const groupManager = createGroupManager({
    notifier,
    airplayGroup: { syncCurrentGroup: async () => {}, stopGroupMembers: async () => {} } as any,
    configPort,
  });
  groupManager.initOnce({ zoneManager });

  const configService = new LoxoneConfigService(
    zoneManager,
    configPort,
    { refreshFromConfig: () => {} } as unknown as ContentManager,
    notifier,
    groupManager,
  );
  const setconfig = (raw: unknown) =>
    configService.setRawAudioConfig({ raw, rawString: JSON.stringify(raw) });
  const handlers = createGroupHandlers(zoneManager, groupManager, configPort, createGroupTrackerPort());
  const cleanUp = () => {
    groupManager.reconcileFixedGroups([]);
    for (const group of getAllGroups()) groupManager.removeGroup(group.leader);
  };
  return { cfg, groupManager, configService, setconfig, handlers, syncEvents, commands, cleanUp };
}

test('only our own section and our own players make up a fixed group (#434)', () => {
  const raw = payload([
    { uuid: GROUP, players: [14, 15, 31] },
    // Only one of these is ours.
    { uuid: 'lonely', players: [30, 19] },
  ]);
  assert.deepEqual(extractFixedGroupsFromLoxoneConfig(raw, OUR_MAC), [
    { externalId: GROUP, leader: 14, members: [14, 15] },
  ]);
  assert.deepEqual(
    extractFixedGroupsFromLoxoneConfig(JSON.stringify(raw), OUR_MAC.toLowerCase()),
    [{ externalId: GROUP, leader: 14, members: [14, 15] }],
    'the stored string form reads the same',
  );
  assert.deepEqual(extractFixedGroupsFromLoxoneConfig(raw, 'AABBCCDDEEFF'), []);
});

test('a setconfig with a fixed group groups its players, leader first (#434)', async () => {
  const { cfg, groupManager, setconfig, syncEvents, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));

    const group = getGroupByZone(15);
    assert.ok(group, 'the second player is grouped');
    assert.equal(group.leader, 14);
    assert.deepEqual(group.members, [14, 15]);
    assert.equal(group.externalId, GROUP);
    assert.equal(group.source, 'fixed');
    assert.equal(getAllGroups().length, 1, "the other audioserver's group is not ours");

    assert.deepEqual(cfg.groups?.audioGroups, [], 'the Miniserver owns it: not persisted');
    assert.deepEqual(groupManager.getGroupSyncPayload(), [], 'not announced as a dynamic group');
    assert.ok(
      syncEvents.every((event) => event.every((g) => g.group !== GROUP)),
      'no audio_sync_event names it',
    );
  } finally {
    cleanUp();
  }
});

test('a later setconfig updates or removes the fixed group (#434)', async () => {
  const { setconfig, commands, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));
    await setconfig(payload([{ uuid: GROUP, players: [14, 15, 16] }]));
    assert.deepEqual(getGroupByZone(16)?.members, [14, 15, 16], 'a player added in Loxone Config joins');

    await setconfig(payload([{ uuid: GROUP, players: [14, 16] }]));
    assert.deepEqual(getGroupByZone(14)?.members, [14, 16]);
    assert.equal(getGroupByZone(15), undefined, 'a player taken out leaves');
    assert.ok(commands.includes('15:stop'), 'and stops, as a member leaving a dynamic group does');

    await setconfig(payload([]));
    assert.deepEqual(getAllGroups(), [], 'a group no longer configured is gone');
  } finally {
    cleanUp();
  }
});

test('at startup the fixed groups come from the stored config (#434)', async () => {
  const { cfg, configService, cleanUp } = setUp();
  const raw = payload([{ uuid: GROUP, players: [14, 15] }]);
  // As config.json holds it after an earlier setconfig; the Miniserver does not send it
  // again while the CRC matches.
  cfg.rawAudioConfig = { raw, rawString: JSON.stringify(raw), crc32: 'abc' };
  const events: string[] = [];
  const off = onGroupChanged((event, leader) => events.push(`${event}:${leader}`));
  try {
    configService.applyFixedGroups();
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15]);
    configService.applyFixedGroups();
    assert.deepEqual(events, ['new:14'], 'applying the same config again changes nothing');
  } finally {
    off();
    cleanUp();
  }
});

test('dgroup cannot dissolve or regroup a fixed group (#434)', async () => {
  const { setconfig, handlers, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));

    await handlers.audioCfgDynamicGroup(`audio/cfg/dgroup/update/${GROUP}`);
    await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/grp-14-sendspin-abc');
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15], 'an ungroup leaves it alone');

    const refused = await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/new/14,16');
    assert.match(JSON.stringify(refused), /fixed-group/);
    await handlers.audioCfgDynamicGroup(`audio/cfg/dgroup/update/${GROUP}/15,16`);
    assert.deepEqual(getGroupByZone(14)?.members, [14, 15], 'its leader cannot lead another group');

    await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/new/16,15,19');
    assert.deepEqual(getGroupByZone(16)?.members, [16, 19], 'its players cannot join one');
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15]);
  } finally {
    cleanUp();
  }
});

test('a zone that becomes part of a fixed group leaves its dynamic group (#434)', async () => {
  const { cfg, groupManager, setconfig, cleanUp } = setUp();
  try {
    // 16+15 and 19+20+14 were grouped in the app; 15 and 14 are now configured as fixed.
    groupManager.upsert({ leader: 16, members: [16, 15], externalId: 'grp-16', backend: 'Unknown', source: 'manual' });
    groupManager.upsert({ leader: 19, members: [19, 20, 14], externalId: 'grp-19', backend: 'Unknown', source: 'manual' });
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));

    assert.equal(getGroupByZone(16), undefined, 'a dynamic group left with one zone is dissolved');
    assert.deepEqual(getGroupByZone(19)?.members, [19, 20], 'one with zones to spare keeps them');
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15]);
    assert.deepEqual(
      cfg.groups?.audioGroups,
      [{ leader: 19, members: [19, 20], externalId: 'grp-19' }],
      'the persisted dynamic groups follow',
    );
    assert.deepEqual(
      groupManager.getGroupSyncPayload().map((g) => g.group),
      ['grp-19'],
      'dynamic groups are still announced',
    );
  } finally {
    cleanUp();
  }
});
