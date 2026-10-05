import type { AppleMusicAdminPort } from '@/ports/AppleMusicAdminPort';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ComponentLogger } from '@/shared/logging/logger';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

const MAX_WIDEVINE_PRIVATE_KEY_BYTES = 256 * 1024;
const MAX_WIDEVINE_CLIENT_ID_BYTES = 10 * 1024 * 1024;

export type AppleMusicHandlerDeps = {
  log: ComponentLogger;
  /**
   * Apple Music's management operations; see AppleMusicAdminPort.
   *
   * Injected rather than imported: verifying the CDM reads files off disk, and the provider
   * signalled a bad set by throwing its own error class — which this layer had to know about.
   */
  appleMusicAdmin: AppleMusicAdminPort;
  readBinaryBody: (req: IncomingMessage, res: ServerResponse, maxBytes: number) => Promise<Buffer | null>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendHtml: (res: ServerResponse, status: number, html: string) => void;
};

export function buildAppleMusicRoutes(deps: AppleMusicHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/applemusic\/auth$/,
      handler: async (req, res) => handleAppleMusicAuth(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/applemusic\/widevine\/status$/,
      handler: async (_req, res) => handleAppleMusicWidevineStatus(res, deps),
    },
    {
      method: 'PUT',
      pattern: /^\/applemusic\/widevine\/private-key$/,
      handler: async (req, res) => handleAppleMusicWidevineUpload(req, res, 'privateKey', deps),
    },
    {
      method: 'PUT',
      pattern: /^\/applemusic\/widevine\/client-id$/,
      handler: async (req, res) => handleAppleMusicWidevineUpload(req, res, 'clientId', deps),
    },
  ];
}

async function handleAppleMusicAuth(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  try {
    // Prefer the configured developer token (works with authorize() from any origin); fall back to
    // the scraped web-player token only if it's missing.
    const developerToken = deps.appleMusicAdmin.configuredDeveloperToken() || (await deps.appleMusicAdmin.scrapedDeveloperToken());
    if (!developerToken) {
      deps.sendHtml(res, 500, renderAppleMusicAuthError('Apple Music token unavailable. Try again.'));
      return;
    }
    const html = renderAppleMusicAuthPage({
      developerToken,
      appName: 'Loxone Audio Server',
    });
    deps.sendHtml(res, 200, html);
  } catch (err) {
    deps.log.warn('apple music auth page failed', { err });
    deps.sendHtml(res, 500, renderAppleMusicAuthError('Apple Music token fetch failed.'));
  }
}

async function handleAppleMusicWidevineStatus(
  res: ServerResponse,
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  const files = await readWidevineFileStatus();
  try {
    const verdict = await deps.appleMusicAdmin.verifyWidevineArtifacts();
    if (verdict.ok) {
      deps.sendJson(res, 200, { ok: true, status: 'valid', files });
      return;
    }
    deps.sendJson(res, 200, { ok: false, status: verdict.code, details: verdict.details, files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.sendJson(res, 200, { ok: false, status: 'error', details: [message], files });
  }
}

async function handleAppleMusicWidevineUpload(
  req: IncomingMessage,
  res: ServerResponse,
  kind: 'privateKey' | 'clientId',
  deps: AppleMusicHandlerDeps,
): Promise<void> {
  const maxBytes = kind === 'privateKey' ? MAX_WIDEVINE_PRIVATE_KEY_BYTES : MAX_WIDEVINE_CLIENT_ID_BYTES;
  const body = await deps.readBinaryBody(req, res, maxBytes);
  if (res.writableEnded) return;
  if (!body || body.length === 0) {
    deps.sendJson(res, 400, { error: 'empty-body' });
    return;
  }

  const cdmDir = resolveDataDir('widevine_cdm');
  const targetPath =
    kind === 'privateKey'
      ? join(cdmDir, 'private_key.pem')
      : join(cdmDir, 'client_id.bin');

  try {
    await ensureDir(cdmDir);
    await fs.writeFile(targetPath, body, { mode: 0o600 });
    const verdict = await deps.appleMusicAdmin.verifyWidevineArtifacts();
    const files = await readWidevineFileStatus();
    if (!verdict.ok) {
      deps.sendJson(res, 200, { ok: false, status: verdict.code, details: verdict.details, files });
      return;
    }
    deps.sendJson(res, 200, { ok: true, status: 'valid', files });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('widevine upload failed', { kind, message });
    deps.sendJson(res, 500, { error: 'widevine-upload-failed', message });
  }
}

async function readWidevineFileStatus(): Promise<{
  privateKey: { present: boolean; bytes: number };
  clientId: { present: boolean; bytes: number };
}> {
  const cdmDir = resolveDataDir('widevine_cdm');
  const privatePath = join(cdmDir, 'private_key.pem');
  const clientPath = join(cdmDir, 'client_id.bin');
  const readOne = async (filePath: string): Promise<{ present: boolean; bytes: number }> => {
    try {
      const stat = await fs.stat(filePath);
      return { present: stat.isFile(), bytes: stat.isFile() ? stat.size : 0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { present: false, bytes: 0 };
      }
      return { present: false, bytes: 0 };
    }
  };
  const [privateKey, clientId] = await Promise.all([readOne(privatePath), readOne(clientPath)]);
  return { privateKey, clientId };
}

function renderAppleMusicAuthError(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Apple Music Sign-in</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f0f10; color: #f2f2f2; margin: 0; padding: 24px; }
      .card { max-width: 420px; margin: 8vh auto 0; padding: 24px; background: #1c1c1f; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,.45); }
      h1 { font-size: 20px; margin: 0 0 12px; }
      p { margin: 0 0 16px; color: #bdbdbd; }
      button { appearance: none; border: 0; background: #d92b2b; color: #fff; padding: 10px 16px; border-radius: 8px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Apple Music Sign-in</h1>
      <p>${message}</p>
      <button onclick="window.close()">Close</button>
    </div>
  </body>
</html>`;
}

function renderAppleMusicAuthPage(payload: { developerToken: string; appName: string }): string {
  const developerToken = JSON.stringify(payload.developerToken);
  const appName = JSON.stringify(payload.appName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <title>Apple Music Sign-in</title>
    <style>
      /* Chrome-free and matched to the admin portal theme — this page is embedded in the
         portal's modal, which provides the title, framing and close button. */
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #15181D; color: #EDEEF0; margin: 0; padding: 4px 24px 20px; }
      p { margin: 0 0 18px; color: #9CA3AF; line-height: 1.45; font-size: 14px; }
      .actions { display: flex; gap: 12px; flex-wrap: wrap; }
      button { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 1.8px; font-weight: 700; text-transform: uppercase; padding: 10px 22px; border-radius: 8px; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #9CA3AF; transition: background .15s, color .15s, border-color .15s; }
      button:hover:not(:disabled) { color: #EDEEF0; border-color: rgba(255,255,255,0.25); }
      button.primary { background: #4ADE80; color: #062812; border-color: #4ADE80; }
      button.primary:hover:not(:disabled) { background: #86EFAC; border-color: #86EFAC; }
      button:disabled { opacity: .4; cursor: not-allowed; }
      .status { margin-top: 18px; font-size: 13px; color: #9CA3AF; }
      .status:empty { display: none; }
    </style>
    <script src="https://js-cdn.music.apple.com/musickit/v3/musickit.js" data-web-components async></script>
  </head>
  <body>
    <p>Apple handles the sign-in in a window of its own. Sign in there with your Apple ID; the token is filled in here once you're done.</p>
    <div class="actions">
      <button id="signin" class="primary" disabled>Open Apple sign-in</button>
      <button id="close">Close</button>
    </div>
    <div id="status" class="status">Preparing…</div>
    <script>
      const developerToken = ${developerToken};
      const appName = ${appName};
      const statusEl = document.getElementById('status');
      const signInBtn = document.getElementById('signin');
      const closeBtn = document.getElementById('close');
      let musicInstance = null;
      // The user token as the sign-in popup handed it over; see the musickitloaded handler.
      let popupToken = null;

      function setStatus(text) {
        statusEl.textContent = text;
      }

      // Posts back to the embedder: window.parent when hosted in an iframe (in-portal modal),
      // or window.opener when opened as a separate popup window.
      function authTarget() {
        return (window.parent && window.parent !== window) ? window.parent : window.opener;
      }
      function postToParent(message) {
        const target = authTarget();
        if (!target) return;
        target.postMessage(message, window.location.origin);
      }
      function sendToken(token) {
        if (!token) return;
        postToParent({ type: 'applemusic-token', token });
      }

      function describeError(err) {
        if (!err) return 'unknown error';
        if (typeof err === 'string') return err;
        return err.message || err.name || err.errorCode || err.title || JSON.stringify(err);
      }

      // Decode the developer token's JWT payload so we can surface obvious problems (expiry,
      // wrong token) instead of a generic "sign-in failed" after Apple rejects it.
      function inspectDeveloperToken(token) {
        try {
          const parts = String(token).split('.');
          if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
          const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          const now = Math.floor(Date.now() / 1000);
          if (typeof json.exp === 'number' && json.exp <= now) {
            return { ok: false, reason: 'developer token expired' };
          }
          return { ok: true, payload: json };
        } catch (err) {
          return { ok: false, reason: 'developer token unreadable' };
        }
      }

      // Inside the portal's modal its ✕ closes; a second close button only doubles it.
      if (window.parent && window.parent !== window) closeBtn.hidden = true;
      closeBtn.addEventListener('click', () => {
        postToParent({ type: 'applemusic-auth-close' });
        window.close();
      });
      signInBtn.addEventListener('click', async () => {
        if (!musicInstance) return;
        signInBtn.disabled = true;
        popupToken = null;
        setStatus('Waiting for the Apple window — finish signing in there.');
        try {
          const token = await musicInstance.authorize();
          if (!token) {
            setStatus('Sign-in returned no token. Please try again.');
            signInBtn.disabled = false;
            return;
          }
          setStatus('Signed in. The token has been filled in.');
          sendToken(token);
          setTimeout(() => window.close(), 500);
        } catch (err) {
          // The popup succeeded and only the storefront lookup after it failed: the token is good.
          if (popupToken) {
            setStatus('Signed in. The token has been filled in.');
            sendToken(popupToken);
            setTimeout(() => window.close(), 500);
            return;
          }
          // Surface the real MusicKit error. With the scraped web-player developer token Apple
          // typically rejects authorize() here ("Unauthorized"); a proper developer token is needed.
          console.error('Apple Music sign-in failed', err);
          setStatus('Sign-in failed: ' + describeError(err));
          signInBtn.disabled = false;
        }
      });

      document.addEventListener('musickitloaded', async () => {
        const tokenCheck = inspectDeveloperToken(developerToken);
        if (!tokenCheck.ok) {
          console.error('Apple Music developer token problem', tokenCheck.reason);
          setStatus('Developer token problem: ' + tokenCheck.reason + '. Try again later.');
          return;
        }
        try {
          await MusicKit.configure({
            developerToken,
            app: { name: appName, build: '0.0.0' },
          });
          musicInstance = MusicKit.getInstance();
          // After the popup returns a user token, authorize() looks up the storefront on
          // api.music.apple.com. With the scraped web-player token that lookup is refused from any
          // origin but apple.com ("Storefront Country Code error") and authorize() rejects. The
          // provider never needs that lookup — it asks amp-api itself — so keep the token as the
          // popup hands it over and use it when only the lookup failed.
          musicInstance.addEventListener('userTokenDidChange', (event) => {
            if (event && event.userToken) popupToken = event.userToken;
          });
          signInBtn.disabled = false;
          setStatus(musicInstance.isAuthorized ? 'This browser is already signed in with Apple; opening the sign-in again only fetches the token.' : '');
        } catch (err) {
          console.error('MusicKit init failed', err);
          setStatus('Unable to initialize MusicKit: ' + describeError(err));
        }
      });

      // Report our content height so the embedding modal can size the iframe to fit (no empty space).
      function reportHeight() {
        postToParent({ type: 'applemusic-auth-height', height: Math.ceil(document.body.getBoundingClientRect().height) });
      }
      if (window.ResizeObserver) {
        new ResizeObserver(reportHeight).observe(document.body);
      } else {
        window.addEventListener('load', reportHeight);
      }
    </script>
  </body>
</html>`;
}
