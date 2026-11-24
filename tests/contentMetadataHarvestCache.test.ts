import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { ContentManager, createContentManager } from '../src/adapters/content/contentManager';
import { CustomRadioStore } from '../src/adapters/content/providers/customRadioStore';
import { metadataKeyVariants, normalizeProviderAudiopath } from '../src/domain/zones/audiopath';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import type { ContentFolder, ContentFolderItem } from '../src/ports/ContentTypes';
import type { ContentPort } from '../src/ports/ContentPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { SpotifyServiceManagerProvider } from '../src/adapters/content/providers/spotifyServiceManager';
import type { QueueItem } from '../src/ports/types/queueTypes';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { toApiRecents } from '../src/adapters/http/api/libraryProjection';

type TrackCall = { service: string; user: string; trackId: string };

type ManagerHarness = {
  cm: ContentManager;
  calls: { getFolder: number; getTrack: number };
  setFolder: (folder: ContentFolder | null) => void;
  setTrack: (track: ContentFolderItem | null) => void;
  /** How the last live lookup addressed the provider registry. */
  lastTrackCall: () => TrackCall | null;
};

// Builds a ContentManager wired to a fake Spotify/bridge manager so we can count
// the live getFolder/getTrack calls and prove the harvest cache short-circuits.
function makeManager(): ManagerHarness {
  const calls = { getFolder: 0, getTrack: 0 };
  let folder: ContentFolder | null = null;
  let track: ContentFolderItem | null = null;
  let trackCall: TrackCall | null = null;
  const fakeManager = {
    getFolder: async () => {
      calls.getFolder += 1;
      return folder;
    },
    getTrack: async (service: string, user: string, trackId: string) => {
      calls.getTrack += 1;
      trackCall = { service, user, trackId };
      return track;
    },
    hasProvider: () => true,
    listAccounts: () => [],
    getDefaultAccountId: () => null,
    listServiceEntries: () => [],
  };
  const spotifyManagerProvider = {
    get: () => fakeManager,
    reload: () => fakeManager,
  } as unknown as SpotifyServiceManagerProvider;
  const configPort = {
    getConfig: () => ({}),
    load: async () => ({}),
  } as unknown as ConfigPort;
  const notifier = {} as unknown as NotifierPort;
  const cm = createContentManager({
    notifier,
    configPort,
    spotifyManagerProvider,
    customRadioStore: new CustomRadioStore(),
  });
  return {
    cm,
    calls,
    setFolder: (next) => {
      folder = next;
    },
    setTrack: (next) => {
      track = next;
    },
    lastTrackCall: () => trackCall,
  };
}

const LIVE_TRACK: ContentFolderItem = {
  id: 't1',
  name: 'Live Title',
  type: 2,
  title: 'Live Title',
  artist: 'Live Artist',
  album: 'Live Album',
  coverurl: 'http://cover/live',
  duration: 123,
};

function makeFolder(items: ContentFolderItem[]): ContentFolder {
  return { id: 'f', name: 'Folder', start: 0, totalitems: items.length, items };
}

function makeQueueItem(overrides: Partial<QueueItem>): QueueItem {
  return {
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 0,
    coverurl: '',
    duration: 0,
    qindex: 0,
    station: '',
    title: '',
    unique_id: 'queue-1',
    user: 'nouser',
    ...overrides,
  };
}

async function withTempCwd(fn: () => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lox-harvest-test-'));
  process.chdir(tempDir);
  try {
    await fn();
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('metadataKeyVariants indexes raw, decoded and provider-stripped forms', () => {
  const variants = metadataKeyVariants('spotify@bridge-applemusic-x:album:111');
  assert.ok(variants.includes('spotify@bridge-applemusic-x:album:111'));
  assert.ok(variants.includes('spotify:album:111'));
});

test('metadataKeyVariants decodes a trailing b64 segment', () => {
  const inner = 'library://track/abc';
  const b64 = Buffer.from(inner, 'utf-8').toString('base64');
  const variants = metadataKeyVariants(`spotify@acc:track:b64_${b64}`);
  assert.ok(variants.includes(`spotify@acc:track:b64_${b64}`));
  assert.ok(variants.includes(inner));
  assert.ok(variants.includes(`spotify:track:b64_${b64}`));
});

test('harvest cache resolves a browsed item without a second browse', async () => {
  const { cm, calls, setFolder } = makeManager();
  const albumPath = 'spotify@bridge-applemusic-x:album:111';
  setFolder(
    makeFolder([
      {
        id: 'a1',
        name: 'Greatest Hits',
        type: 2,
        audiopath: albumPath,
        coverurl: 'http://cover/111',
        artist: 'The Band',
        album: 'Greatest Hits',
      },
    ]),
  );

  const folder = await cm.getServiceFolder('spotify@bridge-applemusic-x', 'user', 'album:111', 0, 50);
  assert.ok(folder);
  assert.equal(calls.getFolder, 1);

  const meta = await cm.resolveMetadata(albumPath);
  assert.ok(meta);
  assert.equal(meta?.title, 'Greatest Hits');
  assert.equal(meta?.artist, 'The Band');
  assert.equal(meta?.album, 'Greatest Hits');
  assert.equal(meta?.coverurl, 'http://cover/111');
  // No second browse, no live track lookup.
  assert.equal(calls.getFolder, 1);
  assert.equal(calls.getTrack, 0);
});

test('harvest miss falls back to a live track lookup', async () => {
  const { cm, calls, setTrack } = makeManager();
  setTrack({
    id: 't1',
    name: 'Live Title',
    type: 2,
    title: 'Live Title',
    artist: 'Live Artist',
    album: 'Live Album',
    coverurl: 'http://cover/live',
    duration: 123,
  });

  const meta = await cm.resolveMetadata('spotify@acc:track:xyz');
  assert.ok(meta);
  assert.equal(meta?.title, 'Live Title');
  assert.equal(meta?.artist, 'Live Artist');
  assert.equal(meta?.duration, 123);
  assert.equal(calls.getTrack, 1);
});

test('harvested provider-path metadata is found via the normalized favorite path', async () => {
  const { cm, calls, setFolder } = makeManager();
  setFolder(
    makeFolder([
      {
        id: 'a1',
        name: 'Greatest Hits',
        type: 2,
        audiopath: 'spotify@bridge-applemusic-x:album:111',
        coverurl: 'http://cover/111',
        artist: 'The Band',
        album: 'Greatest Hits',
      },
    ]),
  );
  await cm.getServiceFolder('spotify@bridge-applemusic-x', 'user', 'album:111', 0, 50);

  // favoritesManager stores the provider-stripped path; a resolve via that form must still hit.
  const normalized = normalizeProviderAudiopath('spotify@bridge-applemusic-x:album:111');
  assert.equal(normalized, 'spotify:album:111');
  const meta = await cm.resolveMetadata(normalized);
  assert.ok(meta);
  assert.equal(meta?.coverurl, 'http://cover/111');
  assert.equal(meta?.artist, 'The Band');
  assert.equal(calls.getTrack, 0);
});

test('favorites add picks up harvested cover/artist/album without a second browse', async () => {
  await withTempCwd(async () => {
    const { cm, calls, setFolder } = makeManager();
    const albumPath = 'spotify@bridge-applemusic-x:album:222';
    setFolder(
      makeFolder([
        {
          id: 'a1',
          name: 'Night Visions',
          type: 2,
          audiopath: albumPath,
          coverurl: 'http://cover/222',
          artist: 'Imagine Dragons',
          album: 'Night Visions',
        },
      ]),
    );
    await cm.getServiceFolder('spotify@bridge-applemusic-x', 'user', 'album:222', 0, 50);

    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
    } as unknown as ContentPort;
    const favorites = createFavoritesManager({
      notifier: { notifyRoomFavoritesChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });
    favorites.initOnce({ zoneManager: { getState: () => undefined } as never });

    const created = await favorites.add(7, 'User Album Title', albumPath);
    assert.equal(created.coverurl, 'http://cover/222');
    assert.equal(created.artist, 'Imagine Dragons');
    assert.equal(created.album, 'Night Visions');
    // Harvested title wins over the placeholder the user-facing add carried in.
    assert.equal(created.title, 'Night Visions');
    assert.equal(calls.getTrack, 0);
  });
});

test('a browsed container is harvested under its folder id', async () => {
  const { cm, calls, setFolder } = makeManager();
  // An album row carries no audiopath of its own: it is addressed by its folder id, which for
  // a service-native provider is itself a path.
  setFolder(
    makeFolder([
      {
        id: 'applemusic:library-album:b64_bluelines',
        name: 'Blue Lines',
        type: 2,
        artist: 'Massive Attack',
        coverurl: 'http://cover/bluelines',
      },
    ]),
  );
  await cm.getServiceFolder('applemusic', 'user', 'recent', 0, 50);

  const meta = await cm.resolveMetadata('applemusic:library-album:b64_bluelines');
  assert.equal(meta?.title, 'Blue Lines');
  assert.equal(meta?.artist, 'Massive Attack');
  assert.equal(meta?.coverurl, 'http://cover/bluelines');
  assert.equal(calls.getTrack, 0);
});

test('a bare provider id is not harvested as a path (it would collide across services)', async () => {
  const { cm, setFolder } = makeManager();
  setFolder(makeFolder([{ id: 'album:111', name: 'Ambiguous', type: 2, coverurl: 'http://cover/x' }]));
  await cm.getServiceFolder('applemusic', 'user', 'recent', 0, 50);

  assert.equal(await cm.resolveMetadata('album:111'), null);
});

test('recents record fills metadata from the harvest cache (no live lookup)', async () => {
  await withTempCwd(async () => {
    const { cm, calls, setFolder } = makeManager();
    setFolder(
      makeFolder([
        {
          id: 't1',
          name: 'Harvested Song',
          type: 2,
          title: 'Harvested Song',
          audiopath: 'spotify@user:track:abc',
          coverurl: 'http://cover/abc',
          artist: 'Some Artist',
          album: 'Some Album',
          duration: 200,
        },
      ]),
    );
    await cm.getServiceFolder('spotify@user', 'user', 'pl:1', 0, 50);

    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
      getDefaultSpotifyAccountId: () => null,
      listBrowsableServices: () => [],
      getBridgeRegistry: () => buildBridgeRegistry([]),
    } as unknown as ContentPort;
    const recents = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });

    await recents.record(9, makeQueueItem({ audiopath: 'spotify:track:abc', user: 'user', title: '' }));

    const stored = await recents.get(9);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.title, 'Harvested Song');
    assert.equal(calls.getTrack, 0);
  });
});

test('a Radio Paradise recent keeps the catalogue station icon', async () => {
  await withTempCwd(async () => {
    const { cm } = makeManager();
    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
      getDefaultSpotifyAccountId: () => null,
      listBrowsableServices: () => [],
      getBridgeRegistry: () => buildBridgeRegistry([]),
    } as unknown as ContentPort;
    const recents = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });

    // This is the queue row the radio play produces: the audiopath names the
    // station, the station label is already known, and the queue has no cover.
    await recents.record(
      9,
      makeQueueItem({
        audiopath: 'radioparadise:1',
        audiotype: 1,
        title: '',
        station: 'Radio Paradise - Mellow Mix',
      }),
    );

    const stored = await recents.get(9);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.title, 'Radio Paradise - Mellow Mix');
    assert.match(
      stored.items[0]?.coverurl ?? '',
      /\/assets\/icons\/radioparadise-logo-mellow\.png$/,
      'the station logo is resolved from the catalogue, not the now-playing track cover',
    );
    assert.equal(stored.items[0]?.thumbnail, stored.items[0]?.coverurl);

    // The public API surface the Web UI reads is a direct projection of the store.
    const api = toApiRecents(9, stored, 0, 10, buildBridgeRegistry([]), 'Living');
    assert.match(api.items[0]?.coverUrl ?? '', /\/assets\/icons\/radioparadise-logo-mellow\.png$/);
  });
});

test('a tunein-wrapped Radio Paradise source resolves the same station icon', async () => {
  await withTempCwd(async () => {
    const { cm } = makeManager();
    const wrapped = `tunein:station:b64_${Buffer.from('radioparadise:0').toString('base64')}`;
    const meta = await cm.resolveMetadata(wrapped);
    assert.equal(meta?.title, 'Radio Paradise - Main Mix');
    assert.match(meta?.coverurl ?? '', /\/assets\/icons\/radioparadise-logo-main\.png$/);
  });
});

test('an empty queue cover falls through to the metadata cover', async () => {
  // The queue row for a service item carries `coverurl: ''` whenever the picture is
  // only known from metadata. `??` treated that empty string as a value and shadowed
  // the resolved cover; the recent then lost the artwork the browse row had.
  await withTempCwd(async () => {
    const { cm, setTrack } = makeManager();
    setTrack(LIVE_TRACK);
    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
      getDefaultSpotifyAccountId: () => null,
      listBrowsableServices: () => [],
      getBridgeRegistry: () => buildBridgeRegistry([]),
    } as unknown as ContentPort;
    const recents = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });

    await recents.record(
      11,
      makeQueueItem({ audiopath: 'applemusic:track:123', audiotype: 5, coverurl: '' }),
    );

    const stored = await recents.get(11);
    assert.equal(stored.items[0]?.coverurl, LIVE_TRACK.coverurl, 'the metadata cover is used');
    assert.equal(stored.items[0]?.thumbnail, LIVE_TRACK.coverurl, 'thumbnail follows the cover');

    const api = toApiRecents(11, stored, 0, 10, buildBridgeRegistry([]), 'Living');
    assert.equal(api.items[0]?.coverUrl, LIVE_TRACK.coverurl, 'the public response carries it');
  });
});

test('a queue cover still wins over metadata', async () => {
  await withTempCwd(async () => {
    const { cm, setTrack } = makeManager();
    setTrack(LIVE_TRACK);
    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
      getDefaultSpotifyAccountId: () => null,
      listBrowsableServices: () => [],
      getBridgeRegistry: () => buildBridgeRegistry([]),
    } as unknown as ContentPort;
    const recents = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });

    await recents.record(
      12,
      makeQueueItem({
        audiopath: 'applemusic:track:123',
        audiotype: 5,
        coverurl: 'http://cover/queue',
      }),
    );

    assert.equal((await recents.get(12)).items[0]?.coverurl, 'http://cover/queue');
  });
});

test('a replay with no cover keeps the artwork already stored', async () => {
  // Neither the queue row nor metadata names a picture this time; the recent must
  // not lose the image it had.
  await withTempCwd(async () => {
    const { cm, setTrack } = makeManager();
    setTrack(LIVE_TRACK);
    const contentPort = {
      resolveMetadata: (p: string) => cm.resolveMetadata(p),
      getDefaultSpotifyAccountId: () => null,
      listBrowsableServices: () => [],
      getBridgeRegistry: () => buildBridgeRegistry([]),
    } as unknown as ContentPort;
    const recents = createRecentsManager({
      notifier: { notifyRecentlyPlayedChanged: () => {} } as unknown as NotifierPort,
      contentPort,
    });

    await recents.record(
      13,
      makeQueueItem({ audiopath: 'applemusic:track:123', audiotype: 5, coverurl: '' }),
    );
    const first = await recents.get(13);
    assert.equal(first.items[0]?.coverurl, LIVE_TRACK.coverurl);

    setTrack(null);
    await recents.record(
      13,
      makeQueueItem({ audiopath: 'applemusic:track:123', audiotype: 5, coverurl: '' }),
    );
    const second = await recents.get(13);
    assert.equal(second.items[0]?.coverurl, LIVE_TRACK.coverurl, 'the stored cover survives');
    assert.equal(second.items[0]?.thumbnail, LIVE_TRACK.coverurl);
  });
});

test('a service-native track resolves live and names no account when there is one', async () => {
  const { cm, calls, setTrack, lastTrackCall } = makeManager();
  setTrack(LIVE_TRACK);

  const meta = await cm.resolveMetadata('applemusic:track:123');
  assert.equal(meta?.title, 'Live Title');
  assert.equal(calls.getTrack, 1);
  assert.deepEqual(lastTrackCall(), { service: 'applemusic', user: '', trackId: 'track:123' });
});

test('a second account of one service is carried into the lookup, not dropped', async () => {
  // The per-provider regexes this replaced were all `^([^:]+):track:`, which cannot match an
  // account slug: `deezer:ab12:track:9` resolved to nothing at all on a two-account server.
  const { cm, calls, setTrack, lastTrackCall } = makeManager();
  setTrack(LIVE_TRACK);

  const meta = await cm.resolveMetadata('deezer:ab12:track:9');
  assert.equal(meta?.artist, 'Live Artist');
  assert.equal(calls.getTrack, 1);
  // Addressed down to the account, so the registry cannot answer from the other one.
  assert.deepEqual(lastTrackCall(), { service: 'deezer:ab12', user: 'ab12', trackId: 'track:9' });
});

test('an Apple library track keeps its library- marker and its undecoded id', async () => {
  const { cm, setTrack, lastTrackCall } = makeManager();
  setTrack(LIVE_TRACK);

  await cm.resolveMetadata('applemusic:p0gngd:library-track:b64_aWQ');
  // The provider decodes `b64_` itself in getTrack(); passing it raw keeps that in one place.
  assert.deepEqual(lastTrackCall(), {
    service: 'applemusic:p0gngd',
    user: 'p0gngd',
    trackId: 'library-track:b64_aWQ',
  });
});

test('the Loxone disguise still resolves through its own path', async () => {
  const { cm, calls, setTrack } = makeManager();
  setTrack(LIVE_TRACK);

  // Stored favourites and recents come back in this shape; it is not service-native.
  const meta = await cm.resolveMetadata('spotify@bridge-applemusic-x:track:abc');
  assert.equal(meta?.title, 'Live Title');
  assert.equal(calls.getTrack, 1);
});

test('radio/stream listing items are not harvested (live tunein path keeps station)', async () => {
  const { cm } = makeManager();
  // Drive the harvest helper directly with a radio + http item, then confirm nothing was stored.
  const cmInternals = cm as unknown as {
    harvestFolderMetadata: (folder: ContentFolder | null) => ContentFolder | null;
    lookupHarvestedMetadata: (audiopath: string) => unknown;
  };
  cmInternals.harvestFolderMetadata(
    makeFolder([
      { id: 's1', name: 'Bayern 1', type: 3, audiopath: 'tunein:station:abc', coverurl: 'http://cover/radio' },
      { id: 's2', name: 'Web Radio', type: 3, audiopath: 'https://example.com/stream.mp3', coverurl: 'http://cover/web' },
    ]),
  );
  assert.equal(cmInternals.lookupHarvestedMetadata('tunein:station:abc'), null);
  assert.equal(cmInternals.lookupHarvestedMetadata('https://example.com/stream.mp3'), null);
});
