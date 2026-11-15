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
    coverurl: state.coverurl,
    duration: state.duration,
    equalizerSettings: formatEqualizerSettings(state.eq),
    icontype: state.icontype,
    mode: state.mode,
    name: state.name,
    parent: toLoxoneParent(audiopath, account, ctx),
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
