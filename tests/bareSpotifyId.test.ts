import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  createQueueItem,
  normalizeSpotifyAudiopath,
  withSpotifyScheme,
} from '../src/application/zones/helpers/queueHelpers';

// #417. A zone's queue was left holding `track:11hcBLPtbMp4aQI6zGQLub` — a Spotify track id that
// had lost its `spotify:` scheme. Nothing could tell which service it belonged to, so every play of
// the zone failed on it with "no playback source resolved".

const ID = '11hcBLPtbMp4aQI6zGQLub';

test('a bare Spotify id gets its scheme back (#417)', () => {
  assert.equal(withSpotifyScheme(`track:${ID}`), `spotify:track:${ID}`);
  assert.equal(normalizeSpotifyAudiopath(`track:${ID}`), `spotify:track:${ID}`);
  assert.equal(normalizeSpotifyAudiopath(`episode:${ID}`), `spotify:episode:${ID}`);
  assert.equal(normalizeSpotifyAudiopath(`playlist:${ID}`), `spotify:playlist:${ID}`);
});

test('ids that are not Spotify-shaped are left alone', () => {
  for (const path of ['track:123', 'track:i.abc', `library:track:${ID}`, `applemusic:track:${ID}`, `spotify:track:${ID}`]) {
    assert.equal(withSpotifyScheme(path), path);
    assert.equal(normalizeSpotifyAudiopath(path), path);
  }
});

test('a queue row made from a bare id is a playable Spotify row on the default account', () => {
  const item = createQueueItem(`track:${ID}`, 'Sypialnia', { title: 'Song', artist: '', album: '' }, 5, 'acct-1');
  assert.equal(item.audiopath, `spotify:track:${ID}`);
  assert.equal(item.user, 'acct-1');
});
