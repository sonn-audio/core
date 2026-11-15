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

test('dgroup cannot dissolve a fixed group (#434)', async () => {
  const { setconfig, handlers, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));

    await handlers.audioCfgDynamicGroup(`audio/cfg/dgroup/update/${GROUP}`);
    await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/grp-14-sendspin-abc');
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15], 'an ungroup leaves it alone');
    assert.equal(getGroupByZone(15)?.source, 'fixed');
  } finally {
    cleanUp();
  }
});

test('grouping exactly the players of a fixed group hands it to the leader asked for (#430)', async () => {
  // The app still offers "Create group" for those players, and sonn refused it: the
  // speakers stayed apart and the reporter could not group them at all.
  const { setconfig, handlers, commands, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));
    commands.length = 0;

    const reply = await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/new/15,14');
    assert.doesNotMatch(JSON.stringify(reply), /error/);
    assert.match(JSON.stringify(reply), new RegExp(GROUP), 'the group they are in is the fixed one');
    const group = getGroupByZone(14);
    assert.equal(group?.leader, 15);
    assert.equal(group?.source, 'fixed');
    assert.deepEqual(commands, [], 'nothing is stopped on the way');
  } finally {
    cleanUp();
  }
});

test('a dynamic group with a player of a fixed group takes in all of them, and gives them back (#430)', async () => {
  const { cfg, setconfig, handlers, commands, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));
    commands.length = 0;

    const reply = await handlers.audioCfgDynamicGroup('audio/cfg/dgroup/update/new/16,15');
    const id = (JSON.stringify(reply).match(/grp-16-[^"\\]+/) ?? [])[0];
    assert.ok(id, 'a dynamic group is formed');
    const group = getGroupByZone(14);
    assert.equal(group?.leader, 16);
    assert.deepEqual(group?.members, [16, 14, 15], 'its fixed partner comes along');
    assert.equal(group?.source, 'manual');
    assert.deepEqual(commands, [], 'nothing is stopped on the way');

    await handlers.audioCfgDynamicGroup(`audio/cfg/dgroup/update/${id}`);
    assert.equal(getGroupByZone(16), undefined);
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15], 'the fixed group is back');
    assert.equal(getGroupByZone(15)?.source, 'fixed');
    assert.deepEqual(cfg.groups?.audioGroups, [], 'and the dynamic one is forgotten');
  } finally {
    cleanUp();
  }
});

test('content started on another player of a fixed group makes it the leader (#430)', async () => {
  // Loxone gives a fixed group no master: whichever player is played, the group plays it.
  const { groupManager, setconfig, commands, cleanUp } = setUp();
  try {
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));
    commands.length = 0;

    assert.equal(groupManager.leadFixedGroup(15, { endPreviousLeader: true }), true);
    assert.equal(getGroupByZone(14)?.leader, 15);
    assert.deepEqual(getGroupByZone(14)?.members, [15, 14]);
    assert.deepEqual(commands, ['14:stop'], 'only what the old leader played is ended');

    assert.equal(groupManager.leadFixedGroup(15, { endPreviousLeader: true }), false, 'already leading');
    assert.equal(groupManager.leadFixedGroup(16), false, 'not in a fixed group');

    await setconfig(payload([{ uuid: GROUP, players: [14, 15, 16] }]));
    assert.equal(getGroupByZone(16)?.leader, 15, 'a new config keeps the leader it has');
  } finally {
    cleanUp();
  }
});

test('a dynamic group that holds a player of a new fixed group takes in the rest of it (#430)', async () => {
  const { cfg, groupManager, setconfig, cleanUp } = setUp();
  try {
    groupManager.upsert({ leader: 16, members: [16, 15], externalId: 'grp-16', backend: 'Unknown', source: 'manual' });
    groupManager.upsert({ leader: 19, members: [19, 20], externalId: 'grp-19', backend: 'Unknown', source: 'manual' });
    await setconfig(payload([{ uuid: GROUP, players: [14, 15] }]));

    assert.deepEqual(getGroupByZone(14)?.members, [16, 14, 15]);
    assert.deepEqual(getGroupByZone(19)?.members, [19, 20], 'a group without its players is untouched');
    assert.equal(
      getAllGroups().filter((g) => g.source === 'fixed').length,
      0,
      'the fixed group waits until the dynamic one is dissolved',
    );
    assert.deepEqual(
      [...(cfg.groups?.audioGroups?.find((g) => g.externalId === 'grp-16')?.members ?? [])].sort(),
      [14, 15, 16],
      'the persisted dynamic group follows',
    );

    groupManager.removeGroup('grp-16');
    assert.deepEqual(getGroupByZone(15)?.members, [14, 15]);
    assert.equal(getGroupByZone(15)?.source, 'fixed');
  } finally {
    cleanUp();
  }
});
