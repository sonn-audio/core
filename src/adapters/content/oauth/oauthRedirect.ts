/**
 * Reading `code` and `state` off the way back from a browser sign-in.
 *
 * Spotify and Tidal both redirect to a fixed public page (sonn-audio.github.io/callbacks/…),
 * because neither accepts the varying LAN address of a self-hosted server as a redirect URI. The
 * `state` sent along is this server's own callback URL, which carries the real state key; the page
 * forwards the browser there with the code appended. Depending on how that page and the browser
 * encoded things, the state arrives as the bare key, as the encoded callback URL, or with
 * `?code=…` glued onto it — this undoes all three.
 */
export function extractCodeAndState(code: string, state: string): { code: string; state: string } {
  let normalizedCode = code?.trim() ?? '';
  let normalizedState = state?.trim() ?? '';

  // Some redirect flows append ?code=... directly onto state
  const stateQueryIdx = normalizedState.indexOf('?code=');
  if (stateQueryIdx >= 0) {
    const embedded = normalizedState.slice(stateQueryIdx + '?code='.length);
    const [codeFromState] = embedded.split('&');
    if (!normalizedCode && codeFromState) {
      normalizedCode = decodeURIComponent(codeFromState);
    }
    normalizedState = normalizedState.slice(0, stateQueryIdx);
  }

  // state may contain the local callback URL; peel off nested params if present
  try {
    const decoded = decodeURIComponent(normalizedState);
    if (decoded.startsWith('http')) {
      const nested = new URL(decoded);
      normalizedState = nested.searchParams.get('state') ?? normalizedState;
      if (!normalizedCode) {
        normalizedCode = nested.searchParams.get('code') ?? normalizedCode;
      }
    }
  } catch {
    /* ignore */
  }

  return { code: normalizedCode, state: normalizedState };
}

/**
 * The redirect a person pasted back: whichever address the browser ended on — the public page
 * (when it could not forward to this server, e.g. a sign-in on a phone) or this server's own
 * callback (when it was not reachable from where they signed in) — or just its query string.
 * Null when it carries neither a code nor an error, i.e. it is not that redirect at all.
 */
export function parsePastedRedirect(
  pasted: string,
): { code?: string; state?: string; error?: string; errorDescription?: string } | null {
  const raw = pasted.trim();
  if (!raw) return null;
  let query: URLSearchParams;
  try {
    query = new URL(raw).searchParams;
  } catch {
    const at = raw.indexOf('?');
    query = new URLSearchParams(at >= 0 ? raw.slice(at + 1) : raw);
  }
  const { code, state } = extractCodeAndState(query.get('code') ?? '', query.get('state') ?? '');
  const error = query.get('error')?.trim() || undefined;
  if (!code && !error) return null;
  return {
    code: code || undefined,
    state: state || undefined,
    error,
    errorDescription: query.get('error_description') ?? undefined,
  };
}
