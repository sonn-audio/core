import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from './testHarness';
import { createPkcePair, pkceChallenge } from '../src/adapters/content/oauth/pkce';
import { parsePastedRedirect } from '../src/adapters/content/oauth/oauthRedirect';

// The shared OAuth helpers the Spotify sign-in builds on.

test('a PKCE verifier is 43–128 unreserved characters and its challenge is its S256', () => {
  const { verifier, challenge } = createPkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `length ${verifier.length}`);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  // RFC 7636 appendix B's worked example.
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.notEqual(createPkcePair().verifier, verifier);
});

test('a pasted redirect yields its code and state, whatever form it is pasted in', () => {
  const local = 'http://192.168.1.5:7090/admin/api/spotify/auth/callback?state=content:spotify:abc';
  // A public redirect page that could not forward: state is the encoded local callback.
  const publicPage = `https://example.github.io/callbacks/?${new URLSearchParams({ code: 'C1', state: encodeURIComponent(local) })}`;
  assert.deepEqual(parsePastedRedirect(publicPage), { code: 'C1', state: 'content:spotify:abc', error: undefined, errorDescription: undefined });
  // This server's own callback, unreachable from where the person signed in.
  assert.equal(parsePastedRedirect(`${local}&code=C2`)?.code, 'C2');
  assert.equal(parsePastedRedirect(`${local}&code=C2`)?.state, 'content:spotify:abc');
  // Just the query, or the code glued onto the state.
  assert.equal(parsePastedRedirect('code=C3&state=S3')?.state, 'S3');
  assert.equal(parsePastedRedirect('?state=S4?code=C4')?.code, 'C4');
  assert.equal(parsePastedRedirect('https://x/?error=access_denied&error_description=No&state=S')?.error, 'access_denied');
  assert.equal(parsePastedRedirect('https://example.github.io/callbacks/'), null);
  assert.equal(parsePastedRedirect(''), null);
});
