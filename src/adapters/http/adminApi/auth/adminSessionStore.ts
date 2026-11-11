import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import {
  AUTH_COOKIE_NAME,
  SESSION_TTL_MS,
  type AdminServerSession,
} from '@/adapters/http/adminApi/auth/types';

// Sessions live next to the config so they survive a server restart — otherwise
// every restart would force a re-login. Random 32-byte ids, same trust level as
// the config file (a LAN admin tool); expired entries are pruned on load.
const SESSIONS_PATH = path.resolve(process.cwd(), 'data', 'sessions.json');

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const cookies: Record<string, string> = {};
  for (const entry of raw.split(';')) {
    const [key, ...rest] = entry.split('=');
    const name = key?.trim();
    if (!name) continue;
    const value = rest.join('=').trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * The session id, from either the `Authorization: Bearer <id>` header or the auth cookie.
 *
 * The cookie is HttpOnly + SameSite=Lax — secure for same-origin use, but a Lax cookie is not sent
 * on cross-site fetch/XHR, so the admin UI of one audioserver cannot call a peer's /admin/api with
 * it. The bearer token (the same session id, returned in the login response body) carries the
 * session cross-origin instead. Same-origin requests keep using the cookie; only cross-server
 * switching needs the token. Header takes precedence so an explicit token always wins.
 */
export function extractSessionId(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  // EventSource/WebSocket can't set headers, so cross-origin streams pass the token as a query
  // param. (It can end up in access logs — acceptable for the LAN admin tool, stream-only use.)
  if (req.url) {
    const q = req.url.indexOf('?');
    if (q >= 0) {
      const token = new URLSearchParams(req.url.slice(q + 1)).get('token');
      if (token?.trim()) {
        return token.trim();
      }
    }
  }
  return parseCookies(req)[AUTH_COOKIE_NAME];
}

export class AdminSessionStore {
  private readonly sessions = new Map<string, AdminServerSession>();

  constructor() {
    this.load();
  }

  /** Best-effort load of persisted sessions, pruning any that already expired. */
  private load(): void {
    try {
      const raw = readFileSync(SESSIONS_PATH, 'utf8');
      const parsed = JSON.parse(raw) as AdminServerSession[];
      const now = Date.now();
      if (Array.isArray(parsed)) {
        for (const s of parsed) {
          if (s && typeof s.id === 'string' && typeof s.expiresAt === 'number' && s.expiresAt > now) {
            this.sessions.set(s.id, s);
          }
        }
      }
    } catch {
      // No file yet / unreadable / malformed → start with no sessions.
    }
  }

  /** Best-effort persist so a restart doesn't invalidate active sessions. */
  private persist(): void {
    try {
      writeFileSync(SESSIONS_PATH, JSON.stringify([...this.sessions.values()]));
    } catch {
      // Non-fatal: a login still works this run, it just won't survive a restart.
    }
  }

  public cleanupExpired(now = Date.now()): void {
    let changed = false;
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  public getFromRequest(req: IncomingMessage): AdminServerSession | null {
    this.cleanupExpired();
    const sessionId = extractSessionId(req);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      this.persist();
      return null;
    }
    return session;
  }

  public create(username: string): AdminServerSession {
    this.cleanupExpired();
    const now = Date.now();
    const session: AdminServerSession = {
      id: randomBytes(32).toString('hex'),
      username,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  public clearFromRequest(req: IncomingMessage): void {
    const sessionId = extractSessionId(req);
    if (!sessionId) return;
    if (this.sessions.delete(sessionId)) this.persist();
  }

  public buildCookie(req: IncomingMessage, session: AdminServerSession): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=${encodeURIComponent(session.id)}`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if ((req.socket as { encrypted?: boolean }).encrypted) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }

  public buildExpiredCookie(req: IncomingMessage): string {
    const parts = [
      `${AUTH_COOKIE_NAME}=`,
      'Path=/admin/api',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if ((req.socket as { encrypted?: boolean }).encrypted) {
      parts.push('Secure');
    }
    return parts.join('; ');
  }
}

export function isPublicAdminApiRoute(pathname: string, method: string): boolean {
  if (method === 'OPTIONS') return true;
  if (pathname === '/info' && method === 'GET') return true;
  // Self-guarding: refuses once an admin exists, so it can only bootstrap the first.
  if (pathname === '/auth/setup' && method === 'POST') return true;
  if (pathname === '/auth/login' && method === 'POST') return true;
  if (pathname === '/auth/logout' && method === 'POST') return true;
  if (pathname === '/auth/me' && method === 'GET') return true;
  if (/^\/spotify\/auth\/callback/.test(pathname)) return true;
  // Read-only list of peer audioservers (LAN-local, low-sensitivity) — the
  // player reads this to discover/switch servers without an admin login.
  if (pathname === '/audioservers' && method === 'GET') return true;
  return false;
}
