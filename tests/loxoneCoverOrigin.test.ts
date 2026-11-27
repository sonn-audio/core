import assert from 'node:assert/strict';
import { test } from './testHarness';
import { buildLoxoneCoverUrl } from '../src/adapters/loxone/ws/zoneStateProjection';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ArtworkOriginSettings } from '../src/shared/artworkOrigin';

// Which cover urls the Loxone client may fetch directly, and which have to go through this
// server's cover route.
//
// Artwork the gateway serves itself — station icons, library files, playlist collages, custom
// station covers — is already fetchable and must be handed out as-is. Everything else is proxied
// through `/api/v1/zones/<id>/cover`, because that is what makes a remote cover reachable from a
// client on another network and what gives the url an ETag.
//
// Measured on 2026-11-27, on an install configured `artworkProtocol: https` / `artworkPort: 443`:
// a Radio Paradise station icon is `https://<host>/assets/icons/radioparadise-logo-rock.png`, which
// the old test rejected because it insisted on the literal `:7090`. The url was proxied, sonn
// fetched its own asset back through the reverse proxy, failed, answered 404, and the zone showed
// the *previous* track's artwork until something else replaced it.

const HOST = 'sonn.dts.home';
const HTTPS: ArtworkOriginSettings = { protocol: 'https', port: 443 };

function zone(coverurl: string, id = 2): ZoneState {
  return {
    id,
    name: 'Audioserver Wohnzimmer',
    album: '',
    artist: '',
    audiopath: '',
    audiotype: 5 as never,
    clientState: 'on',
    coverurl,
    duration: 0,
    eq: [] as never,
    mode: 'play',
    plrepeat: 0,
    plshuffle: 0,
    power: 'on',
    qindex: 0,
    sourceName: 'Spotify',
    station: '',
    time: 0,
    title: 'x',
    type: 0 as never,
    volume: 10,
    muted: false,
  };
}

const direct = (coverurl: string, artwork: ArtworkOriginSettings = HTTPS) =>
  buildLoxoneCoverUrl(zone(coverurl), HOST, artwork);
const proxied = (coverurl: string, artwork: ArtworkOriginSettings = HTTPS) =>
  direct(coverurl, artwork).startsWith(`https://${HOST}/api/v1/zones/2/cover?v=`);

// --- the case that broke -----------------------------------------------------------------------

test('a station icon on the configured https origin is handed out directly', () => {
  const url = `https://${HOST}/assets/icons/radioparadise-logo-rock.png`;
  assert.equal(direct(url), url);
  assert.equal(proxied(url), false, 'it must not be routed through the cover proxy');
});

test('an explicit default port is the same origin as an implicit one', () => {
  const explicit = `https://${HOST}:443/assets/icons/radioparadise-logo-rock.png`;
  // Recognised as ours, and emitted on the origin clients were given: the redundant :443 is not
  // carried through, the path is.
  assert.equal(direct(explicit), `https://${HOST}/assets/icons/radioparadise-logo-rock.png`);
  assert.equal(proxied(explicit), false);
});

test('an implicit eighty is the same origin as an explicit one', () => {
  const implicit = `http://${HOST}/assets/icons/radioparadise-logo-main.png`;
  assert.equal(direct(implicit, { protocol: 'http', port: 80 }), implicit);
  assert.equal(proxied(implicit, { protocol: 'http', port: 80 }), false);
});

// --- the other kinds of artwork the gateway hosts ------------------------------------------------

test('library artwork on the configured origin is handed out directly', () => {
  const url = `https://${HOST}/music/library/ab/cd/cover.jpg`;
  assert.equal(direct(url), url);
});

test('a playlist collage on the configured origin is handed out directly', () => {
  const url = `https://${HOST}/music/collage/9f2c1a.jpg`;
  assert.equal(direct(url), url);
});

test('a custom station cover keeps its path and query', () => {
  const url = `https://${HOST}/music/radio/station-7.png?v=17`;
  assert.equal(direct(url), url, 'the cache-busting tag travels with the url');
});

// --- the native gateway is still recognised without any artwork configuration --------------------

test('the plain gateway on its own port is still recognised', () => {
  const url = `http://${HOST}:7090/assets/icons/radioparadise-logo-rock.png`;
  assert.equal(direct(url, {}), `http://${HOST}:7090/assets/icons/radioparadise-logo-rock.png`);
  assert.equal(direct(url, {}).includes('/api/v1/zones/'), false);
});

test('the plain gateway is recognised even when clients are given https', () => {
  // An install that has switched the client-facing origin to https but still has a cached cover
  // url from before: same host, and 7090 is this server's gateway whatever the origin says.
  const url = `http://${HOST}:7090/assets/icons/radioparadise-logo-rock.png`;
  assert.equal(direct(url), `https://${HOST}/assets/icons/radioparadise-logo-rock.png`);
});

// --- and nothing else --------------------------------------------------------------------------

test('genuinely remote artwork still goes through the cover route', () => {
  for (const url of [
    'https://i.scdn.co/image/ab67616d0000b273db687db0afb257abdee10816',
    'https://audio.radioparadise.stream/covers/1056.jpg',
    'https://imageproxy.example/cover.jpg',
  ]) {
    assert.equal(proxied(url), true, `${url} is not this server's artwork`);
  }
});

test('a stale gateway host is rewritten, not proxied', () => {
  // Long-standing behaviour, kept: a cover url minted before the address changed still names this
  // gateway, so the host is replaced and the path is not. Nothing else listens on the gateway port
  // and serves artwork, and the client is sent to our own origin either way.
  const url = 'http://192.168.1.99:7090/music/Other/cover.jpg';
  assert.equal(direct(url), `https://${HOST}/music/Other/cover.jpg`);
});

test('an unrelated host on the configured port is not mistaken for this server', () => {
  const url = `https://not-${HOST}/assets/icons/x.png`;
  assert.equal(proxied(url), true);
});

test('the same host and port over a different scheme is a different origin', () => {
  // `https://h/x` and `https://h:443/x` are one origin; `http://h:443/x` is not that origin, and
  // treating it as ours would hand the client a plain-HTTP url on a TLS port.
  const plainOnTlsPort = `http://${HOST}:443/assets/icons/radioparadise-logo-rock.png`;
  assert.equal(proxied(plainOnTlsPort), true, 'a different scheme is not our artwork');

  // And the same for the HTTP configuration: an https url on port 80 is not that origin either.
  const tlsOnHttpPort = `https://${HOST}:80/assets/icons/radioparadise-logo-rock.png`;
  assert.equal(
    buildLoxoneCoverUrl(zone(tlsOnHttpPort), HOST, { protocol: 'http', port: 80 }).startsWith(
      `http://${HOST}/api/v1/zones/2/cover?v=`,
    ),
    true,
  );
});

test('a data uri goes through the cover route, which can serve it', () => {
  // Embedded artwork has no url a client could fetch; the cover route decodes it instead.
  assert.equal(proxied('data:image/png;base64,iVBORw0KGgo='), true);
});

test('no artwork means no url at all', () => {
  assert.equal(direct(''), '');
  assert.equal(direct('   '), '');
});

test('the cover route carries the zone id it was asked for', () => {
  const url = buildLoxoneCoverUrl(
    zone('https://i.scdn.co/image/abc', 7),
    HOST,
    HTTPS,
  );
  assert.equal(url.startsWith(`https://${HOST}/api/v1/zones/7/cover?v=`), true);
});
