import assert from 'node:assert/strict';
import { test } from './testHarness';
import { LoxoneCoverProxy } from '../src/adapters/loxone/coverProxy';

// Covers a Loxone client could not load from where it is: a Sonos speaker's art in the app, any
// http image in the Web UI served over HTTPS (#449). They now go out by way of this server, in the
// form the app retries through the Miniserver: an `imgcache` path with `viaproxy`.

const UUID = '21a199db-01b3-ba0c-ffff4decce15e82a';
const proxy = (uuid: string | null = UUID) =>
  new LoxoneCoverProxy({ host: () => '192.168.1.10', port: 7091, uuid: () => uuid });

const SPEAKER_ART = 'http://192.168.20.34:1400/getaa?s=1&u=x-sonos-spotify%3Aspotify%3Atrack%3A1';

test('an http cover goes out by way of this server, retryable through the Miniserver (#449)', () => {
  const p = proxy();
  const url = new URL(p.clientUrl(SPEAKER_ART));
  assert.equal(url.origin, 'http://192.168.1.10:7091');
  assert.ok(url.pathname.startsWith('/imgcache/'), 'the path the app retries through the proxy');
  assert.equal(url.searchParams.get('viaproxy'), UUID);
  assert.equal(p.resolve(url.pathname + url.search), SPEAKER_ART, 'and it leads back to the original');
});

test('https, inline and empty covers go out as they are, and nothing is wrapped twice', () => {
  const p = proxy();
  for (const cover of ['https://i.scdn.co/image/ab67', 'data:image/png;base64,AAAA', '']) {
    assert.equal(p.clientUrl(cover), cover);
  }
  const once = p.clientUrl(SPEAKER_ART);
  assert.equal(p.clientUrl(once), once);
  assert.equal(proxy(null).clientUrl(SPEAKER_ART), SPEAKER_ART, 'without a uuid there is no retry to offer');
});

test('the cover route only serves what this server handed out', () => {
  const p = proxy();
  const path = new URL(p.clientUrl(SPEAKER_ART)).pathname;
  const [, , signature, encoded] = path.split('/');
  const forged = Buffer.from('http://10.0.0.1/admin', 'utf8').toString('base64url');
  assert.equal(p.resolve(`/imgcache/${signature}/${forged}`), null, 'a signature is for one cover');
  assert.equal(proxy().resolve(path), null, 'another key, another server');
  assert.equal(p.resolve(`/imgcache/${encoded}`), null);
  assert.equal(p.resolve('/audio/1/status'), null);
});

test('every cover field in a payload is rewritten, wherever it sits', () => {
  const p = proxy();
  const out = p.rewrite({
    getroomfavs_result: [{ items: [{ coverurl: SPEAKER_ART, name: SPEAKER_ART }] }],
    audio_event: [{ coverurl: 'https://cdn/x.jpg', thumbnail: SPEAKER_ART }],
  });
  assert.ok(out.getroomfavs_result[0]!.items[0]!.coverurl.includes('/imgcache/'));
  assert.equal(out.getroomfavs_result[0]!.items[0]!.name, SPEAKER_ART, 'only cover fields');
  assert.equal(out.audio_event[0]!.coverurl, 'https://cdn/x.jpg');
  assert.ok(out.audio_event[0]!.thumbnail.includes('/imgcache/'));
});
