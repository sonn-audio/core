import type { SoloistBinaryStatus } from '@/ports/SoloistAdminPort';
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '@/shared/logging/logger';
import { resolveDataDir } from '@/shared/utils/file';

const log = createLogger('Audio', 'SoloistProcess');

/**
 * A free port for one zone's control channel, from the only authority on what is free.
 *
 * Bound and released again rather than held: the point is to be told a number nothing else is
 * using, and Soloist has to be the one listening on it. That leaves a moment in which something
 * else could take it, in which case the process starts, the connection is refused for the whole
 * attempt window, and the zone tries again on a fresh number the next time it plays.
 */
export function reserveWsPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Where the user's own Soloist build lives. Never shipped — Spotify forbids redistributing it. */
export function soloistBinaryPath(): string {
  return resolveDataDir('soloist', 'soloist');
}

/**
 * Where one Soloist keeps its identity, its session and its cache.
 *
 * A data directory holds a lock, so it is what makes two Soloists two: one instance per store, and
 * a second on the same store refuses to start. That is why there are two kinds of store rather
 * than one per room.
 */
export type SoloistStore = { data: string; cache: string };

/**
 * The store behind a room's Connect device.
 *
 * Nothing here is ever signed in by this server. The daemon advertises itself and waits, and
 * whoever picks the room in their own Spotify app is the one who signs it in — so a room is
 * everybody's, and the account that owns it is simply whoever took it last. It keeps whatever
 * session that leaves behind, which is why it is a store and not a scratch directory.
 */
export function zoneStore(zoneId: number): SoloistStore {
  return {
    data: resolveDataDir('soloist', `zone-${zoneId}`, 'data'),
    cache: resolveDataDir('soloist', `zone-${zoneId}`, 'cache'),
  };
}

/**
 * The store behind one Spotify account, for playback this server drives.
 *
 * Per account rather than per room, because a `--single-track` run does not advertise itself:
 * there is nobody to pick it, so its credentials have to be there already. One store per account
 * is also exactly enough — the lock allows one run at a time, which is the same one stream at a
 * time that Spotify allows an account anyway.
 */
export function accountStore(accountId: string): SoloistStore {
  const safe = accountId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'default';
  return {
    data: resolveDataDir('soloist', `account-${safe}`, 'data'),
    cache: resolveDataDir('soloist', `account-${safe}`, 'cache'),
  };
}

/**
 * The refresh token a session is actually restored from.
 *
 * Under the data directory rather than the cache directory it is named after, whatever `-C` says —
 * measured, and the engine names this path itself when the file is empty: "Refresh token storage
 * error: … Token storage file has no contents".
 */
const TOKEN_STORE = ['cache', 'dbrts'];

/**
 * Where a pairing is signed in, before it is allowed anywhere near the store that plays.
 *
 * Separate because `--pair` starts by throwing away whatever session the store it is pointed at
 * already holds — it says so itself: "cleared existing session before pairing". Pointed at the
 * playing store, a re-pairing that nobody completes would therefore sign the account out, and the
 * room would stop playing because somebody pressed a button and then changed their mind.
 */
export function accountPairingStore(accountId: string): SoloistStore {
  const canonical = accountStore(accountId);
  return {
    data: path.join(path.dirname(canonical.data), 'pairing', 'data'),
    cache: path.join(path.dirname(canonical.data), 'pairing', 'cache'),
  };
}

/**
 * Move a completed pairing into place, and only then.
 *
 * Staged first, swapped after: the store that plays is replaced by one that is already known to
 * hold a session, so an interrupted copy cannot leave a room with half a login. The old one is
 * kept aside until the new one is in place, and only then dropped.
 */
export async function promotePairedStore(accountId: string): Promise<void> {
  const staged = accountPairingStore(accountId);
  const canonical = accountStore(accountId);
  const previous = `${canonical.data}.previous`;
  await fsp.rm(previous, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(canonical.data), { recursive: true });
  if (await exists(canonical.data)) {
    await fsp.rename(canonical.data, previous);
  }
  try {
    await fsp.rename(staged.data, canonical.data);
  } catch (error) {
    // Put back what was working rather than leave the account with nothing.
    if (await exists(previous)) {
      await fsp.rename(previous, canonical.data);
    }
    throw error;
  }
  await fsp.rm(previous, { recursive: true, force: true });
  // The cache is rebuilt on demand and holds nothing worth carrying over, but it must not be the
  // old account's: it is where the engine keeps its own copy of the token store.
  await fsp.rm(canonical.cache, { recursive: true, force: true });
  await fsp.rm(path.dirname(staged.data), { recursive: true, force: true });
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a store holds a session that can be restored without anyone picking anything.
 *
 * `settings/Users/<account>` is what a completed login leaves behind — `settings` alone appears
 * earlier, so the users directory is the honest first test. But the thing a run actually restores
 * from is the refresh token, and the two can come apart: a cleared cache leaves the user directory
 * standing, and the run then refuses with "requires stored credentials" for a store that looks
 * signed in. So an empty token store counts as not signed in, while a token store that is missing
 * entirely is left to the users directory — a layout that moves in some later build should not
 * refuse playback that would have worked.
 *
 * Worth being sure of, because the alternative way to find out is bad: a room's daemon does not
 * fail on a store with no session, it advertises itself and waits for somebody who is never coming.
 */
export async function hasStoredSession(store: SoloistStore): Promise<boolean> {
  try {
    const users = await fsp.readdir(path.join(store.data, 'settings', 'Users'));
    if (users.length === 0) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const token = await fsp.stat(path.join(store.data, ...TOKEN_STORE));
    return token.size > 0;
  } catch {
    return true;
  }
}

/** Which account a store is signed in as, as Spotify spells it. Empty when nobody is. */
async function storedAccounts(store: SoloistStore): Promise<string[]> {
  try {
    return await fsp.readdir(path.join(store.data, 'settings', 'Users'));
  } catch {
    return [];
  }
}

/**
 * The Spotify user id a store is signed in as, spelled the way Spotify spells it.
 *
 * Soloist names the directory after the id with `-user` appended, percent-encoded: `düth` lands on
 * disk as `d%C3%BCth`. Compared as it stands, the right account reads as somebody else.
 */
export async function signedInSpotifyId(store: SoloistStore): Promise<string | undefined> {
  const [dir] = await storedAccounts(store);
  if (!dir) {
    return undefined;
  }
  const encoded = dir.replace(/-user$/, '');
  try {
    return decodeURIComponent(encoded).normalize('NFC');
  } catch {
    // Not valid percent-encoding, so not encoded at all — a name with a bare `%` in it.
    return encoded.normalize('NFC');
  }
}

/** Spotify gives a build ninety days, then it exits with code 10 whatever else is right. */
export const SOLOIST_BUILD_LIFETIME_DAYS = 90;

/**
 * The engine's audio behaviour, and the only way in.
 *
 * There is no flag and no command for any of this: Soloist reads the classic desktop client's
 * plain `key=value` prefs stores, and only at startup, so they are rewritten before every spawn.
 *
 * Two stores, not one. A per-user file overrides the global file key by key, and a per-user file
 * only exists once an account has actually signed in — so the global one is what covers a store's
 * first session, and the per-user ones are what stop a stale value from a previous session
 * winning afterwards.
 */
const PREF_QUALITY_METERED = 'audio.play_bitrate_enumeration';
const PREF_QUALITY = 'audio.play_bitrate_non_metered_enumeration';
/**
 * The marker that makes the non-metered tier count.
 *
 * Without it the engine derives the non-metered value from the metered one once and ignores what
 * we wrote, which is silent: nothing reports the tier, so the room simply plays at Spotify's
 * default while the screen says lossless. Both keys and this marker, or none of it means anything.
 */
const PREF_QUALITY_MIGRATED = 'audio.play_bitrate_non_metered_migrated';
/** 5 is the ceiling: lossless FLAC. Outside 1-5 the engine falls back to about 160 kbps. */
const QUALITY_LOSSLESS = '5';
/** Spotify's own "Automatic", which is what it does when nothing says otherwise. */
const QUALITY_AUTOMATIC = '4';
const PREF_NORMALIZE = 'audio.normalize_v2';
const PREF_CROSSFADE = 'audio.crossfade_v2';
/** Milliseconds. Anything under a second silently disables crossfade rather than shortening it. */
const PREF_CROSSFADE_TIME = 'audio.crossfade.time_v2';

/**
 * Autoplay, asked to be off — and it is not.
 *
 * Left on, Soloist reaches the end of a track and starts recommending, which is Spotify deciding
 * what a room plays. Writing this is what the setting is for, and it is written in the form
 * Soloist writes its own booleans, in the file it keeps them in. Measured: it carries on anyway.
 *
 * So the preference stays — it costs nothing and states the intent, and a later build may honour
 * it — but nothing depends on it. What actually keeps a room quiet is that a `--single-track` run
 * ends with the track: whatever the engine wanders into afterwards, the process is already going.
 */
const AUTOPLAY_PREF = 'player.autoplay';

const MANAGED_PREFS = [
  PREF_QUALITY_METERED,
  PREF_QUALITY,
  PREF_QUALITY_MIGRATED,
  PREF_NORMALIZE,
  PREF_CROSSFADE,
  PREF_CROSSFADE_TIME,
  AUTOPLAY_PREF,
];

/**
 * State the engine's audio behaviour, in every store that can decide it.
 *
 * Crossfade is off on purpose rather than by default: this server mixes its own, so a track has to
 * arrive whole and start on its first sample — anything the engine faded would be faded twice and
 * would no longer line up with what the room was told is playing.
 */
export async function applyPreferences(
  store: SoloistStore,
  options: { lossless: boolean; normalize: boolean },
): Promise<void> {
  const quality = options.lossless ? QUALITY_LOSSLESS : QUALITY_AUTOMATIC;
  const managed = [
    `${PREF_QUALITY_METERED}=${quality}`,
    `${PREF_QUALITY}=${quality}`,
    `${PREF_QUALITY_MIGRATED}=true`,
    `${PREF_NORMALIZE}=${options.normalize ? 'true' : 'false'}`,
    `${PREF_CROSSFADE}=false`,
    `${AUTOPLAY_PREF}=false`,
  ];
  const settingsDir = path.join(store.data, 'settings');
  const files = [path.join(settingsDir, 'prefs')];
  try {
    const usersDir = path.join(settingsDir, 'Users');
    for (const account of await fsp.readdir(usersDir)) {
      files.push(path.join(usersDir, account, 'prefs'));
    }
  } catch {
    // No account has signed in yet, so the global store is the only one there is — and the only
    // one that can decide the first session.
  }
  for (const file of files) {
    let kept: string[] = [];
    try {
      kept = (await fsp.readFile(file, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() && !MANAGED_PREFS.some((key) => line.startsWith(`${key}=`)));
    } catch {
      // A store that has never been written yet; the engine's own keys arrive when it starts.
    }
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      // Replace rather than truncate: the store also holds keys that belong to the engine, and a
      // half-written file loses those as well as ours.
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, `${[...kept, ...managed].join('\n')}\n`, 'utf8');
      await fsp.rename(tmp, file);
    } catch (error) {
      log.warn('could not state soloist audio settings', {
        file,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log.debug('soloist preferences applied', { store: store.data, quality, normalize: options.normalize });
}

/**
 * Soloist buffers stdout when it is not attached to a terminal, so its own log file is the only
 * place its lines reliably appear. Everything here reads that file rather than the pipe.
 */
function logPathFor(zoneId: number | 'probe' | 'pair'): string {
  return resolveDataDir('soloist', `soloist-${zoneId}.log`);
}

const EXPIRY_RE = /client expires in (\d+) days/i;
const VERSION_RE = /^soloist ([^\s]+)/im;
/**
 * `soloist 1.3.7.150 build 1786723306 (20260814) …` — the epoch seconds it was built.
 *
 * Reading it means the expiry is known the moment the file is uploaded, rather than only after
 * something has played and Soloist has said so itself on its way up.
 */
const BUILD_STAMP_RE = /\bbuild (\d{10})\b/;
/** Soloist exits with 10 when its build has passed the 90-day mark. Worth naming, not guessing. */
export const SOLOIST_EXIT_EXPIRED = 10;
/**
 * How much audio a store may keep, in MB.
 *
 * Stated for every run, because Soloist's own default is no limit at all: a room that has been
 * played through for a year has a year of audio in its cache, on whatever disk this server was
 * installed on. 512 is enough that a track put on twice does not fetch twice and small enough that
 * a dozen rooms cannot fill a card. The floor Soloist accepts is 100.
 */
const CACHE_LIMIT_MB = '512';

export async function probeBinary(): Promise<SoloistBinaryStatus> {
  const binary = soloistBinaryPath();
  try {
    const stat = await fsp.stat(binary);
    if (!stat.isFile()) {
      return { present: false, executable: false };
    }
  } catch {
    return { present: false, executable: false };
  }
  try {
    await fsp.access(binary, (await import('node:fs')).constants.X_OK);
  } catch {
    return { present: true, executable: false, error: 'not_executable' };
  }
  const output = await runToCompletion(binary, ['--version'], {}, 8000);
  const version = VERSION_RE.exec(output.text)?.[1];
  const builtAt = Number(BUILD_STAMP_RE.exec(output.text)?.[1] ?? 0);
  if (!builtAt) {
    return { present: true, executable: true, version };
  }
  const expiresAt = (builtAt + SOLOIST_BUILD_LIFETIME_DAYS * 86_400) * 1000;
  return {
    present: true,
    executable: true,
    version,
    expiresAt,
    expiresInDays: Math.floor((expiresAt - Date.now()) / 86_400_000),
  };
}

async function runToCompletion(
  binary: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    let text = '';
    let child: ChildProcess;
    try {
      child = spawn(binary, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: null, text: error instanceof Error ? error.message : String(error) });
      return;
    }
    const collect = (chunk: Buffer): void => {
      text += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, text: `${text}\n${error.message}` });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
}

/**
 * Why a run ended, in the engine's own words.
 *
 * Two of these are the only report Soloist gives of the thing that happened, and both look like an
 * ordinary startup failure from outside: a store whose lock another process holds, and a store
 * with no session left to restore — which does not fail at all, it advertises itself and waits.
 */
export type SoloistRunFault = 'store_busy' | 'unpaired' | 'expired';

/** The engine allows one instance per data directory and says so before exiting with a plain 1. */
const STORE_BUSY_MARKER = /another session is running|cannot lock data directory/i;
/**
 * A store with no session left, in the engine's own words.
 *
 * Two forms, because the two shapes fail differently. A `--single-track` run says so outright and
 * exits at once — measured on 1.3.8.12: `--single-track requires stored credentials — run with
 * --pair first`. A room's daemon does not fail at all: it falls back to advertising itself and
 * waits, which from outside is indistinguishable from a slow start until the budget runs out.
 */
const UNPAIRED_MARKER = /waiting for login|requires stored credentials/i;

export type SoloistRunHandle = {
  /** Resolves with the exit code once the track is done and the process has gone. */
  done: Promise<number | null>;
  stop: () => void;
  /** Days left, once the startup line has been seen. */
  expiresInDays: Promise<number | undefined>;
  /** What the engine's own output said was wrong, as soon as it said it. */
  fault: () => SoloistRunFault | null;
};

/**
 * Run a room's Connect device, for as long as the room exists.
 *
 * Never signed in from here. It advertises itself and waits, and whoever picks the room in their
 * Spotify app is the one who signs it in — which is why this takes no account and no session: a
 * room belongs to whoever took it last, and the next person takes it from them the same way. It
 * never plays this server's queue; that is what {@link startSingleTrack} is for.
 */
/**
 * A note on the key, which every argument list below carries.
 *
 * Soloist takes it only as `--api-key`: there is no environment variable and no file it will read
 * one from, so it is visible in `/proc/<pid>/cmdline` to any local user for as long as a room is
 * up. Nothing here writes it anywhere else — not to a log, not to a unit, not into the diagnostics
 * the admin screen can export — and outside the process table it stays in the config. HiFiBerry's
 * own wrapper documents the same exposure as an accepted risk for the same reason.
 */
export function startPersistent(params: {
  zoneId: number;
  apiKey: string;
  deviceName: string;
  wsPort: number;
  env: Record<string, string>;
  onLine?: (line: string) => void;
}): SoloistRunHandle {
  const { zoneId, apiKey, deviceName, wsPort, env, onLine } = params;
  const store = zoneStore(zoneId);
  const args = [
    '-n', deviceName,
    '-k', apiKey,
    '-D', store.data,
    '-C', store.cache,
    // A port of our own choosing rather than 0. Asking Soloist to pick one is what its help
    // suggests, and on 1.3.7.276 it then listens on the port it picked but publishes only
    // `ws.addr` — the address without the number — so nothing can find it: `soloist ctl status`
    // says "ws: not available" about the daemon's own socket. Given an explicit port it writes
    // both files and answers on it, which is measurable, so we name the port and skip the
    // discovery. Zones still cannot collide: each one is handed a free port before it starts.
    '-w', `127.0.0.1:${wsPort}`,
    // A room's daemon caches whatever the app plays through it, for as long as the room exists —
    // which with Soloist's default of no limit is everything, forever.
    '-z', CACHE_LIMIT_MB,
    // The level this device advertises in the Spotify app until the room says otherwise, which it
    // does as soon as the daemon has signed in. A label rather than a taper: Soloist applies no
    // volume itself but passes it to the sound server, and ours records the level and hands the
    // samples on untouched — measured, see `SoloistWsClient.setVolume`. 100 rather than Soloist's
    // default of 40 because a device that has attenuated nothing should not claim it has.
    '-i', '100',
  ];
  return runTracked(zoneId, args, env, 'connect', onLine);
}

/**
 * Play exactly one track from one account's store, and be gone.
 *
 * The whole reason this shape exists: the run ends when the track ends, so the end of a track is a
 * process exiting rather than something to be inferred from events that mean two things. It
 * advertises nothing, starts with shuffle and repeat off, and cannot be taken over — and because
 * the account is a directory rather than a session to be switched, playing from a different
 * account is nothing more than starting from a different one.
 */
export function startSingleTrack(params: {
  /** For the log file only; a run belongs to the room it is sounding in. */
  zoneId: number;
  store: SoloistStore;
  uri: string;
  apiKey: string;
  deviceName: string;
  wsPort: number;
  env: Record<string, string>;
  onLine?: (line: string) => void;
}): SoloistRunHandle {
  const { zoneId, store, uri, apiKey, deviceName, wsPort, env, onLine } = params;
  const args = [
    '-s', uri,
    // Required even here, where nothing is ever advertised under it.
    '-n', deviceName,
    '-k', apiKey,
    '-D', store.data,
    '-C', store.cache,
    // Bounded rather than the default of no limit: this store is written to on every track.
    '-z', CACHE_LIMIT_MB,
    '-w', `127.0.0.1:${wsPort}`,
    // Nothing advertises this run, so the number is never seen by anybody; full scale is simply
    // what it is true to say about a run that attenuates nothing.
    '-i', '100',
  ];
  return runTracked(zoneId, args, env, 'track', onLine);
}

/**
 * Sign an account's store in, once.
 *
 * `--pair` is Soloist advertising itself under a name, waiting for someone to pick it in their
 * Spotify app, storing what that hands it, and exiting. The same handshake a room goes through,
 * except that here it is done deliberately and the credentials it leaves behind are the whole
 * point — a `--single-track` run advertises nothing, so there is nobody to ask at play time.
 */
export function startPairing(params: {
  store: SoloistStore;
  apiKey: string;
  deviceName: string;
  onLine?: (line: string) => void;
}): SoloistRunHandle {
  const { store, apiKey, deviceName, onLine } = params;
  const args = [
    '-p',
    '-n', deviceName,
    '-k', apiKey,
    '-D', store.data,
    '-C', store.cache,
  ];
  return runTracked('pair', args, {}, 'pair', onLine);
}

function runTracked(
  zoneId: number | 'pair',
  args: string[],
  env: Record<string, string>,
  what: string,
  onLine?: (line: string) => void,
): SoloistRunHandle {
  let fault: SoloistRunFault | null = null;
  const binary = soloistBinaryPath();
  let resolveExpiry: (value: number | undefined) => void = () => undefined;
  const expiresInDays = new Promise<number | undefined>((resolve) => {
    resolveExpiry = resolve;
  });

  let child: ChildProcess | null = null;
  const done = new Promise<number | null>((resolve) => {
    try {
      child = spawn(binary, args, {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('soloist could not be started', { zoneId, what, message });
      resolveExpiry(undefined);
      resolve(null);
      return;
    }

    const logPath = logPathFor(zoneId);
    const lines: string[] = [];
    const onOutput = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      lines.push(text);
      const expiry = EXPIRY_RE.exec(text);
      if (expiry?.[1]) {
        resolveExpiry(Number(expiry[1]));
      }
      // Read from the output because there is nowhere else to read it: both of these end the run
      // with a plain exit code that says nothing, and one of them does not end it at all.
      if (!fault && STORE_BUSY_MARKER.test(text)) {
        fault = 'store_busy';
      }
      if (!fault && UNPAIRED_MARKER.test(text)) {
        fault = 'unpaired';
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          log.debug('soloist', { zoneId, line: trimmed.slice(0, 300) });
          onLine?.(trimmed);
        }
      }
    };
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onOutput);

    child.on('error', (error) => {
      log.warn('soloist failed', { zoneId, what, message: error.message });
      resolveExpiry(undefined);
      resolve(null);
    });
    child.on('exit', (code) => {
      resolveExpiry(undefined);
      if (code === SOLOIST_EXIT_EXPIRED) {
        fault = 'expired';
        log.error('this Soloist build has expired; a newer one is fetched before the next track', {
          zoneId,
        });
      }
      // Keep the tail on disk: without a terminal Soloist buffers, so this is the only record of
      // what it said when something goes wrong.
      void fsp
        .writeFile(logPath, lines.join('').slice(-64_000), 'utf8')
        .catch(() => undefined);
      log.debug('soloist exited', { zoneId, what, code });
      resolve(code);
    });
  });

  return {
    done,
    expiresInDays,
    fault: () => fault,
    stop: () => {
      if (child && child.exitCode === null) {
        child.kill();
      }
    },
  };
}

export function soloistLogPath(zoneId: number): string {
  return path.resolve(logPathFor(zoneId));
}
