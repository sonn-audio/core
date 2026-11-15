import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { test } from './testHarness';
import { makeNotifierFake } from './fakes/notifierPort';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { createGlobalSearchHandlers } from '../src/adapters/loxone/commands/handlers/globalSearchHandlers';
import { createInputHandlers } from '../src/adapters/loxone/commands/handlers/inputHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import {
  forLoxoneFolder,
  shapeServiceItemsForLoxone,
  stripNeutralItemFields,
} from '../src/adapters/loxone/commands/utils/loxoneItems';
import { LocalLibraryProvider } from '../src/adapters/content/providers/localLibraryProvider';
import { TuneInProvider } from '../src/adapters/content/providers/tunein/tuneinProvider';
import { SpotifyServiceManager } from '../src/adapters/content/providers/spotifyServiceManager';
import type { ContentItemKind } from '../src/domain/media/contentKind';
import type { ContentFolderItem } from '../src/ports/ContentTypes';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * The native client's list contract, transcribed — what a row has to look like.
 *
 * Read out of the shipped client (Loxone.app 17.3.0, `www/shared-app.js`) and written in the
 * same zod the client uses; module ids are quoted per schema. `docs/loxone-client-map.md` has
 * the surrounding picture.
 *
 * These are the *raw* schemas — the ones the client's `responsePreProcessing` runs on what we
 * send, before it renames anything. They are where a list lives or dies:
 *
 * - Service folders and searches try each row against a fixed list of shapes and take the
 *   first that fits. There is no per-row catch: a row that fits none fails the whole answer,
 *   and the screen that asked for it stays empty.
 * - The first fit is not always the right one. The list ends in two shapes that only look at
 *   `type`, so a track that misses its own shape is still accepted — as a radio station.
 *
 * So each check here asks two things: is the row accepted, and as what.
 */

// --- shared (modules 246494, 12051) ----------------------------------------------

/** `BaseServiceResultScheme`. */
const BaseServiceResult = z.object({
  id: z.coerce.string(),
  start: z.number(),
  totalitems: z.number(),
  name: z.string().optional(),
});

/** `ServiceBaseItemScheme`, module 12051. */
const ServiceBaseItem = z.object({
  id: z.string().optional(),
  type: z.number(),
  name: z.string(),
  coverurl: z.string().optional(),
  audiopath: z.string().optional(),
  unplayable: z.coerce.boolean().default(false),
});

const anyOf = (...values: number[]) => z.union(values.map((value) => z.literal(value)) as [z.ZodLiteral<number>, z.ZodLiteral<number>]);

// --- service rows (modules 29748, 359200, 263460; union order from 11119) ---------

/**
 * The row shapes of a service folder, in the order the client tries them. The order is part of
 * the contract: the two radio shapes at the end accept any row of type 1 or 2.
 */
const SERVICE_ROW_SHAPES: Array<[name: string, schema: z.ZodType]> = [
  ['soundsuit-station', ServiceBaseItem.extend({ type: z.literal(3) })],
  ['soundsuit-schedule', ServiceBaseItem.omit({ id: true }).extend({ type: z.literal(3), linkurl: z.string(), id: z.number() })],
  [
    'track',
    ServiceBaseItem.extend({
      tag: z.literal('track'),
      type: z.literal(2),
      duration: z.number().optional(),
      album: z.string().optional(),
      artist: z.string().optional(),
      thumbnail: z.string(),
      trackid: z.number().optional(),
      title: z.string().optional(),
      name: z.string().optional(),
    }),
  ],
  ['category', ServiceBaseItem.extend({ tag: z.literal('category'), type: z.literal(1) })],
  [
    'playlist',
    ServiceBaseItem.extend({
      tag: z.literal('playlist'),
      type: anyOf(12, 11, 7),
      followed: z.boolean().optional(),
      owner: z.string().optional(),
    }),
  ],
  [
    'album',
    ServiceBaseItem.extend({
      tag: z.literal('album'),
      type: anyOf(12, 11, 7),
      followed: z.boolean().optional(),
      owner: z.string().optional(),
      artist: z.string().optional(),
    }),
  ],
  ['artist', ServiceBaseItem.extend({ tag: z.literal('artist'), type: anyOf(12, 7), followed: z.boolean().optional() })],
  [
    'show',
    ServiceBaseItem.extend({
      tag: z.literal('show'),
      type: anyOf(12, 7),
      description: z.string().optional(),
      publisher: z.string().optional(),
    }),
  ],
  [
    'episode',
    ServiceBaseItem.extend({
      tag: z.literal('episode'),
      type: z.literal(2),
      description: z.string().optional(),
      duration: z.number().optional(),
    }),
  ],
  ['radio-folder', ServiceBaseItem.extend({ type: z.literal(1) })],
  ['radio-station', ServiceBaseItem.extend({ type: z.literal(2), station: z.string().optional(), streamurl: z.string().optional() })],
];

/** The shape the client reads a row as, or null when it fits none and the answer dies. */
function serviceRowShape(row: unknown): string | null {
  return SERVICE_ROW_SHAPES.find(([, schema]) => schema.safeParse(row).success)?.[0] ?? null;
}

/** `getservicefolder`'s raw answer, module 11119. */
const GetServiceFolderRaw = z.object({
  command: z.string(),
  getservicefolder_result: z
    .array(
      BaseServiceResult.extend({
        items: z.array(z.unknown().refine((row) => serviceRowShape(row) !== null, 'fits no row shape')),
      }),
    )
    .min(1),
});

/** What each of our kinds should be drawn as. */
const EXPECTED_SHAPE: Record<ContentItemKind, string> = {
  track: 'track',
  episode: 'episode',
  album: 'album',
  playlist: 'playlist',
  artist: 'artist',
  show: 'show',
  category: 'radio-folder',
  folder: 'radio-folder',
  radio: 'radio-station',
};

const KINDS = Object.keys(EXPECTED_SHAPE) as ContentItemKind[];

/** A row the way providers build them: by kind alone, by tag alone, or both. */
function rowsOfKind(kind: ContentItemKind): ContentFolderItem[] {
  const base = { id: `${kind}-1`, name: `A ${kind}`, coverurl: 'http://cover/1', audiopath: `svc:${kind}:1` };
  return [{ ...base, kind }, { ...base, tag: kind }, { ...base, kind, tag: kind }];
}

test('client lists: every kind of service row is accepted, and as what it is', () => {
  for (const kind of KINDS) {
    for (const row of shapeServiceItemsForLoxone(rowsOfKind(kind))) {
      assert.equal(
        serviceRowShape(row),
        // A tagged category has a shape of its own; an untagged one is a plain folder.
        kind === 'category' && row.tag === 'category' ? 'category' : EXPECTED_SHAPE[kind],
        `${kind} ${JSON.stringify(row)}`,
      );
      assert.equal('kind' in row, false, 'the neutral kind stays off the wire');
    }
  }
});

test('client lists: a container the producer gave an affordance keeps it, where the app allows it', () => {
  const [playlist, artist] = shapeServiceItemsForLoxone([
    { id: 'p', name: 'P', kind: 'playlist', type: 11 },
    // An artist cannot be edited: the app's artist shape has no 11, so it falls back to browsable.
    { id: 'a', name: 'A', kind: 'artist', type: 11 },
  ]);
  assert.equal(playlist!.type, 11);
  assert.equal(serviceRowShape(playlist), 'playlist');
  assert.equal(artist!.type, 7);
  assert.equal(serviceRowShape(artist), 'artist');
  const [followable] = shapeServiceItemsForLoxone([{ id: 'a', name: 'A', kind: 'artist', followable: true }]);
  assert.equal(followable!.type, 12);
});

test('client lists: these are the rows the app would refuse or misdraw without the shaping', () => {
  // Not a claim about our emit — a claim about the client, kept next to the step that answers
  // it. `stripNeutralItemFields` is the plain projection the library uses.
  const plain = (item: ContentFolderItem) => stripNeutralItemFields([item])[0];
  // A container known only by its kind has no tag: no shape takes it, and the folder is lost.
  assert.equal(serviceRowShape(plain({ id: 'x', name: 'X', kind: 'album' })), null);
  // A category is a container to us and a folder to the app.
  assert.equal(serviceRowShape(plain({ id: 'x', name: 'X', kind: 'category', tag: 'category' })), null);
  // A track without a thumbnail is accepted — by the last shape on the list.
  assert.equal(serviceRowShape(plain({ id: 'x', name: 'X', kind: 'track', tag: 'track', coverurl: 'c' })), 'radio-station');
});

test('client lists: a service folder of mixed rows reaches the app whole', async () => {
  const items = KINDS.flatMap(rowsOfKind);
  const handlers = createProviderHandlers(
    {
      getServiceFolder: async (_service: string, _user: string, id: string, start: number) => ({
        id,
        name: 'Browse',
        start,
        totalitems: items.length,
        items,
      }),
    } as any,
    {} as any,
  );
  const command = 'audio/cfg/getservicefolder/spotify/bridge-1/some-folder/0/50';
  const frame = JSON.parse(serializeResult(await handlers.audioCfgGetServiceFolder(command)));
  const parsed = GetServiceFolderRaw.safeParse(frame);
  assert.ok(parsed.success, `the app drops the folder: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
  // The app takes each row's `serviceId` from the fifth segment of the echoed command.
  assert.equal(frame.command.split('/')[4], 'bridge-1');
  assert.equal(frame.getservicefolder_result[0].items.length, items.length);
});

test('client lists: a streaming search result is shaped like a service folder, the library one is not', async () => {
  const sent: Array<Record<string, any>> = [];
  const notifier = { notifyGlobalSearchResult: (result: Record<string, any>) => sent.push(result), notifyGlobalSearchError: () => {} };
  const searchWith = async (providerId: string, source: string) => {
    const handlers = createGlobalSearchHandlers(
      {
        globalSearch: async () => ({
          result: { tracks: [{ id: 't', name: 'T', kind: 'track', coverurl: 'http://cover' }], albums: [{ id: 'a', name: 'A', kind: 'album', type: 1 }] },
          user: 'u',
          providerId,
        }),
      } as any,
      notifier as any,
    );
    await handlers.audioCfgGlobalSearch(`audio/cfg/globalsearch/${source}/abba`);
    await new Promise((resolve) => setImmediate(resolve));
    return sent[sent.length - 1]!;
  };

  const streaming = await searchWith('spotify', 'spotify@u:track#5,album#5');
  assert.equal(serviceRowShape(streaming.tracks[0]), 'track');
  assert.equal(serviceRowShape(streaming.albums[0]), 'album');

  // A library album is a folder (type 1) in the library's own schema; shaping it as a service
  // row would turn it into a container the library schema refuses.
  const library = await searchWith('local', 'local:track#5,album#5');
  assert.equal(library.albums[0].type, 1);
  assert.equal(library.albums[0].tag, undefined);
});

// --- the local library (module 896212) ---------------------------------------------

/**
 * `LibraryItemBaseScheme`, plus the one thing its final union adds: a row is a folder or a
 * file. The booleans are plain `z.boolean()` — a 0 or a 1 fails them.
 */
const LibraryRow = z.object({
  album: z.string().optional(),
  artist: z.string().optional(),
  duration: z.number().optional().default(0),
  external: z.boolean().optional().default(false),
  hasCover: z.boolean().optional().default(false),
  id: z.coerce.string(),
  name: z.string(),
  sort: z.string().optional().default(''),
  type: anyOf(1, 2),
  coverurl: z.string().optional(),
  usb: z.coerce.boolean().default(false),
  nas: z.coerce.boolean().default(false),
});
const GetMediaFolderRaw = z.object({
  command: z.string(),
  getmediafolder_result: z.array(BaseServiceResult.extend({ items: z.array(LibraryRow) })).min(1),
});

const libraryConfigPort = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
} as unknown as ConfigPort;

test('client lists: every folder of a real library, root to track, is one the app accepts', async () => {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-client-lists-'));
  try {
    process.chdir(tempDir);
    const album = path.join(tempDir, 'data', 'music', 'local', 'Various Artists', 'Sampler');
    await fs.mkdir(album, { recursive: true });
    await fs.writeFile(path.join(album, '01 - First.mp3'), '');
    await fs.writeFile(path.join(album, '02 - Second.mp3'), '');

    const provider = new LocalLibraryProvider(makeNotifierFake(), libraryConfigPort);
    // Index the files, so the album and artist views have something behind them too.
    await provider.syncPath('local/Various Artists/Sampler/01 - First.mp3');
    await provider.syncPath('local/Various Artists/Sampler/02 - Second.mp3');
    const handlers = createProviderHandlers(
      { getMediaFolder: (id: string, start: number, limit: number) => provider.getMediaFolder(id, start, limit) } as any,
      {} as any,
    );

    // Walk it the way the app does: open the root, then everything that says it is a folder.
    const seen = new Set<string>();
    const queue = ['0'];
    let rows = 0;
    let tracks = 0;
    while (queue.length && seen.size < 60) {
      const folderId = queue.shift()!;
      if (seen.has(folderId)) continue;
      seen.add(folderId);
      const command = `audio/cfg/getmediafolder/${encodeURIComponent(folderId)}/0/50`;
      const frame = JSON.parse(serializeResult(await handlers.audioCfgGetMediaFolder(command)));
      if (!frame.getmediafolder_result.length) continue;
      const parsed = GetMediaFolderRaw.safeParse(frame);
      assert.ok(
        parsed.success,
        `the app drops library folder ${folderId}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
      );
      for (const row of parsed.data.getmediafolder_result[0]!.items) {
        rows += 1;
        if (row.type === 1) queue.push(row.id);
        else tracks += 1;
      }
    }
    assert.ok(rows > 0, 'the walk found the library');
    assert.ok(tracks > 0, 'and reached its tracks');
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('client lists: a library row that is neither folder nor file takes the folder with it', () => {
  // The library's union has two members. A container type from the service vocabulary —
  // which is what a kind-only album derives to — is not one of them.
  const album = forLoxoneFolder({ items: [{ id: 'a', name: 'A', kind: 'album' as const }] }).items[0];
  assert.equal(LibraryRow.safeParse(album).success, false);
  assert.equal(LibraryRow.safeParse({ ...album, type: 1 }).success, true);
});

// --- local playlists (module 243696) ---------------------------------------------------

/** A playlist row, and a row of a track inside one. */
const PlaylistRow = z.object({
  coverurl: z.string().optional(),
  audiopath: z.string().optional(),
  id: z.string(),
  name: z.string(),
  type: z.literal(11),
});
const PlaylistTrackRow = z.object({
  type: z.literal(2),
  title: z.string(),
  album: z.string().optional(),
  artist: z.string().optional(),
  coverurl: z.string().optional(),
  audiopath: z.string().optional(),
  uniqueId: z.string(),
});
const GetPlaylistsRaw = z.object({
  command: z.string(),
  getplaylists2_result: z
    .array(BaseServiceResult.extend({ items: z.array(z.union([PlaylistRow, PlaylistTrackRow])) }))
    .min(1),
});

function playlistHandlers() {
  return createProviderHandlers(
    {
      getPlaylists: async () => [
        { id: '7', name: 'Morning', tracks: 2, audiopath: 'library:playlist:7', coverurl: 'http://cover/7' },
        { id: '8', name: 'No cover', tracks: 0, audiopath: 'library:playlist:8' },
      ],
      getLocalPlaylist: () => ({ name: 'Morning' }),
      getLocalPlaylistItems: async () => ({
        totalitems: 2,
        items: [
          { id: 't1', name: 'First', audiopath: 'library:local:track:1', artist: 'A', album: 'B', coverurl: 'http://c' },
          // A track with nothing but a path: the title still has to be a string.
          { id: 't2', audiopath: 'library:local:track:2' },
        ],
      }),
    } as any,
    {} as any,
  );
}

test('client lists: the playlists, and the tracks inside one, parse', async () => {
  const handlers = playlistHandlers();
  const list = JSON.parse(serializeResult(await handlers.audioCfgGetPlaylists('audio/cfg/getplaylists2/lms/nouser/0/0/50')));
  const parsedList = GetPlaylistsRaw.safeParse(list);
  assert.ok(parsedList.success, `playlists rejected: ${parsedList.success ? '' : JSON.stringify(parsedList.error.issues)}`);
  const first = list.getplaylists2_result[0].items[0];
  assert.equal(first.type, 11);

  const inside = JSON.parse(
    serializeResult(await handlers.audioCfgGetPlaylists(`audio/cfg/getplaylists2/lms/nouser/${first.id}/0/50`)),
  );
  const parsedInside = GetPlaylistsRaw.safeParse(inside);
  assert.ok(
    parsedInside.success,
    `playlist tracks rejected: ${parsedInside.success ? '' : JSON.stringify(parsedInside.error.issues)}`,
  );
  assert.equal(inside.getplaylists2_result[0].items.length, 2);
});

// --- line-ins (module 33801), radios (123942), services (309207) -------------------------

/** `RawInputItemScheme`. */
const InputRow = z.object({
  cmd: z.string(),
  description: z.string().optional(),
  icontype: z.number().catch(0),
  id: z.coerce.string(),
  name: z.string(),
  type: z.literal(6),
  as: z.string().optional(),
});
const GetInputsRaw = z.object({ command: z.string(), getinputs_result: z.array(InputRow) });

test('client lists: the line-ins parse', () => {
  const handlers = createInputHandlers({} as any, {
    lineIn: {
      listLineInInputs: () => [
        { id: '504F94FF1BB4#1000001', name: 'Turntable', iconType: 8, index: 0 },
        { id: 'custom', name: 'TV', iconType: 7, index: 1 },
      ],
    },
    notifier: {},
  } as any);
  const frame = JSON.parse(serializeResult(handlers.audioCfgGetInputs('audio/cfg/getinputs') as any));
  const parsed = GetInputsRaw.safeParse(frame);
  assert.ok(parsed.success, `line-ins rejected: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
  assert.equal(parsed.data.getinputs_result.length, 2);
});

/** `GetRadioSchema`: four strings, all required. */
const RadioMenuRow = z.object({ name: z.string(), icon: z.string(), cmd: z.string(), root: z.string() });

test('client lists: the radio menu parses', async () => {
  const tunein = new TuneInProvider({ list: async () => [] } as any);
  for (const entry of await tunein.getMenuEntries()) {
    assert.ok(RadioMenuRow.safeParse(entry).success, `radio menu entry rejected: ${JSON.stringify(entry)}`);
  }
});

/**
 * `ServiceConfigsScheme`: told apart by `cmd`, and there is no filter in front of it — an
 * entry under any other command fails the whole list of services.
 */
const ServiceEntry = z.object({
  cmd: z.literal('spotify'),
  configerror: z.boolean(),
  id: z.string(),
  name: z.string(),
  user: z.string(),
  asdefault: z.array(z.number()).optional(),
  icon: z.string().optional(),
  pbr: z.number().optional(),
  email: z.string().optional(),
  product: z.string().optional(),
});

test('client lists: every configured service, real and bridged, is one the app accepts', () => {
  const config = {
    content: {
      spotify: { accounts: [{ id: 'md123121', displayName: 'Rudy', email: 'r@example.com', product: 'premium' }] },
      streamingServices: [
        { id: 'bridge-applemusic-12lijl', label: 'Apple Music', provider: 'applemusic' },
        { id: 'bridge-ytmusic-c89xxz', label: 'YouTube Music', provider: 'ytmusic' },
      ],
    },
    system: { audioserver: { ip: '127.0.0.1' } },
  };
  const manager = new SpotifyServiceManager(
    { getConfig: () => config, load: async () => config, updateConfig: async () => {} } as unknown as ConfigPort,
    config.content.spotify.accounts,
    undefined,
    config.content.streamingServices,
  );
  const entries = manager.listServiceEntries();
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    const parsed = ServiceEntry.safeParse(entry);
    assert.ok(parsed.success, `service rejected: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
  }
});
