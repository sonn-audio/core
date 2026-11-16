import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { LocalLibraryStore } from '../src/adapters/content/providers/localLibraryStore';

// Covers the three library-index bugs fixed together: album browse being served
// from a materialized rollup, accent-aware search, and rescan reconciliation that
// does not destroy a storage it cannot read.

async function withStore(fn: (store: LocalLibraryStore) => Promise<void> | void): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-rollup-'));
  const store = new LocalLibraryStore({ dbPath: path.join(tempDir, 'library.db') });
  await store.init();
  try {
    await fn(store);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function track(over: Partial<Parameters<LocalLibraryStore['insertTrack']>[0]> = {}) {
  return {
    storageId: 'local',
    relPath: 'local/a/1.mp3',
    title: 'Title',
    album: 'Album',
    artist: 'Artist',
    albumArtist: 'Artist',
    audiopath: 'ap-1',
    cover: undefined,
    mtime: 1,
    size: 1,
    duration: 1,
    ...over,
  };
}

test('album rollup: a freshly inserted track is browsable immediately', async () => {
  await withStore((store) => {
    store.insertTrack(track());
    const albums = store.getAlbums('local', 0, 10);
    assert.equal(albums.total, 1);
    assert.equal(albums.items[0]?.track_count, 1);
  });
});

test('album rollup: retagging a track to another album artist leaves no stale group', async () => {
  await withStore((store) => {
    store.insertTrack(track());
    assert.equal(store.getAlbums('local', 0, 10).total, 1);

    // Same file, now credited to a different album artist.
    store.insertTrack(track({ albumArtist: 'Compilation', album: 'Album' }));

    const albums = store.getAlbums('local', 0, 10);
    assert.equal(albums.total, 1, 'the old group must not linger');
    assert.equal(albums.items[0]?.artist, 'Compilation');
    assert.equal(albums.items[0]?.track_count, 1);
  });
});

test('album rollup: deleting tracks updates the album list', async () => {
  await withStore((store) => {
    store.insertTrack(track({ relPath: 'local/a/1.mp3', audiopath: 'ap-1' }));
    store.insertTrack(track({ relPath: 'local/a/2.mp3', audiopath: 'ap-2' }));
    assert.equal(store.getAlbums('local', 0, 10).items[0]?.track_count, 2);

    store.deleteTracksByAudiopath('ap-2');
    assert.equal(store.getAlbums('local', 0, 10).items[0]?.track_count, 1);

    store.deleteTracksByAudiopath('ap-1');
    assert.equal(store.getAlbums('local', 0, 10).total, 0, 'empty album must disappear');
  });
});

test('album rollup: getStats album count matches the rollup', async () => {
  await withStore((store) => {
    store.insertTrack(track({ relPath: 'local/a/1.mp3', audiopath: 'ap-1', album: 'One' }));
    store.insertTrack(track({ relPath: 'local/b/2.mp3', audiopath: 'ap-2', album: 'Two' }));
    assert.equal(store.getStats().albums, 2);
    assert.equal(store.getAlbums('local', 0, 10).total, 2);
  });
});

test('search: accented names are findable (Björk regression)', async () => {
  await withStore((store) => {
    store.insertTrack(
      track({ title: 'Jóga', album: 'Homogenic', artist: 'Björk', albumArtist: 'Björk' }),
    );
    // The old ASCII-only tokenizer turned "Björk" into "bj* rk*" and matched
    // nothing, even though the track was indexed.
    assert.equal(store.searchTracks('Björk', 10).length, 1);
    assert.equal(store.searchArtists('Björk', 10).length, 1);
    // Diacritic folding in FTS5's unicode61 means the unaccented spelling works too.
    assert.equal(store.searchTracks('bjork', 10).length, 1);
    assert.equal(store.searchTracks('Jóga', 10).length, 1);
  });
});

test('deleteTracksMissingFrom prunes only what the scan did not see', async () => {
  await withStore((store) => {
    store.insertTrack(track({ relPath: 'local/a/1.mp3', audiopath: 'ap-1' }));
    store.insertTrack(track({ relPath: 'local/a/2.mp3', audiopath: 'ap-2' }));

    // A scan that saw only the first file prunes the second.
    const removed = store.deleteTracksMissingFrom('local', new Set(['local/a/1.mp3']));
    assert.equal(removed, 1);
    assert.equal(store.getStatsForStorage('local').tracks, 1);
  });
});

test('deleteTracksMissingFrom leaves other storages untouched', async () => {
  await withStore((store) => {
    store.insertTrack(track({ storageId: 'local', relPath: 'local/a.mp3', audiopath: 'ap-l' }));
    store.insertTrack(track({ storageId: 'nas1', relPath: 'nas/nas1/b.mp3', audiopath: 'ap-n' }));

    // Reconciling 'local' must not touch the share — this is what makes it safe
    // to skip an unreachable storage instead of wiping the whole table.
    store.deleteTracksMissingFrom('local', new Set());
    assert.equal(store.getStatsForStorage('local').tracks, 0);
    assert.equal(store.getStatsForStorage('nas1').tracks, 1);
  });
});

// An album used to be listed by file name, compared as text: `10 - x` sorted before `2 - y`,
// files named after their titles came out alphabetically, and two discs in one folder interleaved.
test('album tracks come in disc and track order, not file name order', async () => {
  await withStore((store) => {
    const rows: Array<[string, number, number]> = [
      ['local/a/Zebra.mp3', 1, 1],
      ['local/a/Apple.mp3', 1, 2],
      ['local/a/10 - Tenth.mp3', 1, 10],
      ['local/a/Bonus.mp3', 2, 1],
      ['local/a/untagged.mp3', 0, 0],
    ];
    rows.forEach(([relPath, discNo, trackNo], index) =>
      store.insertTrack(track({ relPath, audiopath: `ap-${index}`, discNo, trackNo })),
    );
    const listed = store.getTracksForAlbum('local', 'Artist', 'Album', 0, 10).items.map((row) => row.rel_path);
    assert.deepEqual(listed, [
      'local/a/Zebra.mp3',
      'local/a/Apple.mp3',
      'local/a/10 - Tenth.mp3',
      'local/a/untagged.mp3',
      'local/a/Bonus.mp3',
    ]);
  });
});

test('discs kept apart only by their folders stay whole', async () => {
  await withStore((store) => {
    // No disc number anywhere, and folder names that say nothing either.
    const rows: Array<[string, number]> = [
      ['local/a/first/1.mp3', 1],
      ['local/a/first/2.mp3', 2],
      ['local/a/second/1.mp3', 1],
      ['local/a/second/2.mp3', 2],
    ];
    rows.forEach(([relPath, trackNo], index) =>
      store.insertTrack(track({ relPath, audiopath: `ap-${index}`, discNo: 0, trackNo })),
    );
    const listed = store.getTracksForAlbum('local', 'Artist', 'Album', 0, 10).items.map((row) => row.rel_path);
    assert.deepEqual(listed, rows.map(([relPath]) => relPath));
  });
});
