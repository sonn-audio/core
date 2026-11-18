import { timingSafeEqual } from 'node:crypto';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { UserAccount } from '@/domain/config/types';
import { decryptSecret, encryptSecret, isEncrypted } from '@/application/auth/secretStore';

/**
 * The server's own account store.
 *
 * One list of users backs every place this server authenticates someone — the
 * admin UI and the Subsonic API — rather than each surface carrying its own
 * credentials. In Loxone-integrated mode these accounts sit alongside Miniserver
 * users; in standalone mode, with no Miniserver to ask, they are the only way in.
 *
 * Passwords are recoverable, not hashed. That is forced by Subsonic's
 * salted-token login (`md5(password + salt)`, salt chosen per request):
 * verifying it means computing the same digest, which needs the original.
 * They are encrypted at rest instead — see {@link ../auth/secretStore}.
 */

/** A user without its secret, safe to return from an API or log. */
export type PublicUser = {
  username: string;
  admin: boolean;
  label?: string;
  source: 'local' | 'loxone';
  verifiedAt?: string;
};

function accounts(config: ConfigPort): UserAccount[] {
  const users = config.getConfig().system?.users;
  if (!Array.isArray(users)) {
    return [];
  }
  // Entries without both fields cannot admit anyone; drop them rather than
  // letting a half-written config look like a usable account.
  return users.filter(
    (user): user is UserAccount =>
      Boolean(user) &&
      typeof user.username === 'string' &&
      user.username.trim().length > 0 &&
      typeof user.password === 'string' &&
      user.password.length > 0,
  );
}

export function listUsers(config: ConfigPort): PublicUser[] {
  return accounts(config).map(toPublic);
}

export function hasUsers(config: ConfigPort): boolean {
  return accounts(config).length > 0;
}

export function hasAdminUser(config: ConfigPort): boolean {
  return accounts(config).some((user) => user.admin === true);
}

/**
 * Whether the admin UI asks for a login. Always once an admin account exists here. A server
 * connected to a Miniserver asks too, before any account exists: its Loxone users log in with
 * their Miniserver credentials. Without that, a paired server with no admin account stood open
 * to anyone on the network (#443).
 */
export function isAdminLoginRequired(config: ConfigPort): boolean {
  if (hasAdminUser(config)) return true;
  const audioserver = config.getConfig().system?.audioserver;
  return audioserver?.paired === true && audioserver?.loxoneEnabled === true;
}

function toPublic(user: UserAccount): PublicUser {
  return {
    username: user.username.trim(),
    admin: user.admin === true,
    source: user.source === 'loxone' ? 'loxone' : 'local',
    ...(user.label ? { label: user.label } : {}),
    ...(user.verifiedAt ? { verifiedAt: user.verifiedAt } : {}),
  };
}

/** Look up an account by name. Names are matched case-sensitively, as stored. */
export function findUser(config: ConfigPort, username: string): UserAccount | null {
  const wanted = username.trim();
  if (!wanted) {
    return null;
  }
  return accounts(config).find((user) => user.username.trim() === wanted) ?? null;
}

/**
 * Verify a username/password pair, in constant time with respect to the
 * password so a caller cannot probe it by timing.
 *
 * Returns the account on success, null otherwise — including for an unknown
 * username, which is deliberately indistinguishable from a wrong password.
 */
export function verifyUser(
  config: ConfigPort,
  username: string,
  password: string,
): PublicUser | null {
  const user = findUser(config, username);
  if (!user) {
    return null;
  }
  const stored = decryptSecret(user.password);
  if (stored === null) {
    // Undecryptable (replaced key, tampering): no credential, never a match.
    return null;
  }
  return constantTimeEquals(password, stored) ? toPublic(user) : null;
}

/**
 * The stored password for an account, for callers that must compute a digest
 * over it (the Subsonic salted-token check). Nothing else should read this.
 */
export function storedPassword(config: ConfigPort, username: string): string | null {
  const stored = findUser(config, username)?.password;
  return stored ? decryptSecret(stored) : null;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type SaveUserInput = {
  username: string;
  /** Plaintext; encrypted here. Omit to keep whatever is stored. */
  password?: string;
  admin?: boolean;
  label?: string;
  source?: 'local' | 'loxone';
  verifiedAt?: string;
};

/**
 * Create or update an account. The single write path, so encryption and the
 * "omitted password keeps the stored one" rule live in one place.
 *
 * A stored password that is still plaintext (hand-edited config) is upgraded to
 * ciphertext on any write that touches the entry.
 */
export async function saveUser(config: ConfigPort, input: SaveUserInput): Promise<void> {
  const username = input.username.trim();
  const existing = findUser(config, username);

  let password: string | undefined;
  if (typeof input.password === 'string') {
    password = encryptSecret(input.password);
  } else if (existing?.password) {
    password = isEncrypted(existing.password)
      ? existing.password
      : encryptSecret(existing.password);
  }
  if (!password) {
    throw new Error('a password is required for a new user');
  }

  const admin = typeof input.admin === 'boolean' ? input.admin : existing?.admin === true;
  const label = input.label ?? existing?.label;
  const source = input.source ?? existing?.source ?? 'local';
  const verifiedAt = input.verifiedAt ?? existing?.verifiedAt;

  await config.updateConfig((cfg) => {
    if (!Array.isArray(cfg.system.users)) {
      cfg.system.users = [];
    }
    const next: UserAccount = {
      username,
      password,
      ...(admin ? { admin: true } : {}),
      ...(label ? { label } : {}),
      ...(source === 'loxone' ? { source } : {}),
      ...(verifiedAt ? { verifiedAt } : {}),
    };
    const index = cfg.system.users.findIndex((user) => user?.username?.trim() === username);
    if (index === -1) {
      cfg.system.users.push(next);
    } else {
      cfg.system.users[index] = next;
    }
  });
}

export async function removeUser(config: ConfigPort, username: string): Promise<void> {
  const wanted = username.trim();
  await config.updateConfig((cfg) => {
    cfg.system.users = (cfg.system.users ?? []).filter(
      (user) => user?.username?.trim() !== wanted,
    );
  });
}

export type RememberOutcome = 'created' | 'refreshed' | 'unchanged' | 'skipped-local';

/**
 * Record a Miniserver account whose password was just verified.
 *
 * This exists because a Miniserver login is the *only* moment the server holds
 * that password in the clear — the Miniserver stores a salted hash and can
 * never hand it back. Keeping it (encrypted) is what allows a Subsonic client
 * using salted-token authentication, which is the default in most apps, to
 * authenticate as that Loxone user afterwards.
 *
 * Refreshed on every login, so a password changed in Loxone takes effect after
 * one web-UI login. An account created by hand is left alone: a Loxone login
 * must never silently overwrite a deliberately configured local credential.
 */
export async function rememberLoxoneUser(
  config: ConfigPort,
  username: string,
  password: string,
  options: { admin?: boolean; verifiedAt?: string } = {},
): Promise<RememberOutcome> {
  const existing = findUser(config, username);
  if (existing && existing.source !== 'loxone') {
    return 'skipped-local';
  }
  const unchanged = existing ? decryptSecret(existing.password) === password : false;
  await saveUser(config, {
    username,
    password,
    admin: options.admin ?? existing?.admin === true,
    source: 'loxone',
    verifiedAt: options.verifiedAt,
  });
  if (!existing) {
    return 'created';
  }
  return unchanged ? 'unchanged' : 'refreshed';
}
