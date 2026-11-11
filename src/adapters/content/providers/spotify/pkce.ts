import { createPkcePair as createPair } from '@/adapters/content/oauth/pkce';

const pkceState = new Map<string, string>();

export function createPkcePair(stateKey: string): { codeChallenge: string } {
  // 32 bytes: the 43-character verifier Spotify has always been sent.
  const { verifier, challenge } = createPair(32);
  pkceState.set(stateKey, verifier);
  return { codeChallenge: challenge };
}

export function consumePkceVerifier(stateKey: string): string | undefined {
  const verifier = pkceState.get(stateKey);
  if (verifier) {
    pkceState.delete(stateKey);
  }
  return verifier;
}
