import { parsePlayerIds } from '@/adapters/loxone/commands/utils/loxoneServiceDefaults';
import {
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { buildResponse } from '@/adapters/loxone/commands/responses';
import type { CommandResult, HandlerFn } from '@/adapters/loxone/commands/types';
import { decodeBase64Segment, safeJsonParse } from '@/adapters/loxone/commands/utils/payload';
import type { LoxoneConfigService } from '@/adapters/loxone/services/loxoneConfigService';
import { createLogger } from '@/shared/logging/logger';
import { buildSpotifyAuthLink, deleteSpotifyAccount } from '@/adapters/content/providers/spotify/serviceAuth';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { LoxoneWsNotifier } from '@/adapters/loxone/ws/notifier';

type KeyMaterial = {
  modulusHex: string;
  exponent: number;
  publicKeyPem: string;
};

type JsonWebKey = {
  n?: string;
  e?: string;
};

let keyPair: { publicKey: KeyObject; privateKey: KeyObject } | null = null;
let cachedMaterial: KeyMaterial | null = null;
let cachedPublicPemSpki: string | null = null;

type ConfigHandlerOptions = {
  onRestart?: () => Promise<boolean>;
  notifier: NotifierPort;
  loxoneNotifier?: LoxoneWsNotifier;
  configService: LoxoneConfigService;
  configPort: ConfigPort;
  contentManager: ContentManager;
  spotifyInputService: SpotifyInputService;
};

function hexSerial(value: string | undefined): string {
  return (value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}

/** The device type Loxone Config lists as "Stereo Extension" in its Tree Turbo search. */
const STEREO_EXTENSION_TYPE = 3;

/**
 * The server's extensions the way Loxone Config's search reads them: the ones the Loxone
 * project already has, and the ones added here that it does not have yet.
 *
 * While "Tree Turbo search" is open in Loxone Config, the Miniserver asks `audio/cfg/getconfig`
 * every few seconds and Config goes through `extensions`. It offers the devices the project
 * lacks and leaves out the ones it knows — but only for a device it can read: `type`, `subtype`
 * and `id` have to be numbers. Anything else, a known extension included, it lists as a
 * nameless "Audio zone" waiting to be added.
 */
export function describeExtensions(
  serverSerial: string,
  learned: Array<{ mac: string; name?: string }>,
  announced: string[],
  version: string,
): Array<{ type: number; subtype: number; id: number; mac: string; version: string; name?: string }> {
  const base = hexSerial(serverSerial);
  const names = new Map(learned.map((entry) => [hexSerial(entry.mac), entry.name]));
  const serials = [...names.keys(), ...announced.map(hexSerial).filter((serial) => !names.has(serial))];
  return Array.from(new Set(serials))
    .filter((serial) => serial.length === 12)
    .map((serial) => ({
      type: STEREO_EXTENSION_TYPE,
      subtype: 0,
      // Its place after the server: extensions are numbered from the server's own serial.
      id: base ? Number(BigInt(`0x${serial}`) - BigInt(`0x${base}`)) : 0,
      mac: serial,
      version,
      ...(names.get(serial) ? { name: names.get(serial) } : {}),
    }));
}

/**
 * Implements the core `/audio/cfg/*` command set.
 */
export function createConfigHandlers(config: LoxoneHttpConfig, options: ConfigHandlerOptions) {
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  const keyMaterial = createKeyMaterial();
  const log = createLogger('Loxone', 'ConfigHandlers');
  const notifier = options.notifier;
  const configService = options.configService;
  const configPort = options.configPort;
  const contentManager = options.contentManager;
  const spotifyInputService = options.spotifyInputService;
  const loxoneNotifier = options.loxoneNotifier;

  return {
    ready: handler((command) =>
      buildResponse(command, 'ready', {
        session: Date.now(),
      }),
    ),
    getConfig: handler((command) => {
      const info = configService.getCurrentConfigInfo();
      const system = configPort.getSystemConfig();
      return buildEmptyResponseWithPayload(command, {
        crc32: info.crc32 ?? null,
        extensions: describeExtensions(
          system?.audioserver?.macId || config.macAddress,
          system?.audioserver?.extensions ?? [],
          system?.audioserver?.announcedExtensions ?? [],
          config.firmwareVersionNumber,
        ),
      });
    }),
    getKey: handler((command) =>
      buildEmptyResponseWithPayload(command, [
        { pubkey: keyMaterial.modulusHex, exp: keyMaterial.exponent },
      ]),
    ),
    getKeyFull: handler((command) =>
      buildResponse(command, 'getkey', [{ pubkey: exportPublicKeyPemSpki() }]),
    ),
    identify: handler((command) =>
      buildEmptyResponseWithPayload(command, {
        mac: config.macAddress,
        services: [],
      }),
    ),
    // Named outright: the last segment is the Miniserver's timestamp, not the command (#440).
    miniserverTime: handler((command) => buildResponse(command, 'miniservertime', Date.now())),
    restart: handler(async (command) => {
      loxoneNotifier?.notifyRestart();
      if (!options.onRestart) {
        return buildEmptyResponseWithPayload(command, true);
      }
      const ok = await options.onRestart();
      return buildEmptyResponseWithPayload(command, ok);
    }),
    diagnosis: handler(async (command) => {
      try {
        const cfg = configPort.getConfig();
        return buildResponse(command, 'diagnosis', cfg ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildResponse(command, 'diagnosis', {
          error: 'diagnosis-failed',
          message,
        });
      }
    }),
    setConfig: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'setconfig', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<unknown>(decoded);
      if (!parsed) {
        return buildResponse(command, 'setconfig', {
          success: false,
          error: 'invalid-config',
        });
      }

      const crc32 = await configService.setRawAudioConfig({
        raw: parsed,
        rawString: decoded,
      });

      const info = configService.getCurrentConfigInfo();
      // Named outright: the last segment is the base64 config, which answered as its key (#440).
      return buildResponse(command, 'setconfig', {
        crc32: crc32 ?? info.crc32 ?? null,
        extensions: info.extensions ?? [],
      });
    }),
    setConfigTimestamp: handler(async (command) => {
      const timestamp = Number(getSegment(command, 3));
      if (!Number.isFinite(timestamp)) {
        return buildResponse(command, 'setconfigtimestamp', {
          success: false,
          error: 'invalid-timestamp',
        });
      }

      const info = configService.getCurrentConfigInfo();
      return buildResponse(command, 'setconfigtimestamp', {
        success: true,
        timestamp,
        crc32: info.crc32 ?? null,
      });
    }),
    setVolumes: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'volumes', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<{ players?: unknown[] }>(decoded);

      if (!parsed?.players) {
        return buildResponse(command, 'volumes', {
          success: false,
          error: 'invalid-volume-payload',
        });
      }

      const count = await configService.applyVolumePreset(parsed.players);
      return buildResponse(command, 'volumes', { success: true, players: count });
    }),
    setDefaultVolume: handler(async (command) => {
      const [, , , zone, value] = command.split('/');
      const zoneId = Number(zone);
      const volume = Number(value);

      if (!Number.isFinite(zoneId) || !Number.isFinite(volume)) {
        return buildResponse(command, 'defaultvolume', {
          success: false,
          error: 'invalid-parameters',
        });
      }

      await configService.applyDefaultVolume(zoneId, volume);
      return buildResponse(command, 'defaultvolume', {
        success: true,
        value: volume,
      });
    }),
    setMaxVolume: handler(async (command) => {
      const [, , , zone, value] = command.split('/');
      const zoneId = Number(zone);
      const volume = Number(value);

      if (!Number.isFinite(zoneId) || !Number.isFinite(volume)) {
        return buildResponse(command, 'maxvolume', {
          success: false,
          error: 'invalid-parameters',
        });
      }

      await configService.applyMaxVolume(zoneId, volume);
      return buildResponse(command, 'maxvolume', {
        success: true,
        value: volume,
      });
    }),
    setEventVolumes: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'eventvolumes', {
          success: false,
          error: 'missing-payload',
        });
      }

      const decoded = decodeBase64Segment(decodeURIComponent(encoded));
      const parsed = safeJsonParse<Record<string, unknown>>(decoded);
      const zoneId = parsed && typeof parsed.playerid === 'number' ? parsed.playerid : NaN;

      if (!parsed || !Number.isFinite(zoneId)) {
        return buildResponse(command, 'eventvolumes', {
          success: false,
          error: 'invalid-event-payload',
        });
      }

      const { playerid: _ignored, ...volumeUpdates } = parsed;
      await configService.applyEventVolumes(zoneId, volumeUpdates);
      return buildResponse(command, 'eventvolumes', { success: true, zone: zoneId });
    }),
    getEq: handler((command) => buildResponse(command, 'geteq', [])),
    playerName: handler(async (command) => {
      const encoded = getSegment(command, 3);
      if (!encoded) {
        return buildResponse(command, 'playername', {
          success: false,
          error: 'missing-player-payload',
        });
      }
      try {
        const decoded = decodeURIComponent(encoded);
        const jsonStr = decodeBase64Segment(decoded);
        const parsed = safeJsonParse<unknown>(jsonStr);
        if (!parsed) {
          throw new Error('player payload is not valid JSON');
        }
        const updates = extractPlayerNameUpdates(parsed);
        if (!updates.length) {
          return buildResponse(command, 'playername', { success: true, result: '' });
        }
        await configService.applyPlayerNames(updates);
        log.info('updated player names', {
          updates: updates.length,
          zones: updates.map((u) => u.zoneId),
        });
        return buildResponse(command, 'playername', { success: true, result: '' });
      } catch (error) {
        log.warn('failed to apply player names', {
          message: error instanceof Error ? error.message : String(error),
        });
        return buildResponse(command, 'playername', {
          success: false,
          error: 'invalid-player-payload',
        });
      }
    }),
    serviceCfgGetLink: handler(async (command) => {
      const parts = command.split('/');
      const service = (parts[4] ?? parts[3] ?? '').toLowerCase();

      if (service !== 'spotify') {
        return buildResponse(command, 'servicecfg', { link: '' });
      }

      const cfg = configPort.getConfig();
      const host = cfg.system?.audioserver?.ip?.trim() || '127.0.0.1';

      const link = buildSpotifyAuthLink({ audioServerHost: host }, configPort);
      return buildResponse(command, 'servicecfg', { link: link ?? '' });
    }),
    serviceCfgDelete: handler(async (command) => {
      const parts = command.split('/');
      const service = (parts[4] ?? '').toLowerCase();
      const userId = parts[5] ?? '';

      if (service === 'spotify' && userId) {
        await deleteSpotifyAccount(configPort, userId, notifier, contentManager, spotifyInputService);
        // notify frontend to refresh service state
        configService.notifyReloadMusicApp('userdel', 'spotify', userId);
      }

      loxoneNotifier?.notifyServiceChanged();

      return buildResponse(command, 'servicecfg', { action: 'deleted', error: 0 });
    }),
    // audio/cfg/servicecfg/set/<service>/<account>/asdefault/player/<id,id,…> — "use this
    // account in these rooms". A room has one default, so naming a new one replaces the old.
    serviceCfgSet: handler(async (command) => {
      const parts = command.split('/');
      const account = decodeURIComponent(parts[5] ?? '');
      const players = parsePlayerIds(parts[8]);
      const services = (contentManager?.getServices() ?? []) as unknown as Array<{ id?: unknown }>;
      const known = services.some((entry) => entry.id === account);
      // The app reads `error` as a number and nothing else; 8 is its "not found".
      if (parts[6] !== 'asdefault' || parts[7] !== 'player' || !players.length || !known) {
        return buildResponse(command, 'servicecfg', { command: 'asdefault', error: 8 });
      }
      await configPort.updateConfig((cfg) => {
        for (const zone of cfg.zones) {
          if (players.includes(zone.id)) {
            zone.streamingAccount = account;
          }
        }
      });
      // The app holds the list of services with their defaults; this makes it fetch it again.
      loxoneNotifier?.notifyServiceChanged();
      return buildResponse(command, 'servicecfg', { command: 'asdefault', error: 0 });
    }),
  };
}

function handler(
  fn: (command: string, payload?: Buffer) => CommandResult | Promise<CommandResult>,
): HandlerFn {
  return (command, payload) => fn(command, payload);
}

function buildEmptyResponseWithPayload(
  command: string,
  payload: unknown,
): CommandResult {
  const name = inferName(command);
  return buildResponse(command, name, payload as CommandResult['payload']);
}

function inferName(command: string): string {
  const parts = command.split('/').filter(Boolean);
  return parts.pop() ?? 'response';
}

function getSegment(command: string, index: number): string | undefined {
  return command.split('/')[index];
}

function createKeyMaterial(): KeyMaterial {
  if (cachedMaterial) {
    return cachedMaterial;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  const { publicKey } = keyPair;

  const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

  const modulusHex = jwk.n
    ? Buffer.from(jwk.n.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('hex')
    : '';
  const exponentBuffer = jwk.e
    ? Buffer.from(jwk.e.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : Buffer.from([0x01, 0x00, 0x01]);
  const exponent = exponentBuffer.readUIntBE(0, exponentBuffer.length);

  cachedMaterial = { modulusHex, exponent, publicKeyPem };
  return cachedMaterial;
}

function exportPublicKeyPemSpki(): string {
  if (cachedPublicPemSpki) {
    return cachedPublicPemSpki;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  cachedPublicPemSpki = keyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  return cachedPublicPemSpki;
}

export function decryptWithAudioCfgKey(cipherBase64: string | undefined): string | null {
  if (!cipherBase64) {
    return null;
  }
  if (!keyPair) {
    keyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
  }
  try {
    const decrypted = privateDecrypt(
      {
        key: keyPair.privateKey,
        padding: cryptoConstants.RSA_PKCS1_PADDING,
      },
      Buffer.from(cipherBase64, 'base64'),
    );
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

function extractPlayerNameUpdates(payload: unknown): Array<{ zoneId: number; name: string }> {
  const updates: Array<{ zoneId: number; name: string }> = [];

  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const candidate = entry as Record<string, unknown>;
    const zoneId = Number(
      candidate.playerid ?? candidate.id ?? candidate.zoneid ?? candidate.zoneId,
    );
    const rawName =
      typeof candidate.name === 'string'
        ? candidate.name
        : typeof candidate.title === 'string'
          ? candidate.title
          : undefined;
    const trimmed = rawName?.trim();
    if (Number.isFinite(zoneId) && trimmed) {
      updates.push({ zoneId, name: trimmed });
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(visit);
  } else if (payload && typeof payload === 'object') {
    const container: unknown =
      (payload as Record<string, unknown>).players ??
      (payload as Record<string, unknown>).player;
    if (Array.isArray(container)) {
      container.forEach(visit);
    } else if (container && typeof container === 'object') {
      Object.values(container).forEach(visit);
    } else {
      visit(payload);
    }
  }

  const deduped = new Map<number, string>();
  for (const update of updates) {
    deduped.set(update.zoneId, update.name);
  }
  return Array.from(deduped.entries()).map(([zoneId, name]) => ({ zoneId, name }));
}
