import { decodeAudiopath } from '@/domain/zones/audiopath';
import { normalizeSpotifyAudiopath } from '@/application/zones/helpers/queueHelpers';

export type ParentContext = {
  parent: string;
  startItem?: string;
  startIndex?: number;
};

type ProviderChecks = {
  providerForAudiopath?: (audiopath: string) => string | null;
};

/**
 * Parents whose path is normalised rather than decoded.
 *
 * YT Music and YouTube are deliberately absent — they were absent when this was four
 * separate `isXParent` checks too, and each site that asks "is this one of the streaming
 * services" still names a slightly different set. Kept as-is here; unifying those sets is a
 * behaviour decision, not a mechanical one.
 */
const NORMALIZED_PARENT_PROVIDERS = ['applemusic', 'deezer', 'tidal', 'amazonmusic', 'soundcloud'];

export function parseParentContext(raw: string): ParentContext | null;
export function parseParentContext(raw: string, providers?: ProviderChecks): ParentContext | null;
export function parseParentContext(raw: string, providers?: ProviderChecks): ParentContext | null {
  const sep = '/parentpath/';
  if (!raw.includes(sep)) {
    return null;
  }
  const idx = raw.indexOf(sep);
  const childRaw = raw.slice(0, idx);
  const parentAndRest = raw
    .slice(idx + sep.length)
    .replace(/\/noshuffle.*$/i, '')
    .replace(/\/\?q&ZW5mb3JjZVVzZXI9dHJ1ZQ.*$/i, '')
    .replace(/\/\?q&[A-Za-z0-9+/=]+$/i, '')
    .replace(/\/+$/, '');
  const lastSlash = parentAndRest.lastIndexOf('/');
  const parentRaw = lastSlash >= 0 ? parentAndRest.slice(0, lastSlash) : parentAndRest;
  const indexPart = lastSlash >= 0 ? parentAndRest.slice(lastSlash + 1) : '';

  const startIndex =
    indexPart && /^\d+$/.test(indexPart) ? Number(indexPart) : undefined;

  const parentProvider =
    providers?.providerForAudiopath?.(parentRaw) ??
    NORMALIZED_PARENT_PROVIDERS.find((provider) => parentRaw.toLowerCase().includes(provider)) ??
    null;
  const isServiceParent =
    parentProvider !== null && NORMALIZED_PARENT_PROVIDERS.includes(parentProvider);
  return {
    parent: isServiceParent
      ? normalizeSpotifyAudiopath(parentRaw)
      : decodeAudiopath(parentRaw),
    // Keep the original provider wrapper (e.g., spotify@bridge:track:...) for the item so routing stays intact.
    startItem: normalizeSpotifyAudiopath(childRaw),
    startIndex,
  };
}
