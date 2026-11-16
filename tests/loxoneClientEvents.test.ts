import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from './testHarness';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import { AudioEventType, AudioType, FileType } from '../src/domain/zones/enums';
import type { ZoneState } from '../src/domain/zones/zoneState';

/**
 * The native client's event contract, transcribed.
 *
 * Read out of the shipped client — Loxone.app 17.3.0, `www/scripts/AppHub.js`, the modules
 * around `eventSchema` (383177) — and written here in the same zod the client uses. Module
 * ids and export names are quoted per schema so each one can be found again in that file.
 * The map of the whole client lives in `docs/loxone-client-map.md`.
 *
 * Why the envelope matters: the client's `_onMessage` takes any frame with a key ending in
 * `_event` and runs the *whole object* through `eventSchema.safeParse`. One field that does
 * not fit and the frame is logged and dropped — every event in it, not only the wrong one.
 * And the shapes are not uniform: most events are arrays, but `service_changed_event`,
 * `customurl_changed_event`, `usbchanged_event` and `mastervolumechanged_event` are bare
 * objects, and `restart_event` / `reboot_event` are bare booleans. An empty array where an
 * object belongs is not "an event without detail", it is a frame the client never sees.
 *
 * Transcribed faithfully, tolerance included (`.catch()`, `.optional()`, `.default()`): the
 * point is to fail here exactly when the client would fail, and not before. The transforms
 * that only rename fields for the client's own use are left out — they cannot fail.
 */

// --- enums (shared-app.js module 788419, 636442) -----------------------------

/** `RepeatMode`: NoRepeat, Queue, Track. There is no 2. */
const RepeatMode = z.union([z.literal(0), z.literal(1), z.literal(3)]);
/** `AudioEventType`. */
const AudioEventTypeValues = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 101];
/** `FileType`. */
const FileTypeValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12];
/** `LineInIconType`. */
const LineInIconTypeValues = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** `DialogLevel`. */
const DialogLevel = z.union([z.literal(1), z.literal(2), z.literal(3)]);

const oneOf = (values: number[]) => z.number().refine((v) => values.includes(v));

// --- the events, one module each ---------------------------------------------

/** `audioEventSchema`, module 267716. */
const audioEventSchema = z.object({
  album: z.string(),
  artist: z.string(),
  audiopath: z.string(),
  audiotype: z.number(),
  coverurl: z.string(),
  duration: z.number().optional().default(0),
  duration_ms: z.number().optional().default(0),
  eventype: oneOf(AudioEventTypeValues).optional().catch(-1),
  mode: z.union([z.literal('play'), z.literal('resume'), z.literal('stop'), z.literal('pause')]),
  name: z.string(),
  parent: z
    .object({ id: z.string(), name: z.string(), audiopath: z.string().optional() })
    .nullable()
    .optional(),
  playerid: z.number(),
  plrepeat: RepeatMode,
  plshuffle: z.coerce.boolean(),
  position_ms: z.number().optional(),
  power: z.union([
    z.literal('rebooting'),
    z.literal('updating'),
    z.literal('starting'),
    z.literal('on'),
    z.literal('off'),
    z.literal('offline'),
  ]),
  qid: z.string().optional(),
  qindex: z.number(),
  sourceName: z.string().optional(),
  station: z.string().optional(),
  time: z.number(),
  title: z.string().optional(),
  type: oneOf(FileTypeValues).catch(0),
  icontype: oneOf(LineInIconTypeValues).catch(0).optional(),
  volume: z.number(),
  pbr: z.number().optional(),
});

/** `hwEventSchema`, module 142146. */
const hwEventSchema = z.object({ client_id: z.number(), event_id: z.number(), value: z.number() });

/** `reloadAppEventSchema`, module 486627. */
const reloadAppEventSchema = z.object({
  action: z.union([z.literal('userdel'), z.literal('useradd'), z.literal('reload')]),
  cause: z.string(),
  reload: z.coerce.boolean(),
  user: z.string(),
});

/** `PlaylistChangedEventSchema`, module 729801. Every field a string — `playlistid` too. */
const PlaylistChangedEventSchema = z
  .object({
    action: z.literal('follow').or(z.literal('unfollow')),
    cmd: z.literal('spotify'),
    id: z.string(),
    user: z.string(),
  })
  .or(
    z.object({
      action: z.union([
        z.literal('delete'),
        z.literal('rename'),
        z.literal('start'),
        z.literal('update'),
        z.literal('create'),
      ]),
      audiopath: z.string(),
      cmd: z.string(),
      name: z.string(),
      playlistid: z.string(),
      user: z.string(),
    }),
  );

/** `roomFavChangedEventSchema`, module 585696. */
const roomFavChangedEventSchema = z.object({ count: z.number(), playerid: z.number() });

/** `masterVolumeChangedEventSchema`, module 964608. An object, not an array. */
const masterVolumeChangedEventSchema = z.object({ group: z.coerce.string(), mastervolume: z.number() });

/** `rescanEventSchema`, module 83095. */
const rescanEventSchema = z.object({
  id: z.string().optional().default('0'),
  status: oneOf([0, 1, 2]).catch(0),
  folders: z.number().default(0),
  files: z.number().default(0),
});

/** `syncEventSchema`, module 869483. */
const syncEventSchema = z.object({
  group: z.string(),
  mastervolume: z.number(),
  type: z.union([z.literal('dynamic'), z.literal('static')]),
  players: z.array(z.object({ playerid: z.number(), id: z.string() })),
});

/** `rebootEventSchema` (546060) and `restartEventSchema` (953995): a bare boolean each. */
const rebootEventSchema = z.boolean();
const restartEventSchema = z.boolean();

/** `serviceChangedEventSchema`, module 104376. An object, not an array. */
const serviceChangedEventSchema = z.object({ action: z.literal('serviceschanged') });

/** `radioChangedEventSchema`, module 747328. An object, not an array. */
const radioChangedEventSchema = z.object({
  action: z.union([z.literal('added'), z.literal('delete'), z.literal('changed')]),
  id: z.string(),
});

/** `usbChangedEventSchema`, module 465504. An object, not an array. */
const usbChangedEventSchema = z.object({ action: z.union([z.literal('added'), z.literal('removed')]) });

/** `queueEventSchema`, module 179715. */
const queueEventSchema = z.object({
  playerid: z.coerce.number(),
  queuesize: z.number(),
  restrictions: z.coerce.boolean(),
});

/** `recentlyPlayedChangedEventSchema`, module 123254. */
const recentlyPlayedChangedEventSchema = z.object({ playerid: z.number(), ts: z.number() });

/** `dialogEventSchema`, module 100846. */
const dialogButtonSchema = z.object({
  title: z.string(),
  command: z.string().optional(),
  color: z.string().optional(),
  link: z.string().optional(),
});
const dialogEventSchema = z.object({
  ID: z.string(),
  buttons: z.array(dialogButtonSchema),
  cancelbtn: dialogButtonSchema.optional(),
  level: DialogLevel,
  message: z.string(),
  messagetype: z.string(),
  state: z.string(),
  title: z.string(),
  ttl: z.number(),
});

/** `eventSchema`, module 383177 — the envelope every `_event` frame is parsed by. */
const eventSchema = z.object({
  audio_event: z.array(audioEventSchema).optional(),
  hw_event: z.array(hwEventSchema).optional(),
  reloadmusicapp_event: z.array(reloadAppEventSchema).optional(),
  lineinchanged_event: z.array(z.any()).optional(),
  playlistchanged_event: z.array(PlaylistChangedEventSchema).optional(),
  roomfavchanged_event: z.array(roomFavChangedEventSchema).optional(),
  mastervolumechanged_event: masterVolumeChangedEventSchema.optional(),
  rescan_event: z.array(rescanEventSchema).optional(),
  audio_sync_event: z.array(syncEventSchema).optional(),
  reboot_event: rebootEventSchema.optional(),
  restart_event: restartEventSchema.optional(),
  service_changed_event: serviceChangedEventSchema.optional(),
  customurl_changed_event: radioChangedEventSchema.optional(),
  usbchanged_event: usbChangedEventSchema.optional(),
  audio_queue_event: z.array(queueEventSchema).optional(),
  recentlyplayedchanged_event: z.array(recentlyPlayedChangedEventSchema).optional(),
  command: z.string().optional(),
  dialog_event: z.array(dialogEventSchema).optional(),
});

// --- what we emit --------------------------------------------------------------

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 12,
    duration: 210,
    volume: 40,
    plrepeat: 0,
    plshuffle: 0,
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverurl: 'http://cover',
    station: '',
    sourceName: 'Library',
    audiopath: 'library://track/9',
    audiotype: AudioType.File,
    type: FileType.File,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    qindex: 0,
    ...overrides,
  } as ZoneState;
}

/** Runs one notifier call and returns the frames it put on the wire, parsed. */
function emitted(run: (notifier: LoxoneWsNotifier) => void): Array<Record<string, unknown>> {
  const frames: string[] = [];
  const registry = { broadcastMessage: (msg: string) => frames.push(msg) } as any;
  const notifier = new LoxoneWsNotifier(registry, { getGroupByZone: () => undefined } as any);
  run(notifier);
  return frames.map((frame) => JSON.parse(frame));
}

/** Asserts the client would accept the single frame a notifier call produced. */
function assertClientAccepts(key: string, run: (notifier: LoxoneWsNotifier) => void): void {
  const frames = emitted(run);
  assert.equal(frames.length, 1, `${key}: expected exactly one frame`);
  const frame = frames[0]!;
  assert.ok(key in frame, `${key}: the frame does not carry that key`);
  const parsed = eventSchema.safeParse(frame);
  assert.ok(
    parsed.success,
    `the client drops this ${key} frame: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
  );
}

test('client events: audio_event parses for a playing, a stopped and a line-in zone', () => {
  assertClientAccepts('audio_event', (n) => n.notifyZoneStateChanged(zoneState()));
  assertClientAccepts('audio_event', (n) =>
    n.notifyZoneStateChanged(zoneState({ mode: 'stop', power: 'off', title: '', coverurl: '' })),
  );
  assertClientAccepts('audio_event', (n) =>
    n.notifyZoneStateChanged(
      zoneState({ audiotype: AudioType.LineIn, type: FileType.LineIn, audiopath: 'linein:1', icontype: 8 } as any),
    ),
  );
});

test('client events: a zone says which alert it plays, and only while it plays one', () => {
  // The client asks `hasOwnProperty("eventype")`, not what the value is: a zone that always
  // carried a 0 would be a zone that is always in an event.
  const frameFor = (alert: AudioEventType | null) =>
    emitted((n) => {
      n.setAlertEventLookup(() => alert);
      n.notifyZoneStateChanged(zoneState());
    })[0] as { audio_event: Array<Record<string, unknown>> };

  assert.equal('eventype' in frameFor(null).audio_event[0]!, false);
  for (const alert of [AudioEventType.Bell, AudioEventType.TTS, AudioEventType.Alarm, AudioEventType.Unknown]) {
    const frame = frameFor(alert);
    assert.equal(frame.audio_event[0]!.eventype, alert);
    assert.ok(eventSchema.safeParse(frame).success, `the client drops an audio_event with eventype ${alert}`);
  }
});

test('client events: a status answer is the row an audio_event carries', async () => {
  // The client files a status row under its `playerid`; the server's own state has an `id`.
  const registry = { broadcastMessage: () => {} } as any;
  const notifier = new LoxoneWsNotifier(registry, { getGroupByZone: () => undefined } as any);
  const handlers = createZoneHandlers(
    { getState: (zoneId: number) => (zoneId === 3 ? zoneState() : undefined) } as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    (state) => notifier.projectForLoxone(state),
  );

  const answer = await handlers.audioGetStatus('audio/3/status');
  assert.equal(answer.name, 'status');
  const rows = answer.payload as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.playerid, 3);
  assert.ok(eventSchema.safeParse({ audio_event: rows }).success, 'the status row is not a valid audio_event row');

  const unknown = await handlers.audioGetStatus('audio/9/status');
  assert.deepEqual(unknown.payload, []);
});

test('client events: a failed search answers every scope with a ticket the client can read', () => {
  // `GlobalSearchTicketResponseScheme` (audio-schemas.txt:1583): `type` and `unique` sit beside
  // the result, never inside it.
  const frames = emitted((n) =>
    n.notifyGlobalSearchError('local:track#50|spotify@acc1:track#50,album#50|tunein:station#50', 'gs-1'),
  );
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.unique]),
    [
      ['local', 'gs-1'],
      ['spotify', 'gs-1'],
      ['tunein', 'gs-1'],
    ],
  );
  assert.deepEqual(frames[0]!.globalsearch_result, {});
  assert.deepEqual(frames[1]!.globalsearch_result, { error: 1, result: { user: 'acc1' } });
  assert.deepEqual(frames[2]!.globalsearch_result, {});
  assert.equal(emitted((n) => n.notifyGlobalSearchError('', 'gs-2')).length, 0);
});

test('client events: every repeat mode we can hold is one the client knows', () => {
  // `plrepeat: z.nativeEnum(RepeatMode)` — 0, 1 or 3. A 2 is not "unknown repeat", it is an
  // audio_event the client throws away, and with it the zone's whole state update.
  for (const plrepeat of [0, 1, 3]) {
    assertClientAccepts('audio_event', (n) => n.notifyZoneStateChanged(zoneState({ plrepeat })));
  }
});

test('client events: the per-zone change events parse', () => {
  assertClientAccepts('audio_queue_event', (n) => n.notifyQueueUpdated(3, 12));
  assertClientAccepts('roomfavchanged_event', (n) => n.notifyRoomFavoritesChanged(3, 4));
  assertClientAccepts('recentlyplayedchanged_event', (n) => n.notifyRecentlyPlayedChanged(3, 1700000000));
  assertClientAccepts('lineinchanged_event', (n) => n.notifyLineInChanged());
});

test('client events: rescan progress parses with and without counts', () => {
  assertClientAccepts('rescan_event', (n) => n.notifyRescan(1));
  assertClientAccepts('rescan_event', (n) => n.notifyRescan(2, 10, 250));
  assertClientAccepts('rescan_event', (n) => n.notifyRescan(0, 10, 250));
});

test('client events: reloadmusicapp_event parses for an added and a removed account', () => {
  assertClientAccepts('reloadmusicapp_event', (n) => n.notifyReloadMusicApp('useradd', 'spotify', 'user-1'));
  assertClientAccepts('reloadmusicapp_event', (n) => n.notifyReloadMusicApp('userdel', 'spotify', 'user-1'));
});

test('client events: the object- and boolean-shaped events are not sent as arrays', () => {
  // The five that are *not* arrays in the client's envelope. Sent as `[]` they fail the
  // envelope and the client never hears that services changed or that we are restarting.
  assertClientAccepts('service_changed_event', (n) => n.notifyServiceChanged());
  assertClientAccepts('restart_event', (n) => n.notifyRestart());
  assertClientAccepts('reboot_event', (n) => n.notifyReboot());
  assertClientAccepts('usbchanged_event', (n) => n.notifyUsbChanged('added'));
  assertClientAccepts('usbchanged_event', (n) => n.notifyUsbChanged('removed'));
  assertClientAccepts('customurl_changed_event', (n) => n.notifyCustomUrlChanged('added', 'custom-1'));
  assertClientAccepts('customurl_changed_event', (n) => n.notifyCustomUrlChanged('delete', 'custom-1'));
});

test('client events: a playlist change parses, numeric playlist id included', () => {
  // The client wants `playlistid`, `audiopath`, `cmd`, `name` and `user` — all strings, all
  // required. Our playlist ids are numbers in places; on the wire they have to be text.
  assertClientAccepts('playlistchanged_event', (n) =>
    n.notifyPlaylistChanged({
      action: 'create',
      playlistid: 7,
      audiopath: 'playlist:7',
      cmd: 'lms',
      user: 'nouser',
      name: 'Mix',
    }),
  );
  assertClientAccepts('playlistchanged_event', (n) =>
    n.notifyPlaylistChanged(
      { action: 'rename', playlistid: 'pl-7', audiopath: 'playlist:7', cmd: 'lms', user: 'nouser', name: 'Mix 2' },
      'audio/cfg/playlist/rename/lms/nouser/pl-7/Mix 2',
    ),
  );
});

test('client events: a playlist delete or item edit parses without a name to report', () => {
  // `name: z.string()` is required for every action, also the ones that rename nothing.
  for (const action of ['delete', 'update', 'start']) {
    assertClientAccepts('playlistchanged_event', (n) =>
      n.notifyPlaylistChanged({ action, playlistid: 'pl-7', audiopath: 'pl-7', cmd: 'lms', user: 'nouser' }),
    );
  }
});

test('client events: a group announcement parses', () => {
  assertClientAccepts('audio_sync_event', (n) =>
    n.notifyAudioSyncEvent([
      {
        group: 'g-1',
        mastervolume: 30,
        type: 'dynamic',
        players: [
          { id: 'zone-41', playerid: 41, name: 'Living' },
          { id: 'zone-42', playerid: 42, name: 'Kitchen' },
        ],
      },
    ]),
  );
});

test('client events: one misshapen event takes the whole frame with it', () => {
  // Not a claim about our emit — a claim about the client, kept next to the emits that must
  // respect it. A frame is parsed as one object; there is no per-key salvage.
  const good = { audio_queue_event: [{ playerid: 3, queuesize: 1, restrictions: 0 }] };
  assert.equal(eventSchema.safeParse(good).success, true);
  assert.equal(eventSchema.safeParse({ ...good, restart_event: [] }).success, false);
  assert.equal(eventSchema.safeParse({ ...good, service_changed_event: [{ action: 'serviceschanged' }] }).success, false);
});
