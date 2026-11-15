import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from './testHarness';
import { LoxoneRouter } from '../src/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '../src/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { createGlobalSearchHandlers } from '../src/adapters/loxone/commands/handlers/globalSearchHandlers';
import { createQueueEditHandlers } from '../src/adapters/loxone/commands/handlers/queueEditHandlers';
import { createInputHandlers } from '../src/adapters/loxone/commands/handlers/inputHandlers';
import type { CommandResult } from '../src/adapters/loxone/commands/types';

/**
 * The native client's command contract, transcribed — the answers this time, not the events.
 *
 * Read out of the shipped client (Loxone.app 17.3.0, `www/shared-app.js`, the command schema
 * modules) and written in the same zod the client uses; the line quoted per schema is where
 * its module starts in the prettified bundle. `docs/loxone-client-map.md` has the whole table.
 *
 * What the client does with an answer (`AudioServerDataSource._onMessage`): it finds the
 * pending request by the echoed `command`, parses the frame with the command's `response`
 * schema, and resolves with the value under the one `<name>_result` key that schema names. A
 * key it does not know is stripped, so an answer under a different name is not a wrong
 * answer — it is no answer: `Command "…" did resolve without any result!`, and the app
 * reports the action as failed although we carried it out.
 *
 * So each check here is two things at once: the frame parses, and the result is there.
 */

/** Every response extends this (`BaseResponse`, shared-app.js:18072). */
const BaseResponse = z.object({ error: z.string().optional(), command: z.string() });

/** What the client ends up with: the frame as it would arrive, parsed by `schema`. */
function clientResult<T extends z.ZodType>(schema: T, result: CommandResult, key: string): unknown {
  const frame = JSON.parse(serializeResult(result));
  const parsed = schema.safeParse(frame);
  assert.ok(
    parsed.success,
    `the client rejects ${result.command}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
  );
  const value = (parsed.data as Record<string, unknown>)[key];
  assert.notEqual(value, undefined, `${result.command} resolves without any result: no ${key}`);
  assert.equal(frame.command, result.command, 'the command is echoed as sent');
  return value;
}

// --- room favourites (shared-app.js 8040, 8447, 8615, 8778) --------------------

/** `RoomFavsSetIdScheme`. */
const RoomFavsSetIdResponse = BaseResponse.extend({
  roomfavs_setid_result: z.object({ changed_from: z.number(), changed_to: z.number() }).optional(),
});
/** `RoomFavsSetNameScheme` — an array of one. */
const RoomFavsSetNameResponse = BaseResponse.extend({
  roomfavs_setname_result: z.array(z.object({ rename_slot: z.number(), rename_to: z.string() })).optional(),
});
/** `RoomFavsSetT5EnabledScheme`. */
const RoomFavsSetPlusResponse = BaseResponse.extend({
  roomfavs_setplus_result: z.object({ plus: z.boolean(), id: z.coerce.number() }).optional(),
});
/**
 * `RoomFavsDeleteScheme`. The client writes `error: z.undefined()`; under its zod 3 a missing
 * key satisfies that, under our zod 4 it has to be said.
 */
const RoomFavsDeleteResponse = BaseResponse.extend({
  roomfavs_delete_result: z.object({ delete_id: z.number(), error: z.undefined().optional() }).optional(),
});

function roomFavHandlers(calls: unknown[][] = []) {
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return {};
    };
  return createZoneHandlers(
    { getState: () => undefined, getMetadata: () => ({}) } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({ items: [] }),
      setId: record('setId'),
      setName: record('setName'),
      setPlus: record('setPlus'),
      remove: record('remove'),
    } as any,
    { resolveMetadata: async () => null } as any,
    {} as any,
    {} as any,
  );
}

test('client commands: the room favourite edits answer under the names the app waits for', async () => {
  const handlers = roomFavHandlers();
  assert.deepEqual(
    clientResult(RoomFavsSetIdResponse, await handlers.audioCfgRoomFavs('audio/cfg/roomfavs/7/setid/3/9'), 'roomfavs_setid_result'),
    { changed_from: 3, changed_to: 9 },
  );
  assert.deepEqual(
    clientResult(
      RoomFavsSetNameResponse,
      await handlers.audioCfgRoomFavs('audio/cfg/roomfavs/7/setname/3/Morning%20Radio'),
      'roomfavs_setname_result',
    ),
    [{ rename_slot: 3, rename_to: 'Morning Radio' }],
  );
  assert.deepEqual(
    clientResult(RoomFavsDeleteResponse, await handlers.audioCfgRoomFavs('audio/cfg/roomfavs/7/delete/3'), 'roomfavs_delete_result'),
    { delete_id: 3 },
  );
});

test('client commands: setplus switches a favourite in and out of the plus round', async () => {
  const calls: unknown[][] = [];
  const handlers = roomFavHandlers(calls);
  assert.deepEqual(
    clientResult(RoomFavsSetPlusResponse, await handlers.audioCfgRoomFavs('audio/cfg/roomfavs/7/setplus/3/0'), 'roomfavs_setplus_result'),
    { plus: false, id: 3 },
  );
  assert.deepEqual(
    clientResult(RoomFavsSetPlusResponse, await handlers.audioCfgRoomFavs('audio/cfg/roomfavs/7/setplus/3/1'), 'roomfavs_setplus_result'),
    { plus: true, id: 3 },
  );
  assert.deepEqual(calls, [
    ['setPlus', 7, 3, false],
    ['setPlus', 7, 3, true],
  ]);
});

test('client commands: roomfav/plus steps over a favourite that is switched out of the round', async () => {
  const played: number[] = [];
  const metadata: Record<string, unknown> = { lastFavoriteId: 1 };
  const favorites = [
    { id: 1, slot: 1, plus: true, audiopath: 'a', name: 'A', type: 'tunein' },
    { id: 2, slot: 2, plus: false, audiopath: 'b', name: 'B', type: 'tunein' },
    { id: 3, slot: 3, plus: true, audiopath: 'c', name: 'C', type: 'tunein' },
  ];
  const handlers = createZoneHandlers(
    {
      getState: () => ({ audiopath: 'a' }),
      getMetadata: () => metadata,
      playContent: async () => {},
      handleCommand: () => {},
      queue: { setPendingShuffle: () => {} },
    } as any,
    { get: async () => ({}) } as any,
    {
      get: async () => ({ items: favorites }),
      getForPlayback: async (_zone: number, id: number) => {
        played.push(id);
        return undefined;
      },
    } as any,
    { resolveMetadata: async () => null } as any,
    {} as any,
    {} as any,
  );
  await handlers.audioRoomFavPlus('audio/7/roomfav/plus');
  assert.deepEqual(played, [3], 'from favourite 1 the round goes to 3, not to the switched-off 2');
});

// --- custom radio (shared-app.js 7318) and storage (10271, 10460, 10555) ----------

/** `ModifyCustomRadioStationSchema`. */
const RadiosModifyResponse = BaseResponse.extend({
  radios_result: z.object({
    action: z.literal('modify'),
    id: z.string().optional(),
    name: z.string(),
    url: z.string(),
    error: z.number(),
    errorInfo: z.string().optional(),
  }),
});

/** `StorageListEntrySchema`. */
const StorageListEntry = z.object({
  name: z.string(),
  server: z.string(),
  folder: z.string(),
  guest: z.boolean(),
  id: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  type: z.string().optional(),
  configerror: z.number().catch(-1),
});
/** `StorageEditSchema`. */
const StorageEditResponse = BaseResponse.extend({ storage_result: StorageListEntry });
/** `StorageListSchema`. */
const StorageListResponse = BaseResponse.extend({ storage_result: z.array(StorageListEntry) });
/** `StorageDeleteSchema`. */
const StorageDeleteResponse = BaseResponse.extend({
  storage_result: z.object({ id: z.string(), error: z.coerce.boolean() }),
});

function providerHandlers(content: Record<string, unknown>, events: unknown[][] = []) {
  const notifier = new Proxy(
    {},
    { get: (_target, name) => (...args: unknown[]) => events.push([String(name), ...args]) },
  );
  return createProviderHandlers(content as any, notifier as any);
}

test('client commands: a custom station is renamed and re-pointed, and the app is told', async () => {
  const updates: unknown[][] = [];
  const events: unknown[][] = [];
  const handlers = providerHandlers(
    {
      updateCustomRadio: async (id: string, name: string, stream: string) => {
        updates.push([id, name, stream]);
        return id === 'known' ? { id, name, stream } : null;
      },
    },
    events,
  );
  // The url arrives as path segments of its own, and credentials ride behind `?q&`.
  const ok = await handlers.audioCfgRadiosModify(
    'audio/cfg/radios/modify/known/Jazz%20FM/http://stream.example/jazz.mp3/?q&dXNlcjpwYXNz',
  );
  assert.deepEqual(clientResult(RadiosModifyResponse, ok, 'radios_result'), {
    action: 'modify',
    id: 'known',
    name: 'Jazz FM',
    url: 'http://stream.example/jazz.mp3',
    error: 0,
  });
  assert.deepEqual(updates, [['known', 'Jazz FM', 'http://stream.example/jazz.mp3']]);
  assert.deepEqual(events, [['notifyCustomUrlChanged', 'changed', 'known']]);

  const missing = await handlers.audioCfgRadiosModify('audio/cfg/radios/modify/gone/Jazz/http://stream.example/j.mp3');
  assert.equal((clientResult(RadiosModifyResponse, missing, 'radios_result') as { error: number }).error, -3);

  const notAUrl = await handlers.audioCfgRadiosModify('audio/cfg/radios/modify/known/Jazz/ftp:stream');
  assert.equal((clientResult(RadiosModifyResponse, notAUrl, 'radios_result') as { error: number }).error, -1);
});

test('client commands: a network share is edited in place and keeps its password when none is sent', async () => {
  const updates: unknown[][] = [];
  const handlers = providerHandlers({
    updateStorage: async (id: string, changes: Record<string, unknown>) => {
      updates.push([id, changes]);
      return { id, name: 'Music', server: 'nas2', folder: 'media', guest: false, type: 'cifs', username: 'me' };
    },
    listStorages: async () => [],
    rescanLibrary: async () => {},
  });
  // What the app sends: base64 of the JSON details (`_encodeNetworkFolderDetails`).
  const details = { name: 'Music', server: 'nas2', folder: 'media', guest: false, username: 'me' };
  const payload = Buffer.from(JSON.stringify(details)).toString('base64');
  const result = await handlers.audioCfgStorageEdit(`audio/cfg/storage/edit/storage-1/${payload}`);
  const entry = clientResult(StorageEditResponse, result, 'storage_result') as z.infer<typeof StorageListEntry>;
  assert.equal(entry.id, 'storage-1');
  assert.equal(entry.server, 'nas2');
  assert.equal(entry.configerror, 0);
  const [id, changes] = updates[0] as [string, Record<string, unknown>];
  assert.equal(id, 'storage-1');
  assert.equal(changes.server, 'nas2');
  assert.equal(changes.password, undefined, 'no password in the payload leaves the stored one alone');
});

test('client commands: an edit of a share that does not exist is an error the app can read', async () => {
  const handlers = providerHandlers({ updateStorage: async () => null });
  const payload = Buffer.from(JSON.stringify({ name: 'X', server: 's', folder: 'f', guest: true })).toString('base64');
  const result = await handlers.audioCfgStorageEdit(`audio/cfg/storage/edit/nope/${payload}`);
  const entry = clientResult(StorageEditResponse, result, 'storage_result') as z.infer<typeof StorageListEntry>;
  assert.equal(entry.configerror, 1);
});

test('client commands: listing and deleting shares parse, guest flag or not', async () => {
  const handlers = providerHandlers({
    // A share saved without a guest flag: the app wants a boolean regardless.
    listStorages: async () => [{ id: 's1', name: 'Music', server: 'nas', folder: 'media', type: 'cifs' }],
    deleteStorage: async () => {},
    rescanLibrary: async () => {},
  });
  const list = clientResult(StorageListResponse, await handlers.audioCfgStorageList('audio/cfg/storage/list'), 'storage_result');
  assert.equal((list as Array<{ guest: boolean }>)[0]!.guest, false);
  assert.deepEqual(
    clientResult(StorageDeleteResponse, await handlers.audioCfgStorageDel('audio/cfg/storage/delete/s1'), 'storage_result'),
    { id: 's1', error: false },
  );
});

// --- paged category search (shared-app.js 8957, preprocessing 579194) -----------

/**
 * The raw shape `PreProcessing` reads: `[0].results[0]`, told apart by `where`. The items are
 * left open here — they are the same items a global search carries, and those have their own
 * schemas.
 */
const SearchResultRaw = z.object({
  where: z.enum(['spotify', 'local', 'library', 'radio']),
  // The preprocessing copies this onto every item as its `serviceId`, which is a required
  // string — so `user` is required in practice, for the library and radio too.
  user: z.string(),
  tag: z.coerce.string(),
  offset: z.number().default(0),
  limit: z.number().optional(),
  totalitems: z.number().optional(),
  items: z.array(z.record(z.string(), z.unknown())),
});
const SearchResponse = BaseResponse.extend({
  search_result: z.array(z.object({ results: z.array(SearchResultRaw).min(1) })).min(1),
});

function searchHandlers(found: Record<string, unknown>, seen: string[][] = []) {
  return createGlobalSearchHandlers(
    {
      globalSearch: async (source: string, query: string) => {
        seen.push([source, query]);
        return { result: found, user: 'bridge-1', providerId: 'spotify' };
      },
    } as any,
    {} as any,
  );
}

const rows = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `t${i}`, name: `Track ${i}`, type: 2 }));

test('client commands: a search category opens in full, one page at a time', async () => {
  const seen: string[][] = [];
  const handlers = searchHandlers({ tracks: rows(70) }, seen);

  const first = await handlers.audioCfgSearch('audio/cfg/search/spotify/bridge-1/track/daft%20punk/0/50');
  const page1 = (clientResult(SearchResponse, first, 'search_result') as any)[0].results[0];
  assert.equal(page1.where, 'spotify');
  assert.equal(page1.user, 'bridge-1');
  assert.equal(page1.items.length, 50);
  assert.ok(page1.totalitems > 50, 'a full page says there is more, so the app asks again');
  assert.deepEqual(seen[0], ['spotify@bridge-1:track#50', 'daft punk']);

  const second = await handlers.audioCfgSearch('audio/cfg/search/spotify/bridge-1/track/daft%20punk/50/50');
  const page2 = (clientResult(SearchResponse, second, 'search_result') as any)[0].results[0];
  assert.equal(page2.items.length, 20);
  assert.equal(page2.items[0].id, 't50');
  assert.equal(page2.totalitems, 70, 'a short page is the end of the list');
});

test('client commands: the library and radio searches answer as `local` and `radio`', async () => {
  const seen: string[][] = [];
  const library = searchHandlers({ albums: rows(3) }, seen);
  const local = (clientResult(
    SearchResponse,
    await library.audioCfgSearch('audio/cfg/search/local/local/album/abbey/0/50'),
    'search_result',
  ) as any)[0].results[0];
  assert.equal(local.where, 'local');
  assert.equal(local.items.length, 3);
  assert.deepEqual(seen[0], ['local:album#50', 'abbey']);

  // Radio categories are named in the singular on both sides.
  const radio = searchHandlers({ station: rows(2) }, seen);
  const stations = (clientResult(
    SearchResponse,
    await radio.audioCfgSearch('audio/cfg/search/radio/nouser/station/jazz/0/50'),
    'search_result',
  ) as any)[0].results[0];
  assert.equal(stations.where, 'radio');
  assert.equal(stations.items.length, 2);
  assert.deepEqual(seen[1], ['tunein:station#50', 'jazz']);
});

test('client commands: a search that fails still answers, with nothing in it', async () => {
  const handlers = createGlobalSearchHandlers(
    {
      globalSearch: async () => {
        throw new Error('provider down');
      },
    } as any,
    {} as any,
  );
  const result = await handlers.audioCfgSearch('audio/cfg/search/spotify/bridge-1/track/x/0/50');
  const page = (clientResult(SearchResponse, result, 'search_result') as any)[0].results[0];
  assert.deepEqual(page.items, []);
});

// --- queue move (shared-app.js 14413) ---------------------------------------------

/** `QueueMoveSchema`: `move_result: z.unknown()` — anything, as long as it is there. */
const QueueMoveResponse = BaseResponse.extend({ move_result: z.unknown() });

function queueHandlers(moves: unknown[][]) {
  return createQueueEditHandlers(
    {
      queue: {
        moveBeforeUniqueId: (zoneId: number, src: string, target: string) => {
          moves.push([zoneId, src, target]);
          return true;
        },
      },
    } as any,
    {} as any,
    {} as any,
  );
}

test('client commands: a queue item is moved before another, or to the end', async () => {
  const moves: unknown[][] = [];
  const handlers = queueHandlers(moves);
  // The app sends the second form — no `before` — when the drop lands past the last row.
  clientResult(QueueMoveResponse, await handlers.queueMove('audio/7/queue/move/uid-3/before/uid-1'), 'move_result');
  clientResult(QueueMoveResponse, await handlers.queueMove('audio/7/queue/move/uid-3/end'), 'move_result');
  assert.deepEqual(moves, [
    [7, 'uid-3', 'uid-1'],
    [7, 'uid-3', 'end'],
  ]);
});

// --- routing ------------------------------------------------------------------------

/**
 * The real route table, with every dependency a stub that answers anything. Enough to ask
 * one question of it: does this command reach a handler of its own, or fall through to the
 * empty answer the router gives a command it does not know?
 */
function routedName(command: string): Promise<string> {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === 'then' ? undefined : anything),
    apply: () => anything,
  });
  const router = new LoxoneRouter();
  registerRoutes(router, new Proxy({}, { get: () => anything }) as any);
  return router.dispatch(command).then((result) => result.name);
}

test('client commands: the commands the app sends each have a route', async () => {
  const expected: Array<[string, string]> = [
    ['audio/7/queue/move/uid-3/end', 'move'],
    ['audio/7/queue/move/uid-3/before/uid-1', 'move'],
    ['audio/cfg/search/spotify/bridge-1/track/daft%20punk/0/50', 'search'],
    ['audio/cfg/radios/modify/id-1/Jazz/http://stream.example/j.mp3', 'radios'],
    ['audio/cfg/storage/edit/storage-1/e30=', 'storage'],
    ['audio/cfg/storage/delete/storage-1', 'storage'],
  ];
  for (const [command, name] of expected) {
    assert.equal(await routedName(command), name, `${command} is not routed`);
  }
});

// --- transport and play commands (shared-app.js 11940–17911) ------------------------

/** `PlaySchema`, `PauseSchema`, `SetVolumeSchema`: a bare boolean each. */
const PlayResponse = BaseResponse.extend({ play_result: z.boolean() });
const PauseResponse = BaseResponse.extend({ pause_result: z.boolean() });
const VolumeResponse = BaseResponse.extend({ volume_result: z.boolean() });
/** `SetPositionScheme`: an array, of which the client takes the first. */
const PositionResponse = BaseResponse.extend({ position_result: z.array(z.object({ position: z.number() })).min(1) });
/** `RepeatSchema`: `RepeatMode` is 0, 1 or 3. */
const RepeatResponse = BaseResponse.extend({
  repeat_result: z.object({ repeat: z.union([z.literal(0), z.literal(1), z.literal(3)]) }),
});
/** `ShuffleSchema`. */
const ShuffleResponse = BaseResponse.extend({ shuffle_result: z.object({ shuffle: z.boolean() }) });
/** `ServicePlayScheme`: the string, or an error object. */
const ServicePlayResponse = BaseResponse.extend({
  serviceplay_result: z.union([z.literal('ok'), z.object({ error: z.number(), message: z.string() })]).optional(),
});
/** `PlayUrlScheme`. */
const PlayUrlResponse = BaseResponse.extend({ playurl_result: z.object({ uri: z.string() }).optional() });
/** `LineInPlayScheme` — and `PlaylistPlayScheme`, which reads the same key. */
const LineInResponse = BaseResponse.extend({ linein_result: z.object({ action: z.literal('play') }).optional() });
/** `LibraryPlayScheme`: anything, under `play_result`. */
const LibraryPlayResponse = BaseResponse.extend({ play_result: z.unknown().optional() });
/** `RoomFavPlayScheme` / `RoomFavPlusScheme`. */
const RoomFavResponse = BaseResponse.extend({
  roomfav_result: z.array(z.object({ playerid: z.number(), playing_slot: z.number() })).optional(),
});
/** `ClearRecentlyPlayedScheme`: the list has to come back empty. */
const RecentClearResponse = BaseResponse.extend({
  recent_result: z.object({ items: z.array(z.unknown()).max(0), ts: z.number() }),
});
/** `SetAllEqualizerLevelsSchema` and `SetSingleEqualizerLevelSchema` — one command, two answers. */
const SetEqAllResponse = BaseResponse.extend({
  seteq_result: z.array(z.object({ band: z.number(), value: z.number() })).min(1),
});
const SetEqSingleResponse = BaseResponse.extend({
  seteq_result: z.object({ id: z.string(), name: z.string(), type: z.string(), values: z.array(z.number()) }),
});
/** `RescanScheme`. */
const RescanResponse = BaseResponse.extend({ rescan_result: z.boolean() });

function playbackHandlers(options: { shuffle?: number; commands?: unknown[][]; played?: unknown[][] } = {}) {
  const bands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return createZoneHandlers(
    {
      getState: () => ({ plshuffle: options.shuffle ?? 0, audiopath: '' }),
      getMetadata: () => ({}),
      handleCommand: (...args: unknown[]) => options.commands?.push(args),
      playContent: async (...args: unknown[]) => {
        options.played?.push(args);
      },
      queue: { setPendingShuffle: () => {}, seekInQueue: () => false },
      setEqualizerBands: async (zoneId: number, next: number[]) => ({
        zoneId,
        bands: next,
        equalizerSettings: next.join(','),
      }),
    } as any,
    {
      cleared: [] as number[],
      clear: async function (this: { cleared: number[] }, zoneId: number) {
        this.cleared.push(zoneId);
      },
      get: async function (this: { cleared: number[] }) {
        return this.cleared.length ? { items: [], ts: 1700000000 } : { items: [{ title: 'x' }], ts: 1 };
      },
    } as any,
    { get: async () => ({ items: [] }) } as any,
    { resolveMetadata: async () => null } as any,
    { getConfig: () => ({ zones: [{ id: 7, equalizer: { bands } }] }) } as any,
  );
}

test('client commands: play, pause, volume, seek, repeat and shuffle each answer in their own shape', async () => {
  const commands: unknown[][] = [];
  const handlers = playbackHandlers({ commands });
  assert.equal(clientResult(PlayResponse, await handlers.audioDynamicCommand('audio/7/play'), 'play_result'), true);
  assert.equal(clientResult(PauseResponse, await handlers.audioDynamicCommand('audio/7/pause'), 'pause_result'), true);
  assert.equal(clientResult(VolumeResponse, await handlers.audioDynamicCommand('audio/7/volume/35'), 'volume_result'), true);
  assert.equal(clientResult(VolumeResponse, await handlers.audioDynamicCommand('audio/7/volume/+3'), 'volume_result'), true);
  assert.deepEqual(
    clientResult(PositionResponse, await handlers.audioDynamicCommand('audio/7/position/42'), 'position_result'),
    [{ position: 42 }],
  );
  for (const mode of [0, 1, 3]) {
    assert.deepEqual(
      clientResult(RepeatResponse, await handlers.audioDynamicCommand(`audio/7/repeat/${mode}`), 'repeat_result'),
      { repeat: mode },
    );
  }
  assert.deepEqual(commands[0], [7, 'play', '']);
  assert.deepEqual(commands[2], [7, 'volume', '35']);
});

test('client commands: shuffle is a switch when told, and a toggle when not', async () => {
  const off = playbackHandlers({ shuffle: 0 });
  const on = playbackHandlers({ shuffle: 1 });
  const shuffle = async (handlers: ReturnType<typeof playbackHandlers>, command: string) =>
    (clientResult(ShuffleResponse, await handlers.audioDynamicCommand(command), 'shuffle_result') as { shuffle: boolean })
      .shuffle;
  assert.equal(await shuffle(off, 'audio/7/shuffle/enable'), true);
  assert.equal(await shuffle(on, 'audio/7/shuffle/disable'), false);
  assert.equal(await shuffle(off, 'audio/7/shuffle'), true, 'a bare shuffle turns it on from off');
  assert.equal(await shuffle(on, 'audio/7/shuffle'), false, 'and off from on');
});

test('client commands: the four ways to start something each answer what the app reads', async () => {
  const played: unknown[][] = [];
  const handlers = playbackHandlers({ played });
  assert.equal(
    clientResult(
      ServicePlayResponse,
      await handlers.audioServicePlay('audio/7/serviceplay/spotify/bridge-1/spotify:track:abc/noshuffle'),
      'serviceplay_result',
    ),
    'ok',
  );
  const url = clientResult(PlayUrlResponse, await handlers.audioPlayUrl('audio/7/playurl/library:local:track:9'), 'playurl_result');
  assert.equal(typeof (url as { uri: string }).uri, 'string');
  // The playlist command answers under the line-in name: that is the key the app's schema holds.
  assert.deepEqual(
    clientResult(LineInResponse, await handlers.audioPlaylistPlay('audio/7/playlist/play/playlist:5/noshuffle'), 'linein_result'),
    { action: 'play' },
  );
  clientResult(LibraryPlayResponse, await handlers.audioLibraryPlay('audio/7/library/play/library:local:track:9'), 'play_result');
  assert.equal(played.length, 4, 'and each of them still starts the zone');
});

test('client commands: roomfav/plus answers with the slot it went to', async () => {
  const handlers = createZoneHandlers(
    {
      getState: () => ({ audiopath: 'a' }),
      getMetadata: () => ({ lastFavoriteId: 1 }),
      playContent: async () => {},
      handleCommand: () => {},
      queue: { setPendingShuffle: () => {} },
    } as any,
    {} as any,
    {
      get: async () => ({
        items: [
          { id: 1, slot: 1, plus: true, audiopath: 'a', name: 'A', type: 'tunein' },
          { id: 4, slot: 2, plus: true, audiopath: 'b', name: 'B', type: 'tunein' },
        ],
      }),
      getForPlayback: async () => undefined,
    } as any,
    { resolveMetadata: async () => null } as any,
  );
  assert.deepEqual(clientResult(RoomFavResponse, await handlers.audioRoomFavPlus('audio/7/roomfav/plus'), 'roomfav_result'), [
    { playerid: 7, playing_slot: 4 },
  ]);
});

test('client commands: clearing recently played clears it and hands the empty list back', async () => {
  const handlers = playbackHandlers();
  const before = JSON.parse(serializeResult(await handlers.audioRecent('audio/7/recent')));
  assert.equal(before.recent_result.items.length, 1, 'reading the list does not clear it');
  assert.deepEqual(clientResult(RecentClearResponse, await handlers.audioRecent('audio/7/recent/clear'), 'recent_result'), {
    items: [],
    ts: 1700000000,
  });
});

test('client commands: setting the whole equalizer and setting one band answer differently', async () => {
  const handlers = playbackHandlers();
  const all = clientResult(SetEqAllResponse, await handlers.audioCfgSetEq('audio/cfg/seteq/7/1,2,3,0,0,0,0,0,-1,-2'), 'seteq_result');
  assert.deepEqual((all as Array<{ band: number; value: number }>)[1], { band: 1, value: 2 });
  const one = clientResult(SetEqSingleResponse, await handlers.audioCfgSetEq('audio/cfg/seteq/7/2/4'), 'seteq_result') as {
    id: string;
    values: number[];
  };
  assert.equal(one.id, '2');
  assert.equal(one.values[2], 4);
});

test('client commands: a rescan answers that it started', async () => {
  const handlers = providerHandlers({ rescanLibrary: async () => {} });
  assert.equal(clientResult(RescanResponse, await handlers.audioCfgRescan('audio/cfg/rescan'), 'rescan_result'), true);
});

test('client commands: starting a line-in answers that it plays', async () => {
  const activated: unknown[][] = [];
  const handlers = createInputHandlers({} as any, {
    lineIn: {
      listLineInInputs: () => [{ id: 'linein-1', name: 'Turntable', iconType: 8 }],
      activateLineIn: (...args: unknown[]) => activated.push(args),
    },
    notifier: {},
  } as any);
  assert.deepEqual(clientResult(LineInResponse, await handlers.audioLineIn('audio/7/linein/linein-1'), 'linein_result'), {
    action: 'play',
  });
  assert.equal(activated.length, 1);
  assert.equal(activated[0]![0], 7);
});
