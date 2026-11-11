import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  extendModule,
  isMixId,
  moduleItems,
  musicModules,
  type RawModule,
  type RawPage,
} from '../src/adapters/content/providers/tidal/tidalPages';
import { TidalProvider } from '../src/adapters/content/providers/tidal/tidalProvider';

// TIDAL's editorial pages (tidal.com/v1/pages/*), as a device-flow account reads them. The shapes
// follow live answers of pages/home, pages/explore_new_music and pages/my_collection_my_mixes; ids,
// titles and image ids are made up, and the items are trimmed to the fields that are read.

type Call = { url: URL };
type Handler = (url: URL) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeAccess(routes: Array<[RegExp, Handler]>) {
  const calls: Call[] = [];
  return {
    calls,
    auth: {
      noteQuality: async () => {},
      fetch: async (_id: string, url: URL) => {
        if (!url.searchParams.has('countryCode')) url.searchParams.set('countryCode', 'NL');
        calls.push({ url });
        const route = routes.find(([pattern]) => pattern.test(url.toString()));
        if (!route) throw new Error(`unexpected fetch ${url}`);
        return route[1](url);
      },
    },
  };
}

const artist = (id: number, name: string) => ({ id, name, type: 'MAIN', picture: `pic-${id}` });
const track = (id: number, title: string) => ({
  id,
  title,
  duration: 201,
  version: null,
  artists: [artist(10, 'The Band'), artist(11, 'Guest')],
  album: { id: 900 + id, title: `Album of ${title}`, cover: `c0ffee00-0000-4000-8000-${String(id).padStart(12, '0')}` },
  audioQuality: 'LOSSLESS',
});
const album = (id: number, title: string) => ({
  id,
  title,
  cover: `a1b2c3d4-0000-4000-8000-${String(id).padStart(12, '0')}`,
  artists: [artist(10, 'The Band')],
  numberOfTracks: 11,
  audioQuality: 'LOSSLESS',
});
const playlist = (uuid: string, title: string, type = 'EDITORIAL') => ({
  uuid,
  title,
  type,
  squareImage: `5a5a5a5a-0000-4000-8000-${uuid.slice(-12)}`,
  numberOfTracks: 50,
  creators: [],
});
const mix = (id: string, title: string) => ({
  id,
  title,
  subTitle: 'Artist A, Artist B and more',
  mixType: 'DISCOVERY_MIX',
  images: { SMALL: { width: 320, url: `https://images.tidal.com/${id}/320.jpg` }, MEDIUM: { width: 640, url: `https://images.tidal.com/${id}/640.jpg` } },
});

/** A home page with one module of each kind, a truncated album shelf, and the furniture left out. */
function homePage(): RawPage {
  return {
    title: 'Home',
    rows: [
      {
        modules: [
          {
            type: 'ALBUM_LIST',
            title: 'Suggested new albums for you',
            pagedList: { items: [album(1, 'One'), album(2, 'Two')], totalNumberOfItems: 5, dataApiPath: 'pages/data/0000-albums' },
          },
        ],
      },
      { modules: [{ type: 'TRACK_LIST', title: 'Recommended new tracks', pagedList: { items: [track(21, 'Song')], totalNumberOfItems: 1, dataApiPath: 'pages/data/0000-tracks' } }] },
      {
        modules: [
          {
            type: 'PLAYLIST_LIST',
            title: 'Popular playlists on TIDAL',
            pagedList: {
              items: [
                playlist('11111111-2222-4333-8444-000000000001', 'Hits'),
                // A podcast's playlist: its episodes do not stream.
                playlist('11111111-2222-4333-8444-000000000002', 'A Podcast', 'PODCAST'),
                // A mix inside a playlist shelf is still a mix.
                mix('0a1b2c3d4e5f60718293a4b5c6d7e8', 'My Mix 1'),
              ],
              totalNumberOfItems: 3,
            },
          },
        ],
      },
      { modules: [{ type: 'VIDEO_LIST', title: 'New Music Videos', pagedList: { items: [{ id: 5, title: 'Clip', type: 'Music Video' }] } }] },
      { modules: [{ type: 'PLAYLIST_LIST', title: 'Video Playlists', pagedList: { items: [playlist('11111111-2222-4333-8444-000000000003', 'Clips')] } }] },
      { modules: [{ type: 'MIX_LIST', title: 'Custom mixes', pagedList: { items: [mix('00112233445566778899aabbccddee', 'Daily Discovery')] } }] },
      {
        modules: [
          {
            type: 'HIGHLIGHT_MODULE',
            title: 'Spotlight',
            highlight: [
              { type: 'ALBUM', item: album(3, 'Featured') },
              { type: 'PLAYLIST', item: playlist('11111111-2222-4333-8444-000000000004', 'Staff Picks') },
            ],
          },
        ],
      },
      { modules: [{ type: 'ARTIST_LIST', title: 'Artists to follow', pagedList: { items: [{ id: 12, name: 'Singer', picture: 'aaaa-bbbb' }] } }] },
      // Untitled furniture: a text block, a mix's header.
      { modules: [{ type: 'TEXT_BLOCK', title: '', text: 'Nothing yet' }, { type: 'MIX_HEADER', title: '' }] },
      // A shelf with nothing that plays here.
      { modules: [{ type: 'PLAYLIST_LIST', title: 'Podcasts', pagedList: { items: [playlist('11111111-2222-4333-8444-000000000005', 'Talk', 'PODCAST')] } }] },
    ],
  };
}

const PAGE_ROUTES = (overrides: Partial<Record<string, Handler>> = {}): Array<[RegExp, Handler]> => [
  [/tidal\.com\/v1\/pages\/home\?/, overrides.home ?? (() => json(200, homePage()))],
  [/tidal\.com\/v1\/pages\/data\/0000-albums/, overrides.data ?? ((url) => {
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const all = [album(1, 'One'), album(2, 'Two'), album(3, 'Three'), album(4, 'Four'), album(5, 'Five')];
    return json(200, { limit, offset, totalNumberOfItems: 5, items: all.slice(offset, offset + limit) });
  })],
  [/tidal\.com\/v1\/pages\/my_collection_my_mixes/, overrides.myMixes ?? (() =>
    json(200, { title: 'My Mix', rows: [{ modules: [{ type: 'MIX_LIST', title: 'My Mixes', pagedList: { items: [mix('0a1b2c3d4e5f60718293a4b5c6d7e8', 'My Mix 1')] } }] }] }))],
  [/tidal\.com\/v1\/pages\/explore_new_music/, overrides.newMusic ?? (() => json(403, { status: 403, subStatus: 1002, userMessage: 'Required scopes: r_usr' }))],
];

// ── parsing ────────────────────────────────────────────────────────────────────

test('a page keeps its titled music shelves and types each item by its module, or by its shape', () => {
  const modules = musicModules(homePage());
  assert.deepEqual(modules.map((m) => [m.index, m.type, m.title]), [
    [0, 'ALBUM_LIST', 'Suggested new albums for you'],
    [1, 'TRACK_LIST', 'Recommended new tracks'],
    [2, 'PLAYLIST_LIST', 'Popular playlists on TIDAL'],
    [5, 'MIX_LIST', 'Custom mixes'],
    [6, 'HIGHLIGHT_MODULE', 'Spotlight'],
    [7, 'ARTIST_LIST', 'Artists to follow'],
  ], 'no videos, no untitled furniture, no shelf of podcasts');
  const kinds = (i: number) => moduleItems(modules.find((m) => m.index === i)!.module).map((e) => e.kind);
  assert.deepEqual(kinds(0), ['album', 'album']);
  assert.deepEqual(kinds(1), ['track']);
  assert.deepEqual(kinds(2), ['playlist', 'mix']);
  assert.deepEqual(kinds(5), ['mix']);
  assert.deepEqual(kinds(6), ['album', 'playlist']);
  assert.deepEqual(kinds(7), ['artist']);

  // A module of an unknown kind: each item by its fields, a `{ type, item }` wrapper by its type.
  const mixed: RawModule = {
    type: 'MIXED_TYPES_LIST',
    title: 'Mixed',
    pagedList: { items: [track(1, 'T'), album(2, 'A'), { uuid: 'u-1', title: 'P' }, { type: 'TRACK', item: track(3, 'W') }, { id: 7, title: 'Clip', type: 'Music Video' }] },
  };
  assert.deepEqual(moduleItems(mixed).map((e) => e.kind), ['track', 'album', 'playlist', 'track']);
  assert.ok(isMixId('0a1b2c3d4e5f60718293a4b5c6d7e8'));
  assert.ok(!isMixId('11111111-2222-4333-8444-000000000001'));
});

test('a truncated module is extended through its dataApiPath, up to its total, and stops on an empty page', async () => {
  const module = homePage().rows![0]!.modules![0]!;
  const asked: Array<[string, number, number]> = [];
  const all = [album(1, 'One'), album(2, 'Two'), album(3, 'Three'), album(4, 'Four'), album(5, 'Five')];
  await extendModule(module, 50, async (path, offset, limit) => {
    asked.push([path, offset, limit]);
    return all.slice(offset, offset + Math.min(limit, 2));
  });
  assert.deepEqual(asked, [['pages/data/0000-albums', 2, 3], ['pages/data/0000-albums', 4, 1]]);
  assert.deepEqual(module.pagedList!.items!.map((a: any) => a.id), [1, 2, 3, 4, 5]);

  const stuck = homePage().rows![0]!.modules![0]!;
  let n = 0;
  await extendModule(stuck, 50, async () => (n++ ? null : [album(3, 'Three')]));
  assert.equal(stuck.pagedList!.items!.length, 3, 'a failed fetch keeps what there is');
  assert.equal(n, 2);

  const whole = homePage().rows![1]!.modules![0]!;
  await extendModule(whole, 50, async () => assert.fail('a module holding its total is not fetched'));
});

// ── the root ───────────────────────────────────────────────────────────────────

test('a v1 account whose token reads the pages gets Home, For You, New, Top and Hi-Res at the root', async () => {
  const { auth, calls } = fakeAccess(PAGE_ROUTES());
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const root = await provider.getFolder('root', 0, 50);
  assert.deepEqual(root?.items.map((i) => [i.id, i.name]), [
    ['home', 'Home'],
    ['for-you', 'For You'],
    ['new-music', 'New Music'],
    ['top-music', 'Top Music'],
    ['hi-res', 'Hi-Res'],
    ['collection', 'My Collection'],
    ['playlists', 'My Playlists'],
    ['mixes', 'Mixes'],
  ]);
  const page = calls[0]!.url;
  assert.equal(page.toString().split('?')[0], 'https://tidal.com/v1/pages/home');
  assert.equal(page.searchParams.get('deviceType'), 'BROWSER');
  assert.equal(page.searchParams.get('locale'), 'en_US');
  assert.equal(page.searchParams.get('countryCode'), 'NL');

  // Home is then served from memory: neither the root nor Home asks again.
  await provider.getFolder('root', 0, 50);
  await provider.getFolder('home', 0, 50);
  assert.equal(calls.length, 1);
});

test('an account without r_usr gets no pages: a refused token is left out quietly', async () => {
  const refused = fakeAccess([
    ...PAGE_ROUTES({ home: () => json(403, { status: 403, subStatus: 1002, userMessage: 'Required scopes: r_usr' }) }),
    [/api\.tidal\.com\/v1\/sessions/, () => json(200, { userId: 4242 })],
    [/api\.tidal\.com\/v1\/users\/4242\/playlists/, () => json(200, { totalNumberOfItems: 0, items: [] })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth: refused.auth });
  const v1Root = await provider.getFolder('root', 0, 50);
  assert.deepEqual(v1Root?.items.map((i) => i.id), ['collection', 'playlists', 'mixes']);
  await provider.getFolder('root', 0, 50);
  assert.equal(refused.calls.length, 1, 'the refusal is remembered');
  // Its library stays on v1.
  await provider.getFolder('playlists', 0, 50);
  assert.ok(refused.calls.slice(1).every((c) => c.url.host === 'api.tidal.com'));
});

// ── pages and shelves ──────────────────────────────────────────────────────────

test('a page is a folder of its shelves, with their first items as sections', async () => {
  const { auth } = fakeAccess(PAGE_ROUTES());
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const home = await provider.getFolder('tidal:home', 0, 50);
  assert.equal(home?.name, 'Home');
  assert.deepEqual(home?.items.map((i) => [i.id, i.name, i.kind, i.items]), [
    ['page-module:home:0', 'Suggested new albums for you', 'category', 5],
    ['page-module:home:1', 'Recommended new tracks', 'category', 1],
    ['page-module:home:2', 'Popular playlists on TIDAL', 'category', 3],
    ['page-module:home:5', 'Custom mixes', 'category', 1],
    ['page-module:home:6', 'Spotlight', 'category', 2],
    ['page-module:home:7', 'Artists to follow', 'category', 1],
  ]);
  assert.equal(home?.items[0]?.coverurl, 'https://resources.tidal.com/images/a1b2c3d4/0000/4000/8000/000000000001/320x320.jpg');
  assert.deepEqual(home?.sections?.map((s) => [s.id, s.items.length]), [
    ['page-module:home:0', 2],
    ['page-module:home:1', 1],
    ['page-module:home:2', 2],
    ['page-module:home:5', 1],
    ['page-module:home:6', 2],
    ['page-module:home:7', 1],
  ]);

  const tracks = await provider.getFolder('page-module:home:1', 0, 50);
  assert.deepEqual(tracks?.items.map((i) => [i.audiopath, i.name, i.artist, i.album, i.duration]), [
    ['tidal:track:21', 'Song', 'The Band, Guest', 'Album of Song', 201],
  ]);
  const shelf = await provider.getFolder('page-module:home:2', 0, 50);
  assert.deepEqual(shelf?.items.map((i) => [i.audiopath, i.name, i.owner, i.coverurl]), [
    ['tidal:playlist:11111111-2222-4333-8444-000000000001', 'Hits', 'TIDAL', 'https://resources.tidal.com/images/5a5a5a5a/0000/4000/8000/000000000001/320x320.jpg'],
    ['tidal:playlist:0a1b2c3d4e5f60718293a4b5c6d7e8', 'My Mix 1', 'TIDAL', 'https://images.tidal.com/0a1b2c3d4e5f60718293a4b5c6d7e8/640.jpg'],
  ]);
  const artists = await provider.getFolder('page-module:home:7', 0, 50);
  assert.deepEqual(artists?.items.map((i) => [i.audiopath, i.kind]), [['tidal:artist:12', 'artist']]);
});

test('a truncated shelf pages through its dataApiPath and keeps what it fetched', async () => {
  const { auth, calls } = fakeAccess(PAGE_ROUTES());
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const first = await provider.getFolder('page-module:home:0', 0, 3);
  assert.deepEqual(first?.items.map((i) => i.audiopath), ['tidal:album:1', 'tidal:album:2', 'tidal:album:3']);
  assert.equal(first?.totalitems, 5);
  const data = calls.find((c) => c.url.pathname.includes('/pages/data/'))!.url;
  assert.equal(data.toString().split('?')[0], 'https://tidal.com/v1/pages/data/0000-albums');
  assert.equal(data.searchParams.get('offset'), '2');
  assert.equal(data.searchParams.get('limit'), '1');
  assert.equal(data.searchParams.get('deviceType'), 'BROWSER');

  const rest = await provider.getFolder('page-module:home:0', 3, 3);
  assert.deepEqual(rest?.items.map((i) => i.audiopath), ['tidal:album:4', 'tidal:album:5']);
  assert.equal(calls.filter((c) => c.url.pathname.includes('/pages/data/')).length, 2, 'the first three are not fetched again');

  // When the rest cannot be fetched, the shelf promises only what it holds.
  const failing = fakeAccess(PAGE_ROUTES({ data: () => json(500, {}) }));
  const short = await new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth: failing.auth }).getFolder('page-module:home:0', 0, 50);
  assert.equal(short?.items.length, 2);
  assert.equal(short?.totalitems, 2);
});

test('a page TIDAL refuses is an empty folder, not an error', async () => {
  const { auth } = fakeAccess(PAGE_ROUTES());
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  await provider.getFolder('root', 0, 50);
  const page = await provider.getFolder('new-music', 0, 50);
  assert.deepEqual([page?.name, page?.items, page?.totalitems], ['New Music', [], 0]);
  const module = await provider.getFolder('page-module:new-music:0', 0, 50);
  assert.deepEqual(module?.items, []);
  const root = await provider.getFolder('root', 0, 50);
  assert.ok(root?.items.some((i) => i.id === 'home'), 'one refused page does not take the others away');
});

// ── mixes ──────────────────────────────────────────────────────────────────────

const EMPTY_MIX_COLLECTION: Handler = () => json(200, { data: [], links: { self: '/x' } });

test('a v1 account lists its mixes from the My Mixes page and the official API, and a mix opens through v1', async () => {
  const { auth, calls } = fakeAccess([
    ...PAGE_ROUTES(),
    [/openapi\.tidal\.com\/v2\/userDailyMixes/, () =>
      json(200, {
        data: [{ id: '0a1b2c3d4e5f60718293a4b5c6d7e8', type: 'playlists' }, { id: 'ffeeddccbbaa99887766554433221100', type: 'playlists' }],
        links: { self: '/x' },
        included: [
          { id: '0a1b2c3d4e5f60718293a4b5c6d7e8', type: 'playlists', attributes: { name: 'My Mix 1', playlistType: 'MIX' }, relationships: {} },
          { id: 'ffeeddccbbaa99887766554433221100', type: 'playlists', attributes: { name: 'My Mix 2', playlistType: 'MIX' }, relationships: {} },
        ],
      })],
    [/openapi\.tidal\.com\/v2\/user(Discovery|NewRelease)Mixes/, EMPTY_MIX_COLLECTION],
    [/api\.tidal\.com\/v1\/mixes\/0a1b2c3d4e5f60718293a4b5c6d7e8\/items/, () =>
      json(200, {
        limit: 100,
        offset: 0,
        totalNumberOfItems: 3,
        items: [
          { type: 'track', item: { ...track(31, 'Mixed One'), artist: { name: 'The Band' } } },
          { type: 'video', item: { id: 32, title: 'A Clip' } },
          { type: 'track', item: { ...track(33, 'Mixed Two'), artist: { name: 'The Band' } } },
        ],
      })],
  ]);
  const provider = new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth });
  const mixes = await provider.getFolder('mixes', 0, 50);
  assert.deepEqual(mixes?.items.map((i) => [i.audiopath, i.name, i.owner]), [
    ['tidal:playlist:0a1b2c3d4e5f60718293a4b5c6d7e8', 'My Mix 1', 'TIDAL'],
    ['tidal:playlist:ffeeddccbbaa99887766554433221100', 'My Mix 2', 'TIDAL'],
  ], 'the page first, the same mix from the official API once');
  assert.equal(mixes?.items[0]?.coverurl, 'https://images.tidal.com/0a1b2c3d4e5f60718293a4b5c6d7e8/640.jpg');

  const opened = await provider.getFolder('tidal:playlist:0a1b2c3d4e5f60718293a4b5c6d7e8', 1, 5);
  assert.deepEqual(opened?.items.map((i) => [i.audiopath, i.name]), [['tidal:track:33', 'Mixed Two']]);
  assert.equal(opened?.totalitems, 2, 'videos are not counted');
  assert.ok(!calls.some((c) => c.url.pathname.includes('/v1/playlists/')), 'a mix is not a v1 playlist');
});
