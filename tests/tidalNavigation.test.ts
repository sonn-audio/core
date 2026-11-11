import assert from 'node:assert/strict';
import { test } from './testHarness';
import { TidalProvider } from '../src/adapters/content/providers/tidal/tidalProvider';

// An artist's page and what TIDAL puts beside an artist, an album and a track, for a device-flow
// account: through v1, and through openapi.tidal.com/v2 for the similar albums and tracks v1 lacks.
// Shapes follow live answers of both APIs; ids, names and image ids are made up.

type Handler = (url: URL) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function fakeAccess(routes: Array<[RegExp, Handler]>) {
  const calls: URL[] = [];
  return {
    calls,
    auth: {
      noteQuality: async () => {},
      fetch: async (_id: string, url: URL) => {
        if (!url.searchParams.has('countryCode')) url.searchParams.set('countryCode', 'NL');
        calls.push(url);
        const route = routes.find(([pattern]) => pattern.test(url.toString()));
        if (!route) throw new Error(`unexpected fetch ${url}`);
        return route[1](url);
      },
    },
  };
}

const provider = (access: ReturnType<typeof fakeAccess>) =>
  new TidalProvider({ providerId: 'tidal', serviceId: 'bridge-tidal-1', auth: access.auth });

const paths = (items: Array<{ audiopath?: string; id: string }> | undefined) => (items ?? []).map((i) => i.audiopath ?? i.id);

// ── v1 ─────────────────────────────────────────────────────────────────────────

const v1Track = (id: number, title: string) => ({ id, title, duration: 180, artist: { name: 'The Band' }, artists: [{ id: 77, name: 'The Band' }], album: { id: 500, title: 'Record', cover: 'aaaa-bbbb' } });
const v1Album = (id: number, title: string, type = 'ALBUM') => ({ id, title, type, cover: 'cccc-dddd', artist: { name: 'The Band' }, numberOfTracks: 10 });
const v1Page = (items: unknown[], url: URL, total = items.length) =>
  json(200, { limit: Number(url.searchParams.get('limit')), offset: Number(url.searchParams.get('offset')), totalNumberOfItems: total, items });

const V1_ROUTES: Array<[RegExp, Handler]> = [
  [/api\.tidal\.com\/v1\/artists\/77\/toptracks/, (url) => v1Page([v1Track(1, 'Hit'), v1Track(2, 'Other Hit')], url, 120)],
  [/api\.tidal\.com\/v1\/artists\/77\/albums/, (url) =>
    url.searchParams.get('filter') === 'EPSANDSINGLES'
      ? v1Page([v1Album(31, 'A Single', 'SINGLE'), v1Album(32, 'An EP', 'EP')], url)
      : v1Page([v1Album(21, 'Newest LP'), v1Album(22, 'Debut LP')], url)],
  [/api\.tidal\.com\/v1\/artists\/77\/similar/, (url) => v1Page([{ id: 78, name: 'Friend', picture: 'eeee-ffff' }], url)],
  [/api\.tidal\.com\/v1\/artists\/77\/radio/, (url) => v1Page([v1Track(41, 'Radio One'), v1Track(42, 'Radio Two')], url, 100)],
  [/api\.tidal\.com\/v1\/tracks\/1\/radio/, (url) => v1Page([v1Track(51, 'Track Radio One')], url, 100)],
  [/api\.tidal\.com\/v1\/albums\/21\/tracks/, (url) => {
    const offset = Number(url.searchParams.get('offset'));
    const all = [v1Track(1, 'Hit'), v1Track(3, 'Deep Cut'), v1Track(4, 'Closer')];
    return v1Page(all.slice(offset, offset + Number(url.searchParams.get('limit'))), url, all.length);
  }],
];

test('a v1 artist page lists top tracks, albums, singles, then similar artists and the radio, with sections', async () => {
  const access = fakeAccess(V1_ROUTES);
  const artist = await provider(access).getFolder('tidal:artist:77', 0, 50);
  assert.deepEqual(paths(artist?.items), [
    'tidal:track:1',
    'tidal:track:2',
    'tidal:album:21',
    'tidal:album:22',
    'tidal:album:31',
    'tidal:album:32',
    'artist-similar:77',
    'artist-radio:77',
  ]);
  assert.equal(artist?.totalitems, 8);
  const links = artist!.items.slice(-2);
  assert.deepEqual(links.map((i) => [i.name, i.kind, i.audiopath]), [
    ['Similar Artists', 'category', undefined],
    ['Artist Radio', 'category', undefined],
  ], 'entries, not playable: playing the artist must not queue the radio');
  assert.deepEqual(artist?.sections?.map((s) => [s.id, s.name, s.items.length]), [
    ['artist-top-tracks', 'Top Tracks', 2],
    ['artist-albums', 'Albums', 2],
    ['artist-singles', 'Singles & EPs', 2],
    ['artist-more', 'More', 2],
  ]);
  const top = access.calls.find((u) => u.pathname.endsWith('/toptracks'))!;
  assert.equal(top.searchParams.get('limit'), '10');

  // The next window comes from memory and carries no sections.
  const before = access.calls.length;
  const same = provider(access);
  await same.getFolder('tidal:artist:77', 0, 4);
  const window = await same.getFolder('tidal:artist:77', 4, 4);
  assert.deepEqual(paths(window?.items), ['tidal:album:31', 'tidal:album:32', 'artist-similar:77', 'artist-radio:77']);
  assert.equal(window?.sections, undefined);
  assert.equal(access.calls.length - before, 3, 'the page is asked for once, not per window');
});

test('a v1 account reads similar artists and the artist and track radios from v1', async () => {
  const access = fakeAccess(V1_ROUTES);
  const tidal = provider(access);
  const similar = await tidal.getFolder('artist-similar:77', 0, 20);
  assert.equal(similar?.name, 'Similar Artists');
  assert.deepEqual(similar?.items.map((i) => [i.audiopath, i.name, i.kind]), [['tidal:artist:78', 'Friend', 'artist']]);

  const radio = await tidal.getFolder('tidal:artist-radio:77', 0, 2);
  assert.deepEqual(paths(radio?.items), ['tidal:track:41', 'tidal:track:42']);
  assert.equal(radio?.totalitems, 100);

  const trackRadio = await tidal.getFolder('track-radio:1', 0, 20);
  assert.equal(trackRadio?.name, 'Track Radio');
  assert.deepEqual(paths(trackRadio?.items), ['tidal:track:51']);

  assert.deepEqual(await tidal.getRelatedArtists('tidal:artist:77', 8).then((items) => items.map((i) => i.name)), ['Friend']);
  assert.deepEqual(await tidal.getRelatedArtists('tidal:album:21', 8), [], 'only an artist has related artists');
  assert.ok(access.calls.every((u) => u.host === 'api.tidal.com'));
});

test('an album ends with an entry into its similar albums, on its last page only', async () => {
  const access = fakeAccess(V1_ROUTES);
  const tidal = provider(access);
  const first = await tidal.getFolder('tidal:album:21', 0, 2);
  assert.deepEqual(paths(first?.items), ['tidal:track:1', 'tidal:track:3']);
  assert.equal(first?.totalitems, 3);
  const last = await tidal.getFolder('tidal:album:21', 2, 2);
  assert.deepEqual(last?.items.map((i) => [i.audiopath ?? i.id, i.kind]), [
    ['tidal:track:4', 'track'],
    ['album-similar:21', 'category'],
  ]);
  assert.equal(last?.totalitems, 4);
});

// ── the official API ───────────────────────────────────────────────────────────

const art = (id: string) => ({ id, type: 'artworks', attributes: { files: [{ href: `https://resources.tidal.com/images/${id}/320x320.jpg`, meta: { width: 320 } }] } });
const v2Artist = (id: string, name: string) => ({ id, type: 'artists', attributes: { name }, relationships: { profileArt: { data: [{ id: `art${id}`, type: 'artworks' }] } } });
const v2Album = (id: string, title: string, albumType: string, releaseDate: string) => ({
  id,
  type: 'albums',
  attributes: { title, albumType, releaseDate },
  relationships: { artists: { data: [{ id: '77', type: 'artists' }] }, coverArt: { data: [{ id: `art${id}`, type: 'artworks' }] } },
});
const v2Track = (id: string, title: string) => ({
  id,
  type: 'tracks',
  attributes: { title, duration: 'PT3M' },
  relationships: { artists: { data: [{ id: '77', type: 'artists' }] }, albums: { data: [{ id: '21', type: 'albums' }] } },
});
const INCLUDED = [
  v2Artist('77', 'The Band'),
  v2Album('21', 'Newest LP', 'ALBUM', '2025-04-11'),
  v2Album('60', 'Kindred Record', 'ALBUM', '2024-01-01'),
  v2Track('70', 'Kindred Song'),
  art('art21'),
];

/** A relationship answer: its linkage, the shared `included`, and a cursor when there is a next page. */
const relationship = (pages: Array<Array<[string, string]>>): Handler => (url) => {
  const cursor = url.searchParams.get('page[cursor]');
  const index = cursor ? Number(cursor.slice(1)) : 0;
  const data = (pages[index] ?? []).map(([id, type]) => ({ id, type }));
  const next = index + 1 < pages.length ? `${url.pathname.replace(/^\/v2/, '')}?page%5Bcursor%5D=c${index + 1}` : undefined;
  return json(200, { data, included: INCLUDED, links: { self: url.pathname, ...(next ? { next, meta: { nextCursor: `c${index + 1}` } } : {}) } });
};

const V2_ROUTES: Array<[RegExp, Handler]> = [
  [/\/v2\/albums\/21\/relationships\/similarAlbums/, relationship([[['60', 'albums']]])],
  [/\/v2\/tracks\/1\/relationships\/similarTracks/, relationship([[['70', 'tracks']]])],
];

test('a v1 account reads similar albums and tracks from the official API, which v1 has none of', async () => {
  const access = fakeAccess([...V1_ROUTES, ...V2_ROUTES]);
  const tidal = provider(access);
  assert.deepEqual(paths((await tidal.getFolder('album-similar:21', 0, 20))?.items), ['tidal:album:60']);
  assert.deepEqual(paths((await tidal.getFolder('track-similar:1', 0, 20))?.items), ['tidal:track:70']);
  assert.ok(access.calls.every((u) => u.host === 'openapi.tidal.com'));
  // And the artist page still comes from v1.
  await tidal.getFolder('tidal:artist:77', 0, 50);
  assert.ok(access.calls.slice(2).every((u) => u.host === 'api.tidal.com'));
});
