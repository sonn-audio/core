import assert from 'node:assert/strict';
import { test } from './testHarness';
import { executePlaybackPlan } from '../src/application/playback/executePlaybackPlan';
import { resolveSpotifyAccountId } from '../src/application/zones/helpers/queueHelpers';
import type { PlaybackPlan } from '../src/application/playback/types/PlaybackPlan';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ContentPort } from '../src/ports/ContentPort';
import type { InputsPort } from '../src/ports/InputsPort';
import type { QueueItem } from '../src/ports/types/queueTypes';

// The queue stores Spotify rows normalized (`spotify:track:…`), so the account that the content
// layer resolved (`spotify@AccountB:…`) survives only in the row's `user`. Playback used to read
// the audiopath alone, which left the input to pick its default account: a second account's track
// played — and locked — the first account's Soloist store (#377).

// ── the helper ───────────────────────────────────────────────────────────────

test('the account in the audiopath wins, since a raw request carries the truth', () => {
  assert.equal(resolveSpotifyAccountId('spotify@AccountB:track:abc', 'AccountA'), 'AccountB');
});

test('a normalized audiopath falls back to the account the queue row kept', () => {
  assert.equal(resolveSpotifyAccountId('spotify:track:abc', 'AccountB'), 'AccountB');
});

test('nothing named leaves the account unset, never the literal nouser', () => {
  assert.equal(resolveSpotifyAccountId('spotify:track:abc', 'nouser'), undefined);
  assert.equal(resolveSpotifyAccountId('spotify:track:abc'), undefined);
});

// ── the path that broke ──────────────────────────────────────────────────────

const queueRow = (audiopath: string, user: string): QueueItem =>
  ({
    album: '',
    artist: '',
    audiopath,
    audiotype: 5,
    coverurl: '',
    duration: 0,
    qindex: 0,
    station: '',
    title: 'Track',
    unique_id: 'q1',
    user,
  }) as QueueItem;

function spotifyZone(items: QueueItem[], currentIndex: number): ZoneContext {
  const ctx = {
    id: 7,
    name: 'Kitchen',
    queue: { items },
    queueController: {
      current: () => items[currentIndex] ?? null,
      currentIndex: () => currentIndex,
    },
    player: {
      playExternal: () => ({ zoneId: 7 }),
    },
  } as unknown as ZoneContext;
  return ctx;
}

const spotifyPlan = (audiopath: string): PlaybackPlan => ({
  zoneId: 7,
  zoneName: 'Kitchen',
  audiopath,
  kind: 'queue',
  isRadio: false,
  provider: null,
  playExternalLabel: 'spotify',
  needsStreamResolution: true,
  metadata: { title: 'Track', artist: '', album: '' },
  preferredSettings: { outputOverride: null },
});

async function accountUsedFor(items: QueueItem[], currentIndex: number, audiopath: string) {
  let seen: string | undefined | 'unset' = 'unset';
  const inputs = {
    getPlaybackSourceForUri: async (_zoneId: number, _uri: string, _seek: number, accountId?: string) => {
      seen = accountId;
      return { kind: 'pipe' };
    },
  } as unknown as InputsPort;
  await executePlaybackPlan({
    ctx: spotifyZone(items, currentIndex),
    plan: spotifyPlan(audiopath),
    content: {} as ContentPort,
    inputs,
    log: { debug: () => undefined, warn: () => undefined } as never,
    zoneAudioPrefs: {
      setPreferredOutputSettings: () => undefined,
      setHttpPreferences: () => undefined,
      setInputPreferences: () => undefined,
    } as never,
  });
  return seen;
}

test('a normalized queue row plays from the account the row names', async () => {
  const items = [queueRow('spotify:track:abc', 'AccountB')];
  assert.equal(await accountUsedFor(items, 0, 'spotify:track:abc'), 'AccountB');
});

test('a fast start ahead of the rebuild finds its row by audiopath, not by index', async () => {
  // The queue is still on the previous track; answering from the current index would name
  // AccountA for a track that belongs to AccountB.
  const items = [queueRow('spotify:track:old', 'AccountA'), queueRow('spotify:track:abc', 'AccountB')];
  assert.equal(await accountUsedFor(items, 0, 'spotify:track:abc'), 'AccountB');
});

test('a row with no account of its own leaves the input to choose', async () => {
  const items = [queueRow('spotify:track:abc', 'nouser')];
  assert.equal(await accountUsedFor(items, 0, 'spotify:track:abc'), undefined);
});
