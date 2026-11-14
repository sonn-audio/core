import type { TidalSession } from '@/domain/config/types';

export type TidalLoginFailure =
  /**
   * No client to sign in as: not SONN_TIDAL_CLIENT_ID in the environment, a client id in the
   * request or the service's config, nor one the image was built with.
   */
  | 'client-required'
  /** Tidal will not run the device flow for the configured client. */
  | 'client-refused'
  /** The sign-in is unknown, finished, or its code ran out; start again. */
  | 'expired'
  | 'failed';

export type TidalLoginStart =
  | {
      ok: true;
      loginId: string;
      mode: 'device';
      userCode: string;
      verificationUri: string;
      /** The verification page with the code filled in; what the "Open" link points at. */
      verificationUriComplete: string;
      expiresIn: number;
      /** Seconds between Tidal polls. */
      interval: number;
    }
  | { ok: false; error: TidalLoginFailure; message: string };

export type TidalLoginStatus =
  | { state: 'pending' }
  | { state: 'done'; userId?: string; userName?: string; countryCode?: string }
  | { state: 'error'; error: TidalLoginFailure; message: string };

/**
 * Signing a Tidal account in, through the device flow only: start hands out a code to approve at
 * link.tidal.com, the background polling finishes it, and status reports how that is going. The
 * session a sign-in produces is held here, keyed by the login id, until the service is saved — the
 * save route collects it, as it does an Amazon Music registration.
 */
export interface TidalAdminPort {
  /**
   * Whether the server provides the client, so the form need not: through SONN_TIDAL_CLIENT_ID
   * (`source: 'env'`) or one the image was built with (`source: 'bundled'`). `envConfigured` keeps
   * its name for consoles that predate `source`; it is true for either.
   */
  clientStatus(): { envConfigured: boolean; source: 'env' | 'bundled' | null };
  startLogin(input: { serviceId?: string; clientId?: string; clientSecret?: string }): Promise<TidalLoginStart>;
  loginStatus(loginId: string): TidalLoginStatus;
  /** The session a finished login produced, handed over once; null when there is none. */
  takeSession(loginId: string): TidalSession | null;
  /** Drop a service's signed-in session (and any login still running for it). */
  logout(input: { serviceId?: string; loginId?: string }): Promise<void>;
}
