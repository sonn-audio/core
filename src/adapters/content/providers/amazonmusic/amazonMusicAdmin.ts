import { randomUUID } from 'node:crypto';
import type { AmazonMusicCredentials } from '@/domain/config/types';
import type { AmazonMusicAdminPort, AmazonMusicLoginOutcome } from '@/ports/AmazonMusicAdminPort';
import { createLogger } from '@/shared/logging/logger';
import {
  AmazonMusicApiError,
  completeRegistration,
  createLogin,
  extractAuthorizationCode,
  registerDevice,
  type PendingLogin,
} from './amazonMusicClient';
import { amazonRegions } from './amazonMusicRegions';

/** Long enough to sign in through a captcha and a one-time code; short enough not to linger. */
const LOGIN_TTL_MS = 30 * 60 * 1000;

type Entry = { login: PendingLogin; createdAt: number; credentials?: AmazonMusicCredentials };

const log = createLogger('Content', 'AmazonMusicAdmin');
const pending = new Map<string, Entry>();

function prune(): void {
  const cutoff = Date.now() - LOGIN_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.createdAt < cutoff) pending.delete(id);
  }
}

export const amazonMusicAdmin: AmazonMusicAdminPort = {
  storefronts: () => amazonRegions().map((region) => ({ country: region.country, name: region.name })),

  startLogin: (country) => {
    prune();
    const login = createLogin(country);
    const loginId = randomUUID();
    pending.set(loginId, { login, createdAt: Date.now() });
    return { loginId, url: login.url };
  },

  finishLogin: async (loginId, landingUrl): Promise<AmazonMusicLoginOutcome> => {
    prune();
    const entry = pending.get(loginId);
    if (!entry) {
      return { ok: false, error: 'expired', message: 'This sign-in has expired. Start it again.' };
    }
    const code = extractAuthorizationCode(landingUrl);
    if (!code) {
      return {
        ok: false,
        error: 'no-code',
        message:
          'That address carries no authorization code. Copy the full address of the page Amazon shows right after signing in (it contains "maplanding").',
      };
    }
    try {
      const credentials = await completeRegistration(await registerDevice(entry.login, code));
      entry.credentials = credentials;
      log.info('amazon music device registered', { country: credentials.country, tier: credentials.tier });
      return {
        ok: true,
        loginId,
        country: credentials.country,
        accountName: credentials.accountName,
        tier: credentials.tier ?? 'free',
      };
    } catch (err) {
      const status = err instanceof AmazonMusicApiError ? err.status : undefined;
      log.warn('amazon music sign-in failed', {
        status,
        message: err instanceof Error ? err.message : String(err),
        body: err instanceof AmazonMusicApiError ? err.body.slice(0, 300) : undefined,
      });
      // A code is single-use: whatever went wrong, this sign-in cannot be finished again.
      pending.delete(loginId);
      return {
        ok: false,
        error: 'rejected',
        message: 'Amazon did not accept this sign-in. Start again and paste the address right after signing in — the code in it expires within minutes.',
      };
    }
  },

  takeCredentials: (loginId) => {
    const entry = pending.get(loginId);
    if (!entry?.credentials) return null;
    pending.delete(loginId);
    return entry.credentials;
  },
};
