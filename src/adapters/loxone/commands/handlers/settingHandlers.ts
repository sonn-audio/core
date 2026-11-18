import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { HandlerFn } from '@/adapters/loxone/commands/types';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import { createLogger } from '@/shared/logging/logger';

/**
 * Settings the Miniserver pushes on every connection, which sonn takes note of but does not act
 * on: `speakertype`, `playeropts`, `groupopts`, `presencemode`, `miniserverip`,
 * `miniserverversion`, `timezone` and `bluetooth/<zone>/visible` (captured from a Miniserver on
 * 17.3.11.12, see docs/loxone-miniserver-map.md). Some carry what the installer set in Loxone
 * Config — AirPlay and Spotify Connect per player in `playeropts` and per group in `groupopts` —
 * but sonn's own settings for those lead.
 *
 * Each is acknowledged, which is what a real Audioserver does with them, rather than answered as
 * not implemented; the payload is logged decoded so a debug log shows what the Miniserver sent.
 */
export function createAcknowledgedSettingHandler(name: string): HandlerFn {
  const log = createLogger('Loxone', 'Settings');
  const prefix = `audio/cfg/${name}/`;
  return (command) => {
    const payload = command.startsWith(prefix) ? command.slice(prefix.length) : '';
    log.debug(`${name} received`, { payload, decoded: payload ? decodeSetting(payload) : undefined });
    return buildResponse(command, name, { success: true });
  };
}

function decodeSetting(payload: string): unknown {
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
