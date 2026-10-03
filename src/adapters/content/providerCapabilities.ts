/**
 * What each content provider can actually do.
 *
 * One table, so a consumer asks here instead of assuming. It replaces
 * `globalsearch/describe`, which reported Spotify's six search categories for every
 * provider — false for SoundCloud, which has never returned an album from a search, and
 * badly false for YouTube and YT Music, which return tracks and nothing else.
 *
 * Each row below was read off the provider's own `search()` implementation: the keys it
 * assigns on its result object are exactly the kinds it can serve. When a provider gains a
 * category, this table is the second place to change — and a consumer notices, which is the
 * point of declaring it rather than inferring it.
 */
import type { ProviderCapabilities, SearchableKind } from '@/ports/ProviderCapabilities';
import { DEFAULT_CAPABILITIES } from '@/ports/ProviderCapabilities';

const MUSIC: readonly SearchableKind[] = ['track', 'album', 'artist', 'playlist'];

const CAPABILITIES: Record<string, ProviderCapabilities> = {
  // Pathfinder covers music; shows and episodes fall through to the Web API, so all six.
  spotify: {
    browse: true,
    search: [...MUSIC, 'show', 'episode'],
    catalogueExceedsLibrary: true,
  },
  applemusic: { browse: true, search: MUSIC, catalogueExceedsLibrary: true },
  deezer: { browse: true, search: MUSIC, catalogueExceedsLibrary: true },
  tidal: { browse: true, search: MUSIC, catalogueExceedsLibrary: true },
  amazonmusic: { browse: true, search: MUSIC, catalogueExceedsLibrary: true },
  // No album search: the provider's own search assigns tracks, artists and playlists only.
  soundcloud: {
    browse: true,
    search: ['track', 'artist', 'playlist'],
    catalogueExceedsLibrary: true,
  },
  // Both YouTube providers search by scraping, which yields videos — tracks, nothing else.
  ytmusic: { browse: true, search: ['track'], catalogueExceedsLibrary: true },
  youtube: { browse: true, search: ['track'], catalogueExceedsLibrary: true },
  // Music Assistant fronts its own providers, so its catalogue is whatever it has synced.
  musicassistant: { browse: true, search: MUSIC, catalogueExceedsLibrary: false },
  // The local library is the one place the catalogue *is* the collection. Its search
  // declares playlists and folders, but both return empty today, so they are omitted:
  // advertising a category that never yields anything is the mistake this table fixes.
  library: {
    browse: true,
    search: ['track', 'album', 'artist'],
    catalogueExceedsLibrary: false,
  },
  // Stations are the only kind either radio provider has.
  tunein: { browse: true, search: ['radio'], catalogueExceedsLibrary: true },
  radioparadise: { browse: true, search: [], catalogueExceedsLibrary: false },
  // The combined radio tile browses several providers but answers no general search of its
  // own — TuneIn's station search is reached as `tunein`, not through here. Declared rather
  // than left to the default so it reads as a decision.
  radio: { browse: true, search: [], catalogueExceedsLibrary: false },
};

/**
 * What a provider can do, by its provider id.
 *
 * An unknown provider gets {@link DEFAULT_CAPABILITIES} — browsable and unsearchable — so a
 * new provider is under-advertised rather than credited with features it may not have.
 */
export function capabilitiesFor(provider: string | undefined | null): ProviderCapabilities {
  const key = (provider ?? '').trim().toLowerCase();
  return CAPABILITIES[key] ?? DEFAULT_CAPABILITIES;
}

/** Every provider with a declared row, for tests and for describing the whole surface. */
export function declaredProviders(): string[] {
  return Object.keys(CAPABILITIES);
}

/**
 * A provider's search categories in the vocabulary the Loxone app expects.
 *
 * The app's category names are mostly ours, with one exception: it says `station` where we
 * say `radio`. Translating here keeps the wire compatible while the capability itself stays
 * declared in one place.
 */
export function searchCategoriesForLoxone(provider: string): string[] {
  return capabilitiesFor(provider).search.map((kind) => (kind === 'radio' ? 'station' : kind));
}

/**
 * The search categories every one of these providers supports, in Loxone's vocabulary.
 *
 * Needed because the Loxone app has one `spotify` source standing for several bridged
 * services: it knows no other streaming source, so an Apple Music and a SoundCloud account
 * both arrive under that name. Whatever that entry promises must therefore hold for all of
 * them — announcing `show` because real Spotify has podcasts would put a permanently empty
 * tab in front of an Apple Music user.
 *
 * An empty list is the honest answer when the providers have nothing in common.
 */
export function intersectSearchCategories(providers: readonly string[]): string[] {
  if (providers.length === 0) {
    return [];
  }
  const [first, ...rest] = providers;
  let shared = searchCategoriesForLoxone(first!);
  for (const provider of rest) {
    const next = new Set(searchCategoriesForLoxone(provider));
    shared = shared.filter((category) => next.has(category));
  }
  return shared;
}
