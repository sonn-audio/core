/**
 * The storefronts Amazon Music runs in, and how each one is reached.
 *
 * An account belongs to one of three backends — NA, EU and FE — and every music call goes to
 * `music.amazon.<tld>/<backend>/api/…`. Which backend, which top-level domain and which
 * marketplace a country uses is not derivable from the country code: the Netherlands is served
 * from `amazon.com` on the EU backend, Austria shares Germany's marketplace, New Zealand
 * Australia's. So it is a table, read off the Android app's own country list.
 */

export type AmazonContinent = 'NA' | 'EU' | 'FE';

export type AmazonRegion = {
  /** ISO 3166-1 alpha-2, as the music API's `musicTerritory`. */
  country: string;
  continent: AmazonContinent;
  marketplaceId: string;
  name: string;
  /** `en_US`-style, as the music API's `locale`/`lang`. */
  locale: string;
  /** `com`, `co.uk`, … — the domain both sign-in and the music API live under. */
  tld: string;
};

type Row = [country: string, marketplaceId: string, name: string, locale: string, tld: string];

const US_MARKETPLACE = 'ATVPDKIKX0DER';

const ROWS: Record<AmazonContinent, Row[]> = {
  NA: [
    ['US', US_MARKETPLACE, 'United States', 'en_US', 'com'],
    ['CA', 'A2EUQ1WTGCTBG2', 'Canada', 'en_CA', 'ca'],
    ['MX', 'A1AM78C64UM0Y8', 'Mexico', 'es_MX', 'com.mx'],
    ['BR', 'A2Q3Y263D00KWC', 'Brazil', 'pt_BR', 'com.br'],
    ['AR', US_MARKETPLACE, 'Argentina', 'es_AR', 'com'],
    ['CL', US_MARKETPLACE, 'Chile', 'es_CL', 'com'],
    ['CO', US_MARKETPLACE, 'Colombia', 'es_CO', 'com'],
  ],
  EU: [
    ['GB', 'A1F83G8C2ARO7P', 'United Kingdom', 'en_GB', 'co.uk'],
    ['DE', 'A1PA6795UKMFR9', 'Germany', 'de_DE', 'de'],
    ['AT', 'A1PA6795UKMFR9', 'Austria', 'de_AT', 'de'],
    ['FR', 'A13V1IB3VIYZZH', 'France', 'fr_FR', 'fr'],
    ['IT', 'APJ6JRA9NG5V4', 'Italy', 'it_IT', 'it'],
    ['ES', 'A1RKKUPIHCS9HS', 'Spain', 'es_ES', 'es'],
    ['NL', 'A1805IZSGTT6HS', 'Netherlands', 'nl_NL', 'com'],
    ['BE', US_MARKETPLACE, 'Belgium', 'fr_BE', 'com'],
    ['LU', US_MARKETPLACE, 'Luxembourg', 'fr_LU', 'com'],
    ['IE', US_MARKETPLACE, 'Ireland', 'en_IE', 'com'],
    ['PL', 'A1C3SOZRARQ6R3', 'Poland', 'pl_PL', 'com'],
    ['SE', 'A2NODRKZP88ZB9', 'Sweden', 'sv_SE', 'com'],
    ['FI', US_MARKETPLACE, 'Finland', 'fi_FI', 'com'],
    ['PT', US_MARKETPLACE, 'Portugal', 'pt_PT', 'com'],
    ['IN', 'A21TJRUUN4KGV', 'India', 'hi_IN', 'in'],
  ],
  FE: [
    ['JP', 'A1VC38T7YXB528', 'Japan', 'ja_JP', 'co.jp'],
    ['AU', 'A39IBJ37TRP1C6', 'Australia', 'en_AU', 'com.au'],
    ['NZ', 'A39IBJ37TRP1C6', 'New Zealand', 'en_NZ', 'com.au'],
  ],
};

const BY_COUNTRY: ReadonlyMap<string, AmazonRegion> = new Map(
  (Object.entries(ROWS) as Array<[AmazonContinent, Row[]]>).flatMap(([continent, rows]) =>
    rows.map(([country, marketplaceId, name, locale, tld]) => [
      country,
      { country, continent, marketplaceId, name, locale, tld },
    ]),
  ),
);

/** The storefront for a country code, or null when Amazon Music is not offered there. */
export function amazonRegion(country: string | undefined | null): AmazonRegion | null {
  return BY_COUNTRY.get((country ?? '').trim().toUpperCase()) ?? null;
}

/** Every supported storefront, for the sign-in screen's country picker. */
export function amazonRegions(): AmazonRegion[] {
  return [...BY_COUNTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** `https://music.amazon.<tld>/<backend>/api/` for a storefront. */
export function musicApiBase(region: AmazonRegion): string {
  return `https://music.amazon.${region.tld}/${region.continent}/api/`;
}
