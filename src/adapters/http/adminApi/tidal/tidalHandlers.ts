import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TidalAdminPort, TidalLoginMode } from '@/ports/TidalAdminPort';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type TidalHandlerDeps = {
  log: ComponentLogger;
  /** Tidal's sign-in; see TidalAdminPort. */
  tidalAdmin: TidalAdminPort;
  readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  sendHtml: (res: ServerResponse, status: number, html: string) => void;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const MODES: readonly TidalLoginMode[] = ['browser', 'device'];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The page the sign-in tab lands on; the admin UI in the other tab sees the outcome by polling. */
function callbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Signed in to Tidal' : 'Tidal sign-in failed';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>${title}</h1><p>${escapeHtml(message)}</p><p>You can close this tab and return to sonn.</p>
${ok ? '<script>setTimeout(function(){window.close()},1500)</script>' : ''}</body></html>`;
}

/**
 * The sign-in steps for a Tidal account.
 *
 * Saving the account is not here: the screen posts the login id to the ordinary streaming-service
 * route, which collects the session this flow produced.
 */
export function buildTidalRoutes(deps: TidalHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/tidal\/client$/,
      handler: async (_req, res) => deps.sendJson(res, 200, deps.tidalAdmin.clientStatus()),
    },
    {
      method: 'POST',
      pattern: /^\/tidal\/login\/start$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as Record<string, unknown> | null;
        if (res.writableEnded) return;
        const mode = MODES.find((m) => m === body?.mode) ?? 'browser';
        const outcome = await deps.tidalAdmin.startLogin({
          mode,
          serviceId: text(body?.serviceId),
          clientId: text(body?.clientId),
          clientSecret: text(body?.clientSecret),
        });
        if (outcome.ok) {
          deps.sendJson(res, 200, outcome);
          return;
        }
        deps.sendJson(res, outcome.error === 'failed' ? 502 : 400, { error: `tidal-${outcome.error}`, message: outcome.message });
      },
    },
    {
      // Where the public redirect page forwards the browser after login.tidal.com, with the code.
      method: 'GET',
      pattern: /^\/tidal\/auth\/callback$/,
      handler: async (req, res) => {
        const query = new URL(req.url ?? '', 'http://localhost').searchParams;
        const status = await deps.tidalAdmin.completeCallback(query);
        if (status.state === 'done') {
          const who = status.userName ? ` as ${status.userName}` : '';
          deps.sendHtml(res, 200, callbackPage(true, `Signed in${who}. Save the service in sonn to keep it.`));
        } else if (status.state === 'error') {
          deps.sendHtml(res, 400, callbackPage(false, status.message));
        } else {
          deps.sendHtml(res, 200, callbackPage(true, 'Finishing the sign-in…'));
        }
      },
    },
    {
      // The fallback when that forward could not reach this server: the address the browser ended on.
      method: 'POST',
      pattern: /^\/tidal\/login\/finish$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as Record<string, unknown> | null;
        if (res.writableEnded) return;
        const loginId = text(body?.loginId);
        const url = text(body?.url);
        if (!loginId || !url) {
          deps.sendJson(res, 400, { error: 'invalid-payload' });
          return;
        }
        const status = await deps.tidalAdmin.completePaste(loginId, url);
        deps.sendJson(res, status.state === 'error' ? 400 : 200, status);
      },
    },
    {
      method: 'GET',
      pattern: /^\/tidal\/login\/status$/,
      handler: async (req, res) => {
        const loginId = new URL(req.url ?? '', 'http://localhost').searchParams.get('loginId')?.trim() ?? '';
        if (!loginId) {
          deps.sendJson(res, 400, { error: 'invalid-payload' });
          return;
        }
        deps.sendJson(res, 200, deps.tidalAdmin.loginStatus(loginId));
      },
    },
    {
      method: 'POST',
      pattern: /^\/tidal\/logout$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as Record<string, unknown> | null;
        if (res.writableEnded) return;
        const serviceId = text(body?.serviceId);
        const loginId = text(body?.loginId);
        if (!serviceId && !loginId) {
          deps.sendJson(res, 400, { error: 'invalid-payload' });
          return;
        }
        try {
          await deps.tidalAdmin.logout({ serviceId, loginId });
          deps.sendJson(res, 200, { ok: true });
        } catch (err) {
          deps.log.warn('tidal sign-out failed', { serviceId, message: err instanceof Error ? err.message : String(err) });
          deps.sendJson(res, 500, { error: 'tidal-logout-failed' });
        }
      },
    },
  ];
}
