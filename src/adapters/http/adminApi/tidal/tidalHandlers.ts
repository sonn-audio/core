import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TidalAdminPort } from '@/ports/TidalAdminPort';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type TidalHandlerDeps = {
  log: ComponentLogger;
  /** Tidal's sign-in; see TidalAdminPort. */
  tidalAdmin: TidalAdminPort;
  readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The sign-in steps for a Tidal account: the device flow only.
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
        // The device flow is the only one; a request for another (the removed browser sign-in) is refused.
        if (body?.mode !== undefined && body.mode !== 'device') {
          deps.sendJson(res, 400, { error: 'invalid-payload', message: 'Tidal signs in only through the device flow.' });
          return;
        }
        const outcome = await deps.tidalAdmin.startLogin({
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
