import assert from 'node:assert/strict';
import { test } from './testHarness';
import { resolveTrackPosition } from '../src/adapters/content/providers/trackPosition';

test('track position: tags win over the path', () => {
  assert.deepEqual(resolveTrackPosition({ disc: 2, track: 7 }, 'Artist/Album/01 - Song.flac'), { disc: 2, track: 7 });
});

test('track position: a leading number in the file name is the track', () => {
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/03 - Song.flac'), { disc: 0, track: 3 });
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/12. Song.mp3'), { disc: 0, track: 12 });
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/7-Song.mp3'), { disc: 0, track: 7 });
});

test('track position: digit, dash, two digits is disc and track', () => {
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/2-07 Song.flac'), { disc: 2, track: 7 });
});

test('track position: the folder names the disc', () => {
  assert.deepEqual(resolveTrackPosition({ track: 4 }, 'Artist/Album/CD2/Song.flac'), { disc: 2, track: 4 });
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/Disc 1/05 Song.flac'), { disc: 1, track: 5 });
});

test('track position: a year or a title is not a track number', () => {
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/1999.flac'), { disc: 0, track: 0 });
  assert.deepEqual(resolveTrackPosition({}, 'Artist/Album/Song.flac'), { disc: 0, track: 0 });
  assert.deepEqual(resolveTrackPosition({ disc: 0, track: 0 }, 'Song.flac'), { disc: 0, track: 0 });
});
