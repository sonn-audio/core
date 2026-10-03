import { createHash, createPrivateKey, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { AmazonMusicCredentials } from '@/domain/config/types';
import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import { amazonRegion, musicApiBase, type AmazonRegion } from './amazonMusicRegions';

/**
 * The Amazon Music API as its Android app speaks it.
 *
 * There is no public API to build on — Amazon's developer programme is invite-only and its terms
 * rule out integrations like this one — so this registers as the app does: an OAuth sign-in that
 * yields a device registration, after which every call is signed with that device's RSA key
 * (`x-adp-signature`) and carries the account's website cookies. Nothing here expires on a
 * schedule; a registration lasts until the account owner removes the device.
 *
 * The protocol was learned from two open-source clients that use it — OrpheusDL's Amazon Music
 * module (sign-in, catalogue, DASH manifests, licences) and the Kodi `amazonmedia` add-on
 * (library playlists, artist pages). Version strings are the app release those were taken from;
 * Amazon has not been seen to reject an older one.
 */

export const AMAZON_DEVICE_TYPE = 'A1DL2DVDQVK3Q';
const APP_VERSION = '22.15.12';
const APP_SOFTWARE_VERSION = '523160014';
const HARLEY_VERSION = '3.12.3.86';
const APP_USER_AGENT = `MusicAndroid/${APP_VERSION}`;
const HARLEY_USER_AGENT = `Harley/${HARLEY_VERSION} ${AMAZON_DEVICE_TYPE}/${APP_VERSION}`;
const WEBVIEW_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 11; Pixel 5 Build/RD2A.211001.002; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Mobile Safari/537.36';
const ASSOC_HANDLE = 'amzn_tiburon_na';
const REQUEST_TIMEOUT_MS = 15_000;

/** What the content tier of an account lets it play. */
export type AmazonMusicTier = NonNullable<AmazonMusicCredentials['tier']>;

export class AmazonMusicApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'AmazonMusicApiError';
  }
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                    */
/* -------------------------------------------------------------------------- */

const base64Url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The device client id Amazon expects: the hex of `<serial>#<deviceType>`. */
export function buildClientId(serial: string): string {
  return Buffer.from(`${serial}#${AMAZON_DEVICE_TYPE}`, 'utf8').toString('hex');
}

export type PendingLogin = {
  url: string;
  codeVerifier: string;
  serial: string;
  country: string;
};

/**
 * The sign-in page a person opens, and what has to be kept to finish it.
 *
 * Amazon's sign-in ends on a `/ap/maplanding` page that shows nothing useful — the app reads the
 * authorization code out of that URL and so must we, which is why the flow asks the person to
 * paste the address they land on rather than redirecting back to us.
 */
export function createLogin(country: string): PendingLogin {
  const region = amazonRegion(country);
  if (!region) {
    throw new Error(`Amazon Music is not available in ${country}`);
  }
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  // The app's serials are a model name and a random hex id; Amazon rejects a bare one.
  const serial = `PIXEL5${randomUUID().replace(/-/g, '').toUpperCase()}`;
  const params = new URLSearchParams({
    'openid.pape.max_auth_age': '0',
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    accountStatusPolicy: 'P1',
    language: region.locale,
    'openid.return_to': 'https://www.amazon.com/ap/maplanding',
    'openid.assoc_handle': ASSOC_HANDLE,
    'openid.oa2.response_type': 'code',
    'openid.mode': 'checkid_setup',
    'openid.ns.pape': 'http://specs.openid.net/extensions/pape/1.0',
    'openid.oa2.code_challenge_method': 'S256',
    'openid.ns.oa2': 'http://www.amazon.com/ap/ext/oauth/2',
    'openid.oa2.code_challenge': codeChallenge,
    'openid.oa2.scope': 'device_auth_access',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.oa2.client_id': `device:${buildClientId(serial)}`,
    disableLoginPrepopulate: '0',
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    forceMobileLayout: 'true',
  });
  // Outside North America the marketplace has to be named — except Australia, whose sign-in
  // answers 404 when it is.
  if (region.continent !== 'NA' && region.country !== 'AU') {
    params.set('marketPlaceId', region.marketplaceId);
  }
  return {
    url: `https://www.amazon.com/ap/signin?${params.toString()}`,
    codeVerifier,
    serial,
    country: region.country,
  };
}

/** The authorization code in the address the sign-in landed on, or null when it carries none. */
export function extractAuthorizationCode(landingUrl: string): string | null {
  const trimmed = (landingUrl || '').trim();
  if (!trimmed) return null;
  let query: string;
  try {
    query = new URL(trimmed).search;
  } catch {
    // A pasted query string on its own is just as good.
    query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?')) : trimmed;
  }
  const code = new URLSearchParams(query).get('openid.oa2.authorization_code');
  return code && code.trim() ? code.trim() : null;
}

/**
 * Normalise the device key Amazon hands out to a PEM a `KeyObject` can be made from.
 *
 * It arrives as bare base64 DER — PKCS#1 in every registration seen, PKCS#8 tolerated — and is
 * stored as PEM so a configuration file says what it holds.
 */
export function normalizeDevicePrivateKey(raw: string): string {
  const value = (raw || '').trim();
  if (value.includes('-----BEGIN')) {
    createPrivateKey(value);
    return value;
  }
  const der = Buffer.from(value, 'base64');
  for (const type of ['pkcs1', 'pkcs8'] as const) {
    try {
      const key = createPrivateKey({ key: der, format: 'der', type });
      return key.export({ format: 'pem', type: 'pkcs1' }).toString();
    } catch {
      // try the next encoding
    }
  }
  throw new Error('Amazon device key is not an RSA private key');
}

/**
 * Register a device with the authorization code from a finished sign-in.
 *
 * Yields everything a configured account keeps except the customer id and tier, which only the
 * music API can tell — see {@link completeRegistration}.
 */
export async function registerDevice(login: PendingLogin, authorizationCode: string): Promise<AmazonMusicCredentials> {
  const region = amazonRegion(login.country);
  if (!region) throw new Error(`Amazon Music is not available in ${login.country}`);
  const body = {
    requested_token_type: ['bearer', 'mac_dms', 'website_cookies', 'store_authentication_cookie'],
    cookies: { website_cookies: [], domain: `.amazon.${region.tld}` },
    registration_data: {
      domain: 'Device',
      app_version: APP_VERSION,
      device_serial: login.serial,
      device_type: AMAZON_DEVICE_TYPE,
      device_name: `sonn ${randomBytes(4).toString('hex')} Android Device (MP3)`,
      os_version: '11',
      software_version: APP_SOFTWARE_VERSION,
      device_model: 'Pixel 5',
      app_name: 'Amazon Music',
    },
    auth_data: {
      client_id: buildClientId(login.serial),
      authorization_code: authorizationCode,
      code_verifier: login.codeVerifier,
      code_algorithm: 'SHA-256',
      client_domain: 'DeviceLegacy',
    },
    requested_extensions: ['device_info', 'customer_info'],
  };
  const res = await fetch(`https://api.amazon.${region.tld}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': WEBVIEW_USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await safeReadText(res, '');
  if (!res.ok) {
    throw new AmazonMusicApiError(`device registration rejected (${res.status})`, res.status, text);
  }
  const json = JSON.parse(text) as any;
  const success = json?.response?.success;
  const tokens = success?.tokens;
  const adpToken = tokens?.mac_dms?.adp_token;
  const privateKey = tokens?.mac_dms?.device_private_key;
  if (typeof adpToken !== 'string' || typeof privateKey !== 'string') {
    throw new AmazonMusicApiError('device registration returned no device credentials', res.status, text.slice(0, 500));
  }
  const websiteCookies: Record<string, string> = {};
  for (const cookie of Array.isArray(tokens?.website_cookies) ? tokens.website_cookies : []) {
    if (cookie?.Name) websiteCookies[String(cookie.Name)] = String(cookie.Value ?? '').replace(/"/g, '');
  }
  const deviceSerial = String(success?.extensions?.device_info?.device_serial_number || login.serial);
  return {
    country: region.country,
    deviceSerial,
    adpToken,
    devicePrivateKey: normalizeDevicePrivateKey(privateKey),
    websiteCookies,
    customerId: '',
    accountName: typeof success?.extensions?.customer_info?.name === 'string' ? success.extensions.customer_info.name : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Signed music API calls                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The signature Amazon checks on every device call.
 *
 * `METHOD\npath\ndate\nbody\nadpToken`, RSA-SHA256 with the device key, sent as `sig:date`. The
 * date is ISO with microseconds, as the Python clients this was learned from send it; Amazon
 * reads it back out of the header, so the precision only has to be consistent.
 */
export function signDeviceRequest(args: {
  method: string;
  path: string;
  body: string;
  adpToken: string;
  privateKey: KeyObject | string;
  now?: Date;
}): Record<string, string> {
  const date = (args.now ?? new Date()).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
  const payload = `${args.method.toUpperCase()}\n${args.path}\n${date}\n${args.body}\n${args.adpToken}`;
  const signature = sign('sha256', Buffer.from(payload, 'utf8'), args.privateKey).toString('base64');
  return {
    'x-adp-token': args.adpToken,
    'x-adp-alg': 'SHA256withRSA:1.0',
    'x-adp-signature': `${signature}:${date}`,
  };
}

/** Which content tier an `isAccountValid` answer grants. */
export function tierFromAccountStatus(status: any): AmazonMusicTier {
  const benefits = status?.customerAccount?.customerBenefits ?? {};
  if (benefits.HAWKFIRE_KATANA_ACCESS === 'true' && benefits.HAWKFIRE_PLAYBACK_ACCESS === 'true') {
    return 'unlimited';
  }
  if (benefits.PRIME_MUSIC_BROWSE === 'true' && benefits.PRIME_MUSIC_CONTENT_ACCESS === 'true') {
    return 'prime';
  }
  return 'free';
}

type CallOptions = { userAgent?: string; extraHeaders?: Record<string, string> };

export class AmazonMusicClient {
  private readonly log = createLogger('Content', 'AmazonMusicApi');
  private readonly region: AmazonRegion;
  private readonly privateKey: KeyObject;

  constructor(private readonly credentials: AmazonMusicCredentials) {
    const region = amazonRegion(credentials.country);
    if (!region) {
      throw new Error(`Amazon Music is not available in ${credentials.country}`);
    }
    this.region = region;
    this.privateKey = createPrivateKey(credentials.devicePrivateKey);
  }

  public get territory(): string {
    return this.region.country;
  }

  public get tier(): AmazonMusicTier {
    return this.credentials.tier ?? 'unlimited';
  }

  /** POST to `music.amazon.<tld>/<backend>/api/<service>/`, signed as this device. */
  public async call<T = any>(service: string, target: string, data: unknown, options: CallOptions = {}): Promise<T> {
    const url = new URL(`${service.replace(/\/+$/, '')}/`, musicApiBase(this.region));
    const body = JSON.stringify(data);
    const headers: Record<string, string> = {
      'User-Agent': options.userAgent ?? APP_USER_AGENT,
      'Accept-Language': 'en-US',
      'x-requested-with': 'com.amazon.mp3',
      'android-app-version': APP_VERSION,
      'content-encoding': 'amz-1.0',
      accept: 'application/json',
      'accept-charset': 'utf-8',
      'content-type': 'application/json; charset=UTF-8',
      'x-amz-target': target,
      'x-amz-requestid': randomUUID(),
      ...signDeviceRequest({
        method: 'POST',
        path: url.pathname + url.search,
        body,
        adpToken: this.credentials.adpToken,
        privateKey: this.privateKey,
      }),
      ...(options.extraHeaders ?? {}),
    };
    const cookie = Object.entries(this.credentials.websiteCookies ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    if (cookie) headers.cookie = cookie;

    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await safeReadText(res, '');
    if (!res.ok) {
      this.log.warn('amazon music call rejected', { target, status: res.status, body: text.slice(0, 300) });
      throw new AmazonMusicApiError(`${target.split('.').pop()} rejected (${res.status})`, res.status, text);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AmazonMusicApiError(`${target.split('.').pop()} returned no JSON`, res.status, text.slice(0, 300));
    }
  }

  private get device() {
    return { deviceId: this.credentials.deviceSerial, deviceType: AMAZON_DEVICE_TYPE };
  }

  /** Bind this device to the account's music entitlement; returns the customer id. */
  public async authorizeDevice(): Promise<string> {
    const resp = await this.call('stratus', 'com.amazon.stratus.StratusServiceExternal.authorizeDevice', {
      capabilities: ['RETRIEVE_OWNED_CONTENT', 'RETRIEVE_ROBIN_CONTENT'],
      customerInfo: { customerId: '', ...this.device },
      ...this.device,
      targetDeviceId: this.credentials.deviceSerial,
      targetDeviceType: AMAZON_DEVICE_TYPE,
    });
    const customerId = resp?.device?.customerId;
    if (typeof customerId !== 'string' || !customerId) {
      throw new AmazonMusicApiError('device authorisation returned no customer', 200, JSON.stringify(resp).slice(0, 300));
    }
    return customerId;
  }

  public async accountStatus(): Promise<any> {
    return this.call('stratus', 'com.amazon.stratus.StratusServiceExternal.isAccountValid', {
      customerId: this.credentials.customerId,
      ...this.device,
      ipAddress: null,
      verbose: true,
    });
  }

  /** Full metadata for tracks, albums, artists and catalogue playlists, by ASIN. */
  public async lookup(asins: string[]): Promise<{
    trackList?: any[];
    albumList?: any[];
    artistList?: any[];
    playlistList?: any[];
  }> {
    return this.call('muse', 'com.amazon.musicensembleservice.MusicEnsembleService.lookup', {
      allowedParentalControls: { hasExplicitLanguage: true },
      asins,
      features: [
        'expandTracklist',
        'fullAlbumDetails',
        'popularity',
        'trackLibraryAvailability',
        'collectionLibraryAvailability',
        'playlistLibraryAvailability',
      ],
      lang: this.region.locale,
      ...this.device,
      musicTerritory: this.region.country,
      requestedContent: 'FULL_CATALOG',
    });
  }

  /** Catalogue search; one result list per requested document type (`catalog_track`, …). */
  public async search(query: string, types: string[], limit: number): Promise<Record<string, any[]>> {
    const resp = await this.call(
      'textsearch/search/v1_1',
      'com.amazon.tenzing.textsearch.v1_1.TenzingTextSearchServiceExternalV1_1.search',
      {
        customerIdentity: {
          customerId: this.credentials.customerId,
          ...this.device,
          musicRequestIdentityContextToken: null,
          sessionId: '123-1234567-5555555',
        },
        explain: null,
        features: {
          spellCorrection: { accepted: null, allowCorrection: true, rejected: null },
          spiritual: null,
          upsell: { allowUpsellForCatalogContent: false },
        },
        locale: this.region.locale,
        musicTerritory: this.region.country,
        query,
        queryMetadata: null,
        resultSpecs: types.map((type) => ({
          contentRestrictions: {
            allowedParentalControls: { hasExplicitLanguage: true },
            assetQuality: { quality: [] },
            contentTier: this.region.country === 'IN' || this.tier === 'prime' ? 'PRIME' : 'UNLIMITED',
            eligibility: null,
          },
          documentSpecs: [
            {
              fields: ['__default', 'parentalControls.hasExplicitLanguage', 'contentTier', 'artOriginal', 'contentEncoding'],
              filters: null,
              type,
            },
          ],
          label: type,
          maxResults: Math.max(1, Math.min(limit, 100)),
          pageToken: null,
          topHitSpec: null,
        })),
      },
    );
    const out: Record<string, any[]> = {};
    for (const category of Array.isArray(resp?.results) ? resp.results : []) {
      const label = String(category?.label ?? '');
      if (!label) continue;
      out[label] = (Array.isArray(category?.hits) ? category.hits : [])
        .map((hit: any) => hit?.document)
        .filter((doc: any) => doc && typeof doc === 'object');
    }
    return out;
  }

  /** A catalogue playlist and its tracks, for when a lookup does not expand it. */
  public async catalogPlaylist(asin: string): Promise<any | null> {
    const resp = await this.call('playlists', 'com.amazon.musicplaylist.model.MusicPlaylistService.getCatalogPlaylistByAsin', {
      asin,
      contentEncoding: true,
      customerInfo: { customerId: '', ...this.device },
      musicTerritory: this.region.country,
    });
    return resp?.playlist ?? resp ?? null;
  }

  /** A user playlist (UUID) and its tracks. */
  public async playlistsById(ids: string[]): Promise<any[]> {
    const resp = await this.call('playlists', 'com.amazon.musicplaylist.model.MusicPlaylistService.getPlaylistsByIdV2', {
      contentEncoding: true,
      customerInfo: { customerId: '', ...this.device },
      featureSet: ['SUPPORT_MIXED_ID_TYPES', 'INCLUDE_FOLLOWER_COUNT'],
      playlistIds: ids,
      requestedMetadata: [
        'asin',
        'title',
        'artistName',
        'artistAsin',
        'albumName',
        'albumAsin',
        'duration',
        'trackNum',
        'discNum',
        'albumCoverImageLarge',
        'albumCoverImageFull',
        'status',
        'primeStatus',
        'isMusicSubscription',
      ],
    });
    return Array.isArray(resp?.playlists) ? resp.playlists : [];
  }

  /** The account's own playlists. */
  public async ownedPlaylists(offset: number, pageSize: number): Promise<any[]> {
    const resp = await this.call('playlists', 'com.amazon.musicplaylist.model.MusicPlaylistService.getOwnedPlaylistsInLibrary', {
      entryOffset: offset,
      pageSize,
      ...this.device,
      musicTerritory: this.region.country,
      customerId: this.credentials.customerId,
    });
    return Array.isArray(resp?.playlists) ? resp.playlists : [];
  }

  /** Playlists the account follows (catalogue and shared). */
  public async followedPlaylists(offset: number, pageSize: number): Promise<any[]> {
    const resp = await this.call('playlists', 'com.amazon.musicplaylist.model.MusicPlaylistService.getFollowedPlaylistsInLibrary', {
      optIntoSharedPlaylists: true,
      entryOffset: offset,
      pageSize,
      ...this.device,
      musicTerritory: this.region.country,
      customerId: this.credentials.customerId,
    });
    return Array.isArray(resp?.playlists) ? resp.playlists : [];
  }

  /** An artist's albums, most popular first. */
  public async artistAlbums(asin: string, maxCount: number): Promise<any[]> {
    const resp = await this.call('muse/artistDetailsMetadata', 'com.amazon.musicensembleservice.MusicEnsembleService.artistDetailsMetadata', {
      requestedContent: this.tier === 'unlimited' ? 'MUSIC_SUBSCRIPTION' : 'PRIME',
      asin,
      types: [{ sortBy: 'popularity-rank', type: 'album', maxCount, nextToken: null }],
      features: ['popularity'],
      ...this.device,
      musicTerritory: this.region.country,
      customerId: this.credentials.customerId,
    });
    return Array.isArray(resp?.albumList) ? resp.albumList : [];
  }

  /** The DASH manifest (MPD XML) for a track, or null when Amazon will not serve it here. */
  public async dashManifest(asin: string): Promise<string | null> {
    const resp = await this.call(
      'dmls/getDashManifestsV2',
      'com.amazon.digitalmusiclocator.DigitalMusicLocatorServiceExternal.getDashManifestsV2',
      {
        appInfo: { musicAgent: `Harley/${HARLEY_VERSION} Harley/${APP_VERSION} ( ${randomUUID()} ${asin} )` },
        contentIdList: [{ identifier: asin, identifierType: 'ASIN' }],
        contentProtectionList: ['GROUP_PSSH', 'TRACK_PSSH'],
        customerInfo: {
          entitlementList: ['NIGHTWING', 'SONIC_RUSH', 'HAWKFIRE', 'ROBIN', 'KATANA', 'MERCURY'],
          marketplaceId: this.region.marketplaceId,
          territoryId: this.region.country,
        },
        customerId: this.credentials.customerId,
        deviceToken: { deviceId: this.credentials.deviceSerial, deviceTypeId: AMAZON_DEVICE_TYPE },
        musicDashVersionList: ['SIREN_KATANA'],
        try3dAsinSubstitution: false,
        tryAsinSubstitution: true,
      },
      { userAgent: HARLEY_USER_AGENT, extraHeaders: { accept: 'application/json, text/javascript, */*' } },
    );
    const entry = Array.isArray(resp?.contentResponseList) ? resp.contentResponseList[0] : null;
    if (!entry || entry.contentResponseStatusCode !== 'SUCCESS' || typeof entry.manifest !== 'string') {
      this.log.info('amazon music manifest unavailable', {
        asin,
        status: entry?.contentResponseStatusCode,
      });
      return null;
    }
    return entry.manifest;
  }

  /** Exchange a Widevine challenge (base64) for a licence (base64). */
  public async license(asin: string, challenge: string): Promise<string | null> {
    const resp = await this.call(
      'dmls/getLicenseForPlaybackV2',
      'com.amazon.digitalmusiclocator.DigitalMusicLocatorServiceExternal.getLicenseForPlaybackV2',
      {
        DrmType: 'WIDEVINE',
        appInfo: { musicAgent: `Harley/${HARLEY_VERSION} Harley/${APP_VERSION} ( ${randomUUID()} ${asin} )` },
        deviceToken: { deviceId: this.credentials.deviceSerial, deviceTypeId: AMAZON_DEVICE_TYPE },
        licenseChallenge: challenge,
        persistent: false,
      },
      {
        userAgent: WEBVIEW_USER_AGENT,
        extraHeaders: { Origin: `https://music.amazon.${this.region.tld}`, Referer: `https://music.amazon.${this.region.tld}/` },
      },
    );
    return typeof resp?.license === 'string' ? resp.license : null;
  }
}

/**
 * Finish a registration: bind the device to Amazon Music and read the account's tier.
 *
 * Kept apart from {@link registerDevice} because it already speaks the signed music API, which
 * needs the device credentials that registration produced.
 */
export async function completeRegistration(credentials: AmazonMusicCredentials): Promise<AmazonMusicCredentials> {
  const client = new AmazonMusicClient(credentials);
  const customerId = await client.authorizeDevice();
  const withCustomer = { ...credentials, customerId };
  let tier: AmazonMusicTier = 'free';
  try {
    tier = tierFromAccountStatus(await new AmazonMusicClient(withCustomer).accountStatus());
  } catch {
    // The status call is a nicety; an account it cannot read is treated as the most limited.
  }
  return { ...withCustomer, tier };
}
