import type { TidalSession } from '@/domain/config/types';

/**
 * How the sign-in runs.
 *
 * - `browser`: authorization code + PKCE at login.tidal.com, the flow TIDAL offers apps from
 *   developer.tidal.com. Tidal sends the browser to a fixed public page, which forwards it to this
 *   server's callback; where that cannot reach this server (a sign-in on a phone), the address the
 *   browser ended on is pasted back instead.
 * - `device`: a code to approve at link.tidal.com; only clients TIDAL allows that flow.
 */
export type TidalLoginMode = 'browser' | 'device';

export type TidalLoginFailure =
  /** Tidal will not run this flow for the configured client. */
  | 'client-refused'
  /** The sign-in is unknown, finished, or its code ran out; start again. */
  | 'expired'
  /** The redirect does not belong to this sign-in (wrong or missing `state`). */
  | 'state-mismatch'
  /** The pasted address is not the redirect after signing in. */
  | 'no-code'
  /** The person declined, or Tidal reported an error on the redirect. */
  | 'denied'
  | 'failed';

export type TidalLoginStart =
  | {
      ok: true;
      loginId: string;
      mode: 'browser';
      /** Open this in a new tab to sign in. */
      authorizeUrl: string;
      /** The redirect URI the sign-in uses; it must be registered on the Tidal app as is. */
      redirectUri: string;
      /** This server's callback the public page forwards to. */
      callbackUrl: string;
      /** Seconds before the sign-in is forgotten. */
      expiresIn: number;
    }
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
  | { state: 'done'; userId?: string; userName?: string; countryCode?: string; accessTier?: string }
  | { state: 'error'; error: TidalLoginFailure; message: string };

/**
 * Signing a Tidal account in.
 *
 * Start hands out where to sign in; the redirect (callback or pasted) or the device-flow polling
 * finishes it; status reports how that is going. The PKCE verifier and state stay here, never in
 * the browser, and the session a sign-in produces is held here, keyed by the login id, until the
 * service is saved — the save route collects it, as it does an Amazon Music registration.
 */
export interface TidalAdminPort {
  /**
   * Which client signs in when the form names none: the environment's, or sonn's own app; and the
   * redirect URI a self-registered app needs.
   */
  clientStatus(): { envConfigured: boolean; defaultClientId: string; redirectUri: string };
  startLogin(input: {
    mode: TidalLoginMode;
    serviceId?: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<TidalLoginStart>;
  /** Finish a browser sign-in from the query the public page forwarded to this server's callback. */
  completeCallback(query: URLSearchParams): Promise<TidalLoginStatus>;
  /** Finish a browser sign-in from the address the person's browser ended on, pasted back. */
  completePaste(loginId: string, pastedUrl: string): Promise<TidalLoginStatus>;
  loginStatus(loginId: string): TidalLoginStatus;
  /** The session a finished login produced, handed over once; null when there is none. */
  takeSession(loginId: string): TidalSession | null;
  /** Drop a service's signed-in session (and any login still running for it). */
  logout(input: { serviceId?: string; loginId?: string }): Promise<void>;
}
