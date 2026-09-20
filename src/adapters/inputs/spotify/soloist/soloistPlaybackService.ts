import type { Readable } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata } from '@/ports/types/playback';
import { PulseSoundCard } from '@/adapters/inputs/pulse/pulseSoundCard';
import {
  accountStore,
  applyPreferences,
  hasStoredSession,
  probeBinary,
  reserveWsPort,
  startPersistent,
  zoneStore,
  type SoloistRunHandle,
  type SoloistStore,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  SoloistTrackRun,
  type TrackRunEnd,
  type TrackRunFailure,
} from '@/adapters/inputs/spotify/soloist/soloistTrackRun';
import { fetchBuild } from '@/adapters/inputs/spotify/soloist/soloistUpdater';
import {
  clampVolume,
  readTrack,
  SoloistWsClient,
  type SoloistQueueEntry,
  type SoloistStateEvent,
} from '@/adapters/inputs/spotify/soloist/soloistWsClient';
import type { SpotifyConnectController, SpotifyQueueTrack } from '@/ports/InputsPort';

/**
 * How often to ask Spotify whether it has published a new build.
 *
 * Daily, because a build lasts 90 days and there is no hurry — and because with an etag the check
 * costs a couple of hundred bytes, so there is nothing to save by doing it less.
 */
const BUILD_CHECK_INTERVAL_MS = 24 * 3600_000;
/**
 * How long a volume arriving around an activation is treated as Connect's rather than a listener's.
 *
 * Four seconds, the same window the librespot backend needed: the handshake reports the device's
 * stored level once the account moves, sometimes more than once, and always within a moment of it.
 */
const ACTIVATION_VOLUME_LATCH_MS = 4000;
/**
 * How long a track waits for another room to let go of the account's store.
 *
 * An account plays in one room at a time — Spotify's rule, and the engine's too, since one store
 * takes one run. So a second room asking for the same account is refused rather than allowed to
 * steal the first one's music, which is the right way round. Short wait only, for the case where
 * the first room has just stopped and its process is on its way out.
 */
const STORE_WAIT_MS = 1500;

/** Everything that has to be true before an account can play, named so the UI can say which is not. */
export type SoloistReadiness =
  | { ready: true }
  | {
    ready: false;
    reason: 'no_api_key' | 'no_binary' | 'not_executable' | 'no_account' | 'not_paired';
  };

/**
 * Who is deciding what plays in a room.
 *
 * `idle` is nobody: the room's daemon is sitting there advertising itself, and anything it reports
 * playing is somebody picking the room in their Spotify app — which is the one state a takeover
 * can be adopted from.
 *
 * `queue` is this server working through its own list, and it no longer goes through that daemon at
 * all: every track is its own `--single-track` run from the account it came from. While the queue
 * owns a room, everything the daemon says is about an account playing somewhere else, so none of it
 * is read. That is what the split bought — the end of a track, a pause and a skip used to arrive
 * looking identical.
 *
 * `connect` is someone driving the room from the Spotify app, where Soloist owns the queue and
 * moving to the next track is ordinary rather than something to be read into.
 */
type Owner = 'idle' | 'queue' | 'connect';

/**
 * The volume Connect hands a device when that device takes the account, still to be dropped.
 *
 * `value` is empty until the first one arrives: which level it is cannot be known in advance, and
 * recognising its repeats after the window has closed is the whole point of remembering it.
 */
export type VolumeLatch = { until: number; value: number | null };

/** One zone's Connect device: the process, its control channel, and whatever it is playing. */
type ZoneRunner = {
  handle: SoloistRunHandle;
  ws: SoloistWsClient;
  owner: Owner;
  /** The run playing this room's own queue, when there is one. Never this daemon. */
  track: SoloistTrackRun | null;
  /** What is sounding now, so a repeat of the same event is not treated as a change. */
  currentUri: string | null;
  /** The current track in full, since the queue Soloist reports leaves it out. */
  currentTrack: SpotifyQueueTrack | null;
  /** Either side of the current track, as Soloist last reported it. */
  queue: { previous: string[]; upcoming: string[] };
  stream: Readable | null;
  /**
   * Armed for as long as an adoption is on its way.
   *
   * Adopting waits for the player to say what format it plays in, and `stream` is still null for
   * however long that takes — so the condition that started the adoption is still true when the
   * next event arrives. Every other adopt here is edge-triggered; the one on `playing` is not,
   * because the app keeps saying `playing` while the music runs.
   */
  adopting: boolean;
  /**
   * Set while the zone is being held for a pause the Spotify app asked for.
   *
   * What makes the difference between a resume and the app simply saying what it is doing. Reading
   * `playing` alone as a resume would be level-triggered against an event the app repeats while
   * the music runs, and a zone told to carry on when it already is restarts its position clock
   * and sends a resume to every output for its trouble.
   */
  paused: boolean;
  /**
   * The level this zone and Soloist last agreed on.
   *
   * Both directions write it, which is what keeps them from chasing each other: a `set_volume` of
   * ours comes straight back as a `volume_changed`, and a level equal to the one already agreed is
   * nobody asking for anything.
   */
  volume: number | null;
  /** Armed while the volume Connect reports for an activation is still to be ignored. */
  volumeLatch: VolumeLatch | null;
};

/**
 * Whether a volume Soloist reports is somebody moving the slider in the Spotify app.
 *
 * Two kinds are not. Our own `set_volume` arrives back as a `volume_changed` a moment later, and
 * Connect hands a device its stored level the instant that device takes the account — the device
 * picker's slider rather than anyone's hand, and following it would overwrite the zone's own
 * default at the start of every session. So a level inside the activation window is dropped, and
 * afterwards only repeats of the one seen there.
 *
 * The window has to expire even when nothing arrived in it. Measured on a real start, the burst
 * either never comes or comes while the zone is still setting the track up, where every event is
 * ignored anyway — and a latch left waiting for it swallows the first genuine turn of the knob
 * instead. Its late arrival is the lesser risk of the two, and the level this server sends on
 * starting makes it unlikely: what Connect then has stored for the device is the room's own level.
 *
 * The latch that comes back is what the caller should keep: `null` once released.
 */
export function classifyVolumeReport(args: {
  level: number;
  /** The level the zone and Soloist last agreed on, if any. */
  agreed: number | null;
  latch: VolumeLatch | null;
  now: number;
}): { follow: boolean; latch: VolumeLatch | null; reason: 'listener' | 'echo' | 'activation' } {
  const { level, agreed, latch, now } = args;
  if (level === agreed) {
    return { follow: false, latch, reason: 'echo' };
  }
  if (latch && now < latch.until) {
    // The first one seen is Connect's, and remembering it keeps its repeats recognisable later.
    return {
      follow: false,
      latch: { until: latch.until, value: latch.value ?? level },
      reason: 'activation',
    };
  }
  if (latch && latch.value !== null && level === latch.value) {
    return { follow: false, latch, reason: 'activation' };
  }
  return { follow: true, latch: null, reason: 'listener' };
}

function urisOf(entries: SoloistQueueEntry[] | undefined): string[] {
  return (entries ?? [])
    .map((entry) => entry?.item?.uri)
    .filter((uri): uri is string => Boolean(uri));
}

/**
 * The app's queue with the current track put back where it belongs.
 *
 * `queue_changed` names what has been played and what is to come but not what is playing, so
 * mirroring it verbatim would leave a gap at exactly the place a listener looks first — and the
 * zone would have nothing to anchor its own position to.
 */
export function buildMirroredQueue(
  current: SpotifyQueueTrack,
  previous: SoloistQueueEntry[] | undefined,
  upcoming: SoloistQueueEntry[] | undefined,
): { tracks: SpotifyQueueTrack[]; currentIndex: number } {
  const asTracks = (entries: SoloistQueueEntry[] | undefined): SpotifyQueueTrack[] =>
    (entries ?? [])
      .map((entry) => queueTrackOf(readTrack(entry?.item), entry?.uid))
      .filter((track): track is SpotifyQueueTrack => track !== null);
  const before = asTracks(previous);
  return { tracks: [...before, current, ...asTracks(upcoming)], currentIndex: before.length };
}

/** A queue line, as the rest of this server wants a track described. */
function queueTrackOf(
  track: ReturnType<typeof readTrack>,
  uid?: string,
): SpotifyQueueTrack | null {
  return track.uri
    ? {
      uri: track.uri,
      ...(uid ? { uid } : {}),
      title: track.title,
      artist: track.artist,
      album: track.album,
      coverUrl: track.coverUrl,
      durationSec: track.durationSec,
    }
    : null;
}

/**
 * Plays Spotify through the user's own Soloist build.
 *
 * Two jobs, and they are deliberately separate processes on separate stores.
 *
 * A room is a Spotify Connect device: one daemon per zone, kept running, advertising itself and
 * never signed in from here. Whoever picks the room in their own Spotify app is the one who signs
 * it in, so a room belongs to whoever took it last and there is nothing to pair from this side.
 *
 * A room playing this server's own queue is one `--single-track` run per track, started from the
 * store of the account the track came from. That is what makes the end of a track a fact rather
 * than a guess — the process exits — and what makes playing from a second account nothing more
 * than starting from a second directory.
 */
export class SoloistPlaybackService {
  private readonly log = createLogger('Input', 'Soloist');
  /** The sound card Soloist plays into: no daemon, the audio lands in this process. */
  private readonly audio = new PulseSoundCard('soloist');
  private readonly runners = new Map<number, ZoneRunner>();
  /**
   * Track runs for rooms with no Connect daemon of their own.
   *
   * A room only has a daemon when Soloist is the chosen player and the room has been synced; a
   * track can be asked for before that, and it plays regardless — the daemon is what makes a room
   * appear in the Spotify app, not what makes it sound.
   */
  private readonly orphanRuns = new Map<number, SoloistTrackRun>();
  /**
   * Runs that have been told to stop but may not have gone yet, per account.
   *
   * A data directory holds a lock, so the next track cannot start from the same account until the
   * previous process has actually exited. Killing it is not the same as it having gone: measured,
   * a run spawned straight after a kill is refused outright — which is what a skip looked like.
   *
   * Kept by account rather than by room, because the store is the account's: a run put down in one
   * room is exactly what the next room has to wait for when it asks for that same account.
   */
  private readonly draining = new Map<string, Promise<void>>();
  /** Why the last track would not start, so the screen can say something better than "no". */
  private lastFailure: TrackRunFailure | null = null;
  private readonly starting = new Map<number, Promise<ZoneRunner | null>>();
  /** Track lengths as Soloist reported them, so a position update can carry one. */
  private readonly durations = new Map<number, number>();

  private controller: SpotifyConnectController | null = null;
  private buildTimer: NodeJS.Timeout | null = null;

  constructor(private readonly configPort: ConfigPort) {}

  /**
   * The way back into the zone, for playback this server did not start.
   *
   * Everything routed through it rather than driven directly, so the ZoneManager's own check —
   * is spotify still this zone's input — can refuse an update from a room that has moved on.
   */
  public setController(controller: SpotifyConnectController): void {
    this.controller = controller;
  }

  private get settings() {
    return this.configPort.getConfig()?.content?.spotify?.soloist ?? {};
  }

  /**
   * Whether this server can play Spotify at all, which is the same question as whether it has a key.
   *
   * The key is personal and Premium-only, so it is never there by accident: somebody went and got
   * it, and the only reason to do that is to play Spotify. Clearing it is how you turn this off.
   */
  public isEnabled(): boolean {
    return Boolean(this.settings.apiKey?.trim());
  }

  /**
   * Start a Soloist for every zone, so each one is a Connect device from the moment the server is.
   *
   * Eager on purpose, and this is the whole of what these processes are for: a room with no process
   * is not in the Spotify app's device list, so nobody can pick it. Starting one is also how a room
   * comes to be signed in at all — with no stored session it advertises itself and waits, and
   * whoever picks it is the one who signs it in. Lazily starting on the first play would mean a
   * room could only be reached from a phone after it had already been played from here, which is
   * backwards.
   *
   * Playing this server's own queue does not go through any of them; see `getPlaybackSource`.
   */
  public async syncZones(zoneIds: number[]): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    this.watchForBuilds();
    const wanted = new Set(zoneIds);
    // A zone that no longer does Spotify must stop appearing in the device list, which means its
    // process has to go — there is no way to run Soloist without it advertising itself.
    for (const [zoneId, runner] of [...this.runners]) {
      if (!wanted.has(zoneId)) {
        this.log.info('zone no longer does spotify; stopping its soloist', { zoneId });
        this.finishTrack(zoneId);
        runner.ws.close();
        runner.handle.stop();
        this.runners.delete(zoneId);
        await this.audio.remove(zoneId);
      }
    }
    for (const zoneId of wanted) {
      await this.ensureRunner(zoneId).catch(() => null);
    }
  }

  /**
   * Give up the daemons a changed quality setting has to reach.
   *
   * The prefs are read once, when a process starts, so a room that is already advertising itself
   * is still on the settings it was born with — a switch that only takes effect after a restart of
   * the whole server is not a switch. Dropping the runners here is enough: the `syncZones` that
   * follows every settings change starts them again, and starting is what writes the prefs.
   *
   * A room the app is playing through is left alone. Taking somebody's music away to apply a
   * preference they would hear on the next track is the wrong way round; it picks the change up
   * when that session ends. Nothing is done for this server's own queue either, and nothing needs
   * to be: a track run states the prefs itself, every track.
   */
  public dropForQualityChange(): void {
    for (const [zoneId, runner] of [...this.runners]) {
      if (runner.owner === 'connect') {
        this.log.info('a room the app is playing through keeps its quality until that session ends', {
          zoneId,
        });
        continue;
      }
      this.log.info('restarting soloist so a quality change reaches this room', { zoneId });
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
      this.runners.delete(zoneId);
    }
  }

  /**
   * Keep the program itself up to date.
   *
   * Soloist expires 90 days after it was built, and until now that meant someone had to notice a
   * dead room, work out why, and go and fetch a new one. Spotify publishes builds as plain files
   * with an etag, so this asks daily and installs what it finds. Switching the backend on with
   * nothing installed fetches one straight away, which is the whole of the setup this step used
   * to be.
   */
  private watchForBuilds(): void {
    if (this.buildTimer) {
      return;
    }
    void this.updateBuild('startup');
    this.buildTimer = setInterval(() => void this.updateBuild('daily'), BUILD_CHECK_INTERVAL_MS);
    // Nothing here should hold the process open.
    this.buildTimer.unref?.();
  }

  private async updateBuild(reason: 'startup' | 'daily' | 'expired'): Promise<void> {
    const installed = await probeBinary();
    const known = installed.present ? this.settings.build : undefined;
    const result = await fetchBuild(known);
    if (result.status === 'unsupported-arch') {
      this.log.info('spotify publishes no soloist for this machine; upload one by hand', {
        arch: result.arch,
      });
      return;
    }
    if (result.status === 'failed') {
      // Never fatal: an installed build keeps playing, and an absent one is already reported by
      // readiness as the thing that is missing.
      this.log.warn('could not fetch a soloist build', { reason, message: result.message });
      await this.recordBuild({});
      return;
    }
    if (result.status === 'unchanged') {
      this.log.debug('soloist build is current', { reason });
      await this.recordBuild({ signature: result.signature });
      return;
    }
    await this.recordBuild({
      signature: result.signature,
      digest: result.digest,
      installedAt: Date.now(),
    });
    await this.adoptNewBuild();
  }

  /**
   * Put a freshly installed build to use.
   *
   * A running process holds its own copy of the program, so replacing the file changes nothing
   * until it restarts — and restarting a room that is playing would cut the music for a program
   * that has 90 days left. So it waits: rooms that are idle pick it up now, the rest at the next
   * check, or whenever they next stop.
   */
  private async adoptNewBuild(): Promise<void> {
    const playing = [...this.runners.values()].some((runner) => runner.stream !== null);
    if (playing) {
      this.log.info('new soloist build installed; rooms will pick it up once they are quiet');
      return;
    }
    const zoneIds = [...this.runners.keys()];
    for (const zoneId of zoneIds) {
      const runner = this.runners.get(zoneId);
      if (!runner) {
        continue;
      }
      runner.ws.close();
      runner.handle.stop();
      this.runners.delete(zoneId);
    }
    for (const zoneId of zoneIds) {
      await this.ensureRunner(zoneId).catch(() => null);
    }
    this.log.info('rooms restarted on the new soloist build', { zones: zoneIds.length });
  }

  private async recordBuild(patch: {
    signature?: string;
    digest?: string;
    installedAt?: number;
  }): Promise<void> {
    try {
      await this.configPort.updateConfig((cfg) => {
        const spotify = cfg.content?.spotify;
        if (!spotify) {
          return;
        }
        const previous = spotify.soloist?.build ?? {};
        spotify.soloist = {
          ...(spotify.soloist ?? {}),
          build: { ...previous, ...patch, checkedAt: Date.now() },
        };
      });
    } catch {
      /* best effort; the figure is a convenience, not state anything depends on */
    }
  }

  /** Stop every zone's Soloist, for when the backend is switched off. */
  public async stopAllZones(): Promise<void> {
    for (const run of this.orphanRuns.values()) {
      run.stop();
    }
    this.orphanRuns.clear();
    for (const [zoneId, runner] of [...this.runners]) {
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
      this.runners.delete(zoneId);
    }
    // The cards go too. They exist for these players and nothing else, and a socket left listening
    // for a backend nobody selected is an open door onto a room with no one behind it.
    await this.audio.stop();
  }

  /** Everything that has to be true before a zone can play, named so the UI can say which is not. */
  public async readiness(accountId: string): Promise<SoloistReadiness> {
    if (!this.settings.apiKey?.trim()) {
      return { ready: false, reason: 'no_api_key' };
    }
    const binary = await probeBinary();
    if (!binary.present) {
      return { ready: false, reason: 'no_binary' };
    }
    if (!binary.executable) {
      return { ready: false, reason: 'not_executable' };
    }
    if (!accountId) {
      return { ready: false, reason: 'no_account' };
    }
    if (!(await hasStoredSession(accountStore(accountId)))) {
      // Rooms need no pairing at all now; an account does, once, and until then there is no stored
      // session for a run to restore — it would advertise itself and wait for nobody.
      return { ready: false, reason: 'not_paired' };
    }
    return { ready: true };
  }

  /** Why the last track would not play, so a screen can name it rather than saying nothing. */
  public lastPlaybackFailure(): TrackRunFailure | null {
    return this.lastFailure;
  }

  /** Which accounts can play, for the screen that offers to pair the ones that cannot. */
  public async pairedAccounts(): Promise<Array<{ id: string; label: string; paired: boolean }>> {
    const accounts = this.configPort.getConfig()?.content?.spotify?.accounts ?? [];
    return Promise.all(
      accounts
        .filter((account) => Boolean(account.id))
        .map(async (account) => ({
          id: account.id as string,
          label: account.displayName || account.name || account.user || (account.id as string),
          paired: await hasStoredSession(accountStore(account.id as string)),
        })),
    );
  }

  /** The store one account's playback runs from, for the pairing flow to sign in. */
  public storeForAccount(accountId: string): SoloistStore {
    return accountStore(accountId);
  }

  private zoneName(zoneId: number): string {
    const zone = this.configPort.getConfig()?.zones?.find((z) => z.id === zoneId);
    return zone?.name?.trim() || `Sonn Zone ${zoneId}`;
  }

  /** Start this zone's Soloist and connect to it, or return the one already running. */
  private async ensureRunner(zoneId: number): Promise<ZoneRunner | null> {
    const existing = this.runners.get(zoneId);
    if (existing) {
      return existing;
    }
    const inFlight = this.starting.get(zoneId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.startRunner(zoneId).finally(() => this.starting.delete(zoneId));
    this.starting.set(zoneId, promise);
    return promise;
  }

  private async startRunner(zoneId: number): Promise<ZoneRunner | null> {
    const apiKey = this.settings.apiKey?.trim();
    if (!apiKey) {
      return null;
    }
    if (!(await this.audio.ensure(zoneId))) {
      return null;
    }

    // Stated before the process starts, because that is the only time the engine reads them — and
    // for a room, whoever signs it in gets the room's quality rather than whatever their app had
    // set for a device they have never opened the settings of.
    await applyPreferences(zoneStore(zoneId), {
      lossless: this.settings.lossless !== false,
      // The app is driving, so what a listener expects here is what their other Spotify clients
      // do — which is why this defaults to on. It is a real gain on the samples, though, and the
      // one thing between a lossless stream and a bit-exact one, so it is theirs to turn off.
      normalize: this.settings.normalize !== false,
    });

    // The control channel's port is settled here rather than by Soloist, so there is nothing to
    // wait for a file to tell us. A zone whose port cannot be reserved gets no process: it would
    // play and then answer to nothing, which is worse than saying so.
    let wsPort: number;
    try {
      wsPort = await reserveWsPort();
    } catch (error) {
      this.log.warn('no free port for this zone\'s control channel', {
        zoneId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const handle = startPersistent({
      zoneId,
      apiKey,
      deviceName: this.zoneName(zoneId),
      wsPort,
      env: await this.audio.childEnv(zoneId),
    });
    void handle.expiresInDays.then((days) => {
      if (typeof days === 'number') {
        void this.recordExpiry(days);
      }
    });

    const ws = new SoloistWsClient(zoneId, wsPort);
    if (!(await ws.connect())) {
      handle.stop();
      return null;
    }
    // Deliberately not waiting for a login here. A zone that has never been signed in never
    // reports one — it is sitting there advertising itself, which is the only way it can ever be
    // signed in. Requiring it first killed exactly the process that was waiting to be picked, so
    // such a zone could never appear in the Spotify app at all.

    const runner: ZoneRunner = {
      handle,
      ws,
      // Nobody is driving a room that has only just started advertising itself.
      owner: 'idle',
      track: null,
      currentUri: null,
      currentTrack: null,
      queue: { previous: [], upcoming: [] },
      stream: null,
      adopting: false,
      paused: false,
      volume: null,
      volumeLatch: null,
    };
    ws.on('event', (event: SoloistStateEvent) => this.onEvent(zoneId, event));
    // If the process dies the control channel goes with it; drop the runner so the next play
    // starts a fresh one rather than talking into a closed socket.
    void handle.done.then(() => {
      this.log.info('soloist exited; zone will restart it on the next track', { zoneId });
      ws.close();
      this.finishTrack(zoneId);
      this.runners.delete(zoneId);
    });

    this.runners.set(zoneId, runner);
    this.log.info('soloist running for zone', { zoneId });
    // A stored session is reported the moment the socket opens, which is before this runner
    // exists — so that first `auth_state` reached an `onEvent` with nothing to act on, and the
    // level would wait for the next time somebody turned the knob.
    if (ws.isLoggedIn) {
      this.seedVolume(zoneId);
    }
    return runner;
  }

  /**
   * What the room's Connect daemon reports, which is only ever about the app.
   *
   * This daemon no longer plays anything of ours, so nothing here has to tell our track apart from
   * somebody else's any more: while the queue owns the room, every one of these events is the
   * account doing something in another room and is dropped on sight. That is the whole of what the
   * split bought — the end of a track, a pause and a skip used to arrive looking identical.
   */
  private onEvent(zoneId: number, event: SoloistStateEvent): void {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    // A daemon that has just signed in is advertising the level it was started with, and this is
    // the first moment that can be corrected — before this it refuses commands outright. Handled
    // ahead of everything below because a login is about the device rather than about the music:
    // the guards further down are all "is this event about the room's own playback", and this one
    // is not.
    if (event.type === 'auth_state') {
      if (event.logged_in === true) {
        this.seedVolume(zoneId);
      }
      return;
    }
    // This server is driving the room from its own queue, through a run of its own. Whatever the
    // room's Connect device has to say, it is not about the music that is playing in here.
    if (runner.owner === 'queue') {
      return;
    }
    const track = readTrack(event.item);
    const uri = track.uri;

    // Nothing an inactive device reports is about this room, and everything below would act on it.
    //
    // Connect tells every device the account owns what the account is doing, note for note — same
    // track, same queue, same position. A room that reads that as its own has no way to tell a
    // listener's doing from another room's: two rooms on one account each saw the other's track
    // start, read it as a skip, stepped their own queue and started playing, which made them the
    // active device and set the other one off again.
    if (!runner.ws.isActive) {
      if (runner.owner !== 'connect') {
        // An idle room hears every note of what the account is doing elsewhere. None of it is its
        // business until somebody picks this room.
        return;
      }
      this.log.info('spotify moved playback to another device', { zoneId });
      runner.owner = 'idle';
      runner.currentUri = null;
      runner.currentTrack = null;
      this.finishTrack(zoneId);
      this.controller?.stopPlayback(zoneId);
      return;
    }

    // Just became the active device again, but with nothing carrying its audio.
    //
    // The handoff that moved the account away tore this zone's stream down, and coming back is
    // announced as a `device_changed`, which carries no `status` — so the `status === 'playing'`
    // adopt below never fires on it. Re-adopting here reopens the pipe so playback is consumed
    // again and advances. See #352.
    if (event.type === 'device_changed' && !runner.stream) {
      void this.adoptConnectPlayback(zoneId, event);
      return;
    }

    // The slider in the Spotify app. Only `volume_changed` — the level rides along on every
    // `playback_state` as well, where it says what the device is set to rather than that anybody
    // just changed it, and acting on those would put the app's level back on the zone continually.
    if (event.type === 'volume_changed' && typeof event.volume === 'number') {
      this.onVolumeReported(zoneId, runner, event.volume);
      return;
    }

    // Both lists arrive together on `queue_changed`, unasked after every change. While the app owns
    // the room they are the only account anyone here has of what is coming.
    if (Array.isArray(event.previous) || Array.isArray(event.upcoming)) {
      runner.queue = {
        previous: urisOf(event.previous),
        upcoming: urisOf(event.upcoming),
      };
      this.publishQueue(zoneId, runner, event);
    }

    if (event.type === 'track_changed' && uri && uri !== runner.currentUri) {
      runner.currentUri = uri;
      runner.currentTrack = queueTrackOf(track);
      if (!runner.stream) {
        // Owned by the app but with nothing carrying its audio: the room was stopped or handed
        // back at some point and the stream went with it, while the app kept sending. Only the
        // labels moved after that — the track showed up in the room and stayed on stop, which
        // reads as playback that never starts. Taking it over again is the whole of the fix.
        void this.adoptConnectPlayback(zoneId, event);
        return;
      }
      // The app moved to its own next track. The stream carries on; only the labels change.
      this.publishTrack(zoneId, track);
      return;
    }

    if (event.status === 'playing') {
      // Playing something nobody here asked for means the zone was taken over from the Spotify
      // app. Adopting it is the whole of Connect: open the pipe and let the zone follow along.
      //
      // A missing stream counts as much as a new track. The app says `playing` for a track this
      // room already believes is current whenever somebody resumes it, and if nothing is carrying
      // the audio then that is precisely the room the app is asking for sound in and cannot get
      // any: the labels, queue and position all keep arriving, so the zone looks alive while it
      // is silent, and no later event ever reaches a path that would open the pipe. See #383.
      if ((uri && uri !== runner.currentUri) || !runner.stream) {
        void this.adoptConnectPlayback(zoneId, event);
        return;
      }
      // A stream that is already on this track, held for a pause the app asked for: this is the
      // app letting it go again. Nothing else ever did — `paused` below holds the zone
      // unconditionally, so a room paused from the app stayed paused while Soloist played on to
      // nobody, and only the next track brought it back. The same silence as above, from the
      // other end.
      if (runner.paused) {
        runner.paused = false;
        this.controller?.resumePlayback(zoneId);
      }
      return;
    }
    if (event.status === 'paused') {
      runner.paused = true;
      this.controller?.pausePlayback(zoneId);
      return;
    }
    if (event.status === 'idle' || event.status === 'stopped') {
      this.log.info('the spotify app stopped this zone', { zoneId });
      runner.owner = 'idle';
      runner.currentUri = null;
      this.finishTrack(zoneId);
      this.controller?.stopPlayback(zoneId);
      return;
    }
    if (event.type === 'position_sync' && typeof event.position?.position_ms === 'number') {
      const elapsed = Math.max(0, Math.round(event.position.position_ms / 1000));
      // Zero arrives on every track change, where the timer has already been reset; forwarding it
      // would hold the clock at the start of a track that is already running.
      if (elapsed > 0) {
        this.controller?.updateTiming(zoneId, elapsed, this.durations.get(zoneId) ?? 0);
      }
    }
  }

  /**
   * A level the Spotify app set, on its way to the zone's own volume.
   *
   * Deliberately the zone's volume rather than a gain on the way in: Soloist is run at 100 and the
   * sound card it plays into keeps the level it is handed instead of applying it, so this number
   * has touched no samples. Handing it to the zone puts it exactly where a listener turning the
   * knob in any other client puts it — at the output, which for most of them is the speaker's own
   * volume — and it costs the stream nothing.
   */
  private onVolumeReported(zoneId: number, runner: ZoneRunner, reported: number): void {
    const level = clampVolume(reported);
    const verdict = classifyVolumeReport({
      level,
      agreed: runner.volume,
      latch: runner.volumeLatch,
      now: Date.now(),
    });
    runner.volumeLatch = verdict.latch;
    if (!verdict.follow) {
      this.log.debug('not following a volume soloist reported', {
        zoneId,
        level,
        reason: verdict.reason,
      });
      return;
    }
    runner.volume = level;
    this.log.info('the spotify app set this zone\'s volume', { zoneId, level });
    this.controller?.zoneVolume(zoneId, level);
  }

  /**
   * Put the zone's own level on the app's slider.
   *
   * Told to every daemon that is signed in, not only the one that is sounding. A Connect device
   * carries a level of its own and shows it in the app's device list whether or not anybody is
   * playing through it, and a device that was never told the room's shows the 100 it was started
   * with — a room reading 100 while it is at 12, which is the whole of #372.
   *
   * Safe to send because it is a label rather than a taper. Soloist applies no volume itself: it
   * passes the level to the sound server, and the sound server here is this process — a card that
   * records the level and hands the samples on untouched. Measured at 5, 20 and 100 within one
   * track, the peak of the delivered audio did not move, so a lossless stream stays bit-for-bit
   * what Spotify sent. That is the point of the backend and it is not being traded for a number.
   *
   * Nothing echoes back into the room: an idle device's `volume_changed` is dropped on sight (see
   * `onEvent`), and an active one recognises the level it has just agreed to.
   *
   * Still never a track run of ours. Those advertise nothing, so there is no slider anywhere for
   * their number to stand on; the room's own daemon is the device a listener is looking at.
   *
   * Returns whether it was this backend's to answer, so a caller can try elsewhere.
   */
  public setVolume(zoneId: number, level: number): boolean {
    const runner = this.runners.get(zoneId);
    if (!runner || !runner.ws.isLoggedIn) {
      return false;
    }
    const clamped = clampVolume(level);
    if (clamped === runner.volume) {
      return true;
    }
    // Somebody has settled what the room is at, which is the question the latch was holding open.
    runner.volumeLatch = null;
    runner.volume = clamped;
    return runner.ws.setVolume(clamped);
  }

  /**
   * Tell a room's daemon what the room is at, once it can be told.
   *
   * Read from the zone rather than remembered here: a daemon signs in on its own schedule — at
   * boot, or after its process was replaced — and the level by then is whatever the room has
   * settled on since, which is the zone's business and nobody else's.
   */
  private seedVolume(zoneId: number): void {
    const level = this.controller?.currentZoneVolume(zoneId);
    if (typeof level !== 'number') {
      return;
    }
    this.setVolume(zoneId, level);
  }

  /**
   * Follow playback that started in the Spotify app.
   *
   * The zone is a Connect device whenever its Soloist is up, so this can happen at any moment and
   * without warning. All it takes is reading the pipe that is already there and telling the zone
   * what is on it — the audio path is the same one the queue uses.
   */
  private async adoptConnectPlayback(zoneId: number, event: SoloistStateEvent): Promise<void> {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      return;
    }
    // One takeover, one stream. Dropping the events that arrive while the first one is still
    // waiting for a format costs nothing: the adoption they would have started publishes the
    // track and the queue itself, and anything that moved since arrives again straight after.
    if (runner.adopting) {
      return;
    }
    runner.adopting = true;
    try {
      await this.followConnectPlayback(zoneId, runner, event);
    } finally {
      runner.adopting = false;
    }
  }

  private async followConnectPlayback(
    zoneId: number,
    runner: ZoneRunner,
    event: SoloistStateEvent,
  ): Promise<void> {
    const track = readTrack(event.item);
    runner.owner = 'connect';
    runner.paused = false;
    runner.currentUri = track.uri ?? null;
    runner.currentTrack = queueTrackOf(track);
    // A takeover is announced as playback, not as a queue, so the list has to be asked for once.
    // After this it arrives by itself whenever the listener changes anything.
    runner.ws.requestQueue();

    if (!runner.stream) {
      // A takeover is an activation as much as one of ours is, and it arrives with the level the
      // app remembered for this device. The zone applies its own on starting, so the same latch
      // keeps Connect's out of the way here.
      runner.volumeLatch = { until: Date.now() + ACTIVATION_VOLUME_LATCH_MS, value: null };
      // The first track of a session has to wait for the player to say what it plays in; after
      // that the answer is already there. Without this a takeover that arrives before the player
      // has opened its stream finds no format and gives up, and nothing tries again.
      await this.audio.waitForSpec(zoneId);
      const opened = this.openAudio(zoneId);
      if (!opened) {
        return;
      }
      runner.stream = opened.stream;
      const source = opened.source;
      this.log.info('the spotify app took this zone over', { zoneId, uri: track.uri });
      this.controller?.startPlayback(zoneId, 'spotify-connect', source, this.metadataFor(track));
      return;
    }
    this.publishTrack(zoneId, track);
  }

  /** Hand the app's queue over to the zone, so a room shows the album someone put on. */
  private publishQueue(zoneId: number, runner: ZoneRunner, event: SoloistStateEvent): void {
    const current = runner.currentTrack;
    if (!current) {
      return;
    }
    const { tracks, currentIndex } = buildMirroredQueue(current, event.previous, event.upcoming);
    this.log.debug('mirroring the spotify app queue', {
      zoneId,
      items: tracks.length,
      currentIndex,
    });
    this.controller?.updateQueue(zoneId, tracks, currentIndex);
  }

  private publishTrack(zoneId: number, track: ReturnType<typeof readTrack>): void {
    const metadata = this.metadataFor(track);
    this.controller?.updateMetadata(zoneId, metadata);
    if (typeof track.durationSec === 'number') {
      this.durations.set(zoneId, track.durationSec);
      this.controller?.updateTiming(zoneId, 0, track.durationSec);
    }
  }

  private metadataFor(track: ReturnType<typeof readTrack>): PlaybackMetadata {
    return {
      title: track.title ?? '',
      artist: track.artist ?? '',
      album: track.album ?? '',
      coverurl: track.coverUrl,
      duration: track.durationSec,
      audiopath: track.uri,
    };
  }

  /**
   * End the room's view of what is playing, whichever of the two was playing it.
   *
   * A track run is put down here rather than left to finish: it holds the account, and an account
   * held by a room that has stopped listening is an account the next room cannot have.
   */
  private finishTrack(zoneId: number): void {
    const runner = this.runners.get(zoneId);
    // A room playing without a Connect daemon of its own still has a run to put down, so this is
    // read before the runner is: there is nothing to look the run up on otherwise.
    const track = runner?.track ?? this.orphanRuns.get(zoneId) ?? null;
    if (runner) {
      runner.track = null;
    }
    this.orphanRuns.delete(zoneId);
    if (track) {
      // Kept so the next track can wait for the store rather than being refused it — under the
      // account, since that is whose directory is being let go of.
      this.draining.set(track.accountId, track.stop());
    }
    if (!runner) {
      this.audio.discardPending(zoneId);
      return;
    }
    const stream = runner.stream;
    runner.stream = null;
    stream?.destroy();
    // What the app was playing described the stream that just went, so it goes with it. Left
    // behind, it makes the room claim a track it is not playing: the app resuming that same track
    // reads as "already current", and the room stays silent under a perfectly correct display.
    runner.currentUri = null;
    runner.currentTrack = null;
    runner.paused = false;
    // Whatever arrives from here on belongs to the track that is over.
    this.audio.discardPending(zoneId);
  }

  /**
   * Start a track and hand back the FIFO the engine should read.
   *
   * Not `realTime`: the sink is clocked, so the pacing is already upstream, and adding ffmpeg's
   * `-re` puts a second timer on the same stream — which stutters against a pipe buffer far too
   * small to absorb the disagreement.
   */
  public async getPlaybackSource(
    zoneId: number,
    uri: string,
    seekPositionMs = 0,
    accountId?: string,
  ): Promise<PlaybackSource | null> {
    const account = accountId ?? (await this.defaultAccount());
    const ready = await this.readiness(account);
    if (!ready.ready) {
      this.log.warn('soloist cannot play this track yet', { zoneId, reason: ready.reason, account });
      return null;
    }
    if (!(await this.audio.ensure(zoneId))) {
      return null;
    }

    // Whatever was sounding is over, and this server is deciding again — even if the app had taken
    // the zone over a moment ago. The Connect daemon is left running: it is what keeps the room
    // pickable in the app, and from here on nothing it says is about this room's music.
    const runner = this.runners.get(zoneId);
    this.finishTrack(zoneId);
    // The store this run needs is the account's, and its lock outlives the kill by a moment —
    // whether the room letting go is this one or another. Waiting here is what makes a skip work,
    // and what makes an account follow a listener from one room to the next.
    await this.releaseAccount(account, zoneId);
    if (runner) {
      runner.owner = 'queue';
      runner.currentTrack = null;
      runner.currentUri = null;
      if (runner.ws.isActive) {
        // Only when it holds the account: a room the app was playing into has to let go, or two
        // players end up talking to one sound card and the first one to have connected is dropped
        // mid-track without ever being told.
        runner.ws.pause();
        runner.ws.deactivate();
      }
    }
    // The player behind this card is replaced on every track, so what the last one played in says
    // nothing about the next: without forgetting it, the format is answered before its player has
    // even connected.
    this.audio.forgetSpec(zoneId);

    const start = async (): Promise<Awaited<ReturnType<typeof SoloistTrackRun.start>>> =>
      SoloistTrackRun.start({
        zoneId,
        uri,
        accountId: account,
        apiKey: this.settings.apiKey?.trim() ?? '',
        deviceName: this.zoneName(zoneId),
        lossless: this.settings.lossless !== false,
        // Nobody else is normalizing this audio, and the engine is the only thing in the path that
        // knows what Spotify measured for the track — so on by default here too. Read per track,
        // which is why the queue path needs no restart to follow the setting.
        normalize: this.settings.normalize !== false,
        seekPositionMs,
        env: await this.audio.childEnv(zoneId),
        onEnd: (end) => this.onTrackEnded(zoneId, uri, end),
      });
    let started = await start();
    if (!started.ok && started.failure === 'store_busy') {
      // Every run this server knows of has been put down and waited for by now, so a store still
      // held is one taking longer to let go than its budget allowed — or a stray process from a
      // previous life of this server. One more try, and then the room is told rather than left
      // retrying a directory that may never come free.
      await new Promise((resolve) => setTimeout(resolve, STORE_WAIT_MS));
      started = await start();
    }
    if (!started.ok) {
      this.log.warn('soloist would not play this track', {
        zoneId,
        uri,
        account,
        reason: started.failure,
      });
      this.lastFailure = started.failure;
      if (started.failure === 'expired') {
        // A build past its ninety days exits the moment it starts, and the daily check may be
        // hours away. Fetching now is what makes the next track work instead of every track until
        // tomorrow — and there is no point retrying this one: the room has already waited.
        void this.updateBuild('expired');
      }
      return null;
    }
    this.lastFailure = null;
    if (runner) {
      runner.track = started.run;
    } else {
      // A room with no Connect daemon still plays: the daemon is what makes it appear in the app,
      // not what makes it sound. Kept here so stopping and pausing still find the run.
      this.orphanRuns.set(zoneId, started.run);
    }

    // The player opens its stream a moment after it starts sounding, and every track brings a new
    // one, so this waits on every track rather than only the first of a session.
    await this.audio.waitForSpec(zoneId);
    const opened = this.openAudio(zoneId);
    if (!opened) {
      started.run.stop();
      return null;
    }
    if (runner) {
      runner.stream = opened.stream;
    }
    return opened.source;
  }

  /**
   * What became of a track this server put on.
   *
   * `ended` is left alone on purpose. The room is still hearing the last of the track out of the
   * output's buffer, and it finishes it on its own clock the way it finishes every track — the
   * next track's `getPlaybackSource` is what closes the stream, once the room has had what was in
   * it. The other endings are not endings at all: the room would sit in silence for the rest of a
   * track that has stopped arriving, so it is told.
   */
  private onTrackEnded(zoneId: number, uri: string, end: TrackRunEnd): void {
    const runner = this.runners.get(zoneId);
    const current = runner?.track ?? this.orphanRuns.get(zoneId) ?? null;
    if (current && current.uri !== uri) {
      // A later track already replaced this one; its ending says nothing about what is playing.
      return;
    }
    if (runner) {
      runner.track = null;
    }
    this.orphanRuns.delete(zoneId);
    if (end.reason === 'ended' || end.reason === 'stopped') {
      this.log.debug('the soloist run for this track is done', { zoneId, uri, reason: end.reason });
      return;
    }
    if (end.reason === 'taken') {
      // Somebody picked this room, or another one, in their Spotify app. Either way the account is
      // theirs now — and if it was this room they picked, its daemon is the one holding it, so the
      // room goes back to being adoptable rather than staying pinned to a queue it cannot play.
      if (runner) {
        runner.owner = 'idle';
      }
      this.controller?.transport(zoneId, 'stop');
      return;
    }
    this.log.warn('spotify playback stopped for this room', { zoneId, uri, detail: end.detail });
    this.controller?.transport(zoneId, 'stop');
  }

  /**
   * Free an account's store, wherever it is being held, and wait until it is actually free.
   *
   * A store belongs to an account and not to a room: one directory, one lock, one run at a time.
   * So a room asking for an account another room is holding is a move, not a second stream — the
   * same thing the Spotify app does when you pick another speaker — and the only way to honour it
   * is to put the other room's run down first. A paused room in particular holds its run for as
   * long as it stays paused, which is how starting the same account elsewhere used to sit there
   * being refused the directory until something else happened to end it.
   *
   * The waiting is the point: the lock outlives the kill, so letting go and having let go are not
   * the same moment.
   */
  private async releaseAccount(accountId: string, forZoneId: number): Promise<void> {
    for (const [zoneId, run] of this.trackRuns()) {
      if (zoneId === forZoneId || run.accountId !== accountId) {
        continue;
      }
      this.log.info('an account is moving to another room', {
        account: accountId,
        from: zoneId,
        to: forZoneId,
      });
      this.finishTrack(zoneId);
      // The room that lost the account is left showing a track nothing is sending it any more, so
      // it is told. Nobody else is going to: this is not a stop it asked for.
      this.controller?.transport(zoneId, 'stop');
    }
    const draining = this.draining.get(accountId);
    if (draining) {
      this.draining.delete(accountId);
      await draining;
    }
  }

  /** Every track run this server is holding, whichever of the two places it is kept in. */
  private *trackRuns(): Iterable<[number, SoloistTrackRun]> {
    for (const [zoneId, runner] of this.runners) {
      if (runner.track) {
        yield [zoneId, runner.track];
      }
    }
    yield* this.orphanRuns;
  }

  /** The run carrying this room's queue, wherever it is being kept. */
  private trackRunFor(zoneId: number): SoloistTrackRun | null {
    return this.runners.get(zoneId)?.track ?? this.orphanRuns.get(zoneId) ?? null;
  }

  /**
   * Which account plays when nothing said.
   *
   * A queue item normally carries the account it was browsed from, and that is the one that plays.
   * Absent one — a bare `spotify:track:…` from somewhere older — the first account that has been
   * paired stands in, which is the only answer that is right on a server with one account and
   * defensible on a server with several.
   */
  private async defaultAccount(): Promise<string> {
    for (const account of this.configPort.getConfig()?.content?.spotify?.accounts ?? []) {
      const id = account.id?.trim();
      if (id && (await hasStoredSession(accountStore(id)))) {
        return id;
      }
    }
    return '';
  }

  /**
   * The zone's audio, however playback came about.
   *
   * Whatever Soloist asked to play in, we take: it decodes to float and says so when it opens the
   * stream, and passing that on untouched is one conversion fewer than pinning a format and having
   * something meet it. Not `realTime` — reading this stream is what releases the next grant, so the
   * pacing is already ours and a second timer would only fight it.
   */
  private openAudio(zoneId: number): { stream: Readable; source: PlaybackSource } | null {
    const stream = this.audio.takeStream(zoneId);
    const spec = this.audio.specFor(zoneId);
    if (!stream || !spec) {
      this.log.warn('no audio stream for this zone yet', { zoneId });
      return null;
    }
    return {
      stream,
      source: {
        kind: 'pipe',
        path: `soloist-${zoneId}`,
        format: spec.format as 's16le' | 's24le' | 's32le' | 'f32le',
        sampleRate: spec.rate,
        channels: spec.channels,
        realTime: false,
        stream,
      },
    };
  }

  public async stopZone(zoneId: number, reason = 'stop'): Promise<void> {
    const runner = this.runners.get(zoneId);
    if (!runner) {
      // A room can be playing without a Connect daemon of its own, and its run still has to go:
      // it holds the account, and an account held for a room that stopped listening is one the
      // next room cannot have.
      this.finishTrack(zoneId);
      return;
    }
    this.log.debug('stopping soloist playback for zone', { zoneId, reason });
    if (runner.owner === 'connect') {
      runner.ws.pause();
    }
    // Hand the account's playback back rather than keeping it pinned to a room that stopped
    // listening; the process stays up so the zone remains pickable in the Spotify app.
    runner.ws.deactivate();
    // An idle device's volume can be moved in the app without this room hearing about it, so what
    // the two last agreed on stops being true. Forgetting it makes the next session say its level
    // out loud instead of assuming the slider is already right.
    runner.volume = null;
    runner.volumeLatch = null;
    // Back to nobody driving, which is what makes the room adoptable again: while this server was
    // driving it, everything its daemon reported was deliberately ignored.
    runner.owner = 'idle';
    this.finishTrack(zoneId);
  }

  /**
   * Step the Spotify app's own queue, for a zone the app is driving.
   *
   * When the app owns the queue this server cannot walk it: the list belongs to Spotify, and the
   * room is showing a mirror of it. So the zone's own next and previous are passed on to the thing
   * that does own it, which is the only way those buttons can mean anything at all.
   */
  public skip(zoneId: number, direction: 'next' | 'previous'): boolean {
    const runner = this.runners.get(zoneId);
    if (!runner || runner.owner !== 'connect') {
      return false;
    }
    this.log.info('passing a queue step to the spotify app', { zoneId, direction });
    return direction === 'next' ? runner.ws.skipNext() : runner.ws.skipPrevious();
  }

  /**
   * Hold or release the player along with its room.
   *
   * A zone paused in the app used to pause only what this server sends: Soloist played on to the
   * end of the track, and Spotify then moved to the next — so a room resumed a minute later came
   * back somewhere else entirely, if it came back at all.
   *
   * Returns false when this backend is not the one holding that room, so the caller can look
   * elsewhere.
   */
  public setPaused(zoneId: number, paused: boolean): boolean {
    const run = this.trackRunFor(zoneId);
    if (!run) {
      return false;
    }
    this.log.debug('holding the player with its zone', { zoneId, paused });
    // Nothing to mark as ours any more: a `--single-track` run is in no Spotify app, so a pause it
    // reports can only be the one just asked for.
    if (paused) {
      run.pause();
    } else {
      run.resume();
    }
    return true;
  }

  /** Move within the track that is playing, for a room this server is driving. */
  public seek(zoneId: number, positionMs: number): boolean {
    const run = this.trackRunFor(zoneId);
    if (!run) {
      return false;
    }
    run.seek(positionMs);
    return true;
  }

  public isPlaying(zoneId: number): boolean {
    return Boolean(this.runners.get(zoneId)?.stream) || this.orphanRuns.has(zoneId);
  }

  /** Keep the reported expiry fresh so the admin screen can warn before a build stops working. */
  private async recordExpiry(daysAtCheck: number): Promise<void> {
    const existing = this.settings.expiry;
    if (existing && existing.daysAtCheck === daysAtCheck && Date.now() - existing.checkedAt < 12 * 3600_000) {
      return;
    }
    try {
      await this.configPort.updateConfig((cfg) => {
        const spotify = cfg.content?.spotify;
        if (!spotify) {
          return;
        }
        spotify.soloist = { ...(spotify.soloist ?? {}), expiry: { daysAtCheck, checkedAt: Date.now() } };
      });
    } catch {
      /* best effort; the figure is a convenience, not state anything depends on */
    }
  }

  public async shutdown(): Promise<void> {
    if (this.buildTimer) {
      clearInterval(this.buildTimer);
      this.buildTimer = null;
    }
    for (const run of this.orphanRuns.values()) {
      run.stop();
    }
    this.orphanRuns.clear();
    for (const [zoneId, runner] of [...this.runners]) {
      this.finishTrack(zoneId);
      runner.ws.close();
      runner.handle.stop();
    }
    this.runners.clear();
    await this.audio.stop();
  }

  /**
   * Follow a renamed room into the Spotify app.
   *
   * The name is fixed at spawn, so the process has to start again for a rename to show up in
   * anybody's device list. A room that is playing is left alone: a new label is not worth cutting
   * the music for, and the next start picks it up anyway.
   */
  public async renameZone(zoneId: number, name: string): Promise<void> {
    const runner = this.runners.get(zoneId);
    if (!runner || runner.owner !== 'idle' || runner.track) {
      return;
    }
    this.log.info('restarting a room\'s soloist under its new name', { zoneId, name });
    runner.ws.close();
    runner.handle.stop();
    this.runners.delete(zoneId);
    await this.ensureRunner(zoneId).catch(() => null);
  }

  /** Where a room's Connect device keeps its identity, for anything that has to look at it. */
  public dataDirFor(zoneId: number): string {
    return zoneStore(zoneId).data;
  }
}
