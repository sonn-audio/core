import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-favorites-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('favorites manager normalizes legacy local favorite types for app compatibility', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '27.json'),
      JSON.stringify({
        id: 27,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 4,
            slot: 4,
            plus: true,
            name: 'Azizam',
            title: 'Azizam',
            audiopath: 'library:local:track:b64_example',
            type: 'custom_track',
            coverurl: '',
            artist: '',
            album: '',
            service: 'custom',
            serviceType: 3,
            owner: '',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(27);
    assert.equal(result.items[0]?.type, 'library_track');
    assert.equal(result.items[0]?.service, 'library');
    assert.equal(result.items[0]?.serviceType, 2);
  });
});

test('favorites manager exposes ownerId/owner_id for spotify_playlist favorites', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '11.json'),
      JSON.stringify({
        id: 11,
        type: 4,
        start: 0,
        totalitems: 2,
        items: [
          {
            id: 3,
            slot: 3,
            plus: true,
            name: 'Ben Böhmer Radio',
            title: 'Ben Böhmer Radio',
            audiopath: 'spotify:playlist:37i9dQZF1E4pZXZH78vpiC',
            type: 'spotify_playlist',
            coverurl: '',
            artist: '',
            album: '',
            service: 'spotify',
            serviceType: 3,
            owner: 'Timo',
          },
          {
            id: 4,
            slot: 4,
            plus: true,
            name: 'Liked Songs',
            title: 'Liked Songs',
            audiopath: 'spotify:user:collection',
            type: 'spotify_collection',
            coverurl: '',
            artist: '',
            album: '',
            service: 'spotify',
            serviceType: 3,
            owner: 'Timo',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(11);
    const playlist = result.items[0] as Record<string, unknown>;
    const collection = result.items[1] as Record<string, unknown>;

    assert.equal(playlist.type, 'spotify_playlist');
    assert.equal(playlist.ownerId, 'Timo');
    assert.equal(playlist.owner_id, 'Timo');

    assert.equal(collection.type, 'spotify_collection');
    assert.equal(collection.ownerId, 'Timo');
    assert.equal(collection.owner_id, 'Timo');
  });
});

test('favorites manager omits ownerId for non-spotify-playlist favorites', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '12.json'),
      JSON.stringify({
        id: 12,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 1,
            slot: 1,
            plus: true,
            name: 'WDR 2',
            title: 'WDR 2',
            audiopath: 'https://example.com/wdr2.mp3',
            type: 'custom_stream',
            coverurl: '',
            service: 'custom',
            serviceType: 3,
            owner: '',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(12);
    const radio = result.items[0] as Record<string, unknown>;
    assert.equal('ownerId' in radio, false);
    assert.equal('owner_id' in radio, false);
  });
});

test('favorites manager detects apple-music library kind prefixes', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const artist = await favoritesManager.add(
      1,
      'Adele',
      'spotify@bridge-applemusic-djq5zp:library-artist:b64_ci43Sjd3Y29i',
    );
    assert.equal(artist.type, 'spotify_artist');

    const album = await favoritesManager.add(
      1,
      'Album',
      'spotify@bridge-applemusic-djq5zp:library-album:b64_YWxidW0=',
    );
    assert.equal(album.type, 'spotify_album');

    const playlist = await favoritesManager.add(
      1,
      'Playlist',
      'spotify@bridge-applemusic-djq5zp:library-playlist:b64_cGxheQ==',
    );
    assert.equal(playlist.type, 'spotify_playlist');
  });
});

test('favorites manager heals a stale spotify_track type for an apple-music artist', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '5.json'),
      JSON.stringify({
        id: 5,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 5,
            slot: 5,
            plus: true,
            name: 'Adele',
            title: 'Adele',
            audiopath: 'spotify:library-artist:b64_ci43Sjd3Y29i',
            type: 'spotify_track',
            coverurl: 'https://example.com/adele.jpg',
            artist: 'Adele',
            album: '',
            service: 'spotify',
            serviceType: 3,
            owner: 'bridge-applemusic-djq5zp',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(5);
    assert.equal(result.items[0]?.type, 'spotify_artist');
  });
});

test('favorites manager types local library artist/album containers', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    // The native client has no library_artist/library_album type, so local
    // artist/album containers are typed as library_folder.
    const artist = await favoritesManager.add(
      1,
      'Queen',
      'library:artist:eyJzdG9yYWdlSWQiOiJsb2NhbCIsImFydGlzdCI6IlF1ZWVuIn0',
    );
    assert.equal(artist.type, 'library_folder');

    const album = await favoritesManager.add(1, 'Some Album', 'library:album:abc');
    assert.equal(album.type, 'library_folder');
  });
});

test('favorites manager heals a stale library_track type for a local artist', async () => {
  await withTempCwd(async () => {
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '8.json'),
      JSON.stringify({
        id: 8,
        type: 4,
        start: 0,
        totalitems: 1,
        items: [
          {
            id: 8,
            slot: 7,
            plus: true,
            name: 'Queen',
            title: 'Queen',
            audiopath: 'library:artist:eyJzdG9yYWdlSWQiOiJsb2NhbCIsImFydGlzdCI6IlF1ZWVuIn0',
            type: 'library_track',
            coverurl: '',
            artist: '',
            album: '',
            service: 'library',
            serviceType: 2,
            owner: '',
          },
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const result = await favoritesManager.get(8);
    assert.equal(result.items[0]?.type, 'library_folder');
  });
});

test('favorites manager stores stream favorites as custom_stream', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    const created = await favoritesManager.add(11, 'Web Radio', 'https://example.com/radio.m3u8');
    assert.equal(created.type, 'custom_stream');

    const result = await favoritesManager.get(11);
    assert.equal(result.items[0]?.type, 'custom_stream');
  });
});

test('a favorite of something else does not borrow what is playing', async () => {
  await withTempCwd(async () => {
    const playing = {
      audiopath: 'applemusic:track:b64_playing',
      title: 'Teardrop',
      artist: 'Massive Attack',
      album: 'Mezzanine',
      coverurl: 'http://cover/teardrop',
    };
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => playing } as any });

    // Saving a browse row while a track plays: the row's own name is all we know.
    const other = await favoritesManager.add(28, 'Blue Lines', 'applemusic:album:b64_bluelines');
    assert.equal(other.title, 'Blue Lines');
    assert.equal(other.name, 'Blue Lines');
    assert.equal(other.artist, '');
    assert.equal(other.album, '');
    assert.equal(other.coverurl, '');

    // Saving what *is* playing still fills itself in from the zone.
    const current = await favoritesManager.add(28, '', playing.audiopath);
    assert.equal(current.title, 'Teardrop');
    assert.equal(current.artist, 'Massive Attack');
    assert.equal(current.coverurl, 'http://cover/teardrop');
  });
});

test('a non-spotify favorite does not inherit the playing spotify account', async () => {
  await withTempCwd(async () => {
    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({
      zoneManager: { getState: () => ({ audiopath: 'spotify@acct-1:track:xyz' }) } as any,
    });

    const apple = await favoritesManager.add(28, 'Muse', 'applemusic:album:b64_muse');
    assert.equal(apple.owner, '');
    assert.equal(await favoritesManager.getAudiopathForFavorite(28, apple.id), 'applemusic:album:b64_muse');

    // A Spotify path saved while that account plays still keeps its owner.
    const spotify = await favoritesManager.add(28, 'Some Album', 'spotify:album:111');
    assert.equal(spotify.owner, 'acct-1');
    assert.equal(await favoritesManager.getAudiopathForFavorite(28, spotify.id), 'spotify@acct-1:album:111');
  });
});

test('a stream favourite that carries a stale owner plays its own url, not a spotify one', async () => {
  // Favourites saved while Spotify was playing borrowed its account as their owner. Putting that
  // owner back as `spotify@<owner>:` turned a custom stream or TuneIn station into an address the
  // engine cannot open, and the room answered "Playback unavailable" (#415).
  await withTempCwd(async () => {
    const stream = 'http://example.com/bbc.m3u8?station=bbc_radio_two';
    const station = 'tunein:station:b64_aHR0cDovL2V4YW1wbGUuY29tL3JhZGlv';
    const item = (id: number, audiopath: string, type: string) => ({
      id,
      slot: id,
      plus: true,
      name: `fav ${id}`,
      title: `fav ${id}`,
      audiopath,
      type,
      coverurl: '',
      artist: '',
      album: '',
      service: 'custom',
      serviceType: 3,
      owner: 'md123121',
    });
    await fs.mkdir(path.join(process.cwd(), 'data', 'favorites'), { recursive: true });
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'favorites', '12.json'),
      JSON.stringify({
        id: 12,
        type: 4,
        start: 0,
        totalitems: 3,
        items: [
          item(1, stream, 'custom_stream'),
          item(2, station, 'tunein'),
          item(3, 'spotify:playlist:abc', 'spotify_playlist'),
        ],
      }),
    );

    const favoritesManager = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as any,
      contentPort: { resolveMetadata: async () => null } as any,
    });
    favoritesManager.initOnce({ zoneManager: { getState: () => undefined } as any });

    assert.equal(await favoritesManager.getAudiopathForFavorite(12, 1), stream);
    assert.equal(await favoritesManager.getAudiopathForFavorite(12, 2), station);
    // A Spotify favourite still gets its account back.
    assert.equal(await favoritesManager.getAudiopathForFavorite(12, 3), 'spotify@md123121:playlist:abc');
  });
});
