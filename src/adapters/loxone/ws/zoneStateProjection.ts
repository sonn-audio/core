/**
 * Projects the server's `ZoneState` onto the payload Loxone clients expect.
 *
 * This is the counterpart of `src/adapters/http/api/zoneProjection.ts`: both take
 * the same internal state and shape it for one consumer. Keeping the Loxone wire
 * format in its own type here — rather than letting `ZoneState` be that format —
 * is what makes Loxone a projection instead of the source of truth. Every field
 * below that only the Loxone clients understand should ultimately be *computed*
 * here rather than carried in `ZoneState`; `mastervolume` already is.
 */
import type { AudioEventType, AudioType, FileType, LineInIconType } from '@/domain/zones/enums';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import type { ZoneState } from '@/domain/zones/zoneState';
import { formatEqualizerSettings } from '@/domain/zones/equalizer';

/**
 * The `audio_event` entry as the Loxone Miniserver and native app parse it.
 *
 * Field names and numeric encodings are Loxone's and cannot change: they mirror
 * the official Audio Server UI. Anything here that is *not* in the native
 * protocol is marked as ours.
 */
/**
 * What the zone is playing from — the album, playlist or artist behind the queue.
 *
 * The native client uses it in three places: a row of a browse list is marked as playing when
 * its audiopath equals `id`, the mini player shows `name` in place of the album, and the queue
 * screen is titled with it. Null when there is no such container, or when we cannot name it:
 * the name is shown, so an unnamed context would blank a line that is otherwise filled.
 */
export interface LoxoneParentMeta {
  id: string;
  name: string;
  /** Lets the client open the container from the now-playing screen. */
  audiopath: string;
}

export interface LoxoneZoneState {
  album: string;
  artist: string;
  audiopath: string;
  audiotype: AudioType;
  clientState: 'on' | 'off';
  coverurl: string;
  duration: number;
  /** Comma-separated 10-band EQ values for the Loxone app's AudioZone control. */
  equalizerSettings: string;
  icontype?: LineInIconType;
  mode: 'play' | 'pause' | 'stop';
  name: string;
  parent: LoxoneParentMeta | null;
  /** Which transport controls to offer; absent when all of them work. */
  pbr?: number;
  playerid: number;
  plrepeat: number;
  plshuffle: number;
  power: 'on' | 'off';
  qindex: number;
  queueAuthority?: string;
  sourceName: string;
  station: string;
  time: number;
  title: string;
  qid?: string;
  /**
   * Which alert the zone is playing. Present only while one plays: the app reads the mere
   * presence of the field as "an event is on", and forgets it with the first frame without.
   */
  eventype?: AudioEventType;
  /** A `FileType`, or an `AudioEventType` while an alert plays. */
  type: FileType | AudioEventType;
  volume: number;
  /** Player ids of every member of this zone's sync group, leader first. */
  syncedzones: number[];
  /** The sync group leader's volume; 0 when the zone is not grouped. */
  mastervolume: number;
  /**
   * Ours, not Loxone's: the zone's output protocol. The native client ignores it;
   * our own player uses it as a grouping hint, since grouping requires matching
   * output protocols — a concept the native app has no notion of.
   */
  outputProtocol?: string;
  /** Ours, not Loxone's: whether this server allows mixed-protocol grouping. */
  mixedGroupEnabled?: boolean;
}

export type ZoneStateProjectionContext = {
  /** Sync group this zone belongs to, if any. */
  group: { leader: number; members: number[] } | null;
  /** Volume of the group leader, used for `mastervolume`. */
  leaderVolume: number;
  outputProtocol?: string;
  mixedGroupEnabled?: boolean;
  /**
   * Rewrites a service-native audiopath into the disguise the native client
   * expects (`spotify@bridge-…`). Identity when there is nothing to translate.
   */
  audiopathToLoxone: (audiopath: string) => string;
  /** The container the zone is playing from, when there is one and it has a name. */
  playContext?: { path: string; name: string } | null;
  /**
   * The streaming accounts as the client knows them: the `id` and `user` of each `getservices`
   * entry, in the order they are listed. `fake` marks a bridged service, which is addressed
   * by its id in every audiopath; a real Spotify account is not always.
   */
  serviceAccounts?: () => ReadonlyArray<LoxoneServiceAccount>;
  /** What the zone's transport controls will do right now — see {@link toLoxonePbr}. */
  transport?: LoxoneTransport | null;
  /** The alert the zone is playing right now; null or absent when it plays none. */
  alertEvent?: AudioEventType | null;
  /**
   * Rewrites the zone's artwork url into one the native client may fetch — see
   * {@link buildLoxoneCoverUrl}. Unset leaves the provider's url verbatim.
   */
  coverUrlToLoxone?: (state: ZoneState) => string;
};

function clamp01to100(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** True for a raw source id in any of the forms that can reach these fields. */
function looksLikeAudiopath(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@') ||
    Boolean(parseServiceNativeAudiopath(value))
  );
}

/**
 * Guard the emitted title: an audiopath is never a valid title. A background
 * queue-fill race can momentarily leave a service-native audiopath (or a
 * `spotify:`/`spotify@` id) in state.title; replace it with the zone name so the
 * raw id never reaches the client.
 */
function titleOrFallback(title: string | undefined, zoneName: string): string {
  const raw = (title ?? '').trim();
  if (!raw) {
    return raw;
  }
  return looksLikeAudiopath(raw) ? zoneName : (title ?? '');
}

/**
 * The station line is a human-readable source label (radio name, playlist name).
 * A raw audiopath must never surface there. Pre-service-native this was blanked
 * implicitly — the old `spotify@bridge` form matched the client's own sanitising;
 * the service-native form does not, so blank it here.
 */
function blankAudiopathStation(station: string | undefined): string {
  const raw = (station ?? '').trim();
  if (!raw) {
    return '';
  }
  return looksLikeAudiopath(raw) ? '' : (station ?? '');
}

export type LoxoneTransport = { skip: boolean; seek: boolean; shuffle: boolean; repeat: boolean };

/** `PlaybackControlBit` in the client. Each bit is something the zone *can* do. */
const PlaybackControlBit = {
  TRACKSEEK: 32,
  PREV: 512,
  NEXT: 1024,
  SHUFFLE: 2048,
  REPEAT_ALL: 4096,
  REPEAT_ONE: 8192,
} as const;

/**
 * Set on every mask we send. The client reads a mask of zero as "no mask" for next/previous
 * and for seeking (`!r.pbr`), so a zone that can do none of the four would otherwise get all
 * of its skip and seek controls back. No client code reads this bit.
 */
const PBR_PRESENT = 1;

/**
 * `pbr` — which transport controls the client should offer for this zone.
 *
 * Left out when everything works, which is every zone playing from a queue of its own: no
 * mask is what the client has always had from us, and it then offers everything. A mask goes
 * out only for the zones where a button would be ignored — AirPlay, Bluetooth, a line-in,
 * Spotify Connect — and says what is left.
 */
function toLoxonePbr(transport: LoxoneTransport | null | undefined): number | undefined {
  if (!transport || (transport.skip && transport.seek && transport.shuffle && transport.repeat)) {
    return undefined;
  }
  return (
    PBR_PRESENT |
    (transport.skip ? PlaybackControlBit.NEXT | PlaybackControlBit.PREV : 0) |
    (transport.seek ? PlaybackControlBit.TRACKSEEK : 0) |
    (transport.shuffle ? PlaybackControlBit.SHUFFLE : 0) |
    (transport.repeat ? PlaybackControlBit.REPEAT_ALL | PlaybackControlBit.REPEAT_ONE : 0)
  );
}

export type LoxoneServiceAccount = { id: string; user: string; fake?: boolean };

/**
 * The account behind a zone that plays a streaming service, as the client would name it.
 *
 * The native client takes every `spotify…` audiopath for Spotify — which is how all the
 * services we bridge reach it — and identifies *which account* by name: it reads `sourceName`
 * off the audio_event and looks for the service entry whose `user` equals it
 * (`getServiceForAccountName`, `isItemPlaying`). So the name has to be exactly that `user`.
 *
 * Null when the zone is not streaming, or when the account cannot be told for certain: a path
 * without an account in it, on a server with more than one real Spotify account. Null also
 * when another entry further up the list carries the same name — the client takes the first
 * it finds, so the name would point it at the wrong account.
 */
function streamingAccount(
  playing: string,
  accounts: ReadonlyArray<LoxoneServiceAccount>,
): LoxoneServiceAccount | null {
  if (!playing.toLowerCase().startsWith('spotify')) {
    return null;
  }
  const inPath = /^spotify@([^:]+)/i.exec(playing)?.[1];
  const real = accounts.filter((account) => !account.fake);
  const account = inPath
    ? accounts.find((entry) => entry.id === inPath)
    : real.length === 1
      ? real[0]
      : undefined;
  if (!account?.user) {
    return null;
  }
  return accounts.find((entry) => entry.user === account.user) === account ? account : null;
}

/**
 * The `parent` of a zone's audio_event, or null when sending one would do harm.
 *
 * A parent is not free. Without one the client marks a row as playing when its audiopath is
 * the zone's. With one, for anything it takes to be Spotify, it first looks the playing
 * account up by `sourceName` and marks *nothing* when that finds no account or a different
 * one than the row's (`isItemPlaying`, shared-app.js:20768). So a streaming zone only gets a
 * parent when its account is known — which is also when its `sourceName` is that account's
 * name; otherwise it keeps what it had, the track row marked and the container not.
 */
function toLoxoneParent(
  playing: string,
  account: LoxoneServiceAccount | null,
  ctx: ZoneStateProjectionContext,
): LoxoneParentMeta | null {
  const context = ctx.playContext;
  if (!context?.path || !context.name) {
    return null;
  }
  if (playing.toLowerCase().startsWith('spotify') && !account) {
    return null;
  }
  // The same translation the track's own audiopath gets, so the id is the one the client
  // holds for that row.
  const id = ctx.audiopathToLoxone(context.path);
  return { id, name: context.name, audiopath: id };
}

export function toLoxoneZoneState(
  state: ZoneState,
  ctx: ZoneStateProjectionContext,
): LoxoneZoneState {
  const syncedzones = ctx.group
    ? Array.from(new Set<number>([ctx.group.leader, ...ctx.group.members]))
    : [];

  const audiopath = ctx.audiopathToLoxone(state.audiopath);
  const account = streamingAccount(audiopath, ctx.serviceAccounts?.() ?? []);

  return {
    album: state.album,
    artist: state.artist,
    audiopath,
    audiotype: state.audiotype,
    clientState: state.clientState,
    coverurl: ctx.coverUrlToLoxone?.(state) ?? state.coverurl,
    duration: state.duration,
    equalizerSettings: formatEqualizerSettings(state.eq),
    icontype: state.icontype,
    mode: state.mode,
    name: state.name,
    parent: toLoxoneParent(audiopath, account, ctx),
    pbr: toLoxonePbr(ctx.transport),
    playerid: state.id,
    plrepeat: state.plrepeat,
    plshuffle: state.plshuffle,
    power: state.power,
    qindex: state.qindex,
    queueAuthority: state.queueAuthority,
    // For a streaming zone: the account's name as the client lists it, which is how it tells
    // accounts apart. The zone's own source name ("Spotify") stays for everything else, and
    // for a streaming zone whose account cannot be told.
    sourceName: account?.user ?? state.sourceName,
    station: blankAudiopathStation(state.station),
    time: state.time,
    title: titleOrFallback(state.title, state.name),
    qid: state.qid,
    ...(ctx.alertEvent != null ? { eventype: ctx.alertEvent } : {}),
    type: state.type,
    volume: state.volume,
    syncedzones,
    // Computed here rather than carried in ZoneState: it is a view of the group's
    // leader, which only this payload needs.
    mastervolume: ctx.group ? clamp01to100(ctx.leaderVolume) : 0,
    outputProtocol: ctx.outputProtocol,
    mixedGroupEnabled: ctx.mixedGroupEnabled,
  };
}

/**
 * The artwork url the native client can actually fetch.
 *
 * The app GETs whatever `coverurl` names and caches the bytes in its own CoverDB. That only
 * works for a url whose response it is allowed to read: our gateway answers with
 * `Access-Control-Allow-Origin: *`, while a Sonos speaker's `:1400/getaa`, a streaming CDN and
 * a station logo do not — the fetch is refused and the player draws no artwork, even though our
 * own web UI (a plain `<img>`) shows it from the same url. Naming the zone instead lets the
 * gateway proxy whatever the zone is playing now, with an `ETag` for revalidation.
 *
 * A cover the gateway already serves is left alone: it is on the gateway port and carries its
 * own cache-busting query already.
 */
export function buildLoxoneCoverUrl(state: ZoneState, coverHost: string): string {
  const source = (state.coverurl ?? '').trim();
  if (!source || isServedByGateway(source)) {
    return source;
  }
  const host = coverHost.trim() || '127.0.0.1';
  return `http://${host}:7090/api/v1/zones/${state.id}/cover?v=${coverRevision(source)}`;
}

/** Artwork the gateway itself serves (library files, custom stations): already fetchable. */
function isServedByGateway(source: string): boolean {
  try {
    const url = new URL(source);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.port === '7090';
  } catch {
    // A data uri, or nothing a `<img>` could fetch either; the gateway can serve both.
    return false;
  }
}

/**
 * A short, stable tag that follows the artwork, so the client's cache moves with the track
 * instead of showing the previous cover. Hashed rather than the raw url: the url is long and
 * may carry query the client should not have to care about.
 */
function coverRevision(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
