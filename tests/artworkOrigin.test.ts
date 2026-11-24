import assert from 'node:assert/strict';
import { test } from './testHarness';
import { artworkOrigin, localImageUrl } from '../src/shared/artworkOrigin';

/**
 * One origin for every image this server hands a client: station icons, custom-radio pictures,
 * library covers and playlist mosaics.
 *
 * The scheme and port exist because a Loxone Web UI served over HTTPS blocks an HTTP image as
 * mixed content. The defaults are the plain gateway the server actually listens on, so an install
 * that never configures them emits exactly the urls it always did.
 */

const HOST = 'sonn.dts.home';

test('without settings the origin is the plain gateway', () => {
  assert.equal(artworkOrigin(HOST), `http://${HOST}:7090`);
  assert.equal(artworkOrigin(HOST, {}), `http://${HOST}:7090`);
  assert.equal(artworkOrigin(HOST, { protocol: 'http' }), `http://${HOST}:7090`);
});

test('https on the default TLS port is emitted without a port', () => {
  assert.equal(artworkOrigin(HOST, { protocol: 'https' }), `https://${HOST}`);
  assert.equal(artworkOrigin(HOST, { protocol: 'https', port: 443 }), `https://${HOST}`);
});

test('a default port of the chosen scheme is left out', () => {
  assert.equal(artworkOrigin(HOST, { protocol: 'http', port: 80 }), `http://${HOST}`);
});

test('a custom port is kept', () => {
  assert.equal(artworkOrigin(HOST, { protocol: 'https', port: 8443 }), `https://${HOST}:8443`);
  assert.equal(artworkOrigin(HOST, { protocol: 'http', port: 8080 }), `http://${HOST}:8080`);
});

test('unusable values fall back to the scheme default', () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    assert.equal(
      artworkOrigin(HOST, { protocol: 'https', port }),
      `https://${HOST}`,
      `port ${port} should fall back to 443`,
    );
  }
  assert.equal(artworkOrigin(HOST, { protocol: 'ftp' as never, port: 443 }), `http://${HOST}:443`);
});

test('an empty host is the loopback the server always used', () => {
  assert.equal(artworkOrigin(''), 'http://127.0.0.1:7090');
  assert.equal(artworkOrigin('   '), 'http://127.0.0.1:7090');
});

test('station icons follow the origin', () => {
  assert.equal(
    localImageUrl('/assets/icons', HOST, { protocol: 'https', port: 443 }),
    `https://${HOST}/assets/icons`,
  );
  assert.equal(
    localImageUrl('/assets/icons/radioparadise-logo-main.png', HOST, { protocol: 'https', port: 443 }),
    `https://${HOST}/assets/icons/radioparadise-logo-main.png`,
  );
});

test('a custom radio picture keeps its path and cache-busting tag', () => {
  assert.equal(
    localImageUrl('/music/customradio/known.png?cb=1700000000000', HOST, {
      protocol: 'https',
      port: 443,
    }),
    `https://${HOST}/music/customradio/known.png?cb=1700000000000`,
  );
});

test('a library cover keeps its path and cache-busting tag', () => {
  assert.equal(
    localImageUrl('/music/Artist/Album/cover.jpg?cb=12', HOST, { protocol: 'https', port: 443 }),
    `https://${HOST}/music/Artist/Album/cover.jpg?cb=12`,
  );
});

test('a playlist mosaic follows the origin', () => {
  assert.equal(
    localImageUrl('/music/collage/abc123.jpg', HOST, { protocol: 'https', port: 443 }),
    `https://${HOST}/music/collage/abc123.jpg`,
    'mosaic covers are the same /music tree',
  );
});

test('a path without a leading slash is still a path', () => {
  assert.equal(localImageUrl('music/x.jpg', HOST), `http://${HOST}:7090/music/x.jpg`);
});
