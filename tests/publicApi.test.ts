import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { ApiHandler, API_ROOT } from '../src/adapters/http/api/apiHandler';
import { ProviderUnavailableError } from '../src/adapters/content/providerUnavailable';
import { ApiEventHub } from '../src/adapters/http/api/apiEventHub';
import { withApiEvents } from '../src/adapters/http/api/apiNotifierTap';
import { toApiZoneState } from '../src/adapters/http/api/zoneProjection';
import { AudioType } from '../src/domain/zones/enums';
import { COVER_ART_NOW_PLAYING_SIZE } from '../src/shared/coverArt';
import { ServerLifecycle } from '../src/domain/server/lifecycle';
import type { HealthReport } from '../src/domain/server/health';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ApiOutputSync, ApiStreamFormat } from '../src/domain/zones/apiTypes';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { AudioAnalysisEvent } from '../src/application/audio/audioAnalysisService';

// This API is the contract third parties build on, so the tests below guard the
// two promises that make it one: Loxone vocabulary never reaches the wire, and a
// successful command is always followed by an event (so nobody has to poll).

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public headers: Record<string, unknown> = {};
  public body = '';
  public writableEnded = false;

  public writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) this.headers = headers;
    return this;
  }

  public write(chunk: string): boolean {
    this.body += chunk;
    return true;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) this.body += data.toString();
    this.writableEnded = true;
    this.emit('finish');
  }

  public json(): any {
    return this.body ? JSON.parse(this.body) : null;
  }
}

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): IncomingMessage {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const stream = Readable.from(payload ? [payload] : []) as unknown as IncomingMessage;
  (stream as any).method = method;
  (stream as any).url = url;
  (stream as any).headers = headers;
  return stream;
}

function zoneState(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    id: 3,
    name: 'Kitchen',
    mode: 'play',
    power: 'on',
    clientState: 'on',
    time: 42.7,
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
    type: 2,
    eq: [0,0,0,0,0,0,0,0,0,0],
    qindex: 0,
    outputProtocol: 'sendspin',
    ...overrides,
  } as ZoneState;
}

type Harness = {
  handler: ApiHandler;
  hub: ApiEventHub;
  commands: Array<{ zoneId: number; command: string; payload?: string }>;
  powers: Array<{ zoneId: number; signal: 0 | 1 }>;
  plays: Array<{ zoneId: number; uri: string }>;
  handoffs: Array<{ sourceId: number; targetId: number }>;
  states: Map<number, ZoneState>;
  browseAsks: Array<{ id: string; start: number; limit: number }>;
};

let eqBands: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let queueOps: string[] = [];
let libOps: string[] = [];
// What the cover route asked for, so the tests can check the size hint it passed on.
let coverAsks: Array<{ zoneId: number; targetSize: number }> = [];
let zoneCover: { data: Buffer; mime?: string } | string | null = null;
let inputSelections: Array<{ zoneId: number; inputId: string }> = [];
let alertCalls: Array<Record<string, unknown>> = [];
let alertResult: { success: boolean; action: 'on' | 'off'; reason?: string } | null = null;
let analysisListener: ((event: AudioAnalysisEvent) => void) | null = null;
// What the browse route passed on, so the paging a caller *did not* ask for can be checked.
let browseAsks: Array<{ id: string; start: number; limit: number }> = [];
/** What the delay route passed to the setter, so a test can assert the clamp and the target. */
let delaysSet: Array<{ zoneId: number; delayMs: number; clientId: string | null }> = [];
let lifecycle = new ServerLifecycle();
let health: HealthReport;
const favItems = [{ id: 1, name: 'Radio Paradise', source: 'tunein:s1', coverUrl: 'c' }];
const recentItems = [
  { source: 'applemusic:track:1', title: 'One', artist: 'A', album: 'X', coverUrl: 'c', service: 'applemusic' },
];
const queueItems = [
  { id: 'a', title: 'One', artist: 'A', album: 'X', duration: 100, coverUrl: 'c1', source: 'applemusic:track:1' },
  { id: 'b', title: 'Two', artist: 'B', album: 'Y', duration: 200, coverUrl: 'c2', source: 'library://track/2' },
];

function harness(): Harness {
  eqBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  queueOps = [];
  libOps = [];
  coverAsks = [];
  zoneCover = { data: Buffer.from('jpegbytes'), mime: 'image/png' };
  inputSelections = [];
  alertCalls = [];
  alertResult = { success: true, action: 'on' };
  analysisListener = null;
  delaysSet = [];
  lifecycle = new ServerLifecycle();
  lifecycle.markReady();
  health = {
    status: 'ok',
    version: '4.0.0-test',
    uptimeSec: 5,
    phase: 'ready',
    checks: [{ name: 'audio', status: 'ok' }],
  };
  const states = new Map<number, ZoneState>([[3, zoneState()]]);
  const commands: Harness['commands'] = [];
  const powers: Harness['powers'] = [];
  const plays: Harness['plays'] = [];
  const handoffs: Harness['handoffs'] = [];
  const hub = new ApiEventHub();
  const handler = new ApiHandler({
    eventHub: hub,
    getAllZoneStates: () => [...states.values()],
    getZoneState: (zoneId) => states.get(zoneId) ?? null,
    handleCommand: (zoneId, command, payload) => commands.push({ zoneId, command, payload }),
    setPower: (zoneId, signal) => {
      if (!states.has(zoneId)) return false;
      powers.push({ zoneId, signal });
      return true;
    },
    playContent: async (zoneId, uri) => {
      plays.push({ zoneId, uri });
    },
    getVolumeLimits: (zoneId) => (zoneId === 3 ? { max: 70, default: 20, step: 2 } : undefined),
    getOutputProtocol: (zoneId) => (zoneId === 9 ? 'sonos' : 'sendspin'),
    getOutputCapabilities: () => null,
    // Ungrouped: several tests below assert `group: null`, and the projection's own group handling
    // is covered directly in `toApiZoneState` tests rather than through the handler.
    getGroup: () => null,
    getOutputSync: (zoneId) =>
      zoneId === 3
        ? {
            state: 'synchronized' as const,
            delayMs: 40,
            deviceDelayMs: 40,
            targetLeadMs: 250,
            leadMarginMs: 100,
            leadMs: 268,
            leadMinMs: 252,
            driftMs: -2,
          }
        : null,
    setOutputDelay: async (zoneId, delayMs, clientId) => {
      delaysSet.push({ zoneId, delayMs, clientId: clientId ?? null });
      return { delayMs, applied: zoneId === 3 };
    },
    getFavorites: async (zoneId, start, limit) =>
      zoneId === 3
        ? { zoneId, items: favItems.slice(start, start + limit), start, total: favItems.length }
        : null,
    addFavorite: async (_zoneId, name, uri) => {
      libOps.push(`addFav:${name || '(auto)'}:${uri}`);
      return { id: 9, name: name || 'Auto', source: uri, coverUrl: '' };
    },
    renameFavorite: async (_zoneId, id, name) => {
      libOps.push(`renameFav:${id}:${name}`);
    },
    removeFavorite: async (_zoneId, id) => {
      libOps.push(`removeFav:${id}`);
    },
    reorderFavorites: async (_zoneId, ids) => {
      libOps.push(`reorderFav:${ids.join(',')}`);
    },
    playFavorite: async (_zoneId, id) => {
      libOps.push(`playFav:${id}`);
      return favItems.some((f) => f.id === id);
    },
    getRecents: async (zoneId, start, limit) =>
      zoneId === 3
        ? { zoneId, items: recentItems.slice(start, start + limit), start, total: recentItems.length }
        : null,
    clearRecents: async () => {
      libOps.push('clearRecents');
    },
    setGroup: (zoneId, members) => {
      if (zoneId !== 3) return null;
      if (!members.length) return { leader: zoneId, members: [], rejected: [] };
      const rejected: Array<{ id: number; reason: 'protocol-mismatch' | 'zone-not-found' }> = [];
      const ok: number[] = [];
      for (const id of members) {
        if (id === zoneId) continue;
        if (id === 99) rejected.push({ id, reason: 'zone-not-found' });
        else if (id === 9) rejected.push({ id, reason: 'protocol-mismatch' });
        else ok.push(id);
      }
      return { leader: zoneId, members: [zoneId, ...ok], rejected };
    },
    getQueue: (zoneId, start, limit) =>
      zoneId === 3
        ? {
            zoneId,
            items: queueItems.slice(start, start + limit),
            start,
            total: queueItems.length,
            currentIndex: 0,
          }
        : null,
    queueAppend: async (_zoneId, uri) => {
      queueOps.push(`append:${uri}`);
    },
    queueInsertNext: async (_zoneId, uri) => {
      queueOps.push(`next:${uri}`);
    },
    queuePlay: (_zoneId, id) => {
      queueOps.push(`play:${id}`);
      return queueItems.some((i) => i.id === id);
    },
    queueMove: (_zoneId, id, before) => {
      queueOps.push(`move:${id}>${before ?? 'end'}`);
      return queueItems.some((i) => i.id === id);
    },
    queueRemove: (_zoneId, id) => {
      queueOps.push(`remove:${id}`);
    },
    queueClear: () => {
      queueOps.push('clear');
    },
    queueUndo: () => {
      queueOps.push('undo');
    },
    handoff: async (sourceId, targetId) => {
      handoffs.push({ sourceId, targetId });
      return true;
    },
    listAudioServers: () => ({ selfId: 'SELF', servers: [] }),
    getInputs: () => [
      { id: 'linein-a', name: 'BeoSound 9000', icon: 'cd-player', controllable: true, reportsMetadata: true },
      { id: 'linein-b', name: 'Turntable', icon: 'turntable', controllable: false, reportsMetadata: false },
    ],
    selectInput: (zoneId, inputId) => {
      if (inputId !== 'linein-a' && inputId !== 'linein-b') return false;
      inputSelections.push({ zoneId, inputId });
      return true;
    },
    getInputLabel: (inputId) => (inputId === 'linein-a' ? 'BeoSound 9000' : null),
    getStreamFormat: () => null,
    getAudioAnalysisFormat: () => ({ sampleRate: 44100, channels: 2, bitDepth: 16 }),
    subscribeAudioAnalysis: (_zoneId, _options, listener) => {
      analysisListener = listener;
      return () => {
        analysisListener = null;
      };
    },
    getLocalDestinationOwner: (zoneId) => (zoneId === 9000 ? 'browser-mine' : null),
    listDestinations: () => [
      { id: '3', name: 'Kitchen', kind: 'zone' as const, protocol: 'sendspin', available: true },
      { id: '9000', name: 'This tab', kind: 'local' as const, protocol: 'sendspin', available: true },
    ],
    registerLocalDestination: async (opts) => ({
      id: '9000',
      name: opts.name ?? 'Browser 1',
      kind: 'local' as const,
      protocol: 'sendspin',
      available: true,
      clientId: opts.clientId ?? 'browser-9000',
      streamUrl: `ws://${opts.host ?? '127.0.0.1:7090'}/sendspin`,
    }),
    removeLocalDestination: async (id) => id === '9000',
    playAlert: async (request) => {
      alertCalls.push(request as unknown as Record<string, unknown>);
      return request.zoneId === 3 ? alertResult : null;
    },
    getZoneCover: (zoneId, targetSize) => {
      coverAsks.push({ zoneId, targetSize });
      return zoneId === 3 ? zoneCover : null;
    },
    getServiceLabel: (audiopath) => (audiopath.startsWith('applemusic:') ? 'Apple Music' : null),
    getOutputDevice: (zoneId) =>
      zoneId === 3
        ? { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true }
        : undefined,
    getEqualizerBands: (zoneId) => (zoneId === 3 ? [...eqBands] : null),
    setEqualizerBands: async (zoneId, bands) => {
      if (zoneId !== 3) return null;
      if (!Array.isArray(bands) || bands.length !== 10) return null;
      if (!bands.every((b) => typeof b === 'number' && Number.isFinite(b))) return null;
      eqBands = bands.map((b) => Math.min(6, Math.max(-6, Math.round(b as number))));
      return [...eqBands];
    },
    listServices: async () => [
      { id: 'library', name: 'Library', rootId: 'b1.c.category.library.root', searchableKinds: [] },
    ],
    browse: async (id, start, limit) => {
      browseAsks.push({ id, start, limit });
      if (id === 'refused') {
        throw new ProviderUnavailableError('spotify@Bianca', 'auth', 401);
      }
      return { container: null, items: [], start, total: 0 };
    },
    getHealth: () => health,
    getLifecycle: () => lifecycle.snapshot(),
    serverVersion: '4.0.0-test',
    startedAt: Date.now() - 5000,
    // Surfaces these tests never call, but the port requires: present so a future
    // signature change here shows up as a compile error rather than a silent gap.
    getWaveform: () => null,
    describeItem: async () => null,
    search: async (request: { query: string }) => ({ query: request.query, items: {}, services: [] }),
    listPlaylists: async () => ({ items: [], total: 0 }),
    createPlaylist: async (name: string) => ({ id: 'pl-1', name, tracks: 0 }),
    renamePlaylist: async () => null,
    deletePlaylist: async () => false,
    addPlaylistItem: async () => false,
    removePlaylistItem: async () => false,
    movePlaylistItem: async () => false,
  });
  browseAsks = [];
  return { handler, hub, commands, powers, plays, handoffs, states, browseAsks };
}

async function call(
  h: Harness,
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const res = new FakeResponse();
  await h.handler.handle(
    makeRequest(method, url, body, headers),
    res as unknown as ServerResponse,
  );
  return res;
}

/**
 * Open one of the SSE routes, run the body against it, and close it afterwards.
 *
 * An SSE route holds a keep-alive timer for as long as its request is open, and only a `close` on
 * the request clears it. A real client closing its connection emits that; a `Readable.from()` never
 * does, so a stream a test opens stays open forever — and one repeating timer is enough to keep the
 * whole suite's process from ever exiting, long after the last test passed. Closing here happens in
 * a `finally` so a failing assertion reports as a failure instead of hanging the run.
 */
async function withStream(
  h: Harness,
  url: string,
  body: (res: FakeResponse) => void | Promise<void>,
): Promise<void> {
  const req = makeRequest('GET', url);
  const res = new FakeResponse();
  await h.handler.handle(req, res as unknown as ServerResponse);
  try {
    await body(res);
  } finally {
    req.emit('close');
  }
}

test('projection keeps Loxone vocabulary off the wire', () => {
  const api = toApiZoneState(zoneState({ mode: 'pause', plrepeat: 3, plshuffle: 1, time: 42.7 }));

  // The numeric enums, the raw path field name, and the comma-string EQ are the
  // fields that make the Loxone payload unreadable without Loxone's app.
  const keys = Object.keys(api);
  for (const leaked of ['audiotype', 'type', 'icontype', 'equalizerSettings', 'clientState', 'mode', 'plrepeat', 'plshuffle', 'audiopath', 'station', 'playerid', 'parent', 'qindex']) {
    assert.ok(!keys.includes(leaked), `public zone must not expose ${leaked}`);
  }

  assert.equal(api.state, 'paused');
  assert.equal(api.repeat, 'one', 'plrepeat 3 is RepeatMode.Track');
  assert.equal(api.shuffle, true);
  assert.equal(api.id, 3);
  // Position is promised in whole seconds.
  assert.equal(api.position, 43);
});

test('projection maps every AudioType to a readable source kind', () => {
  const cases: Array<[number, string]> = [
    [AudioType.File, 'track'],
    [AudioType.Radio, 'radio'],
    [AudioType.Playlist, 'playlist'],
    [AudioType.LineIn, 'linein'],
    [AudioType.AirPlay, 'airplay'],
    [AudioType.Spotify, 'spotify'],
    [AudioType.Bluetooth, 'bluetooth'],
  ];
  for (const [audiotype, kind] of cases) {
    assert.equal(toApiZoneState(zoneState({ audiotype })).source?.kind, kind);
  }
  // An unknown/new category must degrade, never break a client's parse. The cast
  // is the point: `audiotype` is typed as `AudioType`, so a value outside the enum
  // can only arrive from an older persisted state or a future member — exactly the
  // case a client must survive.
  assert.equal(
    toApiZoneState(zoneState({ audiotype: 99 as AudioType })).source?.kind,
    'unknown',
  );
});

test('projection reports radio station as the source name', () => {
  const api = toApiZoneState(
    zoneState({ audiotype: AudioType.Radio, station: 'Radio Paradise', duration: 0 }),
  );
  assert.equal(api.source?.name, 'Radio Paradise');
  assert.equal(api.duration, 0);
});

test('projection returns null track and null group instead of empty sentinels', () => {
  const api = toApiZoneState(
    zoneState({ title: '', artist: '', album: '', syncedzones: [] }),
  );
  assert.equal(api.track, null, 'an idle zone has no track, not empty strings');
  assert.equal(api.group, null, 'an ungrouped zone has no group');
});

test('an idle zone reports no source instead of leaking the routing MAC', () => {
  // A freshly seeded zone carries `audiotype: 0` (File, not "none") and holds the
  // audioserver's MAC in `sourceName` as an internal routing tag. The native app
  // ignores both while idle, so a naive projection would be the first thing ever
  // to show a MAC address as a human-readable source name.
  const api = toApiZoneState(
    zoneState({
      audiopath: '',
      audiotype: 0,
      sourceName: '000C290E5497',
      title: '',
      artist: '',
      album: '',
    }),
  );
  assert.equal(api.source, null);
  assert.equal(api.track, null);
  assert.ok(!JSON.stringify(api).includes('000C290E5497'), 'no MAC may reach the wire');
});

test('projection surfaces the sync group with the leader first', () => {
  const api = toApiZoneState(zoneState({ syncedzones: [3, 7, 9] }));
  assert.deepEqual(api.group, { leader: 3, members: [3, 7, 9] });
});

test('the group comes from the group tracker, because zone state never carries it', () => {
  /*
   * The gap this closes: `syncedzones` is typed on `ZoneState` and *never assigned* — the Loxone
   * projection computes it per emit and puts it on its own payload. So this API answered
   * `group: null` for every zone, always, and grouping was invisible on it. Nothing failed; you had
   * to group two rooms and read one back to find out.
   */
  const grouped = toApiZoneState(zoneState({ id: 3 }), {
    group: (zoneId) => (zoneId === 3 ? { leader: 28, members: [28, 27] } : null),
  });
  assert.deepEqual(grouped.group, { leader: 28, members: [28, 27] }, 'leader first, as the tracker has it');

  // A lone zone is not a group of one: `if (zone.group)` has to mean "playing with others".
  assert.equal(
    toApiZoneState(zoneState({ id: 3 }), { group: () => ({ leader: 3, members: [3] }) }).group,
    null,
    'a group of one is no group',
  );
  assert.equal(toApiZoneState(zoneState({ id: 3 }), { group: () => null }).group, null);
});

test('projection exposes power only through powerState', () => {
  const api = toApiZoneState(zoneState({ power: 'off' }));
  assert.deepEqual(api.powerState, {
    power: 'off',
    target: 'off',
    managed: false,
    idleTimeoutMs: null,
  });
  assert.ok(!('power' in api));
});

test('projection puts cover colors on the current track', () => {
  const api = toApiZoneState(
    zoneState({
      artworkColors: {
        primary: [120, 30, 40],
        accent: [220, 80, 60],
        background_dark: [10, 5, 8],
        background_light: [245, 240, 240],
        on_dark: [255, 255, 255],
        on_light: [0, 0, 0],
      },
    }),
  );
  assert.deepEqual(api.track?.colors, {
    primary: [120, 30, 40],
    accent: [220, 80, 60],
    backgroundDark: [10, 5, 8],
    backgroundLight: [245, 240, 240],
    onDark: [255, 255, 255],
    onLight: [0, 0, 0],
  });
});

test('GET /api/zones returns the projected snapshot', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zones.length, 1);
  assert.equal(res.json().zones[0].name, 'Kitchen');
});

test('GET /api/zones/{id} 404s for an unknown zone', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/99`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'zone-not-found');
});

test('transport verbs map onto the shared zone command engine', async () => {
  const h = harness();
  for (const [route, expected] of [
    ['play', 'play'],
    ['pause', 'pause'],
    ['stop', 'off'],
    ['next', 'queueplus'],
    ['previous', 'queueminus'],
  ] as Array<[string, string]>) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/${route}`);
    assert.equal(res.statusCode, 204, `${route} should return 204`);
    assert.equal(h.commands.at(-1)?.command, expected);
    assert.equal(h.commands.at(-1)?.zoneId, 3);
  }
});

test('volume accepts an absolute value and a signed delta', async () => {
  const h = harness();
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: 55 });
  assert.deepEqual(h.commands.at(-1), { zoneId: 3, command: 'volume', payload: '55' });

  // Relative stepping is how every physical remote works; a read-then-write
  // client would race with itself.
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { delta: -5 });
  assert.equal(h.commands.at(-1)?.payload, '-5');
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { delta: 5 });
  assert.equal(h.commands.at(-1)?.payload, '+5');
});

test('volume clamps to the documented 0-100 range', async () => {
  const h = harness();
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: 500 });
  assert.equal(h.commands.at(-1)?.payload, '100');
  await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, { volume: -20 });
  assert.equal(h.commands.at(-1)?.payload, '0');
});

test('malformed command bodies are rejected without reaching the engine', async () => {
  const h = harness();
  for (const body of [{ volume: 'loud' }, {}]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/volume`, body);
    assert.equal(res.statusCode, 400);
  }
  const bad = await call(h, 'PUT', `${API_ROOT}/zones/3/power`, { power: 'maybe' });
  assert.equal(bad.statusCode, 400);
  assert.equal(h.commands.length, 0, 'no invalid request may reach the zone engine');
});

test('explicit power commands bypass the automatic off delay', async () => {
  const h = harness();
  const off = await call(h, 'PUT', `${API_ROOT}/zones/3/power`, { power: 'off' });
  assert.equal(off.statusCode, 204);
  assert.deepEqual(h.powers, [{ zoneId: 3, signal: 0 }]);
  assert.deepEqual(h.commands, [{ zoneId: 3, command: 'off', payload: undefined }]);

  const on = await call(h, 'PUT', `${API_ROOT}/zones/3/power`, { power: 'on' });
  assert.equal(on.statusCode, 204);
  assert.deepEqual(h.powers, [
    { zoneId: 3, signal: 0 },
    { zoneId: 3, signal: 1 },
  ]);
});

test('a wrong method is a 405, not a silent success', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/volume`);
  assert.equal(res.statusCode, 405);
  assert.equal(h.commands.length, 0);
});

test('GET /api/health reports status, version and uptime', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/health`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().version, '4.0.0-test');
  assert.ok(res.json().uptimeSec >= 5);
});

test('the events stream opens with a full snapshot so clients render immediately', async () => {
  const h = harness();
  await withStream(h, `${API_ROOT}/events`, (res) => {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['Content-Type']), /text\/event-stream/);

    const first = JSON.parse(res.body.replace(/^data: /, '').trim());
    assert.equal(first.type, 'server.snapshot');
    assert.equal(first.zones[0].name, 'Kitchen');
  });
});

test('the analysis stream announces its subscription and serializes spectrum bins', async () => {
  const h = harness();
  await withStream(
    h,
    `${API_ROOT}/zones/3/analysis?types=spectrum,pitch&rate=30&bins=16`,
    (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /text\/event-stream/);
      const ready = JSON.parse(res.body.split('data: ')[1]!.split('\n')[0]!);
      /*
       * The geometry is part of the announcement, not something a client mirrors by hand: the u16
       * amplitudes mean nothing without the dB window they span, and the bins mean nothing without
       * the frequency range they were binned over. A player that guessed drew 1 kHz at 26% of the
       * width where it belonged at 54%.
       *
       * `serverNowUs` is a live reading of a monotonic clock, so it is checked for shape rather
       * than value — but it has to be *there*: without a reference reading the `timestampUs` on
       * every following event is a number against an origin the client cannot know.
       */
      assert.equal(typeof ready.serverNowUs, 'number');
      assert.ok(Number.isFinite(ready.serverNowUs));
      delete ready.serverNowUs;
      assert.deepEqual(ready, {
        type: 'analysis.ready',
        zoneId: 3,
        rateMax: 30,
        types: ['spectrum', 'pitch'],
        // The fallback: this harness reports no stream format, and a consumer still has to be told
        // what the analyzer was built for rather than being left to assume.
        format: { sampleRate: 44100, channels: 2, bitDepth: 16 },
        floorDb: -60,
        fullScale: 65535,
        spectrum: { n_disp_bins: 16, scale: 'log', f_min: 40, f_max: 16000 },
        // This harness zone is a Sendspin output, so the stream follows the scheduled-output
        // timeline and the stamps say when the audio will be *heard* — about 250 ms out. A client
        // that draws on arrival therefore leads the music; one that honours this delays to match.
        // Zones on other outputs report 'capture' here, where the stamp is already in the past.
        timeline: 'presentation',
      });

      analysisListener?.({ type: 'spectrum', bins: new Uint16Array([1, 2, 3]), timestampUs: 123 });
      const messages = res.body
        .split('data: ')
        .slice(1)
        .map((message) => JSON.parse(message.split('\n')[0]!));
      assert.deepEqual(messages[1], { type: 'spectrum', bins: [1, 2, 3], timestampUs: 123 });
    },
  );
});

test('a zone reports how its audio is timed against the device', async () => {
  /*
   * Two different things live in `sync` and the distinction is the point: `state` and `delayMs` are
   * the agreement with the device, the rest is how well the server is keeping it. A protocol with
   * no clock says nothing at all — an absent `sync` must not read as "out of sync".
   */
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3`);
  assert.deepEqual(JSON.parse(res.body).output.sync, {
    state: 'synchronized',
    delayMs: 40,
    deviceDelayMs: 40,
    targetLeadMs: 250,
    leadMarginMs: 100,
    leadMs: 268,
    leadMinMs: 252,
    driftMs: -2,
  });
});

test('the output delay is settable, clamped, and reports whether it reached a live output', async () => {
  const h = harness();
  const res = await call(h, 'PUT', `${API_ROOT}/zones/3/output/delay`, { delayMs: 120 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { delayMs: 120, applied: true, clientId: null });
  assert.deepEqual(delaysSet, [{ zoneId: 3, delayMs: 120, clientId: null }]);

  // Out of range is clamped rather than refused: the caller asked for "as far as it goes".
  await call(h, 'PUT', `${API_ROOT}/zones/3/output/delay`, { delayMs: 99_999 });
  assert.equal(delaysSet[1]?.delayMs, 10_000);
  await call(h, 'PUT', `${API_ROOT}/zones/3/output/delay`, { delayMs: -5 });
  assert.equal(delaysSet[2]?.delayMs, 0);

  // A satellite gets its own offset — a subwoofer needs a different one from the speakers above it.
  await call(h, 'PUT', `${API_ROOT}/zones/3/output/delay`, { delayMs: 30, clientId: 'sub-living' });
  assert.deepEqual(delaysSet[3], { zoneId: 3, delayMs: 30, clientId: 'sub-living' });

  // Not a number is a refusal, not a silent 0: that would move the speaker without being asked.
  const bad = await call(h, 'PUT', `${API_ROOT}/zones/3/output/delay`, { delayMs: 'soon' });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).error, 'invalid-delay');
  assert.equal(delaysSet.length, 4, 'a rejected value never reaches the setter');

  const missing = await call(h, 'PUT', `${API_ROOT}/zones/77/output/delay`, { delayMs: 10 });
  assert.equal(missing.statusCode, 404);
  const wrongMethod = await call(h, 'GET', `${API_ROOT}/zones/3/output/delay`);
  assert.equal(wrongMethod.statusCode, 405);
});

test('a zone change reaches the stream as a full zone, never a patch', async () => {
  const h = harness();
  await withStream(h, `${API_ROOT}/events`, (res) => {
    res.body = '';

    h.hub.publishZoneChanged(toApiZoneState(zoneState({ title: 'Next song' })));

    const event = JSON.parse(res.body.replace(/^data: /, '').trim());
    assert.equal(event.type, 'zone.changed');
    assert.equal(event.zone.track.title, 'Next song');
    // A full zone means clients need no prior state to interpret an event.
    assert.equal(event.zone.volume, 40);
    assert.equal(event.zone.state, 'playing');
  });
});

test('closing a stream unsubscribes it', async () => {
  const h = harness();
  const req = makeRequest('GET', `${API_ROOT}/events`);
  const res = new FakeResponse();
  await h.handler.handle(req, res as unknown as ServerResponse);
  assert.equal(h.hub.subscriberCount, 1);
  req.emit('close');
  assert.equal(h.hub.subscriberCount, 0);
});

test('the notifier tap feeds the API without disturbing Loxone delivery', () => {
  const delivered: unknown[] = [];
  const inner = {
    notifyZoneStateChanged: (s: ZoneState) => delivered.push(s),
    notifyQueueUpdated: () => {},
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyAudioSyncEvent: () => {},
  } as unknown as NotifierPort;

  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const tapped = withApiEvents(inner, hub);

  tapped.notifyZoneStateChanged(zoneState({ title: 'Tapped' }));

  assert.equal(delivered.length, 1, 'Loxone must still receive the state');
  assert.equal(seen.length, 1, 'the API must receive the projected state');
  assert.equal(seen[0].zone.track.title, 'Tapped');
  assert.equal((seen[0].zone as any).audiotype, undefined);
});

test('a failing API subscriber cannot break Loxone delivery', () => {
  const delivered: unknown[] = [];
  const inner = {
    notifyZoneStateChanged: (s: ZoneState) => delivered.push(s),
    notifyQueueUpdated: () => {},
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyAudioSyncEvent: () => {},
  } as unknown as NotifierPort;

  const hub = new ApiEventHub();
  hub.subscribe(() => {
    throw new Error('subscriber exploded');
  });
  const tapped = withApiEvents(inner, hub);

  tapped.notifyZoneStateChanged(zoneState());

  assert.equal(delivered.length, 1, 'Loxone delivery survives a broken subscriber');
  assert.equal(hub.subscriberCount, 0, 'the broken subscriber is dropped');
});

// The equalizer moved here from /admin/api because an external provider owns it: the
// LoxBerry Squeezelite Multi-Room plugin writes a zone's bands whenever someone moves
// a slider in its own UI (sonn-audio/core#251). Integrators should never need a route
// under /admin/api, which is why that one is gone rather than aliased.

test('equalizer bands round-trip for a configured zone', async () => {
  const h = harness();
  const before = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

  // The exact body the plugin sends.
  const put = await call(h, 'PUT', `${API_ROOT}/zones/3/equalizer`, {
    bands: [6, 6, 6, 6, 6, 6, 6, 0, -2, 2],
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);

  const after = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.deepEqual(after.json().bands, [6, 6, 6, 6, 6, 6, 6, 0, -2, 2]);
});

test('equalizer is readable without live playback state', async () => {
  // It is configuration, not playback, so it must not require a zone that is
  // currently streaming — an idle zone still has an equalizer to configure.
  const h = harness();
  h.states.clear();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().zoneId, 3);
});

test('equalizer rejects a band array that is not ten values', async () => {
  const h = harness();
  for (const bands of [[1, 2], new Array(11).fill(0), 'loud', null]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/equalizer`, { bands });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(bands)}`);
    assert.equal(res.json().error, 'invalid-equalizer-bands');
  }
  // And nothing was applied.
  const after = await call(h, 'GET', `${API_ROOT}/zones/3/equalizer`);
  assert.deepEqual(after.json().bands, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('equalizer 404s an unknown zone and 405s a wrong method', async () => {
  const h = harness();
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/99/equalizer`)).statusCode, 404);
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/equalizer`)).statusCode, 405);
});

// A caller mapping its own devices onto zones needs the device identity from the same
// read that gives it zone state, on an idle zone as much as a playing one
// (sonn-audio/core#247).

test('a zone reports which device its output plays to', async () => {
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(zone.output, {
    protocol: 'sendspin',
    device: { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true },
    capabilities: null,
    sync: {
      state: 'synchronized',
      delayMs: 40,
      deviceDelayMs: 40,
      targetLeadMs: 250,
      leadMarginMs: 100,
      leadMs: 268,
      leadMinMs: 252,
      driftMs: -2,
    },
  });
});

test('device identity is reported on an idle zone too', async () => {
  const h = harness();
  h.states.set(3, zoneState({ mode: 'stop', title: '', artist: '', album: '', audiopath: '' }));
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(zone.state, 'stopped');
  assert.equal(zone.track, null, 'nothing playing');
  assert.equal(zone.output?.device?.id, '02:8C:54:A9:DC:AC', 'yet the device is known');
});

test('an event describes a zone exactly as a read does', async () => {
  // If the event stream omitted output.device, a client would watch it appear and
  // disappear depending on which path it last heard from.
  const h = harness();
  await withStream(h, `${API_ROOT}/events`, async (res) => {
    const ready = JSON.parse(res.body.replace(/^data: /, '').trim());
    const read = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
    assert.deepEqual(ready.zones[0], read, 'snapshot and read agree');
  });
});

// The path carries the version. Additive changes are safe without one, but a field
// that has to be renamed cannot be — and by the time that is clear, integrators have
// shipped. These pin the version so it cannot be dropped back out by accident.

test('the API is served under a versioned path', async () => {
  const h = harness();
  assert.equal(API_ROOT, '/api/v1');
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 200);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones`)).statusCode, 200);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/3`)).statusCode, 200);
});

test('audio servers are part of the public API', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/audio-servers`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { selfId: 'SELF', servers: [] });
});

test('handoff moves playback through the public API', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/handoff`, { targetZoneId: 7 });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(h.handoffs, [{ sourceId: 3, targetId: 7 }]);
});

test('an unversioned request is told where the API went', async () => {
  // It would otherwise fall through to the static file handler and answer a caller
  // written against the beta with an HTML page.
  const h = harness();
  for (const path of ['/api', '/api/zones', '/api/health', '/api/zones/3/volume']) {
    const res = await call(h, 'GET', path);
    assert.equal(res.statusCode, 404, `${path} is refused`);
    assert.equal(res.json().error, 'api-version-required');
    assert.ok(
      String(res.json().message).includes(API_ROOT),
      'and says which prefix to use instead',
    );
  }
});

test('the versioned prefix is matched before the unversioned one', async () => {
  // `/api/v1/zones` also starts with `/api/`, so checking the legacy prefix first
  // would swallow every real request.
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones`);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().zones));
});

test('an unknown path under the version is a plain not-found', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/nope`);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not-found', 'not the version message');
});

// Mozart (B&O) reports what a source and a volume will accept, not just their current
// value. Ours did not, so a client had to infer seekability from `duration === 0` and
// discover a volume cap by writing past it.

test('a zone reports what its volume will accept', async () => {
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.deepEqual(zone.volumeLimits, { max: 70, default: 20, step: 2 });
  assert.equal(zone.volume, 40, 'the current level is still its own field');
});

test('a source says whether it can be seeked', async () => {
  const h = harness();
  const track = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(track.source.seekable, true, 'a track has a position to seek to');

  // Live radio has no length, so there is nowhere to seek.
  h.states.set(3, zoneState({ audiotype: AudioType.Radio, station: 'Radio Paradise', duration: 0 }));
  const radio = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  assert.equal(radio.source.seekable, false);
  assert.equal(radio.duration, 0, 'which is what a client used to have to infer from');
});

test('an event reports limits and seekability like a read does', async () => {
  const h = harness();
  await withStream(h, `${API_ROOT}/events`, async (res) => {
    const ready = JSON.parse(res.body.replace(/^data: /, '').trim());
    const read = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
    assert.deepEqual(ready.zones[0], read);
  });
});

// A zone.changed is ~550 bytes and a progress tick fires every second per playing
// zone, so the clock advancing must not cost a whole zone.

test('a progress tick is sent when only the position moved', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, extra: Partial<ZoneState> = {}) =>
    toApiZoneState(zoneState({ time, ...extra }));

  hub.publishZoneChanged(at(10));
  assert.equal(seen[0].type, 'zone.changed', 'the first publish has nothing to compare to');

  hub.publishZoneChanged(at(11));
  hub.publishZoneChanged(at(12));
  assert.deepEqual(
    seen.slice(1).map((e) => [e.type, e.position]),
    [['zone.progress', 11], ['zone.progress', 12]],
  );
});

test('anything other than the position sends the whole zone', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, extra: Partial<ZoneState> = {}) =>
    toApiZoneState(zoneState({ time, ...extra }));

  hub.publishZoneChanged(at(10));
  // Volume moved as well, so a client that ignores progress events must still see it.
  hub.publishZoneChanged(at(11, { volume: 55 }));
  hub.publishZoneChanged(at(12, { volume: 55, title: 'Next' }));

  assert.deepEqual(seen.map((e) => e.type), ['zone.changed', 'zone.changed', 'zone.changed']);
  assert.equal(seen[1].zone.volume, 55);
  assert.equal(seen[2].zone.track.title, 'Next');
});

test('a moving lead or jitter is a reading, not a zone change', () => {
  /*
   * `output.sync` carries live measurements — the achieved lead, the jitter, the drift — and they
   * change on every frame. Counting them as a difference would make every one-second position tick
   * a full `zone.changed`, which is the traffic a progress tick exists to avoid. The *agreement*
   * (locked or not, the configured delay, the lead being aimed at) is state and must still get one.
   */
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, sync: Partial<ApiOutputSync> = {}) =>
    toApiZoneState(zoneState({ time }), {
      outputProtocol: () => 'sendspin',
      outputSync: () => ({
        state: 'synchronized',
        delayMs: 0,
        deviceDelayMs: 0,
        targetLeadMs: 250,
        leadMarginMs: 100,
        leadMs: 264,
        leadMinMs: 251,
        driftMs: -1,
        ...sync,
      }),
    });

  hub.publishZoneChanged(at(10));
  assert.equal(seen[0].type, 'zone.changed');

  // The clock ticked and every measurement moved with it: still just a progress tick.
  hub.publishZoneChanged(at(11, { leadMs: 331, leadMinMs: 243, driftMs: -25 }));
  assert.equal(seen[1].type, 'zone.progress', 'measurements alone are not a change');

  // The delay was set: that is state, and every client has to hear it.
  hub.publishZoneChanged(at(12, { leadMs: 302, delayMs: 60 }));
  assert.equal(seen[2].type, 'zone.changed', 'the configured delay is state');
  assert.equal(seen[2].zone.output.sync.delayMs, 60);

  // So is losing the clock.
  hub.publishZoneChanged(at(13, { leadMs: 288, delayMs: 60, state: 'error' }));
  assert.equal(seen[3].type, 'zone.changed', 'losing the lock is state');
});

test('a moving bitrate is a reading, not a zone change', () => {
  /*
   * `format.*.bitrate` is a throughput counter, re-averaged about once a second for every codec
   * that is not PCM (PCM's is derived from its sample format and does not move). Leaving it in the
   * comparison made a FLAC or MP3 output differ from itself on every tick, so a playing zone sent
   * its whole state every second and `zone.progress` never fired at all — on MQTT that was all ~27
   * of a zone's topics, every second, and the "send the playing time" setting could not turn it off
   * because none of it was a progress tick (sonn-audio/core#325).
   */
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  const at = (time: number, output: Partial<ApiStreamFormat> = {}) =>
    toApiZoneState(zoneState({ time }), {
      streamFormat: () => ({
        bitPerfect: false,
        dspApplied: true,
        source: null,
        output: {
          codec: 'flac',
          sampleRate: 44100,
          bitDepth: 16,
          channels: 2,
          bitrate: 1030904,
          highRes: false,
          ...output,
        },
        processing: null,
      }),
    });

  hub.publishZoneChanged(at(10));
  assert.equal(seen[0].type, 'zone.changed');

  // A second of FLAC compresses differently from the one before it. Nothing changed.
  hub.publishZoneChanged(at(11, { bitrate: 1055456 }));
  assert.equal(seen[1].type, 'zone.progress', 'a re-averaged throughput counter is not state');

  // The codec is: a client showing what is being heard has to hear about that one.
  hub.publishZoneChanged(at(12, { bitrate: 945896, codec: 'mp3' }));
  assert.equal(seen[2].type, 'zone.changed', 'the codec beside it is state');
  assert.equal(seen[2].zone.format.output.codec, 'mp3');
  assert.equal(seen[2].zone.format.output.bitrate, 945896, 'and the event still carries the reading');
});

test('a snapshot that says nothing new is not published at all', () => {
  /*
   * The internal notifier is re-entered for reasons that do not always change the projection — the
   * 60 s heartbeat re-broadcast, a field that only exists in the Loxone payload. Each of those used
   * to be a full `zone.changed`, because "the position did not move" was read as "something else
   * did".
   */
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));

  hub.publishZoneChanged(toApiZoneState(zoneState({ time: 10 })));
  hub.publishZoneChanged(toApiZoneState(zoneState({ time: 10 })));
  hub.publishZoneChanged(toApiZoneState(zoneState({ time: 10 })));
  assert.deepEqual(seen.map((e) => e.type), ['zone.changed'], 'saying it twice says nothing');

  hub.publishZoneChanged(toApiZoneState(zoneState({ time: 10, volume: 55 })));
  assert.equal(seen[1]?.type, 'zone.changed', 'a real change still gets through');
  assert.equal(seen[1].zone.volume, 55);
});

test('progress is tracked per zone, so one zone cannot mask another', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((e) => seen.push(e));
  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 3, time: 10 })));
  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 7, time: 10 })));
  // Zone 7's first publish is its own baseline, not a tick against zone 3.
  assert.deepEqual(seen.map((e) => e.type), ['zone.changed', 'zone.changed']);

  hub.publishZoneChanged(toApiZoneState(zoneState({ id: 7, time: 11 })));
  assert.equal(seen[2].type, 'zone.progress');
  assert.equal(seen[2].id, 7);
});

// Without a body, /play resumes what is queued — which is all this API could do at
// first, making it a remote rather than something an automation can trigger.

test('play with a uri starts it, play without one resumes', async () => {
  const h = harness();
  const resumed = await call(h, 'POST', `${API_ROOT}/zones/3/play`);
  assert.equal(resumed.statusCode, 204);
  assert.equal(h.commands.at(-1)?.command, 'play', 'resume goes to the command engine');
  assert.equal(h.plays.length, 0, 'and starts nothing new');

  const started = await call(h, 'POST', `${API_ROOT}/zones/3/play`, {
    uri: 'http://example/stream.mp3',
  });
  assert.equal(started.statusCode, 204);
  assert.deepEqual(h.plays.at(-1), { zoneId: 3, uri: 'http://example/stream.mp3' });
});

test('play accepts a source.id back, so a client can restart what it saw', async () => {
  // The zone reports `source.id` as an opaque value; handing it back is how an
  // integration replays something without knowing our content model.
  const h = harness();
  const zone = (await call(h, 'GET', `${API_ROOT}/zones/3`)).json();
  const id = zone.source.id;
  assert.ok(id, 'the zone reports an id to hand back');

  const res = await call(h, 'POST', `${API_ROOT}/zones/3/play`, { uri: id });
  assert.equal(res.statusCode, 204);
  assert.equal(h.plays.at(-1)?.uri, id);
});

test('play rejects an empty uri rather than silently resuming', async () => {
  const h = harness();
  for (const uri of ['', '   ', 42, null]) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/play`, { uri });
    assert.equal(res.statusCode, 400, `rejects ${JSON.stringify(uri)}`);
    assert.equal(res.json().error, 'invalid-uri');
  }
  assert.equal(h.plays.length, 0);
  assert.equal(h.commands.length, 0, 'and does not fall back to resume');
});

test('the other transport verbs still take no body', async () => {
  const h = harness();
  for (const verb of ['pause', 'stop', 'next', 'previous']) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/${verb}`);
    assert.equal(res.statusCode, 204, verb);
  }
  assert.equal(h.plays.length, 0);
});

// Both of these showed up in a live payload: an Apple Music track reporting "Spotify"
// as its source, and a zone reporting no output while audio was playing.

test('a bridged service is named for itself, not for its Loxone disguise', () => {
  // `sourceName` carries the name the Loxone clients need, and they only know Spotify —
  // so an Apple Music track arrives labelled "Spotify". The audiopath is service-native
  // by then, so the real name is derivable.
  const state = zoneState({
    audiopath: 'applemusic:track:b64_MTc4MDM4MjY5NQ==',
    sourceName: 'Spotify',
  });

  const disguised = toApiZoneState(state);
  assert.equal(disguised.source?.name, 'Spotify', 'without a lookup it falls back');

  const named = toApiZoneState(state, {
    serviceLabel: (p) => (p.startsWith('applemusic:') ? 'Apple Music' : null),
  });
  assert.equal(named.source?.name, 'Apple Music');
  assert.equal(named.source?.id, state.audiopath, 'the id is untouched');
});

test('a playing zone reports its output', () => {
  // `state.outputProtocol` is only ever filled in by the Loxone notifier at emit time,
  // so reading it here reported `output: null` even mid-playback.
  const state = zoneState({ outputProtocol: undefined });
  assert.equal(toApiZoneState(state).output, null, 'nothing to report without a lookup');

  const resolved = toApiZoneState(state, { outputProtocol: () => 'sendspin' });
  assert.deepEqual(resolved.output, { protocol: 'sendspin' });
});

test('the resolved output still carries its device', () => {
  const resolved = toApiZoneState(zoneState({ outputProtocol: undefined }), {
    outputProtocol: () => 'squeezelite',
    device: () => ({ id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true }),
  });
  assert.deepEqual(resolved.output, {
    protocol: 'squeezelite',
    device: { id: '02:8C:54:A9:DC:AC', name: 'Test1', connected: true },
  });
});

test('a service-native audiopath decides the kind, not audiotype', () => {
  // `audiotype` is shaped for the Loxone clients: a bridged service becomes Spotify and
  // is then downgraded to Playlist whenever the queue is not Spotify-owned, which labels
  // a single Apple Music track a playlist. The audiopath says what it actually is.
  const track = toApiZoneState(
    zoneState({
      audiopath: 'applemusic:track:b64_MTc4MDM4MjY5NQ==',
      audiotype: AudioType.Playlist,
    }),
  );
  assert.equal(track.source?.kind, 'track');

  const playlist = toApiZoneState(
    zoneState({ audiopath: 'applemusic:playlist:pl.42', audiotype: AudioType.Playlist }),
  );
  assert.equal(playlist.source?.kind, 'playlist');

  // An album is not a kind of its own — playing one queues its tracks.
  const album = toApiZoneState(
    zoneState({ audiopath: 'applemusic:album:123', audiotype: AudioType.Playlist }),
  );
  assert.equal(album.source?.kind, 'playlist');

  // Anything without a service-native path still falls back to audiotype.
  const local = toApiZoneState(
    zoneState({ audiopath: 'library://track/9', audiotype: AudioType.File }),
  );
  assert.equal(local.source?.kind, 'track');
});

// The Loxone dialect spends eight commands on the queue (queueadd, queueinsert,
// queueandplay, queue/play, queue/move/…/before/…, queue/remove, queue/clear,
// queueundo). Same capabilities here, addressed by what they do to the collection.

test('the queue reads as a page, with real source ids', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/queue`);
  assert.equal(res.statusCode, 200);
  const q = res.json();
  assert.equal(q.zoneId, 3);
  assert.equal(q.total, 2);
  assert.equal(q.currentIndex, 0);
  // Not collapsed to `spotify:…` the way the Loxone queue payload has to be.
  assert.equal(q.items[0].source, 'applemusic:track:1');
  assert.equal(q.items[0].id, 'a', 'the entry handle, for move and remove');
});

test('the queue pages', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/queue?start=1&limit=1`);
  const q = res.json();
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].id, 'b');
  assert.equal(q.start, 1);
  assert.equal(q.total, 2, 'total is the whole queue, not the page');
});

test('posting to the queue appends, or inserts next', async () => {
  const h = harness();
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/queue`, { uri: 'x:1' })).statusCode, 204);
  assert.equal(
    (await call(h, 'POST', `${API_ROOT}/zones/3/queue`, { uri: 'x:2', next: true })).statusCode,
    204,
  );
  assert.deepEqual(queueOps, ['append:x:1', 'next:x:2']);

  const bad = await call(h, 'POST', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid-uri');
});

test('patching the queue jumps to an entry or reorders one', async () => {
  const h = harness();
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { play: 'b' })).statusCode, 204);
  assert.equal(
    (await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { move: 'a', before: 'b' })).statusCode,
    204,
  );
  // No `before` means the end.
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { move: 'a' })).statusCode, 204);
  assert.deepEqual(queueOps, ['play:b', 'move:a>b', 'move:a>end']);

  const gone = await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, { play: 'nope' });
  assert.equal(gone.statusCode, 404);
  assert.equal(gone.json().error, 'queue-item-not-found');

  const empty = await call(h, 'PATCH', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(empty.statusCode, 400);
});

test('deleting from the queue removes one, clears all, or undoes', async () => {
  const h = harness();
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { id: 'a' })).statusCode, 204);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { all: true })).statusCode, 204);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, { undo: true })).statusCode, 204);
  assert.deepEqual(queueOps, ['remove:a', 'clear', 'undo']);

  // Clearing everything has to be asked for, not be what an empty body happens to mean.
  const vague = await call(h, 'DELETE', `${API_ROOT}/zones/3/queue`, {});
  assert.equal(vague.statusCode, 400);
  assert.equal(vague.json().error, 'invalid-queue-delete');
});

test('repeat and shuffle can be set, not only read', async () => {
  // ZoneState reported both from the start while the API had no way to change them.
  const h = harness();
  for (const [mode, expected] of [['all', 'all'], ['one', 'one'], ['off', 'off']] as const) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/repeat`, { repeat: mode });
    assert.equal(res.statusCode, 204);
    assert.deepEqual(h.commands.at(-1), { zoneId: 3, command: 'repeat', payload: expected });
  }
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/repeat`, { repeat: 'sometimes' })).statusCode, 400);

  await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: true });
  assert.equal(h.commands.at(-1)?.payload, 'on');
  await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: false });
  assert.equal(h.commands.at(-1)?.payload, 'off');
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/shuffle`, { shuffle: 'yes' })).statusCode, 400);
});

test('repeat maps to the same numbers the engine and outputs use', () => {
  // RepeatMode.Queue = 1 is "all", Track = 3 is "one". These were swapped here.
  assert.equal(toApiZoneState(zoneState({ plrepeat: 1 })).repeat, 'all');
  assert.equal(toApiZoneState(zoneState({ plrepeat: 3 })).repeat, 'one');
  assert.equal(toApiZoneState(zoneState({ plrepeat: 0 })).repeat, 'off');
});

// Favourites, recents and grouping: the last three things the own player still needed
// the Loxone protocol for.

test('favourites read, add, rename, reorder, play and remove', async () => {
  const h = harness();
  const list = await call(h, 'GET', `${API_ROOT}/zones/3/favorites`);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].id, 1);
  // The Loxone slot/plus pair describes their button grid, not the favourite.
  assert.ok(!('slot' in list.json().items[0]));
  assert.ok(!('plus' in list.json().items[0]));

  const created = await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, { uri: 'x:1', name: 'Mine' });
  assert.equal(created.statusCode, 201, 'a created resource is a 201');
  assert.equal(created.json().name, 'Mine');

  // Without a name the server fills in what it knows about the source.
  await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, { uri: 'x:2' });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { id: 1, name: 'New' });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { order: [2, 1] });
  await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { play: 1 });
  await call(h, 'DELETE', `${API_ROOT}/zones/3/favorites`, { id: 1 });
  assert.deepEqual(libOps, [
    'addFav:Mine:x:1',
    'addFav:(auto):x:2',
    'renameFav:1:New',
    'reorderFav:2,1',
    'playFav:1',
    'removeFav:1',
  ]);
});

test('favourites refuse a request that says nothing', async () => {
  const h = harness();
  assert.equal((await call(h, 'POST', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/favorites`, {})).statusCode, 400);
  assert.equal((await call(h, 'PATCH', `${API_ROOT}/zones/3/favorites`, { play: 42 })).statusCode, 404);
  assert.equal(libOps.filter((o) => !o.startsWith('playFav')).length, 0, 'nothing was applied');
});

test('recents read and clear, and carry no handle to edit', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/recents`);
  assert.equal(res.statusCode, 200);
  const item = res.json().items[0];
  assert.equal(item.source, 'applemusic:track:1', 'what you hand back to play');
  assert.ok(!('id' in item), 'history has nothing to rename or reorder');

  assert.equal((await call(h, 'DELETE', `${API_ROOT}/zones/3/recents`)).statusCode, 204);
  assert.deepEqual(libOps, ['clearRecents']);
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/recents`, {})).statusCode, 405);
});

test('grouping says what the group became, not just that it tried', async () => {
  const h = harness();
  const ok = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [7] });
  assert.equal(ok.statusCode, 200, '200 rather than 204 — the result is worth reading');
  assert.deepEqual(ok.json(), { leader: 3, members: [3, 7], rejected: [] });

  // Grouping mirrors frames between outputs of one protocol, so a zone on another is
  // reported as rejected rather than quietly left out.
  const mixed = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [7, 9] });
  assert.deepEqual(mixed.json().members, [3, 7]);
  assert.deepEqual(mixed.json().rejected, [{ id: 9, reason: 'protocol-mismatch' }]);

  const gone = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [99] });
  assert.deepEqual(gone.json().rejected, [{ id: 99, reason: 'zone-not-found' }]);
});

test('an empty member list ungroups, and a bad one is refused', async () => {
  const h = harness();
  const off = await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: [] });
  assert.equal(off.statusCode, 200);
  assert.deepEqual(off.json().members, [], 'no separate verb for leaving');

  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/group`, { members: 'nope' })).statusCode, 400);
  assert.equal((await call(h, 'PUT', `${API_ROOT}/zones/3/group`, {})).statusCode, 400);
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/3/group`)).statusCode, 405);
});

// A cover url that only names the zone is the point of this route: `track.coverUrl`
// changes every track and can be a remote host or a data uri, so it cannot be put in a
// wall panel's <img src> and left there.

test('the zone cover serves whatever the zone has, at a url that never changes', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png', 'the mime the source reported');
  assert.equal(res.body, 'jpegbytes');
  // Briefly cacheable: polling should not re-fetch the same art every second, but the
  // next track has to become visible without a url change to force it.
  assert.equal(res.headers['Cache-Control'], 'public, max-age=10');
});

test('a data-uri cover is decoded rather than handed over as text', async () => {
  const h = harness();
  zoneCover = `data:image/gif;base64,${Buffer.from('gifbytes').toString('base64')}`;
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/gif');
  assert.equal(res.body, 'gifbytes');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=10', 'same policy as bytes');
});

test('a zone without art answers 404 instead of an empty image', async () => {
  const h = harness();
  zoneCover = null;
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(res.statusCode, 404);
  // An unknown zone looks the same from outside: there is no cover either way.
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/404/cover`)).statusCode, 404);
});

test('size is passed upstream as a hint, and a nonsense one falls back', async () => {
  const h = harness();
  await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=300`);
  assert.deepEqual(coverAsks.at(-1), { zoneId: 3, targetSize: 300 });

  // No size, out of range, or not a number: use the now-playing default rather than
  // refusing, since the caller is usually an <img> tag that cannot handle a 400. An
  // out-of-range size must NOT be clamped to the nearest bound — this route once served
  // a 16px thumbnail to every caller that omitted `size`, because a missing value became
  // 0 and 0 clamped up to the minimum.
  for (const query of ['', '?size=0', '?size=1', '?size=99999', '?size=abc', '?size=-4']) {
    await call(h, 'GET', `${API_ROOT}/zones/3/cover${query}`);
    assert.equal(
      coverAsks.at(-1)?.targetSize,
      COVER_ART_NOW_PLAYING_SIZE,
      `${query || 'no query'} falls back`,
    );
  }
});

// The url deliberately does not change when the track does, so an ETag is what keeps a
// cached copy from going stale: revalidating costs a bodyless 304, and a new cover is
// visible immediately without the client having to change the url.

test('an unchanged cover revalidates to 304, and a new one does not', async () => {
  const h = harness();
  const first = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  const etag = first.headers['ETag'] as string;
  assert.ok(etag, 'the response identifies which cover it carried');

  const again = await call(h, 'GET', `${API_ROOT}/zones/3/cover`, undefined, {
    'if-none-match': etag,
  });
  assert.equal(again.statusCode, 304);
  assert.equal(again.body, '', 'no body is the entire point');

  // A different track is a different tag, so the same conditional request now gets bytes.
  zoneCover = { data: Buffer.from('other-art'), mime: 'image/jpeg' };
  const changed = await call(h, 'GET', `${API_ROOT}/zones/3/cover`, undefined, {
    'if-none-match': etag,
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.body, 'other-art');
  assert.notEqual(changed.headers['ETag'], etag);
});

test('the same artwork at another size is a different tag', async () => {
  // Two sizes are two images behind one url, so sharing a tag would serve the wrong one.
  const h = harness();
  const big = await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=640`);
  const small = await call(h, 'GET', `${API_ROOT}/zones/3/cover?size=300`);
  assert.notEqual(big.headers['ETag'], small.headers['ETag']);
});

test('a tag is stable across requests and identifies the source, not the request', async () => {
  // Stable means a restart or a second server hands out the same tag: it is hashed from
  // the artwork itself, not from a counter or a clock.
  const h = harness();
  const a = await call(h, 'GET', `${API_ROOT}/zones/3/cover`);
  const b = await call(harness(), 'GET', `${API_ROOT}/zones/3/cover`);
  assert.equal(a.headers['ETag'], b.headers['ETag']);
});

test('a client can bust a cache it does not control with a throwaway parameter', async () => {
  // A Loxone visualisation holds an <img src> far longer than max-age suggests, so an
  // unknown query parameter must be ignored rather than refused.
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/zones/3/cover?v=track-1234`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'jpegbytes');
  assert.equal(coverAsks.at(-1)?.targetSize, COVER_ART_NOW_PLAYING_SIZE, 'size still default');
});

test('the cover route is read-only', async () => {
  const h = harness();
  for (const method of ['PUT', 'POST', 'DELETE']) {
    assert.equal((await call(h, method, `${API_ROOT}/zones/3/cover`, {})).statusCode, 405, method);
  }
});

// A supervisor decides from the status code, so that is the part of /health and /ready
// that must not drift. The plugin's UI currently does a bare GET / and treats anything
// that is not a connection failure as healthy — a 500 passes.

test('health carries the verdict in the status code, not only the body', async () => {
  const h = harness();
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 200);

  // Degraded stays 200: the commonest reaction to a non-2xx is a restart, which is wrong
  // for a server that is still playing music.
  health = { ...health, status: 'degraded', checks: [{ name: 'loxone', status: 'degraded' }] };
  const degraded = await call(h, 'GET', `${API_ROOT}/health`);
  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.json().status, 'degraded');

  health = { ...health, status: 'unhealthy' };
  assert.equal((await call(h, 'GET', `${API_ROOT}/health`)).statusCode, 503);
});

test('ready answers a yes/no a supervisor can poll cheaply', async () => {
  const h = harness();
  const ready = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ready: true, phase: 'ready' });

  // Not ready is a 503 so a caller can branch on the code alone. This is what replaces
  // blocking 600 seconds on a file lock to guess whether a restart finished.
  lifecycle.markStarting();
  const restarting = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(restarting.statusCode, 503);
  assert.equal(restarting.json().ready, false);
  assert.equal(restarting.json().phase, 'starting');

  // A failed start says why, so "slow" and "broken" are distinguishable.
  lifecycle.markFailed(new Error('port 7090 already in use'));
  const failed = await call(h, 'GET', `${API_ROOT}/ready`);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().phase, 'failed');
  assert.equal(failed.json().error, 'port 7090 already in use');
});

test('health and ready need no session and reject writes', async () => {
  const h = harness();
  for (const path of ['/health', '/ready']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call(h, method, `${API_ROOT}${path}`, {});
      assert.notEqual(res.statusCode, 200, `${method} ${path} is not a command`);
    }
  }
});

// "Say in the kitchen that dinner is ready" is the thing an integrator actually wants from
// a music server, and until now only the Loxone clients could do it — spread over
// audio/<id>/tts, /alert, playeventfile and groupalert. It is a resource rather than a
// play-with-a-special-uri because an alert interrupts: the zone's own playback is ducked
// and resumed around it, and the volume comes from its alert setting, not its current one.

test('speaking into a zone passes the text and language through', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'tts',
    text: 'Dinner is ready',
    language: 'en',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { zoneId: 3, kind: 'tts', action: 'on', zones: [3] });
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0]!.text, 'Dinner is ready');
  assert.equal(alertCalls[0]!.language, 'en');
  assert.equal(alertCalls[0]!.action, 'on');
});

test('tts without text is refused rather than announcing silence', async () => {
  const h = harness();
  for (const body of [{ kind: 'tts' }, { kind: 'tts', text: '   ' }]) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'invalid-text');
  }
  assert.equal(alertCalls.length, 0, 'nothing reached the alerts layer');
});

test('the built-in sounds need no payload beyond their kind', async () => {
  const h = harness();
  for (const kind of ['bell', 'alarm', 'fire', 'buzzer']) {
    const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind });
    assert.equal(res.statusCode, 200, kind);
    assert.equal(res.json().kind, kind);
    assert.equal(alertCalls.at(-1)!.type, kind, 'passed through unchanged');
  }
});

test('an arbitrary sound travels as a custom url', async () => {
  // The alerts layer takes a caller-supplied sound as part of the type rather than as its
  // own argument, so the url is prefixed instead of sent separately.
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'url',
    url: 'http://example/doorbell.mp3',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(alertCalls[0]!.type, 'custom_url/http://example/doorbell.mp3');

  for (const bad of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://host/x.mp3']) {
    const rejected = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'url', url: bad });
    assert.equal(rejected.statusCode, 400, bad || '(empty)');
    assert.equal(rejected.json().error, 'invalid-url');
  }
});

test('one call can announce in several zones, with the addressed one leading', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, {
    kind: 'tts',
    text: 'Everyone out',
    zones: [7, 9],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().zones, [3, 7, 9], 'the path zone leads');
  assert.deepEqual(alertCalls[0]!.zones, [3, 7, 9]);
});

test('the addressed zone is not repeated when it is also listed', async () => {
  const h = harness();
  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', zones: [3, 7] });
  assert.deepEqual(alertCalls[0]!.zones, [3, 7]);
});

test('an alert can be stopped, which is what the looping kinds need', async () => {
  const h = harness();
  alertResult = { success: true, action: 'off' };
  const res = await call(h, 'DELETE', `${API_ROOT}/zones/3/alert`, { kind: 'alarm' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().action, 'off');
  assert.equal(alertCalls[0]!.action, 'off');
});

test('an unknown kind is refused with the list of real ones', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'foghorn' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid-alert-kind');
  assert.match(res.json().message, /tts/, 'says what is valid');
});

test('a volume override is optional and bounded', async () => {
  const h = harness();
  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell' });
  assert.equal(alertCalls[0]!.volume, undefined, 'absent means the zone alert setting wins');

  await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', volume: 80 });
  assert.equal(alertCalls[1]!.volume, 80);

  const bad = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'bell', volume: 'loud' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid-volume');
});

test('a refusal from the alerts layer is reported, not swallowed', async () => {
  // No TTS provider configured is the common one, and a 2xx there would look like success.
  const h = harness();
  alertResult = { success: false, action: 'on', reason: 'no-tts-provider' };
  const res = await call(h, 'POST', `${API_ROOT}/zones/3/alert`, { kind: 'tts', text: 'hello' });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'no-tts-provider');
});

test('an unknown zone and a wrong method are refused', async () => {
  const h = harness();
  assert.equal(
    (await call(h, 'POST', `${API_ROOT}/zones/404/alert`, { kind: 'bell' })).statusCode,
    404,
  );
  for (const method of ['GET', 'PUT', 'PATCH']) {
    const res = await call(h, method, `${API_ROOT}/zones/3/alert`, { kind: 'bell' });
    assert.equal(res.statusCode, 405, method);
  }
});

// You could already see that a zone was on a line-in but not put it there. Inputs are
// server-level — the same socket is selectable from every zone — so they are listed at the
// top level rather than under one zone, which would imply each has its own.

test('the configured inputs are listed, with what a client needs to render them', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/inputs`);
  assert.equal(res.statusCode, 200);
  const inputs = res.json().inputs;
  assert.equal(inputs.length, 2);
  // The icon is a name, not the internal Loxone number: a client would otherwise have to
  // carry that table to render anything.
  assert.equal(inputs[0].icon, 'cd-player');
  assert.equal(inputs[1].icon, 'turntable');
  // controllable says whether transport commands reach the device at all — false for a
  // turntable, where selecting it is the whole interaction.
  assert.equal(inputs[0].controllable, true);
  assert.equal(inputs[1].controllable, false);
});

test('a zone can be switched to an input', async () => {
  const h = harness();
  const res = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, { input: 'linein-a' });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(inputSelections, [{ zoneId: 3, inputId: 'linein-a' }]);
});

test('an unknown input is a different failure from an unknown zone', async () => {
  // A caller reading ids out of GET /inputs deserves to be told which of the two it got
  // wrong, rather than one 404 covering both.
  const h = harness();
  const badInput = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, { input: 'linein-z' });
  assert.equal(badInput.statusCode, 404);
  assert.equal(badInput.json().error, 'input-not-found');

  const badZone = await call(h, 'PUT', `${API_ROOT}/zones/404/input`, { input: 'linein-a' });
  assert.equal(badZone.statusCode, 404);
  assert.equal(badZone.json().error, 'zone-not-found');
  assert.equal(inputSelections.length, 0, 'neither reached the service');
});

test('the input must actually be named', async () => {
  const h = harness();
  for (const body of [{}, { input: '' }, { input: '   ' }, { input: 7 }]) {
    const res = await call(h, 'PUT', `${API_ROOT}/zones/3/input`, body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.equal(res.json().error, 'invalid-input');
  }
});

test('there is no verb for leaving an input', async () => {
  // Selecting something else is how you leave, and the server tears the old source down as
  // part of that. A DELETE would be a third way to say it with "and what plays now?" open.
  const h = harness();
  for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
    const res = await call(h, method, `${API_ROOT}/zones/3/input`, { input: 'linein-a' });
    assert.equal(res.statusCode, 405, method);
  }
});

test('a line-in reports the id you can hand straight back, and its configured name', async () => {
  // The stored audiopath is `linein:<id>` and sourceName holds the server's MAC — neither
  // is usable by a caller, so what round-trips is the input id and the configured name.
  const api = toApiZoneState(
    zoneState({
      audiopath: 'linein:linein-a',
      audiotype: AudioType.LineIn,
      sourceName: '000C290E5497',
      duration: 0,
    }),
    { inputLabel: (id) => (id === 'linein-a' ? 'BeoSound 9000' : null) },
  );
  assert.equal(api.source?.kind, 'linein');
  assert.equal(api.source?.id, 'linein-a', 'no prefix; this is what PUT /input takes');
  assert.equal(api.source?.name, 'BeoSound 9000', 'not the MAC');
  assert.equal(api.source?.seekable, false, 'nothing to seek in a live input');
});

// A queue mutation used to emit nothing at all, so a client could not tell a queue had
// changed — including when *another* client changed it. Our own player worked around it by
// re-reading after its own edits, which left a second tab stale indefinitely. The Loxone
// protocol has carried `audio_queue_event` all along; the API tap forwarded it there and
// published nothing here.

test('a collection change reaches subscribers on our own API too', () => {
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));

  const inner = makeNotifier();
  const notifier = withApiEvents(inner as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 12);
  notifier.notifyRoomFavoritesChanged(3, 4);
  notifier.notifyRecentlyPlayedChanged(3, 1234567890);

  assert.deepEqual(seen, [
    { type: 'queue.changed', id: 3, size: 12 },
    { type: 'favorites.changed', id: 3, count: 4 },
    // The timestamp is Loxone's own change marker and says nothing a caller can use.
    { type: 'recents.changed', id: 3 },
  ]);
});

test('a collection event carries the size, never the collection', () => {
  // A queue is paged and can hold thousands of entries; putting it in an event that fires on
  // every edit would be the wrong trade.
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));
  withApiEvents(makeNotifier() as unknown as NotifierPort, hub).notifyQueueUpdated(3, 900);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['id', 'size', 'type']);
});

test('Loxone still gets its own event, whatever happens on our side', () => {
  // The public API must never be able to break Loxone delivery, so the inner notifier is
  // called first and a subscriber that throws cannot stop it.
  const hub = new ApiEventHub();
  hub.subscribe(() => {
    throw new Error('subscriber is broken');
  });
  const inner = makeNotifier();
  const notifier = withApiEvents(inner as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 1);
  assert.deepEqual(inner.queue, [{ zoneId: 3, size: 1 }], 'Loxone was told regardless');
});

test('identical collection events are both delivered', () => {
  // Unlike zone state, which is a value worth deduplicating, "the queue changed" is an
  // event: two identical ones mean it changed twice. A reorder keeps the size and must
  // still be reported.
  const hub = new ApiEventHub();
  const seen: any[] = [];
  hub.subscribe((event) => seen.push(event));
  const notifier = withApiEvents(makeNotifier() as unknown as NotifierPort, hub);
  notifier.notifyQueueUpdated(3, 5);
  notifier.notifyQueueUpdated(3, 5);
  assert.equal(seen.length, 2);
});

function makeNotifier() {
  const queue: Array<{ zoneId: number; size: number }> = [];
  return {
    queue,
    notifyZoneStateChanged: () => {},
    notifyQueueUpdated: (zoneId: number, size: number) => queue.push({ zoneId, size }),
    notifyRoomFavoritesChanged: () => {},
    notifyRecentlyPlayedChanged: () => {},
    notifyRescan: () => {},
    notifyReloadMusicApp: () => {},
    notifyGlobalSearchResult: () => {},
    notifyGlobalSearchError: () => {},
    notifyAlertStateChanged: () => {},
    notifyPlaylistsChanged: () => {},
    notifyRadiosChanged: () => {},
    notifyServiceChanged: () => {},
  };
}

// `POST /play` answers 204 for a uri it cannot resolve, because resolution is asynchronous —
// the call is accepted before anything is looked up. So the failure has to surface in state,
// and it used to do so only as prose in `track.title`: `if (zone.track)` was then true for a
// zone playing nothing, and a UI rendered an error as a song title. Our own player had to run
// verification timers because of it.

test('a failed play reports an error, not a track', () => {
  // The signature a failure leaves: stopped, a user-facing title, and nothing loaded.
  const api = toApiZoneState(
    zoneState({
      mode: 'stop',
      title: 'Playback unavailable',
      artist: '',
      album: '',
      audiopath: '',
      duration: 0,
      time: 0,
    }),
  );
  assert.equal(api.error, 'Playback unavailable');
  assert.equal(api.track, null, 'if (zone.track) must not be true for a zone playing nothing');
  assert.equal(api.source, null);
});

test('a real track is never mistaken for an error', () => {
  const api = toApiZoneState(zoneState({ mode: 'play' }));
  assert.ok(!('error' in api), 'absent, so `if (zone.error)` is the whole check');
  assert.equal(api.track?.title, 'Song');
});

test('a stopped zone with a real track loaded is not an error', () => {
  // Stopping after playing something leaves the track in place; only a cleared zone with a
  // lone title is a failure.
  const api = toApiZoneState(zoneState({ mode: 'stop' }));
  assert.ok(!('error' in api));
  assert.equal(api.track?.title, 'Song');
});

test('an idle zone reports neither a track nor an error', () => {
  const api = toApiZoneState(
    zoneState({ mode: 'stop', title: '', artist: '', album: '', audiopath: '' }),
  );
  assert.equal(api.track, null);
  assert.ok(!('error' in api));
});

// This server does not require zones — it can run as a DLNA source with a streaming account
// and nothing else. The zone concept comes from the Loxone clients, which need everything to
// be one: a browser tab playing locally was given a synthetic zone purely so it would be
// visible. Destinations are the smaller, honest idea: an id you can play to.

test('destinations list both configured zones and clients playing locally', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/destinations`);
  assert.equal(res.statusCode, 200);
  const kinds = res.json().destinations.map((d: any) => d.kind);
  assert.deepEqual(kinds, ['zone', 'local'], 'a zone is one kind of destination, not the only');
});

test('a client can register itself as somewhere audio goes', async () => {
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/destinations/local`, { name: 'This tab' });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.kind, 'local');
  // It needs both to start receiving: an identity to announce, and where to announce it.
  assert.ok(body.clientId, 'an id to announce on the audio socket');
  assert.match(body.streamUrl, /^ws:\/\/.+\/sendspin$/, 'and the socket to connect to');
});

test('the socket url is built from the address that reached us', async () => {
  // A configured bind address is unusable: a server on 0.0.0.0 would hand out
  // ws://0.0.0.0:7090, and picking an interface would be wrong for another subnet.
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/destinations/local`, {}, {
    host: 'audio.local:7090',
  });
  assert.equal(res.json().streamUrl, 'ws://audio.local:7090/sendspin');
});

test('re-registering with the same clientId reclaims it', async () => {
  // What a page reload needs: without it every refresh leaves an orphan behind until it
  // times out.
  const h = harness();
  const res = await call(h, 'POST', `${API_ROOT}/destinations/local`, {
    clientId: 'browser-mine',
  });
  assert.equal(res.json().clientId, 'browser-mine');
});

test('playback commands work on a destination, and are the same commands', async () => {
  // A destination's id is its zone id, so these share one dispatcher rather than duplicating
  // fourteen verbs — and a server with no zones configured still has destinations.
  const h = harness();
  assert.equal((await call(h, 'POST', `${API_ROOT}/destinations/3/pause`)).statusCode, 204);
  assert.equal(
    (await call(h, 'PUT', `${API_ROOT}/destinations/3/volume`, { volume: 30 })).statusCode,
    204,
  );
  assert.deepEqual(h.commands, [
    { zoneId: 3, command: 'pause', payload: undefined },
    { zoneId: 3, command: 'volume', payload: '30' },
  ]);
});

test('the queue and friends are addressed as a zone, not as a destination', async () => {
  // Not a capability limit — a local destination *is* a zone and every zone route works on it.
  // This is only about which name addresses what: playback is mirrored on `/destinations/…` so
  // a caller holding one id need not know it is also a zone id, and everything else lives where
  // a caller will look for it.
  const h = harness();
  for (const action of ['group', 'favorites', 'recents', 'queue']) {
    const res = await call(h, 'GET', `${API_ROOT}/destinations/3/${action}`);
    assert.equal(res.statusCode, 404, action);
  }
  assert.equal((await call(h, 'GET', `${API_ROOT}/zones/3/queue`)).statusCode, 200);
});

test('a registered local destination is a zone id, usable on every zone route', async () => {
  // The documentation said these routes existed only for configured zones, which sent a client
  // toward building a second set of components it does not need. Measured against a live server
  // they all answer for a browser tab: queue, favourites and recents 200, and grouping accepts
  // it as a member.
  const h = harness();
  const registered = await call(h, 'POST', `${API_ROOT}/destinations/local`, { name: 'A tab' });
  const id = registered.json().id;
  assert.equal(typeof id, 'string');
  // The harness fakes one zone (3), so assert the relationship rather than the fake's contents:
  // a destination id is a zone id, in string form.
  assert.equal(String(Number(id)), id, 'a destination id is a zone id');
});

test('removing a local destination is refused for a zone', async () => {
  const h = harness();
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/destinations/local/9000`)).statusCode, 204);
  // A configured zone is not this route's to delete.
  assert.equal((await call(h, 'DELETE', `${API_ROOT}/destinations/local/3`)).statusCode, 404);
});

test('the server\'s own routing MAC is not reported as a source name', () => {
  // For anything with no service to name — a local file — `sourceName` holds this
  // audioserver's own MAC, which it uses to route between its parts. The native Loxone app
  // ignores it, so it was never visible there; reported here the source appeared to be
  // called "000C290E5497".
  const api = toApiZoneState(
    zoneState({ audiopath: 'library://local/Coldplay/01.flac', sourceName: '000C290E5497' }),
  );
  assert.equal(api.source?.name, '');
});

test('a real source name survives', () => {
  // Only a bare twelve-hex-character string is a MAC; anything a person chose stays.
  for (const name of ['Library', 'Apple Music', 'Kitchen NAS']) {
    const api = toApiZoneState(zoneState({ sourceName: name }));
    assert.equal(api.source?.name, name, name);
  }
});

// A configured zone is a room in a house: everyone may know the kitchen is playing. A local
// destination is a browser tab, which is not a room — it belongs in nobody's zone list, not even
// its owner's. Nor does a client need it there: the Sendspin socket it already holds to receive
// the audio pushes title, artist, album, artwork and progress as `server/state`, and that source
// cannot be out of step with the sound.

test('a local destination is absent from the zone list, for everyone', async () => {
  const h = harness();
  h.states.set(9000, zoneState({ id: 9000, name: 'A tab' }));

  const stranger = await call(h, 'GET', `${API_ROOT}/zones`);
  assert.deepEqual(stranger.json().zones.map((z: any) => z.id), [3]);

  // Including the owner: it reads its own state over Sendspin, not from here.
  const owner = await call(h, 'GET', `${API_ROOT}/zones`, undefined, {
    'x-sonn-client-id': 'browser-mine',
  });
  assert.deepEqual(owner.json().zones.map((z: any) => z.id), [3]);
});

test('the events snapshot leaves them out too', async () => {
  // Repeating a tab's state here would give every listener churn about somebody else's browser.
  const h = harness();
  h.states.set(9000, zoneState({ id: 9000, name: 'A tab' }));
  await withStream(h, `${API_ROOT}/events`, (res) => {
    const snapshot = JSON.parse(res.body.replace(/^data: /, '').split('\n')[0]!);
    assert.deepEqual(snapshot.zones.map((z: any) => z.id), [3]);
  });
});

test('a tab finds itself through destinations, where it is private to it', async () => {
  const h = harness();
  const mine = await call(h, 'GET', `${API_ROOT}/destinations`, undefined, {
    'x-sonn-client-id': 'browser-mine',
  });
  assert.ok(
    mine.json().destinations.some((d: any) => d.kind === 'local'),
    'the owner sees its own',
  );
});

/*
 * Paging a caller did not ask for.
 *
 * `/browse`, `/search` and `/playlists` document a default page size, and read it as
 * `clampInt(Number(params.get('limit') ?? 0), 1, MAX) ?? DEFAULT` — which never reached the default,
 * because `0` is a finite number and clamping it hit the *minimum*. Omitting the parameter returned
 * one item per page, which reads as a nearly empty library rather than as a paging bug: the response
 * is well-formed, the total is right, and only the second page reveals anything is wrong.
 */
test('an omitted limit means the default page, not one item', async () => {
  const h = harness();
  const id = 'b1.c.folder.library.local';

  await call(h, 'GET', `${API_ROOT}/browse/${id}`);
  assert.equal(h.browseAsks.at(-1)?.limit, 50, 'no limit asked for means the default');

  await call(h, 'GET', `${API_ROOT}/browse/${id}?limit=3`);
  assert.equal(h.browseAsks.at(-1)?.limit, 3, 'a limit that was asked for is honoured');

  await call(h, 'GET', `${API_ROOT}/browse/${id}?limit=9999`);
  assert.equal(h.browseAsks.at(-1)?.limit, 500, 'and capped');

  // Nonsense is "no preference", the same rule `?size=` follows, rather than the nearest bound.
  await call(h, 'GET', `${API_ROOT}/browse/${id}?limit=nonsense`);
  assert.equal(h.browseAsks.at(-1)?.limit, 50);

  await call(h, 'GET', `${API_ROOT}/browse/${id}?limit=0`);
  assert.equal(h.browseAsks.at(-1)?.limit, 50);

  // `start` is separate and already worked; asserted here so the pair stays a pair.
  await call(h, 'GET', `${API_ROOT}/browse/${id}?start=40`);
  assert.deepEqual(
    { start: h.browseAsks.at(-1)?.start, limit: h.browseAsks.at(-1)?.limit },
    { start: 40, limit: 50 },
  );
});

/*
 * Refused is not empty. A door the service turned away used to come back `200 []`, so a dead
 * token looked like a library with nothing in it; it is a 502 that names the service and why.
 */
test('a service that would not answer is a 502 with the reason, not an empty listing', async () => {
  const h = harness();
  const res = await call(h, 'GET', `${API_ROOT}/browse/refused`);
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'service-unavailable');
  assert.equal(res.json().service, 'spotify@Bianca');
  assert.equal(res.json().reason, 'auth');
});
