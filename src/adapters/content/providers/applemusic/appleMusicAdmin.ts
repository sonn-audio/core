import {
  buildBaseHeaders,
  describeFetchError,
  getConfiguredDeveloperToken,
  scrapeBearerToken,
} from '@/adapters/content/providers/applemusic/appleMusicAuth';
import {
  invalidateWidevineArtifactsCache,
  loadWidevineArtifacts,
  WidevineArtifactsError,
} from '@/adapters/content/providers/applemusic/widevine';
import type { AppleMusicAdminPort, WidevineVerification } from '@/ports/AppleMusicAdminPort';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('Content', 'AppleMusic');

/**
 * Apple Music's management operations, gathered where they are implemented.
 *
 * The cache is dropped before every check on purpose: the screen asks this right after a file was
 * uploaded, and a cached set would report the previous answer.
 */
export const appleMusicAdmin: AppleMusicAdminPort = {
  configuredDeveloperToken: () => getConfiguredDeveloperToken(),

  // The same scrape the provider uses, so a change to Apple's bundle is fixed in one place.
  scrapedDeveloperToken: async () => {
    try {
      const token = await scrapeBearerToken(buildBaseHeaders());
      if (!token) log.warn('apple music sign-in: bearer token not found');
      return token;
    } catch (err) {
      log.warn('apple music sign-in: token fetch failed', { message: describeFetchError(err) });
      return null;
    }
  },

  verifyWidevineArtifacts: async (): Promise<WidevineVerification> => {
    invalidateWidevineArtifactsCache();
    try {
      await loadWidevineArtifacts();
      return { ok: true };
    } catch (err) {
      if (err instanceof WidevineArtifactsError) {
        return { ok: false, code: err.code, details: err.details };
      }
      // Not a verdict about the files — let the caller report it as the failure it is.
      throw err;
    }
  },
};
