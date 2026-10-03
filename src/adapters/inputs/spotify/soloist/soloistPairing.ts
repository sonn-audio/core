import type { SoloistPairingState } from '@/ports/SoloistAdminPort';
import { createLogger } from '@/shared/logging/logger';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  accountPairingStore,
  hasStoredSession,
  promotePairedStore,
  signedInSpotifyId,
  startPairing,
} from '@/adapters/inputs/spotify/soloist/soloistProcess';

const log = createLogger('Content', 'SoloistPairing');

/** Long enough to find the room in the app and tap it, short enough not to advertise all day. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * How long a finished attempt is still reported.
 *
 * It is feedback on something somebody just did, not a state the account is in: kept for the screen
 * that asked, then gone. Left standing for ever, a re-pairing nobody completed would go on calling
 * a working account broken — the old session survives a failed attempt, so it plays perfectly well.
 */
const SETTLED_TTL_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

type Entry = SoloistPairingState & {
  handle?: { stop: () => void };
  /** Set when this server ended the wait, so the process going is not reported as a failure. */
  cancelled?: boolean;
  /** When the attempt finished, for the TTL above. */
  settledAt?: number;
};

const pairingByAccount = new Map<string, Entry>();

export function pairingSnapshot(accountId: string): SoloistPairingState | null {
  const entry = pairingByAccount.get(accountId);
  if (!entry) {
    return null;
  }
  if (entry.state !== 'pairing' && Date.now() - (entry.settledAt ?? 0) > SETTLED_TTL_MS) {
    pairingByAccount.delete(accountId);
    return null;
  }
  const { handle: _handle, cancelled: _cancelled, settledAt: _settledAt, ...state } = entry;
  return state;
}

/** Record when an attempt finished, which is what the TTL above is counted from. */
function settle(entry: Entry, state: SoloistPairingState['state']): void {
  entry.state = state;
  entry.settledAt = Date.now();
}

/**
 * Sign one account's playback store in, by asking someone to pick it in their Spotify app.
 *
 * The same handshake a room goes through, done on purpose and once: `--pair` advertises a device
 * under a name, waits for somebody to connect to it, keeps what that hands over and exits. What it
 * leaves behind is what every `--single-track` run of this account restores — those advertise
 * nothing, so there is nobody to ask at the moment a track has to start.
 *
 * Returns at once. Whether anyone has picked it yet is what {@link pairingSnapshot} is for.
 */
export async function startAccountPairing(params: {
  accountId: string;
  apiKey: string;
  deviceName: string;
  /**
   * Who this store is supposed to end up signed in as, when it is known.
   *
   * Nothing stops somebody signing the device in from the wrong Spotify app, and the result plays
   * perfectly — as the wrong account. A store that browses as one person and plays as another is
   * worse than one that is not signed in at all, because nothing about it looks wrong.
   */
  expectedSpotifyId?: string;
  timeoutMs?: number;
}): Promise<SoloistPairingState> {
  const { accountId, apiKey, deviceName } = params;
  const existing = pairingByAccount.get(accountId);
  if (existing?.state === 'pairing' && (existing.expiresAt ?? 0) > Date.now()) {
    return pairingSnapshot(accountId) as SoloistPairingState;
  }
  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    Math.min(MAX_TIMEOUT_MS, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  // Signed in beside the store that plays, never into it: `--pair` clears whatever session it
  // finds before it starts advertising, so a re-pairing nobody completes would otherwise sign the
  // account out of a room that was playing perfectly well.
  const store = accountPairingStore(accountId);
  const entry: Entry = {
    state: 'pairing',
    deviceName,
    expiresAt: Date.now() + timeoutMs,
  };
  pairingByAccount.set(accountId, entry);
  log.info('soloist account pairing started', { accountId, deviceName, timeoutMs });

  // A directory left behind by an attempt nobody finished has a device identity of its own and a
  // lock that may still be held; the next attempt starts from nothing.
  await fsp.rm(path.dirname(store.data), { recursive: true, force: true }).catch(() => undefined);
  const handle = startPairing({ store, apiKey, deviceName });
  entry.handle = handle;
  const giveUp = setTimeout(() => {
    if (entry.state !== 'pairing') {
      return;
    }
    // Nobody came. Ended here rather than left advertising: a device in the app that nothing is
    // waiting behind is worse than no device at all.
    handle.stop();
  }, timeoutMs);
  giveUp.unref?.();

  void handle.done.then(async (code) => {
    clearTimeout(giveUp);
    entry.handle = undefined;
    // The exit code is not the answer — a run told to stop exits the same way a paired one does.
    // What settles it is whether a session is there now, which is the thing being asked for.
    if (await hasStoredSession(store)) {
      const signedIn = (await signedInSpotifyId(store)) ?? '';
      const expected = params.expectedSpotifyId;
      if (expected && signedIn && !sameSpotifyUser(signedIn, expected)) {
        settle(entry, 'failed');
        entry.username = signedIn;
        entry.error = 'wrong_account';
        log.warn('soloist was signed in as somebody else', { accountId, signedIn, expected });
        return;
      }
      try {
        await promotePairedStore(accountId);
      } catch (error) {
        settle(entry, 'failed');
        entry.error = 'store_not_replaced';
        log.warn('soloist pairing could not replace the account store', {
          accountId,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      settle(entry, 'paired');
      entry.username = signedIn || undefined;
      log.info('soloist account paired', { accountId, username: signedIn });
      return;
    }
    // Nobody is going to finish this one, so the directory it was signing in to goes: it holds a
    // device identity of its own, and a lock that would have to be waited out.
    await fsp.rm(path.dirname(store.data), { recursive: true, force: true }).catch(() => undefined);
    if (entry.cancelled) {
      // Somebody pressed stop. Nothing went wrong, so nothing is reported as having gone wrong.
      settle(entry, 'idle');
      return;
    }
    settle(entry, 'failed');
    entry.error = handle.fault() ?? (code === null ? 'not_started' : 'no_session');
    log.warn('soloist account pairing produced no session', { accountId, code, error: entry.error });
  });

  return pairingSnapshot(accountId) as SoloistPairingState;
}

/** Spotify ids are matched without regard to case, and `ü` is `ü` however it was composed. */
function sameSpotifyUser(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase();
}

/** Give up on a pairing nobody is going to complete, so the device stops being offered. */
export function cancelAccountPairing(accountId: string): void {
  const entry = pairingByAccount.get(accountId);
  if (entry?.state !== 'pairing') {
    return;
  }
  entry.cancelled = true;
  entry.handle?.stop();
  entry.handle = undefined;
  settle(entry, 'idle');
  log.info('soloist account pairing cancelled', { accountId });
}
