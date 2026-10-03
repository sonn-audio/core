import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { test } from './testHarness';
import {
  buildClientId,
  createLogin,
  extractAuthorizationCode,
  normalizeDevicePrivateKey,
  signDeviceRequest,
  tierFromAccountStatus,
} from '../src/adapters/content/providers/amazonmusic/amazonMusicClient';
import { parseAmazonManifest, pickRepresentation } from '../src/adapters/content/providers/amazonmusic/amazonMusicManifest';
import { AmazonMusicMapper, isCatalogPlaylistId } from '../src/adapters/content/providers/amazonmusic/amazonMusicParsers';
import { amazonRegion, musicApiBase } from '../src/adapters/content/providers/amazonmusic/amazonMusicRegions';
import { buildWidevinePsshFromKid } from '../src/adapters/content/drm/widevine';
import { detectServiceFromAudiopath, isBridgeQueueService, parseTrackAudiopath } from '../src/domain/zones/audiopath';

// ── signing ────────────────────────────────────────────────────────────────────

// Every music call is authenticated by this signature alone, so the one thing worth pinning is
// that it is exactly what Amazon reconstructs: the five fields, newline-joined, under the device
// key — and that the date it signed is the date it sends.
test('a device request is signed over method, path, date, body and token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = new Date('2026-10-03T12:34:56.789Z');
  const headers = signDeviceRequest({
    method: 'post',
    path: '/EU/api/muse/',
    body: '{"a":1}',
    adpToken: '{enc:abc}',
    privateKey,
    now,
  });
  assert.equal(headers['x-adp-token'], '{enc:abc}');
  assert.equal(headers['x-adp-alg'], 'SHA256withRSA:1.0');
  // Base64 has no colon, so the first one separates the signature from the date it covers.
  const header = headers['x-adp-signature']!;
  const signature = header.slice(0, header.indexOf(':'));
  const date = header.slice(header.indexOf(':') + 1);
  assert.equal(date, '2026-10-03T12:34:56.789000Z');
  const payload = `POST\n/EU/api/muse/\n${date}\n{"a":1}\n{enc:abc}`;
  assert.ok(verify('sha256', Buffer.from(payload), publicKey, Buffer.from(signature, 'base64')));
});

// ── sign-in ────────────────────────────────────────────────────────────────────

test('the sign-in URL carries a PKCE challenge for the verifier it keeps', () => {
  const login = createLogin('NL');
  const params = new URL(login.url).searchParams;
  const expected = createHash('sha256')
    .update(login.codeVerifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(params.get('openid.oa2.code_challenge'), expected);
  assert.equal(params.get('openid.oa2.client_id'), `device:${buildClientId(login.serial)}`);
  assert.equal(login.country, 'NL');
  // Outside North America the marketplace is named…
  assert.equal(params.get('marketPlaceId'), 'A1805IZSGTT6HS');
});

test('the US and Australian sign-ins leave the marketplace out', () => {
  assert.equal(new URL(createLogin('US').url).searchParams.get('marketPlaceId'), null);
  assert.equal(new URL(createLogin('AU').url).searchParams.get('marketPlaceId'), null);
});

test('the client id is the hex of serial#deviceType', () => {
  assert.equal(Buffer.from(buildClientId('PIXEL5ABC'), 'hex').toString(), 'PIXEL5ABC#A1DL2DVDQVK3Q');
});

test('a sign-in for a country Amazon Music does not serve is refused up front', () => {
  assert.throws(() => createLogin('ZZ'));
});

test('the authorization code is read from the landing address, and only from there', () => {
  const landing =
    'https://www.amazon.com/ap/maplanding?openid.assoc_handle=amzn_tiburon_na&openid.oa2.authorization_code=ANcode123&openid.mode=id_res';
  assert.equal(extractAuthorizationCode(landing), 'ANcode123');
  assert.equal(extractAuthorizationCode('?openid.oa2.authorization_code=XY'), 'XY');
  assert.equal(extractAuthorizationCode('https://www.amazon.com/ap/signin?foo=bar'), null);
  assert.equal(extractAuthorizationCode(''), null);
});

test('the device key is accepted as bare PKCS#1 or PKCS#8 DER and stored as PEM', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ format: 'der', type: 'pkcs1' }).toString('base64');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  for (const raw of [pkcs1, pkcs8]) {
    const pem = normalizeDevicePrivateKey(raw);
    assert.match(pem, /^-----BEGIN RSA PRIVATE KEY-----/);
  }
  assert.throws(() => normalizeDevicePrivateKey('bm90IGEga2V5'));
});

test('the tier follows the account benefits', () => {
  const benefits = (b: Record<string, string>) => ({ customerAccount: { customerBenefits: b } });
  assert.equal(tierFromAccountStatus(benefits({ HAWKFIRE_KATANA_ACCESS: 'true', HAWKFIRE_PLAYBACK_ACCESS: 'true' })), 'unlimited');
  assert.equal(tierFromAccountStatus(benefits({ PRIME_MUSIC_BROWSE: 'true', PRIME_MUSIC_CONTENT_ACCESS: 'true' })), 'prime');
  assert.equal(tierFromAccountStatus({}), 'free');
});

test('a storefront names its backend and domain', () => {
  assert.equal(musicApiBase(amazonRegion('nl')!), 'https://music.amazon.com/EU/api/');
  assert.equal(musicApiBase(amazonRegion('GB')!), 'https://music.amazon.co.uk/EU/api/');
  assert.equal(musicApiBase(amazonRegion('JP')!), 'https://music.amazon.co.jp/FE/api/');
  assert.equal(amazonRegion('XX'), null);
});

// ── manifest ───────────────────────────────────────────────────────────────────

const KID = '0123456789abcdef0123456789abcdef';
const WEB_PSSH = buildWidevinePsshFromKid(Buffer.from(KID, 'hex')).toString('base64');

const rep = (codecs: string, rate: number, bandwidth: number, url: string, depth?: number) =>
  `<Representation id="${url}" codecs="${codecs}" bandwidth="${bandwidth}" audioSamplingRate="${rate}">` +
  (depth ? `<SupplementalProperty schemeIdUri="amz-music:bitDepth" value="${depth}"/>` : '') +
  `<BaseURL>https://cdn.example/${url}.mp4?ql=${url}&amp;t=1</BaseURL></Representation>`;

const set = (trackType: string, reps: string, withWebPssh = true) =>
  `<AdaptationSet contentType="audio" mimeType="audio/mp4">
    <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc" cenc:default_KID="${KID.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-')}"/>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="AmzMusic-2019"><amz:groupId>KATANA_NL</amz:groupId><cenc:pssh>ENTITLEMENT</cenc:pssh></ContentProtection>
    ${withWebPssh ? `<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>${WEB_PSSH}</cenc:pssh></ContentProtection>` : ''}
    <SupplementalProperty schemeIdUri="amz-music:trackType" value="${trackType}"/>
    ${reps}
  </AdaptationSet>`;

const MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013" xmlns:amz="urn:amazon:music:drm:2019" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static">
  <Period>
    ${set('SD', rep('opus', 48000, 320000, 'SD_HIGH') + rep('opus', 48000, 128000, 'SD_LOW'))}
    ${set('HD', rep('flac', 44100, 1100000, 'HD_44', 16))}
    ${set('HD', rep('flac', 96000, 3000000, 'UHD_96', 24))}
    ${set('3D', rep('ec-3', 48000, 768000, 'SPATIAL_ATMOS_HIGH'))}
  </Period>
</MPD>`;

test('the manifest yields every representation with its codec, rate, depth and key', () => {
  const reps = parseAmazonManifest(MPD);
  assert.equal(reps.length, 5);
  const uhd = reps.find((r) => r.url.includes('UHD_96'))!;
  assert.equal(uhd.url, 'https://cdn.example/UHD_96.mp4?ql=UHD_96&t=1');
  assert.equal(uhd.codec, 'flac');
  assert.equal(uhd.sampleRate, 96000);
  assert.equal(uhd.bitDepth, 24);
  assert.equal(uhd.quality, 'UHD');
  assert.equal(uhd.defaultKid, KID);
  // The web PSSH, never the entitlement one.
  assert.equal(uhd.pssh, WEB_PSSH);
  assert.equal(reps.find((r) => r.codec === 'ec-3')!.spatial, true);
});

test('Unlimited gets the best stereo lossless stream; never the spatial one', () => {
  const picked = pickRepresentation(parseAmazonManifest(MPD), { lossless: true });
  assert.equal(picked?.url.includes('UHD_96'), true);
});

test('a sample-rate ceiling keeps to the stream that fits under it', () => {
  const picked = pickRepresentation(parseAmazonManifest(MPD), { lossless: true, maxSampleRate: 48000 });
  assert.equal(picked?.url.includes('HD_44'), true);
});

test('Prime is held to the best lossy stream it can license', () => {
  const picked = pickRepresentation(parseAmazonManifest(MPD), { lossless: false });
  assert.equal(picked?.codec, 'opus');
  assert.equal(picked?.bandwidth, 320000);
});

test('a manifest with no licensable key offers nothing to play', () => {
  const bare = `<MPD><Period><AdaptationSet>${rep('opus', 48000, 1, 'SD')}</AdaptationSet></Period></MPD>`;
  assert.equal(pickRepresentation(parseAmazonManifest(bare), { lossless: true }), null);
});

// ── mapping ────────────────────────────────────────────────────────────────────

const map = new AmazonMusicMapper('amazonmusic');

test('a looked-up track keeps its nested artist, album and artwork', () => {
  const item = map.track({
    asin: 'B0TRACK001',
    title: 'Song',
    duration: 215,
    artist: { name: 'Artist', asin: 'B0ARTIST01' },
    album: { title: 'Album', asin: 'B0ALBUM001', image: 'https://img/a.jpg' },
  })!;
  assert.equal(item.audiopath, 'amazonmusic:track:B0TRACK001');
  assert.equal(item.artist, 'Artist');
  assert.equal(item.album, 'Album');
  assert.equal(item.coverurl, 'https://img/a.jpg');
  assert.equal(item.duration, 215);
});

test('a search hit and a user-playlist entry map to the same track shape', () => {
  const hit = map.track({ asin: 'B0TRACK002', title: 'Hit', artistName: 'A', albumName: 'B', artOriginal: { artUrl: 'https://img/h.jpg' }, duration: 200000 })!;
  assert.equal(hit.artist, 'A');
  assert.equal(hit.album, 'B');
  assert.equal(hit.coverurl, 'https://img/h.jpg');
  assert.equal(hit.duration, 200, 'milliseconds are read as such');
  const entry = map.track({ metadata: { requestedMetadata: { asin: 'B0TRACK003', title: 'Mine', artistName: 'C', albumCoverImageLarge: 'https://img/m.jpg' } } })!;
  assert.equal(entry.audiopath, 'amazonmusic:track:B0TRACK003');
  assert.equal(entry.coverurl, 'https://img/m.jpg');
  assert.equal(map.track({ title: 'no asin' }), null);
});

test('a user playlist is addressed by its UUID, a catalogue one by its ASIN', () => {
  const uuid = '0b7c5c5e-8a0f-4b56-9d4f-3a2b1c0d9e8f';
  assert.equal(map.playlist({ playlistId: uuid, title: 'Mine', fourSquareImage: { url: 'https://img/p.jpg' } })!.audiopath, `amazonmusic:playlist:${uuid}`);
  assert.equal(isCatalogPlaylistId(uuid), false);
  assert.equal(isCatalogPlaylistId('B07H8QM6PX'), true);
});

// ── service identity ───────────────────────────────────────────────────────────

test('an Amazon Music audiopath is recognised as a queueable streaming service', () => {
  assert.equal(detectServiceFromAudiopath('amazonmusic:track:B0TRACK001'), 'amazonmusic');
  assert.equal(isBridgeQueueService('amazonmusic'), true);
  assert.deepEqual(parseTrackAudiopath('amazonmusic:p0gngd:track:B0TRACK001'), {
    providerKey: 'amazonmusic:p0gngd',
    kind: 'track',
    id: 'B0TRACK001',
    isLibrary: false,
  });
});
