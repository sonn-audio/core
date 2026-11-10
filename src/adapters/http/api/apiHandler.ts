/**
 * The server's own public API (`/api/*`).
 *
 * Deliberately small and separate from the admin API: the admin API is the
 * back-end of our own UI (100+ routes, UI-shaped, free to change), while this is
 * a contract third parties are invited to build on. Commands go over plain
 * HTTP because integrators reach for curl and one-shot scripts; live state goes
 * over SSE because reading state should never require polling.
 *
 * Commands are translated onto the same zone command engine the Loxone adapter
 * drives (`ZoneManager.handleCommand`), so there is one implementation of
 * "pause zone 3" rather than one per protocol.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'node:crypto';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type {
  AudioAnalysisEvent,
  AudioAnalysisSubscription,
} from '@/application/audio/audioAnalysisService';
import { ANALYSIS_DB_FLOOR, ANALYSIS_FULL_SCALE } from '@/domain/audio/analysisScale';
import { serverClockUs } from '@/shared/audio/serverClock';
import { toApiZoneState } from '@/adapters/http/api/zoneProjection';
import { resolveUriFromRef } from '@/domain/media/browseRef';
import {
  OUTPUT_DELAY_MAX_MS,
  OUTPUT_DELAY_MIN_MS,
  parseOutputDelayMs,
} from '@/adapters/http/outputDelay';
import type {
  ApiAlertKind,
  ApiDestination,
  ApiLocalDestination,
  ApiAudioFormat,
  ApiAudioServers,
  ApiBrowseItem,
  ApiBrowseResult,
  ApiInput,
  ApiItemAbout,
  ApiSearchResult,
  ApiService,
  ApiFavorite,
  ApiGroupResult,
  ApiFavorites,
  ApiOutput,
  ApiPowerState,
  ApiOutputCapabilities,
  ApiOutputSync,
  ApiPlaylist,
  ApiQueue,
  ApiRecents,
  ApiVolumeLimits,
  ApiZoneSession,
  ApiZoneState,
} from '@/domain/zones/apiTypes';
import type { ZoneState } from '@/domain/zones/zoneState';
import { createLogger } from '@/shared/logging/logger';
import { healthHttpStatus, type HealthReport } from '@/domain/server/health';
import type { ServerLifecycleSnapshot } from '@/domain/server/lifecycle';
import { serveCover } from '@/adapters/http/streams/serveCover';
import { COVER_ART_NOW_PLAYING_SIZE, isHttpUrl } from '@/shared/coverArt';
import { decodeBrowseRef } from '@/domain/media/browseRef';
import { ProviderUnavailableError } from '@/adapters/content/providerUnavailable';

export type ApiHandlerDeps = {
  eventHub: ApiEventHub;
  getAllZoneStates: () => ZoneState[];
  getZoneState: (zoneId: number) => ZoneState | null | undefined;
  handleCommand: (zoneId: number, command: string, payload?: string) => void;
  /** Applies an explicit power command immediately, without the automatic OFF delay. */
  setPower: (zoneId: number, signal: 0 | 1) => boolean;
  /** Stops playback and applies an immediate physical power-off. */
  powerOffImmediately?: (zoneId: number) => boolean;
  /** Which device a zone's output plays to, when its protocol identifies one. */
  getOutputDevice: (zoneId: number) => ApiOutput['device'] | undefined;
  /**
   * Starts something on a zone. `uri` is either a stream URL or a `source.id` this API
   * handed out earlier; resolving metadata and rebuilding the queue happens downstream,
   * the same way it does for a Loxone-originated play.
   */
  playContent: (zoneId: number, uri: string) => Promise<void>;
  /** A page of a zone's queue, without the Loxone-facing rewrites. */
  getQueue: (zoneId: number, start: number, limit: number) => ApiQueue | null;
  /** Appends to the end of the queue. */
  queueAppend: (zoneId: number, uri: string) => Promise<void>;
  /** Inserts right after the entry playing now. */
  queueInsertNext: (zoneId: number, uri: string) => Promise<void>;
  /** Jumps to an entry by its id; false when no entry has that id. */
  queuePlay: (zoneId: number, itemId: string) => boolean;
  /** Moves an entry before another, or to the end when `beforeId` is null. */
  queueMove: (zoneId: number, itemId: string, beforeId: string | null) => boolean;
  queueRemove: (zoneId: number, itemId: string) => void;
  queueClear: (zoneId: number) => void;
  /** Reverts the last queue edit. */
  queueUndo: (zoneId: number) => void;
  /** Moves the complete queue and current playback position to another zone. */
  handoff: (sourceId: number, targetId: number) => Promise<boolean>;
  /** A page of a zone's favourites. */
  getFavorites: (zoneId: number, start: number, limit: number) => Promise<ApiFavorites | null>;
  /** Adds a favourite; returns the created one. */
  addFavorite: (zoneId: number, name: string, uri: string) => Promise<ApiFavorite>;
  renameFavorite: (zoneId: number, id: number, name: string) => Promise<void>;
  removeFavorite: (zoneId: number, id: number) => Promise<void>;
  /** Reorders the whole list to the given ids. */
  reorderFavorites: (zoneId: number, ids: number[]) => Promise<void>;
  /** Starts a favourite by its id; false when the zone has no such favourite. */
  playFavorite: (zoneId: number, id: number) => Promise<boolean>;
  /** A page of what a zone played before, most recent first. */
  getRecents: (zoneId: number, start: number, limit: number) => Promise<ApiRecents | null>;
  clearRecents: (zoneId: number) => Promise<void>;
  /** Lists the audioservers known through the Loxone installation configuration. */
  listAudioServers: () => ApiAudioServers;
  /**
   * Puts a zone at the head of a group with these members, or ungroups it when the list
   * is empty. Returns what the group became, including anything rejected.
   */
  setGroup: (zoneId: number, members: number[]) => ApiGroupResult | null;
  /**
   * Plays or stops an alert. Null when the zone is unknown; otherwise the alerts layer's
   * own verdict, which can still be a refusal (no TTS provider, missing sound).
   */
  playAlert: (request: {
    zoneId: number;
    type: string;
    action: 'on' | 'off';
    zones: number[];
    text?: string;
    language?: string;
    volume?: number;
  }) => Promise<{ success: boolean; action: 'on' | 'off'; reason?: string } | null>;
  /**
   * The cover for what a zone is playing now: inline bytes, a data uri, or a url to
   * proxy. Null when the zone has none.
   */
  getZoneCover: (
    zoneId: number,
    targetSize: number,
  ) => { data: Buffer; mime?: string } | string | null;
  /** Which protocol a zone plays over right now; see ApiOutput. */
  getOutputProtocol: (zoneId: number) => string | null;
  getOutputCapabilities: (zoneId: number) => ApiOutputCapabilities | null;
  /** How the output is timed against its device; null when the protocol has no clock agreement. */
  getOutputSync: (zoneId: number) => ApiOutputSync | null;
  /**
   * The prepared waveform for an audiopath, or null when there is none.
   *
   * Null covers both "this can never have one" (a stream) and "not yet" (a file being decoded), which
   * the caller cannot and need not tell apart: both mean draw what you have and ask again later.
   */
  getWaveform: (audiopath: string) => { buckets: number[]; durationMs: number | null } | null;
  /** Which zones play as one, leader first. Not derivable from zone state; see toGroup. */
  getGroup: (zoneId: number) => { leader: number; members: number[] } | null;
  /**
   * Persist and apply a zone's output delay. `clientId` targets one Sendspin satellite instead of
   * the zone's own output. `applied` is false when no live output took it — the value is still
   * stored, so a device connecting later gets it.
   */
  setOutputDelay: (
    zoneId: number,
    delayMs: number,
    clientId?: string | null,
  ) => Promise<{ delayMs: number; applied: boolean }>;
  /** The configured name of the service an audiopath belongs to, for `source.name`. */
  getServiceLabel: (audiopath: string) => string | null;
  /** The configured name of a line-in, so `source.name` is not the server's MAC. */
  getInputLabel: (inputId: string) => string | null;
  /** What a zone is streaming right now, for `format`. */
  getStreamFormat: (zoneId: number) => ApiAudioFormat | null;
  /** This run of playback's counters; null when the room is not playing. */
  getZoneSession?: (zoneId: number) => ApiZoneSession | null;
  /** What a zone's volume will accept: its cap, its power-on level and its step. */
  getVolumeLimits: (zoneId: number) => ApiVolumeLimits | undefined;
  getPowerState?: (zoneId: number) => ApiPowerState | null;
  getAudioAnalysisFormat: (zoneId: number) =>
    | { sampleRate: number; channels: number; bitDepth: number }
    | null;
  subscribeAudioAnalysis: (
    zoneId: number,
    options: AudioAnalysisSubscription,
    listener: (event: AudioAnalysisEvent) => void,
  ) => () => void;
  /**
   * Start a zone's *running* measurements over — the loudness integrator and the clip count.
   *
   * Optional so a host that wires an older analysis service still serves this endpoint; without it
   * the readings simply describe everything since the stream armed rather than the current track.
   */
  resetAudioAnalysis?: (zoneId: number) => void;
  /** Current equalizer bands for a zone, or null when the zone is unknown. */
  getEqualizerBands: (zoneId: number) => number[] | null;
  /**
   * Applies equalizer bands. Returns the applied bands, or null when the zone is
   * unknown or the bands are not ten valid values.
   *
   * Deliberately does not forward to an external equalizer provider: a provider that
   * pushed a change here would otherwise receive its own change straight back
   * (sonn-audio/core#251). Only app-originated writes are forwarded.
   */
  setEqualizerBands: (zoneId: number, bands: unknown) => Promise<number[] | null>;
  /** Everywhere audio can be sent right now, from this caller's point of view. */
  listDestinations: (clientId?: string) => ApiDestination[];
  /**
   * The client id that owns a zone when it is a local destination, or null for a configured
   * zone. Used to keep one browser's tab out of another's list.
   */
  getLocalDestinationOwner: (zoneId: number) => string | null;
  /**
   * Registers the caller as a destination that plays audio itself. Null when this runtime was
   * built without local playback.
   */
  registerLocalDestination: (options: {
    name?: string;
    clientId?: string;
    host?: string;
  }) => Promise<ApiLocalDestination | null>;
  /** Removes a local destination; false when there is no such one. */
  removeLocalDestination: (id: string) => Promise<boolean>;
  /** Every content service, with what it can actually search. */
  listServices: () => Promise<ApiService[]>;
  /**
   * Lists a container's children. Null when the id is not one of ours or names nothing.
   */
  browse: (id: string, start: number, limit: number) => Promise<ApiBrowseResult | null>;
  /** Describes one item by id. Null when it cannot be found. */
  describeItem: (id: string) => Promise<ApiBrowseItem | null>;
  /**
   * The story around an item. Null whenever there is none — which is most of the time, and is
   * the documented ordinary answer rather than a failure.
   *
   * Optional so a server assembled without enrichment simply has no such route, which the
   * contract already accounts for: the client reads 404 as "this server cannot tell that story".
   */
  describeAbout?: (id: string) => Promise<ApiItemAbout | null>;
  /** Searches across services, grouped by kind. */
  search: (request: {
    query: string;
    kinds: string[];
    services: string[];
    limit: number;
  }) => Promise<ApiSearchResult>;
  listPlaylists: (start: number, limit: number) => Promise<{ items: ApiPlaylist[]; total: number }>;
  createPlaylist: (name: string) => Promise<ApiPlaylist>;
  renamePlaylist: (id: string, name: string) => Promise<ApiPlaylist | null>;
  deletePlaylist: (id: string) => Promise<boolean>;
  addPlaylistItem: (playlistId: string, itemId: string) => Promise<boolean>;
  removePlaylistItem: (playlistId: string, position: number) => Promise<boolean>;
  movePlaylistItem: (playlistId: string, from: number, to: number) => Promise<boolean>;
  /** Every configured input, in configuration order. */
  getInputs: () => ApiInput[];
  /**
   * Switches a zone to an input. False when no input has that id.
   *
   * There is no counterpart: leaving an input means selecting something else, which the
   * ordinary play/favourite paths already do.
   */
  selectInput: (zoneId: number, inputId: string) => boolean;
  /** The current health verdict; see buildHealthReport. */
  getHealth: () => HealthReport;
  /** Whether the server is serving yet, for the cheap readiness probe. */
  getLifecycle: () => ServerLifecycleSnapshot;
  serverVersion: string;
  startedAt: number;
};

/**
 * Where this API lives. Versioned in the path from the start: additive changes are
 * safe without it, but a field that has to be renamed or removed cannot be, and
 * discovering that after integrators have shipped is too late to fix cheaply.
 */
export const API_ROOT = '/api/v1';

function serializeAnalysisEvent(event: AudioAnalysisEvent): Record<string, unknown> {
  if (event.type === 'spectrum') {
    return { type: event.type, bins: Array.from(event.bins), timestampUs: event.timestampUs };
  }
  /*
   * The two pictures travel as base64, where the spectrum travels as numbers.
   *
   * Not an inconsistency: a spectrum is 48 readings a frame and each one is a *value* a client may
   * want to inspect, while a scope trace and a goniometer figure are 160 and 256 bytes of shape.
   * As a JSON array those two cost about 1.2 kB a frame — 36 kB/s at 30 fps, for a drawing — and
   * base64 puts them at a third of that with no loss, because a signed byte is exactly what the
   * measurement produced.
   */
  if (event.type === 'scope' || event.type === 'gonio') {
    const bytes = Buffer.from(event.points.buffer, event.points.byteOffset, event.points.byteLength);
    return { type: event.type, points: bytes.toString('base64'), timestampUs: event.timestampUs };
  }
  if (event.type === 'truepeak') {
    /* `-Infinity` is what silence measures and is not valid JSON; null is the same statement. */
    return {
      type: event.type,
      leftDb: Number.isFinite(event.leftDb) ? event.leftDb : null,
      rightDb: Number.isFinite(event.rightDb) ? event.rightDb : null,
      clips: event.clips,
      timestampUs: event.timestampUs,
    };
  }
  return { ...event };
}

/**
 * The unversioned prefix this API briefly used during the 4.0 beta. Matched only so a
 * caller from that period gets told where things went, never served.
 */
const LEGACY_ROOT = '/api';

/** How long an idle SSE stream waits before emitting a comment to keep proxies from closing it. */
const SSE_KEEPALIVE_MS = 25_000;

/**
 * Browse paging bounds.
 *
 * Capped because a caller asking for everything is usually a mistake, and several providers
 * fetch a whole upstream page per request. 50 is the same default the Loxone dialect uses.
 */
const BROWSE_DEFAULT_LIMIT = 50;
const BROWSE_MAX_LIMIT = 500;

/**
 * Search paging bounds, per kind.
 *
 * The internal search layer clamps to 20 per category, which is why no consumer can fetch a
 * second page today. This API's own ceiling is set higher so it does not become the binding
 * limit once that is lifted.
 */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

/**
 * What you can do through a `/destinations/…` path.
 *
 * Playback only — but not because a local destination lacks the rest. It *is* a zone: it
 * appears in `GET /zones` with full state, and the queue, favourites, recents and grouping
 * routes all work on it. So this set is about which name addresses what, not about capability.
 *
 * `/destinations` earns its place for the one thing `/zones` cannot express — registering a
 * client as somewhere audio goes, and telling a zone from a tab. Playback is mirrored here so a
 * caller that only holds a destination id never has to know it is also a zone id. Everything
 * else lives under `/zones/…`, which is where a caller looking for the queue will look.
 */
const DESTINATION_ACTIONS = new Set([
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'volume',
  'mute',
  'position',
  'power',
  'repeat',
  'shuffle',
  'cover',
  'alert',
]);

/**
 * Which client is asking, when it says so.
 *
 * Only `GET /destinations` needs this, and only to show a tab itself: a local destination is
 * private to the browser that registered it, and the `clientId` handed back then is how it
 * proves ownership — a value only that client holds.
 *
 * Absent is not an error. A script or a home-automation system has no browser to play to, so the
 * configured zones alone is the right answer for it.
 *
 * Read from a header or the query string, since a client cannot always set headers.
 */
function callerClientId(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers['x-sonn-client-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return (fromHeader ?? url.searchParams.get('clientId') ?? undefined) || undefined;
}

/** The alert kinds this API accepts; `url` becomes a custom sound. */
const ALERT_KINDS: ApiAlertKind[] = ['tts', 'bell', 'alarm', 'fire', 'buzzer', 'url'];

/**
 * How the alerts layer spells "play this arbitrary sound". It takes the url as part of the
 * type rather than as its own argument, so a caller-supplied url is prefixed with this.
 */
const ALERT_CUSTOM_URL_PREFIX = 'custom_url/';

/** Smallest and largest cover a caller may ask for; outside this it is treated as unasked. */
const COVER_SIZE_MIN = 32;
const COVER_SIZE_MAX = 2000;

/**
 * Where a paged request starts.
 *
 * Accepts `start` and `offset` as the same thing. The response field is `start`, so that is
 * the documented name — but `/browse` shipped reading only `offset`, and a caller reading
 * `start` out of one response and writing `offset` into the next request is a trap worth
 * removing rather than documenting. Both work everywhere; neither is silently ignored.
 */
function pagingStart(params: URLSearchParams): number {
  const raw = params.get('start') ?? params.get('offset') ?? '0';
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * How many items a paged request wants.
 *
 * An absent `limit` means the default, and getting that right is the whole reason this is a function.
 * Written inline as `clampInt(Number(params.get('limit') ?? 0), 1, MAX) ?? DEFAULT` it reads as
 * "clamp it, or fall back" — but `0` is a finite number, so the clamp pinned it to the *minimum* and
 * the `??` never fired. A caller who omitted the parameter got one item per page out of `/browse`,
 * `/search` and `/playlists`, which looks like an empty library rather than a paging default.
 *
 * Same rule as `?size=`: a missing or nonsensical value means "no preference" and gets the default,
 * rather than being silently turned into the nearest bound.
 */
function pagingLimit(params: URLSearchParams, fallback: number, max: number): number {
  const raw = params.get('limit');
  if (raw === null || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(max, Math.floor(value));
}

/**
 * The cover size a `?size=` parameter asks for, or the now-playing default.
 *
 * Deliberately *not* clamped: an absent or nonsensical size means "no preference", and
 * clamping it would silently turn that into the nearest bound. Clamping a missing size to
 * the minimum is how this route once served 16px thumbnails to everyone who omitted it.
 */
function coverSize(raw: string | null): number {
  const requested = Number(raw);
  if (!raw || !Number.isFinite(requested)) {
    return COVER_ART_NOW_PLAYING_SIZE;
  }
  const rounded = Math.round(requested);
  return rounded >= COVER_SIZE_MIN && rounded <= COVER_SIZE_MAX
    ? rounded
    : COVER_ART_NOW_PLAYING_SIZE;
}

/**
 * A tag identifying which cover a response carried, or undefined when there is none.
 *
 * Hashed from what the artwork *is* — the upstream url, or the bytes when they are inline
 * — plus the requested size, since two sizes are different images at the same url. It is
 * therefore stable across restarts and identical across servers, which a counter or a
 * timestamp would not be.
 */
function coverEtag(
  cover: { data: Buffer; mime?: string } | string | null,
  size: number,
): string | undefined {
  if (!cover) {
    return undefined;
  }
  const identity = typeof cover === 'string' ? Buffer.from(cover) : cover.data;
  const hash = createHash('sha1').update(identity).update(`@${size}`).digest('base64url');
  return `"${hash}"`;
}

export class ApiHandler {
  private readonly log = createLogger('Api');

  constructor(private readonly deps: ApiHandlerDeps) {}

  /**
   * True when this handler owns the path, so the gateway can delegate.
   *
   * Claims unversioned `/api/...` too, purely to answer it properly: without that it
   * would fall through to the static file handler and a caller written against the
   * beta would get an HTML page instead of an explanation.
   */
  public static owns(pathname: string): boolean {
    return (
      pathname === API_ROOT ||
      pathname.startsWith(`${API_ROOT}/`) ||
      pathname === LEGACY_ROOT ||
      pathname.startsWith(`${LEGACY_ROOT}/`)
    );
  }

  public async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const full = url.pathname.replace(/\/+$/, '') || API_ROOT;
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // A request without the version is answered, not silently 404'd: say where the
    // API moved rather than leaving the caller guessing. Checked *after* ruling out the
    // versioned prefix, since `/api/v1/...` also starts with `/api/`.
    const versioned = full === API_ROOT || full.startsWith(`${API_ROOT}/`);
    if (!versioned && (full === LEGACY_ROOT || full.startsWith(`${LEGACY_ROOT}/`))) {
      const suffix = full.slice(LEGACY_ROOT.length);
      this.sendJson(res, 404, {
        error: 'api-version-required',
        message: `This API is versioned. Use ${API_ROOT}${suffix} instead of ${full}.`,
      });
      return;
    }

    // Everything below matches against the path *after* the version, so the version
    // lives in one place instead of in every comparison.
    const pathname = full === API_ROOT ? '' : full.slice(API_ROOT.length);

    if (pathname === '/health' && method === 'GET') {
      const report = this.deps.getHealth();
      this.sendJson(res, healthHttpStatus(report.status), report);
      return;
    }

    // Separate from /health on purpose: a supervisor asking "can I stop waiting?" wants a
    // yes/no it can read from a status code, not a report it has to parse. Kept cheap
    // enough to poll every second, which is what replaces waiting on a file lock.
    if (pathname === '/ready' && method === 'GET') {
      const lifecycle = this.deps.getLifecycle();
      const ready = lifecycle.phase === 'ready';
      this.sendJson(res, ready ? 200 : 503, {
        ready,
        phase: lifecycle.phase,
        ...(lifecycle.error ? { error: lifecycle.error } : {}),
      });
      return;
    }

    if (pathname === '/events' && method === 'GET') {
      this.streamEvents(req, res);
      return;
    }

    /*
     * The delay is the one output setting this API writes.
     *
     * A read of it comes back inside `output.sync` with everything needed to judge it, so there is
     * no GET here: a caller reading the zone already has it, and a second spelling of the same
     * value is a second thing to keep true.
     */
    /*
     * A waveform belongs to the audio, not to the room playing it.
     *
     * Hence a `uri` query rather than `/zones/{id}/waveform`: the same track has the same shape in
     * every room, so keyed by zone it would be the same bytes under a dozen URLs and uncacheable in a
     * browser. `source.id` on a zone is exactly what goes in here.
     */
    if (pathname === '/waveform') {
      if (method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      const uri = (url.searchParams.get('uri') ?? '').trim();
      if (!uri) {
        this.sendJson(res, 400, { error: 'missing-uri' });
        return;
      }
      const waveform = this.deps.getWaveform(resolveUriFromRef(uri));
      if (!waveform) {
        // 404 rather than an empty array: "no shape for this audio" is a different answer from "a
        // shape that happens to be silent", and a client drawing the second would draw a flat line.
        this.sendJson(res, 404, { error: 'no-waveform' });
        return;
      }
      // Immutable for a day: the bytes are derived from a file that, if it changes, changes its
      // audiopath's size and mtime and therefore gets recomputed under a new response.
      this.sendJson(res, 200, { uri, ...waveform }, { 'cache-control': 'private, max-age=86400' });
      return;
    }

    const delayMatch = /^\/zones\/(\d+)\/output\/delay$/.exec(pathname);
    if (delayMatch) {
      if (method !== 'PUT') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      await this.handleOutputDelay(req, res, Number(delayMatch[1]));
      return;
    }

    const analysisMatch = /^\/zones\/(\d+)\/analysis$/.exec(pathname);
    if (analysisMatch) {
      if (method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.streamAnalysis(req, res, Number(analysisMatch[1]), url);
      return;
    }

    if (pathname === '/services' && method === 'GET') {
      this.sendJson(res, 200, { services: await this.deps.listServices() });
      return;
    }

    if (pathname === '/search' && method === 'GET') {
      await this.handleSearch(res, url);
      return;
    }

    const playlistsMatch = /^\/playlists(?:\/(.+))?$/.exec(pathname);
    const playlistItemsMatch = /^\/playlists\/(.+)\/items$/.exec(pathname);
    if (playlistItemsMatch) {
      await this.handlePlaylistItems(req, res, method, playlistItemsMatch[1]!);
      return;
    }
    if (playlistsMatch) {
      await this.handlePlaylists(req, res, method, playlistsMatch[1], url);
      return;
    }

    // The root has no id of its own, so `/browse` and `/browse/{id}` are one route with the
    // id optional rather than two.
    const browseMatch = /^\/browse(?:\/(.+))?$/.exec(pathname);
    if (browseMatch && method === 'GET') {
      await this.handleBrowse(res, browseMatch[1], url);
      return;
    }

    // Before the item route, and matched on its own: `/items/{id}/about` is a sub-resource, and
    // an id is opaque, so nothing can tell one from the other by looking. See the item route
    // below for what a greedy match did here.
    const aboutMatch = /^\/items\/([^/]+)\/about$/.exec(pathname);
    if (aboutMatch && method === 'GET') {
      await this.handleItemAbout(res, aboutMatch[1]!);
      return;
    }

    // One segment, not `.+`: an id is opaque, so a greedy match cannot tell an id from an id
    // followed by a sub-resource. It swallowed `/items/{id}/about` into the id and answered
    // *200* with a mangled item, which is worse than not having the route at all: a caller that
    // correctly treats 404 as "no such surface" got a body of the wrong shape instead. Anything
    // else under an item now falls through to the 404 at the end, which is the honest answer
    // until such a route exists. Ids containing a slash are percent-encoded by the caller and
    // never appear literally here.
    const itemMatch = /^\/items\/([^/]+)$/.exec(pathname);
    if (itemMatch && method === 'GET') {
      await this.handleItem(res, itemMatch[1]!);
      return;
    }

    if (pathname === '/destinations' && method === 'GET') {
      this.sendJson(res, 200, {
        destinations: this.deps.listDestinations(callerClientId(req, url)),
      });
      return;
    }

    // `local` is a literal, not an id: a caller registering itself has no id yet, and this
    // is the one route where the server assigns one.
    if (pathname === '/destinations/local' && method === 'POST') {
      await this.handleRegisterLocal(req, res);
      return;
    }

    const localMatch = /^\/destinations\/local\/(.+)$/.exec(pathname);
    if (localMatch && method === 'DELETE') {
      const removed = await this.deps.removeLocalDestination(localMatch[1]!);
      if (!removed) {
        this.sendJson(res, 404, { error: 'destination-not-found' });
        return;
      }
      res.writeHead(204).end();
      return;
    }

    if (pathname === '/inputs' && method === 'GET') {
      // Server-level, not per zone: an input is selectable from any zone, so hanging the
      // list off one would imply each has its own.
      this.sendJson(res, 200, { inputs: this.deps.getInputs() });
      return;
    }

    if (pathname === '/audio-servers' && method === 'GET') {
      this.sendJson(res, 200, this.deps.listAudioServers());
      return;
    }

    if (pathname === '/zones' && method === 'GET') {
      this.sendJson(res, 200, { zones: this.snapshot() });
      return;
    }

    // A destination's id is its zone id, so `/destinations/{id}/pause` is the same command as
    // `/zones/{id}/pause` and shares the dispatcher below rather than duplicating fourteen
    // verbs. The two names are not redundant: a server with no zones configured still has
    // destinations, which is the whole point of the split — zones are optional, somewhere to
    // send audio is not.
    //
    // Only playback verbs are reachable this way. Grouping, favourites, recents and the queue
    // stay on `/zones/…` because they are things only a configured zone has.
    const destinationMatch = /^\/destinations\/(\d+)(?:\/([a-z]+))?$/.exec(pathname);
    const zoneMatch =
      /^\/zones\/(\d+)(?:\/([a-z]+))?$/.exec(pathname) ??
      (destinationMatch && (!destinationMatch[2] || DESTINATION_ACTIONS.has(destinationMatch[2]))
        ? destinationMatch
        : null);
    if (zoneMatch) {
      const zoneId = Number(zoneMatch[1]);
      const action = zoneMatch[2];
      // The equalizer is configuration, not playback: it is readable and writable for
      // a configured zone whether or not that zone currently has live state, so it
      // does not go through the live-state lookup below.
      if (action === 'equalizer') {
        await this.handleEqualizer(req, res, method, zoneId);
        return;
      }
      if (action === 'queue') {
        await this.handleQueue(req, res, method, zoneId, url);
        return;
      }
      if (action === 'favorites') {
        await this.handleFavorites(req, res, method, zoneId, url);
        return;
      }
      if (action === 'recents') {
        await this.handleRecents(res, method, zoneId, url);
        return;
      }
      if (action === 'group') {
        await this.handleGroup(req, res, method, zoneId);
        return;
      }
      if (action === 'cover') {
        await this.handleCover(req, res, method, zoneId, url);
        return;
      }
      if (action === 'alert') {
        await this.handleAlert(req, res, method, zoneId);
        return;
      }
      if (action === 'input') {
        await this.handleInput(req, res, method, zoneId);
        return;
      }
      await this.handleZoneRoute(req, res, method, zoneId, action);
      return;
    }

    this.sendJson(res, 404, { error: 'not-found' });
  }

  private async handleZoneRoute(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    action: string | undefined,
  ): Promise<void> {
    const state = this.deps.getZoneState(zoneId);
    if (!state) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }

    if (!action) {
      if (method !== 'GET') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      this.sendJson(res, 200, this.project(state));
      return;
    }

    if (action === 'handoff') {
      if (method !== 'POST') {
        this.sendJson(res, 405, { error: 'method-not-allowed' });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = await this.readJsonBody(req);
      } catch {
        this.sendJson(res, 400, { error: 'invalid-json' });
        return;
      }
      const targetZoneId = this.clampInt(body.targetZoneId, 0, Number.MAX_SAFE_INTEGER);
      if (targetZoneId === null) {
        this.sendJson(res, 400, { error: 'invalid-target-zone' });
        return;
      }
      let moved: boolean;
      try {
        moved = await this.deps.handoff(zoneId, targetZoneId);
      } catch {
        this.sendJson(res, 500, { error: 'handoff-failed' });
        return;
      }
      if (!moved) {
        this.sendJson(res, 404, { error: 'handoff-not-possible' });
        return;
      }
      res.writeHead(204).end();
      return;
    }

    // Actions that carry no body: the verb is the whole request.
    const simpleCommands: Record<string, string> = {
      play: 'play',
      pause: 'pause',
      stop: 'off',
      next: 'queueplus',
      previous: 'queueminus',
    };

    if (action in simpleCommands && method === 'POST') {
      // `play` with a body starts something; without one it resumes whatever is
      // already queued. Everything else takes no body at all.
      if (action === 'play') {
        let body: Record<string, unknown>;
        try {
          body = await this.readJsonBody(req);
        } catch {
          this.sendJson(res, 400, { error: 'invalid-json' });
          return;
        }
        const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
        if (uri) {
          await this.deps.playContent(zoneId, uri);
          res.writeHead(204).end();
          return;
        }
        if (body.uri !== undefined) {
          this.sendJson(res, 400, { error: 'invalid-uri' });
          return;
        }
      }
      this.deps.handleCommand(zoneId, simpleCommands[action]!);
      res.writeHead(204).end();
      return;
    }

    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    switch (action) {
      case 'volume': {
        // Absolute `{volume}` or relative `{delta}` — every physical remote steps
        // relatively, and making the client read-then-write would race with itself.
        if (typeof body.delta === 'number' && Number.isFinite(body.delta)) {
          const delta = Math.round(body.delta);
          this.deps.handleCommand(zoneId, 'volume', delta >= 0 ? `+${delta}` : `${delta}`);
          res.writeHead(204).end();
          return;
        }
        // Clamped to the full range here; the zone's own cap (volumeLimits.max) is
        // applied by the command engine, so a write above it lands on the cap.
        const volume = this.clampInt(body.volume, 0, 100);
        if (volume === null) {
          this.sendJson(res, 400, { error: 'invalid-volume' });
          return;
        }
        this.deps.handleCommand(zoneId, 'volume', String(volume));
        res.writeHead(204).end();
        return;
      }
      case 'mute': {
        // A boolean rather than a toggle, so a client that retries a failed request does
        // not end up flipping it twice. Omit the field to toggle deliberately, which is
        // what a remote's mute key does.
        if (body.muted !== undefined && typeof body.muted !== 'boolean') {
          this.sendJson(res, 400, { error: 'invalid-muted' });
          return;
        }
        this.deps.handleCommand(
          zoneId,
          'mute',
          body.muted === undefined ? 'toggle' : body.muted ? '1' : '0',
        );
        res.writeHead(204).end();
        return;
      }
      case 'position': {
        const position = this.clampInt(body.position, 0, Number.MAX_SAFE_INTEGER);
        if (position === null) {
          this.sendJson(res, 400, { error: 'invalid-position' });
          return;
        }
        this.deps.handleCommand(zoneId, 'position', String(position));
        res.writeHead(204).end();
        return;
      }
      case 'repeat': {
        // The engine's own vocabulary for this is 'off' | 'all' | 'one', so the value
        // passes straight through rather than being translated to a number here.
        if (body.repeat !== 'off' && body.repeat !== 'all' && body.repeat !== 'one') {
          this.sendJson(res, 400, { error: 'invalid-repeat' });
          return;
        }
        this.deps.handleCommand(zoneId, 'repeat', body.repeat);
        res.writeHead(204).end();
        return;
      }
      case 'shuffle': {
        if (typeof body.shuffle !== 'boolean') {
          this.sendJson(res, 400, { error: 'invalid-shuffle' });
          return;
        }
        this.deps.handleCommand(zoneId, 'shuffle', body.shuffle ? 'on' : 'off');
        res.writeHead(204).end();
        return;
      }
      case 'power': {
        if (body.power !== 'on' && body.power !== 'off') {
          this.sendJson(res, 400, { error: 'invalid-power' });
          return;
        }
        const applied = body.power === 'off' && this.deps.powerOffImmediately
          ? this.deps.powerOffImmediately(zoneId)
          : this.deps.setPower(zoneId, body.power === 'on' ? 1 : 0);
        if (!applied) {
          this.sendJson(res, 404, { error: 'zone-not-found' });
          return;
        }
        if (body.power === 'off' && !this.deps.powerOffImmediately) {
          this.deps.handleCommand(zoneId, 'off');
        }
        res.writeHead(204).end();
        return;
      }
      default:
        this.sendJson(res, 404, { error: 'not-found' });
        return;
    }
  }

  /**
   * A zone's queue as one resource with four verbs, where the Loxone dialect has eight
   * commands (queueadd, queueinsert, queueandplay, queue/play, queue/move/…/before/…,
   * queue/remove, queue/clear, queueundo). Same capabilities, addressed by what they do
   * to the collection rather than by their own names.
   *
   *   GET    ?start=&limit=   read a page
   *   POST   {uri, next?}     add — at the end, or right after what is playing
   *   PATCH  {play|move}      jump to an entry, or reorder one
   *   DELETE {id?} | {undo}   remove one entry, clear the lot, or undo the last edit
   */
  private async handleQueue(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = pagingLimit(url.searchParams, 100, 500);
      const queue = this.deps.getQueue(zoneId, start, limit);
      if (!queue) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, queue);
      return;
    }

    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    if (method === 'POST') {
      const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
      if (!uri) {
        this.sendJson(res, 400, { error: 'invalid-uri' });
        return;
      }
      // `next: true` is "play this after the current track" — the one placement worth
      // naming, since anything else is just an append followed by a move.
      if (body.next === true) {
        await this.deps.queueInsertNext(zoneId, uri);
      } else {
        await this.deps.queueAppend(zoneId, uri);
      }
      res.writeHead(204).end();
      return;
    }

    if (method === 'PATCH') {
      const play = typeof body.play === 'string' ? body.play.trim() : '';
      if (play) {
        if (!this.deps.queuePlay(zoneId, play)) {
          this.sendJson(res, 404, { error: 'queue-item-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      const move = typeof body.move === 'string' ? body.move.trim() : '';
      if (move) {
        // `before: null` (or absent) moves it to the end.
        const before = typeof body.before === 'string' ? body.before.trim() || null : null;
        if (!this.deps.queueMove(zoneId, move, before)) {
          this.sendJson(res, 404, { error: 'queue-item-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      this.sendJson(res, 400, { error: 'invalid-queue-patch' });
      return;
    }

    // DELETE
    if (body.undo === true) {
      this.deps.queueUndo(zoneId);
      res.writeHead(204).end();
      return;
    }
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id) {
      this.deps.queueRemove(zoneId, id);
      res.writeHead(204).end();
      return;
    }
    // No id and no undo: clear the whole queue. Explicit, since an empty DELETE body
    // meaning "everything" should be a decision rather than an accident.
    if (body.all === true) {
      this.deps.queueClear(zoneId);
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 400, { error: 'invalid-queue-delete' });
  }

  /**
   * The cover art for whatever a zone is playing, at a stable url.
   *
   * `track.coverUrl` already points at the artwork, but it changes per track and can be
   * a remote host or a data uri — neither of which you can put in an `<img src>` on a
   * wall panel and leave there. This url only names the zone, so it keeps working as the
   * music changes. (The `/streams/{zone}/{session}/cover` route is a different thing: it
   * exists so a Cast or DLNA device can fetch artwork itself, and carries a session id
   * precisely so those devices stop caching the previous track's image.)
   *
   * `size` is a hint, not a promise: it is passed upstream where the provider supports
   * variants (Apple Music, TuneIn, imageproxy) rather than being resized here. Asking a
   * CDN for a smaller image beats scaling a bigger one.
   *
   * Because the url deliberately does not change per track, cache-busting is handled two
   * ways: an `ETag` derived from the resolved artwork, so a polling client revalidates for
   * a bodyless `304` and still sees a new cover immediately; and any unrecognised query
   * parameter, which a client can vary (`?v=<track id>`) to defeat a cache it does not
   * control — a Loxone visualisation will happily hold an `<img src>` far longer than
   * `max-age` suggests.
   */
  private async handleCover(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method !== 'GET') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    const size = coverSize(url.searchParams.get('size'));
    const cover = this.deps.getZoneCover(zoneId, size);
    await serveCover(res, cover, this.log, {
      // Held briefly: a panel polling this should not re-fetch the same artwork every
      // second, but must still notice the next track without changing the url.
      cacheControl: 'public, max-age=10',
      etag: coverEtag(cover, size),
      ifNoneMatch: req.headers['if-none-match'],
    });
  }

  /**
   * A zone's sync group, as the membership it has rather than the Loxone dialect's
   * `dgroup/update/<id>/<csv>` plus a separate `dgroup/update/new/...` for creating one.
   * Putting a zone at the head of a list is the same operation either way.
   *
   *   PUT {members: [ids…]}   group these zones behind this one
   *   PUT {members: []}       ungroup
   *
   * Answers 200 rather than 204, because the result is worth reading: a member on a
   * different output protocol cannot join unless mixed groups are enabled, and saying so
   * beats leaving the caller to diff what it asked for against the next zone event.
   */
  /**
   * Sets the delay a zone's speaker chain adds after its audio output.
   *
   * The one control an installer needs that is not a playback verb, and it points the opposite way
   * from what its name suggests: the client *subtracts* it from every timestamp, so raising it makes
   * that room play **earlier** — which is how a room that arrives late is brought into line. It
   * describes hardware downstream of the device (an amplifier, an active speaker), so a room that
   * arrives early has nothing to declare and the protocol has no negative form. It is persisted
   * *and* applied live — Sendspin pushes it without restarting the stream.
   *
   * `clientId` targets one satellite (a subwoofer under a pair of speakers needs its own offset)
   * rather than the zone's output. `applied: false` means the value was stored but no live output
   * took it: the zone's protocol has no delay, or the named satellite is not configured. That is a
   * 200, not an error — the config is the durable part, and a device that connects later gets it.
   */
  private async handleOutputDelay(
    req: IncomingMessage,
    res: ServerResponse,
    zoneId: number,
  ): Promise<void> {
    if (!this.deps.getZoneState(zoneId)) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
    const delayMs = parseOutputDelayMs(body.delayMs);
    if (delayMs === null) {
      this.sendJson(res, 400, {
        error: 'invalid-delay',
        detail: `delayMs must be a number between ${OUTPUT_DELAY_MIN_MS} and ${OUTPUT_DELAY_MAX_MS}`,
      });
      return;
    }
    const clientId =
      typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;
    const result = await this.deps.setOutputDelay(zoneId, delayMs, clientId);
    /*
     * Announce it, because nothing else will.
     *
     * The delay lives in config, not in `ZoneState`, so writing it fires no state change and no
     * event — while `output.sync.delayMs` says it did change. Every client that had the zone in
     * hand would keep showing the old number until something unrelated happened, which is what the
     * player did: the slider snapped back to where it was and only a reload told the truth.
     */
    const state = this.deps.getZoneState(zoneId);
    if (state) {
      this.deps.eventHub.publishZoneChanged(this.project(state));
    }
    this.sendJson(res, 200, { ...result, clientId });
  }

  private async handleGroup(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
    if (!Array.isArray(body.members)) {
      this.sendJson(res, 400, { error: 'invalid-members' });
      return;
    }
    const members = body.members.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (members.length !== body.members.length) {
      this.sendJson(res, 400, { error: 'invalid-members' });
      return;
    }
    const result = this.deps.setGroup(zoneId, members);
    if (!result) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    this.sendJson(res, 200, result);
  }

  /**
   * Registers the caller as a destination that plays audio itself.
   *
   * This is what makes zones optional: a client can be somewhere audio goes without a zone
   * existing anywhere. It hands back a client id and a socket; nothing plays until the caller
   * connects, so this only reserves the identity.
   *
   * Passing back a `clientId` reclaims an existing registration, which a page reload needs —
   * without it every refresh would leave an orphan behind until it timed out.
   */
  private async handleRegisterLocal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : undefined;
    const destination = await this.deps.registerLocalDestination({
      ...(name ? { name } : {}),
      ...(clientId ? { clientId } : {}),
      // The address that reached us is the one address this caller is known to be able to
      // use — a configured bind address may be 0.0.0.0, or an interface it cannot route to.
      ...(req.headers.host ? { host: req.headers.host } : {}),
    });
    if (!destination) {
      this.sendJson(res, 501, {
        error: 'local-playback-unavailable',
        message: 'This server was built without local playback.',
      });
      return;
    }
    this.sendJson(res, 201, destination);
  }

  /**
   * Lists a container's children, or the services at the root.
   *
   * The root is every configured service — the library, radio, and each streaming account
   * under its own name. There is no `spotify@bridge-…` disguise here: that translation
   * exists for the Loxone clients, which know exactly one streaming service, and it stops
   * at that adapter.
   */
  private async handleBrowse(
    res: ServerResponse,
    rawId: string | undefined,
    url: URL,
  ): Promise<void> {
    const start = pagingStart(url.searchParams);
    const limit = pagingLimit(url.searchParams, BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT);

    if (!rawId) {
      const services = await this.deps.listServices();
      // The root is synthesised, not fetched: it has no container of its own and its total
      // is exactly the number of services, so it is the one listing that is always honest.
      this.sendJson(res, 200, {
        container: null,
        items: services.map((service) => ({
          id: service.rootId,
          name: service.name,
          kind: 'category' as const,
          browsable: true,
          playable: false,
          service: service.id,
        })),
        start: 0,
        total: services.length,
      });
      return;
    }

    let result: ApiBrowseResult | null;
    try {
      result = await this.deps.browse(rawId, start, limit);
    } catch (error) {
      // Refused is not empty. A service that would not answer — a dead token, a rate limit — is
      // a 502 with the reason, so a client can say what is wrong rather than draw an empty shelf.
      if (error instanceof ProviderUnavailableError) {
        this.sendJson(res, 502, {
          error: 'service-unavailable',
          service: error.service,
          reason: error.reason,
          message: error.message,
        });
        return;
      }
      throw error;
    }
    if (!result) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    this.sendJson(res, 200, result);
  }

  /** Local playlist catalogue and editing surface. Playlist ids remain opaque browse ids. */
  private async handlePlaylists(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rawId: string | undefined,
    url: URL,
  ): Promise<void> {
    if (!rawId) {
      if (method === 'GET') {
        const start = pagingStart(url.searchParams);
        const limit = pagingLimit(url.searchParams, BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT);
        this.sendJson(res, 200, await this.deps.listPlaylists(start, limit));
        return;
      }
      if (method === 'POST') {
        const body = await this.readJsonOrBadRequest(req, res);
        if (!body) return;
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) {
          this.sendJson(res, 400, { error: 'invalid-name' });
          return;
        }
        this.sendJson(res, 201, await this.deps.createPlaylist(name));
        return;
      }
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    const playlistId = this.localPlaylistId(rawId);
    if (!playlistId) {
      this.sendJson(res, 404, { error: 'playlist-not-found' });
      return;
    }
    const body = method === 'GET' ? null : await this.readJsonOrBadRequest(req, res);
    if (method !== 'GET' && !body) return;

    if (method === 'PATCH') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name) {
        this.sendJson(res, 400, { error: 'invalid-name' });
        return;
      }
      const playlist = await this.deps.renamePlaylist(playlistId, name);
      if (!playlist) {
        this.sendJson(res, 404, { error: 'playlist-not-found' });
        return;
      }
      this.sendJson(res, 200, playlist);
      return;
    }
    if (method === 'DELETE') {
      if (!(await this.deps.deletePlaylist(playlistId))) {
        this.sendJson(res, 404, { error: 'playlist-not-found' });
        return;
      }
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 405, { error: 'method-not-allowed' });
  }

  private async handlePlaylistItems(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    rawId: string,
  ): Promise<void> {
    const playlistId = this.localPlaylistId(rawId);
    if (!playlistId) {
      this.sendJson(res, 404, { error: 'playlist-not-found' });
      return;
    }
    const body = await this.readJsonOrBadRequest(req, res);
    if (!body) return;
    if (method === 'POST') {
      const itemId = typeof body.id === 'string' ? body.id.trim() : '';
      if (!itemId || !(await this.deps.addPlaylistItem(playlistId, itemId))) {
        this.sendJson(res, 400, { error: 'invalid-playlist-item' });
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (method === 'DELETE') {
      const position = this.clampInt(body.position, 0, Number.MAX_SAFE_INTEGER);
      if (position === null || !(await this.deps.removePlaylistItem(playlistId, position))) {
        this.sendJson(res, 404, { error: 'playlist-item-not-found' });
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (method === 'PATCH') {
      const from = this.clampInt(body.from, 0, Number.MAX_SAFE_INTEGER);
      const to = this.clampInt(body.to, 0, Number.MAX_SAFE_INTEGER);
      if (from === null || to === null || !(await this.deps.movePlaylistItem(playlistId, from, to))) {
        this.sendJson(res, 404, { error: 'playlist-item-not-found' });
        return;
      }
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 405, { error: 'method-not-allowed' });
  }

  private localPlaylistId(rawId: string): string | null {
    const ref = decodeBrowseRef(rawId);
    if (!ref || ref.target !== 'container' || ref.service !== 'library' || ref.kind !== 'playlist') {
      return null;
    }
    const match = /^library:playlist:(\d+)$/.exec(ref.folderId);
    return match?.[1] ?? null;
  }

  private async readJsonOrBadRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return null;
    }
  }

  /**
   * Describes one item by its id — the capability neither Loxone nor Music Assistant has.
   *
   * Worth having because a client that deep-links, restores a session or receives an id from
   * elsewhere has no parent listing to take the name from. Where the content layer genuinely
   * cannot answer, `name` comes back empty rather than filled with the raw id: Music
   * Assistant returns the id as the name in this case, which looks like data and is not.
   */
  /**
   * The story around an item — a biography, the acts beside it, and who wrote the prose.
   *
   * 404 is the *ordinary* answer here, not an error: most items have no article, some kinds have
   * none by nature, and a story that is still being assembled has nothing to show yet. Clients
   * are documented to render nothing on 404, so this route never manufactures a placeholder.
   */
  private async handleItemAbout(res: ServerResponse, rawId: string): Promise<void> {
    const about = await this.deps.describeAbout?.(rawId);
    if (!about) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    this.sendJson(res, 200, about);
  }

  private async handleItem(res: ServerResponse, rawId: string): Promise<void> {
    const item = await this.deps.describeItem(rawId);
    if (!item) {
      this.sendJson(res, 404, { error: 'not-found' });
      return;
    }
    this.sendJson(res, 200, item);
  }

  /**
   * Searches across services, grouped by kind.
   *
   * `kind` narrows what is asked for, which is not just a filter: a provider that cannot
   * search a kind is skipped for it entirely rather than asked and ignored. `service`
   * narrows which providers are asked.
   */
  private async handleSearch(res: ServerResponse, url: URL): Promise<void> {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) {
      this.sendJson(res, 400, { error: 'invalid-query', message: 'q is required.' });
      return;
    }
    const kinds = (url.searchParams.get('kind') ?? '')
      .split(',')
      .map((kind) => kind.trim().toLowerCase())
      .filter(Boolean);
    const services = (url.searchParams.get('service') ?? '')
      .split(',')
      .map((service) => service.trim().toLowerCase())
      .filter(Boolean);
    const limit = pagingLimit(url.searchParams, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);

    this.sendJson(res, 200, await this.deps.search({ query, kinds, services, limit }));
  }

  /**
   * Switches a zone to one of the configured inputs.
   *
   * `input` is the id from `GET /api/v1/inputs` — the same string `source.id` reports back
   * once the zone is on it, which is what closes the loop: until now you could see a zone
   * was on a line-in but not put it there.
   *
   * There is no counterpart for leaving one. Selecting something else is how you leave —
   * a `play`, a favourite, another input — and the server tears the old source down as
   * part of that. A `DELETE` would be a third way to express it with "and what plays now?"
   * left unanswered.
   */
  private async handleInput(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }
    const inputId = typeof body.input === 'string' ? body.input.trim() : '';
    if (!inputId) {
      this.sendJson(res, 400, { error: 'invalid-input' });
      return;
    }
    if (!this.deps.getZoneState(zoneId)) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    // Distinguished from an unknown zone on purpose: "you named an input that is not
    // configured" is a different mistake from "that zone does not exist", and a caller
    // reading ids out of GET /inputs deserves to be told which.
    if (!this.deps.selectInput(zoneId, inputId)) {
      this.sendJson(res, 404, { error: 'input-not-found' });
      return;
    }
    res.writeHead(204).end();
  }

  /**
   * Plays a sound or a spoken message over whatever a zone was doing.
   *
   * A resource rather than a `play` with a special uri, because an alert is an interruption
   * and not a queue entry: the zone's own playback is ducked and resumed around it, the
   * volume comes from that zone's configured alert level rather than its current one, and
   * one call can interrupt several zones as a single announcement.
   *
   * This is the thing an integrator actually asks a music server for — "say in the kitchen
   * that dinner is ready" — and until now only the Loxone clients could do it, spread over
   * `audio/<id>/tts`, `/alert`, `playeventfile` and `groupalert`.
   *
   * `DELETE` stops one, which matters for the looping kinds (`alarm`, `fire`): they play
   * until told otherwise.
   */
  private async handleAlert(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method !== 'POST' && method !== 'DELETE') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    if (!ALERT_KINDS.includes(kind as ApiAlertKind)) {
      this.sendJson(res, 400, {
        error: 'invalid-alert-kind',
        message: `kind must be one of: ${ALERT_KINDS.join(', ')}.`,
      });
      return;
    }

    // Extra zones join the announcement; the zone in the path always leads it.
    const extra = body.zones === undefined ? [] : body.zones;
    if (!Array.isArray(extra)) {
      this.sendJson(res, 400, { error: 'invalid-zones' });
      return;
    }
    const valid = extra.filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
    );
    if (valid.length !== extra.length) {
      this.sendJson(res, 400, { error: 'invalid-zones' });
      return;
    }
    const zones = [zoneId, ...valid.filter((id) => id !== zoneId)];

    const volume = body.volume === undefined ? undefined : this.clampInt(body.volume, 0, 100);
    if (body.volume !== undefined && volume === null) {
      this.sendJson(res, 400, { error: 'invalid-volume' });
      return;
    }

    let text: string | undefined;
    let language: string | undefined;
    let target = kind;
    if (kind === 'tts') {
      text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        this.sendJson(res, 400, { error: 'invalid-text', message: 'tts needs text to speak.' });
        return;
      }
      language = typeof body.language === 'string' ? body.language.trim().toLowerCase() : undefined;
    } else if (kind === 'url') {
      const raw = typeof body.url === 'string' ? body.url.trim() : '';
      if (!isHttpUrl(raw)) {
        this.sendJson(res, 400, {
          error: 'invalid-url',
          message: 'url must be an http(s) address the server can reach.',
        });
        return;
      }
      // The alerts layer takes an arbitrary sound as a `custom_url/` type rather than as a
      // separate argument, so the url travels in place of the kind.
      target = `${ALERT_CUSTOM_URL_PREFIX}${raw}`;
    }

    const result = await this.deps.playAlert({
      zoneId,
      type: target,
      action: method === 'DELETE' ? 'off' : 'on',
      zones,
      text,
      language,
      volume: volume ?? undefined,
    });
    if (!result) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    if (!result.success) {
      // The alerts layer refused it — a missing sound file, no TTS provider configured.
      this.sendJson(res, 422, { error: result.reason ?? 'alert-failed', kind });
      return;
    }
    this.sendJson(res, 200, {
      zoneId,
      kind,
      action: result.action,
      zones,
    });
  }

  /**
   * A zone's favourites, as a collection rather than the Loxone dialect's separate
   * roomfavs/add, /setname, /setid, /delete and roomfav/play commands.
   *
   *   GET    ?start=&limit=        read a page
   *   POST   {uri, name?}          add one
   *   PATCH  {id, name}            rename it
   *   PATCH  {order: [ids…]}       reorder the list
   *   PATCH  {play: id}            start it
   *   DELETE {id}                  remove it
   */
  private async handleFavorites(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = pagingLimit(url.searchParams, 50, 500);
      const favorites = await this.deps.getFavorites(zoneId, start, limit);
      if (!favorites) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, favorites);
      return;
    }

    if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    if (method === 'POST') {
      const uri = typeof body.uri === 'string' ? body.uri.trim() : '';
      if (!uri) {
        this.sendJson(res, 400, { error: 'invalid-uri' });
        return;
      }
      // The name is optional: without one the server fills in what it knows about the
      // source, which is usually better than what a caller would invent.
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const created = await this.deps.addFavorite(zoneId, name, uri);
      this.sendJson(res, 201, created);
      return;
    }

    if (method === 'PATCH') {
      if (Array.isArray(body.order)) {
        const ids = body.order.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (ids.length !== body.order.length) {
          this.sendJson(res, 400, { error: 'invalid-favorite-order' });
          return;
        }
        await this.deps.reorderFavorites(zoneId, ids);
        res.writeHead(204).end();
        return;
      }
      if (typeof body.play === 'number' && Number.isFinite(body.play)) {
        if (!(await this.deps.playFavorite(zoneId, body.play))) {
          this.sendJson(res, 404, { error: 'favorite-not-found' });
          return;
        }
        res.writeHead(204).end();
        return;
      }
      const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (id === null || !name) {
        this.sendJson(res, 400, { error: 'invalid-favorite-patch' });
        return;
      }
      await this.deps.renameFavorite(zoneId, id, name);
      res.writeHead(204).end();
      return;
    }

    const id = typeof body.id === 'number' && Number.isFinite(body.id) ? body.id : null;
    if (id === null) {
      this.sendJson(res, 400, { error: 'invalid-favorite-delete' });
      return;
    }
    await this.deps.removeFavorite(zoneId, id);
    res.writeHead(204).end();
  }

  /**
   * What a zone played before. Read-only apart from clearing: a recent entry has no
   * handle to rename or reorder — it is history, and `source` is what you replay.
   */
  private async handleRecents(
    res: ServerResponse,
    method: string,
    zoneId: number,
    url: URL,
  ): Promise<void> {
    if (method === 'GET') {
      const start = pagingStart(url.searchParams);
      const limit = pagingLimit(url.searchParams, 50, 500);
      const recents = await this.deps.getRecents(zoneId, start, limit);
      if (!recents) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, recents);
      return;
    }
    if (method === 'DELETE') {
      await this.deps.clearRecents(zoneId);
      res.writeHead(204).end();
      return;
    }
    this.sendJson(res, 405, { error: 'method-not-allowed' });
  }

  /**
   * Read and write a zone's 10-band equalizer.
   *
   * A GET/PUT pair rather than a command, because this is state a caller owns rather
   * than an action it triggers — an external provider reads what is set, and writes
   * back when its own UI changes. Bands are validated as ten values; anything else is
   * rejected rather than partially applied.
   */
  private async handleEqualizer(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    zoneId: number,
  ): Promise<void> {
    if (method === 'GET') {
      const bands = this.deps.getEqualizerBands(zoneId);
      if (!bands) {
        this.sendJson(res, 404, { error: 'zone-not-found' });
        return;
      }
      this.sendJson(res, 200, { zoneId, bands });
      return;
    }

    if (method !== 'PUT') {
      this.sendJson(res, 405, { error: 'method-not-allowed' });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await this.readJsonBody(req);
    } catch {
      this.sendJson(res, 400, { error: 'invalid-json' });
      return;
    }

    const applied = await this.deps.setEqualizerBands(zoneId, body.bands);
    if (!applied) {
      // Either the zone is gone or the bands were not ten usable numbers; the caller
      // can tell which from the zone read, and conflating them keeps this simple.
      this.sendJson(res, 400, { error: 'invalid-equalizer-bands' });
      return;
    }
    this.sendJson(res, 200, { zoneId, bands: applied });
  }

  /**
   * SSE rather than a WebSocket: state is one-directional, so the socket buys
   * nothing, and `EventSource`/curl/Perl can all read this without a handshake
   * library. Each stream opens with a `server.snapshot` so a client can render
   * before the first state change arrives.
   */
  private streamAnalysis(
    req: IncomingMessage,
    res: ServerResponse,
    zoneId: number,
    url: URL,
  ): void {
    if (!this.deps.getZoneState(zoneId)) {
      this.sendJson(res, 404, { error: 'zone-not-found' });
      return;
    }
    const requestedTypes = new Set(
      (url.searchParams.get('types') ?? 'loudness,spectrum,f_peak,peak,pitch,stereo')
        .split(',')
        .map((value) => value.trim())
        .filter((value) =>
          [
            'loudness',
            'spectrum',
            'f_peak',
            'peak',
            'pitch',
            'stereo',
            /*
             * The measured readings, which cost more than the drawn ones.
             *
             * Each is opt-in by name for a reason: `ebu` runs two biquads over every sample of every
             * channel, `truepeak` reconstructs the loudest neighbourhoods at 4×, and `gonio` and
             * `scope` put bytes on the wire every frame. A client that only wants a spectrum should
             * not pay for a loudness meter it never draws.
             */
            'correlation',
            'truepeak',
            'ebu',
            'scope',
            'gonio',
          ].includes(value),
        ),
    );
    const rateMax = Math.max(1, Math.min(60, Number(url.searchParams.get('rate') ?? 20) || 20));
    const bins = Math.max(4, Math.min(256, Number(url.searchParams.get('bins') ?? 32) || 32));
    const spectrum = requestedTypes.has('spectrum')
      ? ({ n_disp_bins: bins, scale: 'log', f_min: 40, f_max: 16000 } as const)
      : undefined;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (payload: unknown): void => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    /*
     * The analyzer is built for one PCM format and cannot be retuned, because the format
     * decides how the bytes are read and where the FFT bins land. Sonn follows the source,
     * so that format changes *per track*: a 44.1/16 analyzer handed a 192/24 stream reads
     * every third byte as a sample and reports noise. The sendspin output re-arms its own
     * analyzer on each stream start; this stream lives across tracks, so it has to notice
     * the change itself and rebuild — announcing the new geometry as it does.
     */
    let unsubscribeAnalysis: (() => void) | null = null;
    let armedFor = '';
    const arm = (): void => {
      const format = this.deps.getAudioAnalysisFormat(zoneId) ?? {
        sampleRate: 44100,
        channels: 2,
        bitDepth: 16,
      };
      const signature = `${format.sampleRate}/${format.channels}/${format.bitDepth}`;
      if (signature === armedFor) {
        return;
      }
      armedFor = signature;
      unsubscribeAnalysis?.();
      const options: AudioAnalysisSubscription = {
        ...format,
        rateMax,
        // Drive Sendspin from the PCM timeline that is actually sent to the output. The
        // engine feed can be ahead by the output buffer, which makes a browser visualizer
        // visibly lead the music. Other outputs currently expose the engine timeline.
        feed: this.deps.getOutputProtocol(zoneId) === 'sendspin' ? 'scheduled-output' : 'engine',
        loudness: requestedTypes.has('loudness'),
        fPeak: requestedTypes.has('f_peak'),
        peak: requestedTypes.has('peak'),
        pitch: requestedTypes.has('pitch'),
        stereo: requestedTypes.has('stereo'),
        correlation: requestedTypes.has('correlation'),
        truePeak: requestedTypes.has('truepeak'),
        ebu: requestedTypes.has('ebu'),
        scope: requestedTypes.has('scope'),
        gonio: requestedTypes.has('gonio'),
        spectrum,
      };
      // Everything a consumer needs to turn these numbers back into dB and Hz. Without it a
      // client has to hardcode the same constants and drift when this end changes them.
      //
      // `timeline` and `serverNowUs` are what make `timestampUs` usable at all. The clock is
      // monotonic with a process-relative origin (see serverClockUs), so a reference reading has to
      // travel with it — and *what* the stamp means differs per output, which is the part a client
      // cannot guess: on the scheduled-output timeline it is when the audio will be heard, ~250 ms
      // in the future, so a display that renders on arrival leads the music by that much. On the
      // engine timeline it is when the audio was captured, which for a buffering renderer is
      // earlier than playback by an amount we do not measure yet.
      write({
        type: 'analysis.ready',
        zoneId,
        rateMax,
        types: [...requestedTypes],
        format,
        floorDb: ANALYSIS_DB_FLOOR,
        fullScale: ANALYSIS_FULL_SCALE,
        spectrum: spectrum ?? null,
        timeline: options.feed === 'scheduled-output' ? 'presentation' : 'capture',
        serverNowUs: serverClockUs(),
      });
      unsubscribeAnalysis = this.deps.subscribeAudioAnalysis(zoneId, options, (event) => {
        write(serializeAnalysisEvent(event));
      });
    };
    arm();

    /*
     * A track boundary resets what is *running*, without re-arming the analyzer.
     *
     * The integrated loudness and the clip count describe a programme; carried across a track change
     * they would describe the album, then the evening. Rebuilding the analyzer would achieve the same
     * thing and cost more: the filters and the FFT plan are tuned to the format, which has not
     * changed, and it would blank the spectrum for a window. So the format decides re-arming and the
     * track decides resetting — two boundaries, two answers.
     */
    let programme = '';
    const unsubscribeZone = this.deps.eventHub.subscribe((event) => {
      if (event.type !== 'zone.changed' || event.zone.id !== zoneId) {
        return;
      }
      arm();
      /*
       * The provider's own id when there is one, and only then the title.
       *
       * Both together looked safer and was wrong: a title that arrives a moment after the track does
       * — which is normal, metadata fills in — changed the key mid-track and reset a loudness
       * integrator that was two minutes into a record. The id is stable from the first event. A
       * source with no id is a live stream, where the title changing genuinely *is* the next song.
       */
      const next = event.zone.source?.id ?? event.zone.track?.title ?? '';
      if (next !== programme) {
        programme = next;
        this.deps.resetAudioAnalysis?.(zoneId);
      }
    });
    /*
     * The keep-alive carries a clock reading instead of being a bare comment.
     *
     * One reference at `analysis.ready` is enough to *start* mapping the audio timeline onto the
     * client's own, but not to stay mapped: the two clocks tick at slightly different rates, and a
     * display left on a single sample slowly slides off the music. Repeating the reading costs a
     * few bytes on a message that had to be sent anyway, and it doubles as the recovery path — a
     * client that reconnects or wakes from sleep re-syncs on the next tick rather than on the next
     * track.
     */
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        write({ type: 'analysis.clock', serverNowUs: serverClockUs() });
      }
    }, SSE_KEEPALIVE_MS);
    const close = (): void => {
      clearInterval(keepAlive);
      unsubscribeZone();
      unsubscribeAnalysis?.();
    };
    req.on('close', close);
    req.on('error', close);
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const write = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    write({ type: 'server.snapshot', zones: this.snapshot() });

    // Local destinations are absent from this stream entirely, matching the snapshot. A tab
    // gets its own state over the Sendspin socket it already holds, so repeating it here would
    // give every listener churn about somebody else's browser.
    const visible = (zoneId: number): boolean => !this.deps.getLocalDestinationOwner(zoneId);
    const unsubscribe = this.deps.eventHub.subscribe((event) => {
      const zoneId =
        event.type === 'zone.changed' ? event.zone.id : 'id' in event ? event.id : null;
      if (zoneId !== null && !visible(zoneId)) {
        return;
      }
      if (event.type === 'server.snapshot') {
        write({ ...event, zones: event.zones.filter((zone) => visible(zone.id)) });
        return;
      }
      write(event);
    });
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), SSE_KEEPALIVE_MS);

    const close = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.on('close', close);
    req.on('error', close);
    this.log.debug('events stream opened');
  }

  private project(state: ZoneState): ApiZoneState {
    return toApiZoneState(state, {
      device: (zoneId) => this.deps.getOutputDevice(zoneId),
      outputProtocol: (zoneId) => this.deps.getOutputProtocol(zoneId),
      outputCapabilities: (zoneId) => this.deps.getOutputCapabilities(zoneId),
      outputSync: (zoneId) => this.deps.getOutputSync(zoneId),
      group: (zoneId) => this.deps.getGroup(zoneId),
      serviceLabel: (audiopath) => this.deps.getServiceLabel(audiopath),
      inputLabel: (inputId) => this.deps.getInputLabel(inputId),
      streamFormat: (zoneId) => this.deps.getStreamFormat(zoneId),
      session: (zoneId) => this.deps.getZoneSession?.(zoneId) ?? null,
      volumeLimits: this.deps.getVolumeLimits(state.id),
      powerState: (zoneId) => this.deps.getPowerState?.(zoneId) ?? null,
    });
  }

  /**
   * The zones a caller should see: the configured ones.
   *
   * A configured zone is a room in a house — everyone may know the kitchen is playing. A local
   * destination is not a room, it is a browser tab, and it belongs in nobody's zone list. It
   * used to appear in everyone's, so a phone showed up beside the speakers on a laptop and
   * could be played to by mistake.
   *
   * Nor does a client need it here: everything it would read from a zone — title, artist,
   * album, artwork, playback state and progress — the Sendspin socket already pushes to it as
   * `server/state`, which is the connection it must hold anyway to receive the audio. Two
   * sources for one thing is one too many, and the socket is the one that cannot be out of
   * step with the sound.
   *
   * `GET /destinations` is where a tab finds itself, and `/destinations/{id}/…` is how it is
   * driven.
   */
  private snapshot(): ApiZoneState[] {
    return this.deps
      .getAllZoneStates()
      .filter((state) => !this.deps.getLocalDestinationOwner(state.id))
      .map((state) => this.project(state));
  }

  private clampInt(value: unknown, min: number, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      // Command bodies are a handful of fields; refuse anything that looks like
      // a stream so a bad client cannot grow the heap.
      if (size > 64 * 1024) {
        throw new Error('body-too-large');
      }
      chunks.push(buf);
    }
    if (size === 0) {
      return {};
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not-an-object');
    }
    return parsed as Record<string, unknown>;
  }

  /** `headers` is for the few responses that are cacheable; everything else is state and is not. */
  private sendJson(
    res: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {},
  ): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...headers,
    });
    res.end(body);
  }
}
