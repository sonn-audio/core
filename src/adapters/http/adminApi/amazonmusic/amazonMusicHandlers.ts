import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AmazonMusicAdminPort } from '@/ports/AmazonMusicAdminPort';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

export type AmazonMusicHandlerDeps = {
  log: ComponentLogger;
  /** Amazon Music's sign-in; see AmazonMusicAdminPort. */
  amazonMusicAdmin: AmazonMusicAdminPort;
  readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

/**
 * The sign-in steps for an Amazon Music account.
 *
 * Saving the account is not here: the screen posts the login id to the ordinary streaming-service
 * route, which collects the registration this flow produced.
 */
export function buildAmazonMusicRoutes(deps: AmazonMusicHandlerDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/amazonmusic\/storefronts$/,
      handler: async (_req, res) => deps.sendJson(res, 200, { storefronts: deps.amazonMusicAdmin.storefronts() }),
    },
    {
      method: 'POST',
      pattern: /^\/amazonmusic\/login\/start$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as { country?: unknown } | null;
        if (res.writableEnded) return;
        const country = typeof body?.country === 'string' ? body.country.trim().toUpperCase() : '';
        if (!deps.amazonMusicAdmin.storefronts().some((s) => s.country === country)) {
          deps.sendJson(res, 400, { error: 'amazonmusic-unknown-country' });
          return;
        }
        deps.sendJson(res, 200, deps.amazonMusicAdmin.startLogin(country));
      },
    },
    {
      method: 'POST',
      pattern: /^\/amazonmusic\/login\/finish$/,
      handler: async (req, res) => {
        const body = (await deps.readJsonBody(req, res)) as { loginId?: unknown; url?: unknown } | null;
        if (res.writableEnded) return;
        const loginId = typeof body?.loginId === 'string' ? body.loginId : '';
        const url = typeof body?.url === 'string' ? body.url : '';
        if (!loginId || !url) {
          deps.sendJson(res, 400, { error: 'invalid-payload' });
          return;
        }
        const outcome = await deps.amazonMusicAdmin.finishLogin(loginId, url);
        deps.sendJson(res, outcome.ok ? 200 : 400, outcome.ok ? outcome : { error: `amazonmusic-${outcome.error}`, message: outcome.message });
      },
    },
  ];
}
