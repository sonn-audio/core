import assert from 'node:assert/strict';
import { test } from './testHarness';
import type { TuneInBrowseResult, TuneInClient } from '../src/adapters/content/providers/tunein/tuneinClient';
import {
  expandPresetOutlines,
  listPlayablePresets,
} from '../src/adapters/content/providers/tunein/tuneinPresets';
import { TuneInProvider } from '../src/adapters/content/providers/tunein/tuneinProvider';

// TuneIn returns an account's presets in three different layouts and we only parsed the
// flat one, so accounts that file favourites in folders — or whose listing arrives grouped
// into "Stations"/"Shows" — came back with nothing at all (issue #362).

const station = (id: string, key?: string): unknown => ({
  type: 'audio',
  item: 'station',
  text: `station ${id}`,
  guide_id: id,
  key: key ?? null,
});

const folder = (id: string, text: string): unknown => ({
  type: 'link',
  text,
  guide_id: id,
  URL: `http://opml.radiotime.com/Browse.ashx?id=${id}`,
});

/** A client whose folders are served from a map, recording which ones were asked for. */
function fakeApi(folders: Record<string, unknown[]>): {
  api: TuneInClient;
  requested: string[];
} {
  const requested: string[] = [];
  const api = {
    browseFolder: async (id: string): Promise<TuneInBrowseResult> => {
      requested.push(id);
      const contents = folders[id];
      if (!contents) throw new Error(`TuneIn request failed: HTTP 404 (${id})`);
      return { title: 'folder', outlines: contents };
    },
  } as unknown as TuneInClient;
  return { api, requested };
}

test('a flat preset listing is passed through untouched', async () => {
  const { api, requested } = fakeApi({});
  const outlines = [station('s1'), station('s2')];
  assert.deepEqual(await expandPresetOutlines(api, outlines, 'user'), outlines);
  assert.deepEqual(requested, [], 'a flat listing needs no extra requests');
});

test('presets filed in folders are fetched and flattened', async () => {
  const { api, requested } = fakeApi({
    f1: [station('s1'), station('s2')],
    f2: [station('s3')],
  });
  const expanded = await expandPresetOutlines(
    api,
    [folder('f1', 'General'), folder('f2', 'Germany')],
    'user',
  );
  assert.deepEqual(
    expanded.map((entry) => (entry as { guide_id: string }).guide_id),
    ['s1', 's2', 's3'],
  );
  assert.deepEqual(requested, ['f1', 'f2']);
});

test('a grouped listing carries its presets in children', async () => {
  const { api } = fakeApi({});
  // TuneIn groups larger accounts into sections that hold the entries inline.
  const expanded = await expandPresetOutlines(
    api,
    [
      { element: 'outline', text: 'Shows (1)', key: 'shows', children: [station('p1')] },
      { element: 'outline', text: 'Stations (2)', key: 'stations', children: [station('s1'), station('s2')] },
    ],
    'user',
  );
  assert.deepEqual(
    expanded.map((entry) => (entry as { guide_id: string }).guide_id),
    ['p1', 's1', 's2'],
  );
});

test('a show link is not mistaken for a folder', async () => {
  const { api, requested } = fakeApi({});
  // Shows are links too, but lead to episodes rather than to presets.
  const show = {
    type: 'link',
    item: 'show',
    guide_id: 'p436',
    URL: 'http://opml.radiotime.com/Tune.ashx?c=pbrowse&id=p436',
  };
  await expandPresetOutlines(api, [show], 'user');
  assert.deepEqual(requested, [], 'following a show would fetch its episodes, not presets');
});

test('one unreachable folder does not cost the account its other presets', async () => {
  const { api, requested } = fakeApi({ f2: [station('s3')] });
  const expanded = await expandPresetOutlines(
    api,
    [folder('f1', 'Broken'), folder('f2', 'Germany')],
    'user',
  );
  assert.deepEqual(
    expanded.map((entry) => (entry as { guide_id: string }).guide_id),
    ['s3'],
  );
  assert.deepEqual(requested, ['f1', 'f2']);
});

test('folder following is bounded so one listing cannot fan out without limit', async () => {
  const many = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`f${i}`, [station(`s${i}`)]]),
  );
  const { api, requested } = fakeApi(many);
  await expandPresetOutlines(
    api,
    Array.from({ length: 30 }, (_, i) => folder(`f${i}`, `folder ${i}`)),
    'user',
  );
  assert.equal(requested.length, 12, 'at most MAX_FOLDER_REQUESTS folders are fetched');
});

test('nested folders stop at the depth limit', async () => {
  const { api, requested } = fakeApi({
    f1: [folder('f2', 'nested')],
    f2: [folder('f3', 'deeper'), station('s1')],
    f3: [station('s2')],
  });
  const expanded = await expandPresetOutlines(api, [folder('f1', 'top')], 'user');
  assert.deepEqual(requested, ['f1', 'f2'], 'the third level is not followed');
  assert.deepEqual(
    expanded.map((entry) => (entry as { guide_id: string }).guide_id),
    ['s1'],
  );
});

test('geo-blocked presets are not listed as playable', () => {
  // TuneIn keeps them in the listing but points them at a spoken "not supported" clip.
  const outlines = [station('s1'), station('s2', 'unavailable'), { type: 'text', text: 'no presets' }];
  assert.deepEqual(listPlayablePresets(outlines).map((preset) => preset.id), ['s1']);
});

test('presets come back in the order the account put them in', () => {
  // Folders are walked in whatever sequence they answered in, which is not the order
  // somebody arranged their favourites in. TuneIn numbers them; that is the order.
  const outlines = [
    { ...(station('s3') as object), preset_number: '3' },
    { ...(station('s1') as object), preset_number: '1' },
    { ...(station('s2') as object), preset_number: '2' },
  ];
  assert.deepEqual(listPlayablePresets(outlines).map((preset) => preset.id), ['s1', 's2', 's3']);
});

test('presets without a number keep their listed order, behind the numbered ones', () => {
  const outlines = [
    station('sA'),
    { ...(station('s1') as object), preset_number: '1' },
    station('sB'),
  ];
  assert.deepEqual(
    listPlayablePresets(outlines).map((preset) => preset.id),
    ['s1', 'sA', 'sB'],
  );
});

test('a preset is described from the listing, without resolving anything', () => {
  const outlines = [
    {
      ...(station('s6707') as object),
      text: 'NPO 3FM',
      subtext: 'Music starts here',
      image: 'http://cdn-profiles.tunein.com/s6707/images/logoq.png',
      bitrate: '192',
      formats: 'aac,mp3',
    },
  ];
  assert.deepEqual(listPlayablePresets(outlines), [
    {
      id: 's6707',
      name: 'NPO 3FM',
      description: 'Music starts here',
      logo: 'http://cdn-profiles.tunein.com/s6707/images/logoq.png',
      bitrate: 192,
      formats: 'aac,mp3',
    },
  ]);
});

test('a logo that is not a url is left off rather than rendered as a broken image', () => {
  const outlines = [{ ...(station('s1') as object), image: 'logoq.png', bitrate: '0' }];
  const [preset] = listPlayablePresets(outlines);
  assert.equal(preset?.logo, undefined);
  assert.equal(preset?.bitrate, undefined);
});

test('without a TuneIn account the presets list is empty, not a stock demo list', async () => {
  const store = { list: async () => [] } as unknown as ConstructorParameters<typeof TuneInProvider>[0];
  const provider = new TuneInProvider(store);
  const folder = await provider.getFolder('local', 'start', 0, 50);
  assert.equal(folder?.totalitems, 0);
  assert.deepEqual(folder?.items, []);
});
