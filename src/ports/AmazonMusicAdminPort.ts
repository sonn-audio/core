import type { AmazonMusicCredentials } from '@/domain/config/types';

export type AmazonMusicStorefront = { country: string; name: string };

export type AmazonMusicLoginOutcome =
  | {
      ok: true;
      loginId: string;
      country: string;
      accountName?: string;
      tier: NonNullable<AmazonMusicCredentials['tier']>;
    }
  | {
      ok: false;
      /** `expired`: the sign-in was started too long ago (or never); start again. */
      error: 'expired' | 'no-code' | 'rejected';
      message: string;
    };

/**
 * Signing an Amazon Music account in.
 *
 * Amazon's sign-in cannot redirect back to us — it lands on a page of its own whose address
 * carries the authorization code — so this is two steps with a person in between: start hands out
 * the sign-in URL, finish takes the address they landed on and registers a device with it. The
 * registration is held here, keyed by the login id, until the account is saved; it never travels
 * to the browser, because it is the device's private key.
 */
export interface AmazonMusicAdminPort {
  storefronts(): AmazonMusicStorefront[];
  startLogin(country: string): { loginId: string; url: string };
  finishLogin(loginId: string, landingUrl: string): Promise<AmazonMusicLoginOutcome>;
  /** The registration a finished login produced, handed over once; null when there is none. */
  takeCredentials(loginId: string): AmazonMusicCredentials | null;
}
