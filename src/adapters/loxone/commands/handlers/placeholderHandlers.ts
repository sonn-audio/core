import { buildNotImplemented } from '@/adapters/loxone/commands/responses';
import type { HandlerFn } from '@/adapters/loxone/commands/types';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import { createLogger } from '@/shared/logging/logger';

/**
 * Returns a handler that explicitly reports "not implemented" for a command.
 */
export function createPlaceholderHandler(name: string): HandlerFn {
  return (command) =>
    buildNotImplemented(command.replace(/^(audio|secure)\/[^/]+/, name));
}

const GROUPOPTS_PREFIX = 'audio/cfg/groupopts/';

/**
 * `audio/cfg/groupopts/<payload>`: the Miniserver sends it after connecting, longer when a
 * fixed group is configured. What it carries is not known yet, so it is still answered as not
 * implemented, but its whole payload is logged (and, when it decodes, its JSON) so the next
 * debug log shows what is in it.
 */
export function createGroupOptsHandler(): HandlerFn {
  const log = createLogger('Loxone', 'GroupOpts');
  const placeholder = createPlaceholderHandler('groupopts');
  return (command, body) => {
    const payload = command.startsWith(GROUPOPTS_PREFIX) ? command.slice(GROUPOPTS_PREFIX.length) : command;
    log.debug('groupopts received', {
      payload,
      decoded: decodeGroupOpts(payload),
      body: body?.length ? body.toString('utf-8') : undefined,
    });
    return placeholder(command, body);
  };
}

function decodeGroupOpts(payload: string): unknown {
  let segment = payload;
  try {
    segment = decodeURIComponent(payload);
  } catch {
    // keep it as sent
  }
  const asJson = safeJsonParse<unknown>(segment);
  if (asJson !== null) {
    return asJson;
  }
  const base64 = segment.replace(/\/+$/, '');
  if (!/^[A-Za-z0-9+/=_-]+$/.test(base64)) {
    return null;
  }
  return safeJsonParse<unknown>(decodeBase64Segment(base64));
}
