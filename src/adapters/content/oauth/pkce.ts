import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE (RFC 7636) for the services that sign in through a browser: Spotify and Tidal.
 *
 * The verifier is random bytes in base64url, i.e. only unreserved characters; `bytes` sets its
 * length (32 bytes → 43 characters, the RFC minimum; 64 → 86).
 */
export function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** The S256 challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function createPkcePair(bytes = 64): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(bytes));
  return { verifier, challenge: pkceChallenge(verifier) };
}
