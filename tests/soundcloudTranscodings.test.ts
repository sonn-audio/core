import assert from 'node:assert/strict';
import { test } from './testHarness';
import { orderPlayableTranscodings } from '../src/adapters/content/providers/soundcloud/soundcloudStreamService';

const t = (preset: string, protocol: string) => ({ preset, format: { protocol }, url: `u:${preset}:${protocol}` });

test('soundcloud: progressive mp3 first, then hls mp3, then aac', () => {
  const ordered = orderPlayableTranscodings([
    t('aac_160k', 'hls'),
    t('mp3_1_0', 'hls'),
    t('mp3_1_0', 'progressive'),
    t('opus_0_0', 'hls'),
  ]);
  assert.deepEqual(ordered.map((x) => x.url), ['u:mp3_1_0:progressive', 'u:mp3_1_0:hls', 'u:aac_160k:hls']);
});

test('soundcloud: a track offered only as aac is playable', () => {
  assert.equal(orderPlayableTranscodings([t('aac_160k', 'hls'), t('abr_sq', 'hls')]).length, 1);
});

test('soundcloud: encrypted transcodings are never candidates', () => {
  assert.deepEqual(
    orderPlayableTranscodings([t('aac_160k', 'ctr-encrypted-hls'), t('mp3_1_0', 'cbc-encrypted-hls')]),
    [],
  );
});
