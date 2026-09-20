import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';
import type { ZoneState } from '../src/domain/zones/zoneState';

// A real Loxone Audioserver comes up with every zone showing its first room favourite, stopped.
// That is what makes a wall switch work from cold: the T5 and the app's volume buttons only start
// a zone that already has something loaded (#281, #381).

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-prime-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function writeFavorites(zoneId: number, audiopath = 'tunein:station:one'): Promise<void> {
  await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
  await fs.writeFile(
    path.join(process.cwd(), 'data', 'favorites', `${zoneId}.json`),
    JSON.stringify({
      id: zoneId,
      type: 4,
      start: 0,
      totalitems: 2,
      items: [
        {
          id: 1,
          slot: 1,
          plus: true,
          name: 'Radio One',
          title: 'Radio One',
          audiopath,
          type: 'station',
          coverurl: 'http://cover/one.png',
          artist: 'BBC',
          album: '',
          service: 'tunein',
          serviceType: 3,
          owner: '',
        },
        {
          id: 2,
          slot: 2,
          plus: true,
          name: 'Radio Two',
          title: 'Radio Two',
          audiopath: 'tunein:station:two',
          type: 'station',
          coverurl: '',
          artist: '',
          album: '',
          service: 'tunein',
          serviceType: 3,
          owner: '',
        },
      ],
    }),
  );
}

type Fixture = {
  patches: Array<[number, Partial<ZoneState>]>;
  metadata: Record<string, unknown>;
  prime: () => Promise<void>;
};

function fixture(
  states: Array<Partial<ZoneState> & { id: number }>,
  metadataLookup: { duration?: number } | null = null,
): Fixture {
  const patches: Array<[number, Partial<ZoneState>]> = [];
  const metadata: Record<string, unknown> = {};
  const favoritesManager = createFavoritesManager({
    notifier: { notifyRoomFavoritesChanged: () => {} } as any,
    contentPort: { resolveMetadata: async () => metadataLookup } as any,
  });
  favoritesManager.initOnce({
    zoneManager: {
      getState: (id: number) => states.find((s) => s.id === id),
      getAllZoneStates: () => states,
      applyPatch: (id: number, patch: Partial<ZoneState>) => patches.push([id, patch]),
      getMetadata: () => metadata,
    } as any,
  });
  return { patches, metadata, prime: () => favoritesManager.primeZones() };
}

test('an idle zone comes up showing its first room favourite, stopped', async () => {
  await withTempCwd(async () => {
    await writeFavorites(7);
    const f = fixture([{ id: 7, mode: 'stop', audiopath: '' }]);

    await f.prime();

    assert.equal(f.patches.length, 1);
    const [zoneId, patch] = f.patches[0]!;
    assert.equal(zoneId, 7);
    assert.equal(patch.audiopath, 'tunein:station:one');
    assert.equal(patch.title, 'Radio One');
    assert.equal(patch.artist, 'BBC');
    assert.equal(patch.coverurl, 'http://cover/one.png');
    // A station says it is a station. Left as a File of length zero, a client draws it as live.
    assert.equal(patch.audiotype, 1);
    assert.equal(patch.duration, 0);
    // Nothing starts playing: the patch carries no mode at all.
    assert.equal(patch.mode, undefined);
  });
});

test('a primed track carries its length, so it is not mistaken for a live stream', async () => {
  await withTempCwd(async () => {
    await writeFavorites(7, 'library:track:42');
    const f = fixture([{ id: 7, mode: 'stop', audiopath: '' }], { duration: 212.4 });

    await f.prime();

    const [, patch] = f.patches[0]!;
    assert.equal(patch.audiotype, 0);
    assert.equal(patch.duration, 212);
  });
});

test('priming records the loaded favourite, so roomfav/plus moves on to the second', async () => {
  await withTempCwd(async () => {
    await writeFavorites(7);
    const f = fixture([{ id: 7, mode: 'stop', audiopath: '' }]);

    await f.prime();

    assert.equal(f.metadata.lastFavoriteId, 1);
  });
});

test('a zone that already carries a track is left alone', async () => {
  await withTempCwd(async () => {
    await writeFavorites(7);
    const f = fixture([{ id: 7, mode: 'stop', audiopath: 'library:track:99' }]);

    await f.prime();

    assert.deepEqual(f.patches, []);
  });
});

test('a playing zone is left alone', async () => {
  await withTempCwd(async () => {
    await writeFavorites(7);
    const f = fixture([{ id: 7, mode: 'play', audiopath: '' }]);

    await f.prime();

    assert.deepEqual(f.patches, []);
  });
});

test('a zone without room favourites stays empty', async () => {
  await withTempCwd(async () => {
    const f = fixture([{ id: 7, mode: 'stop', audiopath: '' }]);

    await f.prime();

    assert.deepEqual(f.patches, []);
  });
});
