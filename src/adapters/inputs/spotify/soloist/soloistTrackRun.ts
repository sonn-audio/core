import { createLogger } from '@/shared/logging/logger';
import {
  accountStore,
  applyPreferences,
  hasStoredSession,
  reserveWsPort,
  startSingleTrack,
  type SoloistRunHandle,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';
import {
  SoloistWsClient,
  type SoloistStateEvent,
} from '@/adapters/inputs/spotify/soloist/soloistWsClient';

const log = createLogger('Input', 'SoloistTrack');

/** How long the engine gets to start, log in and reach the track it was asked for. */
const START_TIMEOUT_MS = 30_000;
/** How long a seek gets to land before the track is given up on. */
const SEEK_CONFIRM_TIMEOUT_MS = 15_000;
/** How long to wait for Spotify to allow seeking on a track that has only just started. */
const SEEK_ALLOWED_TIMEOUT_MS = 10_000;
/** How close a position report has to come to count as having arrived at the target. */
const SEEK_GRACE_MS = 3000;
/** How long a stopped run gets to actually let go of its store before the next track gives up. */
const STORE_RELEASE_TIMEOUT_MS = 5000;

/** Why a track could not be started, in terms the screen can turn into a sentence. */
export type TrackRunFailure =
  | 'no_account'
  | 'no_session'
  | 'store_busy'
  | 'expired'
  | 'no_port'
  | 'no_start'
  | 'no_seek';

/**
 * How a track ended.
 *
 * `ended` is the ordinary one and needs no interpreting: the engine played the track out and its
 * process is gone. That is the whole reason this shape exists — a track ending used to be a guess
 * made from events that also mean something else.
 */
export type TrackRunEnd =
  | { reason: 'ended' }
  | { reason: 'taken' }
  | { reason: 'stopped' }
  | { reason: 'failed'; detail: string };

export type TrackRunStart =
  | { ok: true; run: SoloistTrackRun }
  | { ok: false; failure: TrackRunFailure };

/**
 * One track, one engine run.
 *
 * `--single-track` restores an account's stored session without advertising anything, plays the
 * one URI with shuffle and repeat off, and exits when it is done. Everything that used to have to
 * be inferred about a track's end follows from that: the process exiting is the end, a foreign
 * track appearing is the engine wandering off in the moment before it exits, and nobody can pause
 * or skip a run that no Spotify app can see.
 *
 * It plays into the zone's own sound card, so the pacing, the format and the room are unchanged —
 * only what is on the other end of the card is new on every track.
 */
export class SoloistTrackRun {
  private ended = false;
  private position = 0;
  /**
   * Whether the engine has been seen holding the account at all.
   *
   * Measured: the daemon logs "became active device" and then, ten milliseconds later, sends a
   * state carrying `is_active: false` — a startup snapshot, not a handover. Read as a handover it
   * killed the run before a single sample reached the card, and the room got a track that started
   * and instantly stopped for no reason anybody could see.
   */
  private wasActive = false;
  /** Whether Spotify is currently accepting a seek on this track; see `available_actions`. */
  private seekAllowed = false;

  private constructor(
    public readonly zoneId: number,
    public readonly uri: string,
    public readonly accountId: string,
    private readonly handle: SoloistRunHandle,
    private readonly ws: SoloistWsClient,
    private readonly onEnd: (end: TrackRunEnd) => void,
  ) {}

  /**
   * Start the engine on one track and wait until it is actually sounding.
   *
   * Nothing is handed back before the engine says it is playing the URI it was given: a run that
   * is still logging in has no audio to take, and a run that came up on something else is not this
   * track at all.
   */
  public static async start(params: {
    zoneId: number;
    uri: string;
    accountId: string;
    apiKey: string;
    deviceName: string;
    lossless: boolean;
    normalize: boolean;
    seekPositionMs: number;
    env: Record<string, string>;
    onEnd: (end: TrackRunEnd) => void;
  }): Promise<TrackRunStart> {
    const { zoneId, uri, accountId, apiKey, deviceName, seekPositionMs } = params;
    if (!accountId) {
      return { ok: false, failure: 'no_account' };
    }
    const store = accountStore(accountId);
    if (!(await hasStoredSession(store))) {
      // Said here rather than found out later: a run on a store with no session does not fail, it
      // advertises itself and waits for someone who is never coming.
      return { ok: false, failure: 'no_session' };
    }
    // The engine reads these at startup only, so they are stated again for every track.
    await applyPreferences(store, { lossless: params.lossless, normalize: params.normalize });

    let wsPort: number;
    try {
      wsPort = await reserveWsPort();
    } catch {
      return { ok: false, failure: 'no_port' };
    }

    const handle = startSingleTrack({
      zoneId,
      store,
      uri,
      apiKey,
      deviceName,
      wsPort,
      env: params.env,
    });

    const ws = new SoloistWsClient(zoneId, wsPort);
    /**
     * Give up on this run, and do not leave its store locked behind.
     *
     * The waiting matters as much as the reason: the lock outlives the kill, so a caller that tries
     * again straight away — the next track, or the same one — would be refused the directory rather
     * than told what actually went wrong the first time.
     *
     * The reason itself comes from the engine's own output where there is one: a store another
     * process holds and a session that is no longer there both look like an ordinary failure to
     * start otherwise.
     */
    const fail = async (failure: TrackRunFailure): Promise<TrackRunStart> => {
      handle.stop();
      ws.close();
      const fault = handle.fault();
      await Promise.race([
        handle.done,
        new Promise((resolve) => {
          const timer = setTimeout(resolve, STORE_RELEASE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      return {
        ok: false,
        failure: fault === 'unpaired' ? 'no_session' : (fault ?? failure),
      };
    };

    if (!(await ws.connect(START_TIMEOUT_MS))) {
      return fail('no_start');
    }
    if (!(await ws.waitUntilReady(START_TIMEOUT_MS))) {
      return fail('no_start');
    }

    const run = new SoloistTrackRun(zoneId, uri, accountId, handle, ws, params.onEnd);
    const playing = run.waitForPlaying();
    if (!(await playing)) {
      return fail('no_start');
    }
    if (seekPositionMs > 0 && !(await run.coldSeek(seekPositionMs))) {
      return fail('no_seek');
    }

    // Only now is what the engine renders this track's audio, so only now does anything listen to
    // what it reports.
    run.watch();
    log.info('soloist is playing a track for this zone', { zoneId, uri, accountId });
    return { ok: true, run };
  }

  public pause(): void {
    this.ws.pause();
  }

  public resume(): void {
    this.ws.resume();
  }

  public seek(positionMs: number): void {
    this.ws.seek(positionMs);
  }

  /** Where the engine last reported itself, for a caller that has to answer for the room. */
  public get positionMs(): number {
    return this.position;
  }

  /**
   * Put the run down, and answer when its store is free again.
   *
   * The waiting is the point. A data directory holds a lock, so the next track cannot start until
   * this process is actually gone — and killing it is not the same as it having gone. Measured: a
   * replacement spawned straight after a kill is refused outright, which is what a skip looks like
   * from the room. Bounded, because a process that will not die must not hold a room forever;
   * past the budget the next run reports the store as busy, which at least says what happened.
   */
  public stop(reason: TrackRunEnd['reason'] = 'stopped'): Promise<void> {
    if (!this.ended) {
      this.ended = true;
      this.ws.close();
      this.handle.stop();
      this.onEnd({ reason } as TrackRunEnd);
    }
    return this.exited();
  }

  /** Resolves when the process exits, however long that takes. */
  public get gone(): Promise<void> {
    return this.handle.done.then(() => undefined);
  }

  /** Resolves once the process is gone, so its store can be used again. */
  public exited(): Promise<void> {
    return Promise.race([
      this.handle.done.then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STORE_RELEASE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  }

  /**
   * Wait until the engine reports it is playing the track it was given.
   *
   * A `playing` without a URI is taken as ours: the engine sends its status and its item on
   * separate reports, and in single-track mode there is nothing else it could be playing.
   */
  private waitForPlaying(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.ws.off('event', onEvent);
        clearTimeout(timer);
        resolve(ok);
      };
      const onEvent = (event: SoloistStateEvent): void => {
        this.readActions(event);
        const uri = event.item?.uri;
        if (uri && uri !== this.uri) {
          // The engine came up on something else entirely. In single-track mode that only happens
          // when the account is already playing elsewhere, and Spotify hands a run the account's
          // current track rather than the one it was started on.
          log.warn('soloist started on another track; the account is playing elsewhere', {
            zoneId: this.zoneId,
            wanted: this.uri,
            got: uri,
          });
          finish(false);
          return;
        }
        if (typeof event.position?.position_ms === 'number') {
          this.position = event.position.position_ms;
        }
        if (event.status === 'playing') {
          finish(true);
        }
      };
      // A run that exits before it plays has failed, whatever its exit code says; waiting out the
      // whole budget for a process that is already gone helps nobody.
      const onExit = (): void => finish(false);
      void this.handle.done.then(onExit, () => undefined);
      const timer = setTimeout(() => finish(false), START_TIMEOUT_MS);
      this.ws.on('event', onEvent);
    });
  }

  /** Note what Spotify will accept right now, which changes within a second of a track starting. */
  private readActions(event: SoloistStateEvent): void {
    if (event.available_actions) {
      this.seekAllowed = Object.prototype.hasOwnProperty.call(event.available_actions, 'seek');
    }
  }

  /**
   * Move the engine to where the room wants to start, before any of it is taken.
   *
   * The waiting is not a guess. A track that has only just begun does not accept a seek at all —
   * it comes back `seek_to_restricted` — and the engine says so itself: `seek` is absent from
   * `available_actions` and joins it about three hundred milliseconds later. So the position is
   * asked for once the engine will take it, rather than re-sent into a refusal.
   */
  private async coldSeek(targetMs: number): Promise<boolean> {
    if (!(await this.waitForSeekAllowed())) {
      log.warn('spotify would not allow seeking into this track', {
        zoneId: this.zoneId,
        uri: this.uri,
        targetMs,
      });
      return false;
    }
    this.ws.seek(targetMs);
    if (await this.waitForPosition(targetMs - SEEK_GRACE_MS, SEEK_CONFIRM_TIMEOUT_MS)) {
      return true;
    }
    log.warn('soloist did not confirm seeking to the requested position', {
      zoneId: this.zoneId,
      uri: this.uri,
      targetMs,
    });
    return false;
  }

  private waitForSeekAllowed(): Promise<boolean> {
    if (this.seekAllowed) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        this.ws.off('event', onEvent);
        resolve(ok);
      };
      const onEvent = (event: SoloistStateEvent): void => {
        this.readActions(event);
        if (this.seekAllowed) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), SEEK_ALLOWED_TIMEOUT_MS);
      this.ws.on('event', onEvent);
    });
  }

  private waitForPosition(atLeastMs: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        this.ws.off('event', onEvent);
        resolve(ok);
      };
      const onEvent = (event: SoloistStateEvent): void => {
        const positionMs = event.position?.position_ms;
        if (typeof positionMs !== 'number') {
          return;
        }
        this.position = positionMs;
        if (positionMs >= atLeastMs) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.ws.on('event', onEvent);
    });
  }

  /**
   * Follow the run to its end.
   *
   * Three ways out, and none of them is a guess. The process exits when the track is done. A
   * foreign track appearing is the engine wandering into a recommendation of its own in the
   * instant before it goes — the track is over either way, and saying so now saves the room the
   * moment of somebody else's music. And a device that stops being the active one has had the
   * account taken by another player, which no amount of waiting will give back.
   */
  private watch(): void {
    void this.handle.done.then((code) => {
      if (this.ended) {
        return;
      }
      this.ended = true;
      this.ws.close();
      if (code === 0 || code === null) {
        this.onEnd({ reason: 'ended' });
        return;
      }
      const fault = this.handle.fault();
      log.warn('the soloist run for this track stopped', { zoneId: this.zoneId, code, fault });
      this.onEnd({ reason: 'failed', detail: fault ?? `exit ${code}` });
    });

    this.ws.on('event', (event: SoloistStateEvent) => {
      if (this.ended) {
        return;
      }
      this.readActions(event);
      if (typeof event.position?.position_ms === 'number') {
        this.position = event.position.position_ms;
      }
      const uri = event.item?.uri;
      if (uri && uri !== this.uri) {
        log.debug('the engine wandered off; this track is over', {
          zoneId: this.zoneId,
          uri: this.uri,
          wentTo: uri,
        });
        void this.stop('ended');
        return;
      }
      if (event.is_active === true) {
        this.wasActive = true;
        return;
      }
      // Only a `device_changed` is a device changing hands. Every other report carries the flag as
      // well — auth and playback states included — and theirs says what the device was when the
      // report was assembled, which during startup is "not yet".
      if (event.type === 'device_changed' && event.is_active === false && this.wasActive) {
        log.info('spotify gave the account to another player; this track stops', {
          zoneId: this.zoneId,
          accountId: this.accountId,
        });
        void this.stop('taken');
      }
    });
  }
}
