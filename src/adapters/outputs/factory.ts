import { createLogger } from '@/shared/logging/logger';
import type { ZoneConfig, ZoneTransportConfig } from '@/domain/config/types';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import {
  DlnaOutput,
  DLNA_OUTPUT_DEFINITION,
} from '@/adapters/outputs/dlna/dlnaOutput';
import {
  AirPlayOutput,
  AIRPLAY_OUTPUT_DEFINITION,
  type AirPlayOutputConfig,
} from '@/adapters/outputs/airplay/airplayOutput';
import {
  SnapcastOutput,
  SNAPCAST_OUTPUT_DEFINITION,
  type SnapcastOutputConfig,
} from '@/adapters/outputs/snapcast/snapcastOutput';
import {
  SendspinOutput,
  SENDSPIN_OUTPUT_DEFINITION,
  type SendspinOutputConfig,
  type SendspinSatelliteConfig,
} from '@/adapters/outputs/sendspin/sendspinOutput';
import {
  GoogleCastOutput,
  GOOGLE_CAST_OUTPUT_DEFINITION,
  type GoogleCastOutputConfig,
} from '@/adapters/outputs/googleCast/googleCastOutput';
import {
  SendspinCastOutput,
  SENDSPIN_CAST_OUTPUT_DEFINITION,
  type SendspinCastOutputConfig,
} from '@/adapters/outputs/googleCast/sendspinCastOutput';
import {
  SnapcastCastOutput,
  SNAPCAST_CAST_OUTPUT_DEFINITION,
  type SnapcastCastOutputConfig,
} from '@/adapters/outputs/googleCast/snapcastCastOutput';
import {
  SonosOutput,
  SONOS_OUTPUT_DEFINITION,
  type SonosOutputConfig,
} from '@/adapters/outputs/sonos/sonosOutput';
import {
  SqueezeliteOutput,
  SQUEEZELITE_OUTPUT_DEFINITION,
  type SqueezeliteOutputConfig,
} from '@/adapters/outputs/squeezelite/squeezeliteOutput';
import {
  MusicAssistantOutput,
  MUSIC_ASSISTANT_OUTPUT_DEFINITION,
  type MusicAssistantOutputConfig,
} from '@/adapters/outputs/musicassistant/musicAssistantOutput';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

type OutputDefinitions =
  | typeof DLNA_OUTPUT_DEFINITION
  | typeof AIRPLAY_OUTPUT_DEFINITION
  | typeof SNAPCAST_OUTPUT_DEFINITION
  | typeof SENDSPIN_OUTPUT_DEFINITION
  | typeof GOOGLE_CAST_OUTPUT_DEFINITION
  | typeof SENDSPIN_CAST_OUTPUT_DEFINITION
  | typeof SNAPCAST_CAST_OUTPUT_DEFINITION
  | typeof SONOS_OUTPUT_DEFINITION
  | typeof SQUEEZELITE_OUTPUT_DEFINITION
  | typeof MUSIC_ASSISTANT_OUTPUT_DEFINITION;

export const OUTPUT_DEFINITIONS: OutputDefinitions[] = [
  DLNA_OUTPUT_DEFINITION,
  AIRPLAY_OUTPUT_DEFINITION,
  SNAPCAST_OUTPUT_DEFINITION,
  SENDSPIN_OUTPUT_DEFINITION,
  GOOGLE_CAST_OUTPUT_DEFINITION,
  SENDSPIN_CAST_OUTPUT_DEFINITION,
  SNAPCAST_CAST_OUTPUT_DEFINITION,
  SONOS_OUTPUT_DEFINITION,
  SQUEEZELITE_OUTPUT_DEFINITION,
  MUSIC_ASSISTANT_OUTPUT_DEFINITION,
];
const log = createLogger('Output', 'Factory');

export function buildZoneOutputs(
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput[] {
  const outputs: ZoneOutput[] = [];
  const primaryOutput = getPrimaryOutputConfig(zone);
  const entries = primaryOutput ? [primaryOutput] : [];

  for (const entry of entries) {
    const id = entry.id?.toLowerCase();
    if (id === 'dlna') {
      const output = createDlnaOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'airplay') {
      const output = createAirplayOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'snapcast') {
      const output = createSnapcastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'sendspin') {
      const output = createSendspinOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'googlecast') {
      const output = createGoogleCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'sendspin-cast') {
      const output = createSendspinCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'snapcast-cast') {
      const output = createSnapcastCastOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'sonos') {
      const output = createSonosOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'squeezelite') {
      const output = createSqueezeliteOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
    if (id === 'musicassistant') {
      const output = createMusicAssistantOutput(entry, zone, ports);
      if (output) {
        outputs.push(output);
      }
    }
  }

  return outputs;
}

function createDlnaOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const raw = config as Record<string, unknown>;
  const rawHost = raw.host;
  const rawControlUrl = raw.controlUrl;
  const host = typeof rawHost === 'string' ? rawHost.trim() : '';
  const controlUrl = typeof rawControlUrl === 'string' ? rawControlUrl.trim() : '';
  const autoDiscover =
    typeof raw.autoDiscover === 'boolean' || typeof raw.autoDiscover === 'string'
      ? raw.autoDiscover
      : undefined;
  const deviceName = typeof raw.deviceName === 'string' ? raw.deviceName.trim() : '';
  // autoDiscover defaults to on, so a config with neither host nor controlUrl can still
  // self-resolve via SSDP. Only skip when discovery is explicitly turned off.
  const autoDiscoverEnabled =
    autoDiscover === undefined ||
    autoDiscover === true ||
    (typeof autoDiscover === 'string' &&
      !['false', '0', 'no', 'off'].includes(autoDiscover.trim().toLowerCase()));

  if (!host && !controlUrl && !autoDiscoverEnabled) {
    log.warn('DLNA output skipped (no host, control URL, or auto-discovery)', { zoneId: zone.id });
    return null;
  }

  log.info('DLNA output registered', {
    zoneId: zone.id,
    host: host || undefined,
    controlUrl: controlUrl || undefined,
    autoDiscover: autoDiscoverEnabled,
  });

  return new DlnaOutput(
    zone.id,
    zone.name,
    {
      host,
      controlUrl,
      autoDiscover,
      deviceName: deviceName || undefined,
      streamFormat: readStreamFormat(config),
    },
    ports,
  );
}

/**
 * The configured sound quality, as every output that supports one reads it.
 *
 * Each factory below hands its output a narrow, explicitly-built config rather than the raw entry,
 * which is why this has to be forwarded by name: without it the outputs parse `undefined`, resolve
 * to `auto`, and a configured preference is silently ignored.
 */
function readStreamFormat(config: ZoneTransportConfig): string | undefined {
  const raw = (config as Record<string, unknown>).streamFormat;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createSqueezeliteOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawPlayerId = (config as Record<string, unknown>).playerId;
  const rawPlayerName = (config as Record<string, unknown>).playerName;
  const playerId = typeof rawPlayerId === 'string' ? rawPlayerId.trim() : '';
  const playerName = typeof rawPlayerName === 'string' ? rawPlayerName.trim() : '';

  if (!playerId && !playerName) {
    log.warn('Squeezelite output skipped; missing playerId/playerName', { zoneId: zone.id });
    return null;
  }

  const cfg: SqueezeliteOutputConfig = { playerId: playerId || undefined, playerName: playerName || undefined };
  log.info('Squeezelite output registered', { zoneId: zone.id, playerId: cfg.playerId, playerName: cfg.playerName });
  return new SqueezeliteOutput(zone.id, zone.name, cfg, ports);
}

function createMusicAssistantOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const raw = config as Record<string, unknown>;
  const bridgeId = typeof raw.bridgeId === 'string' ? raw.bridgeId.trim() : '';
  const playerId = typeof raw.playerId === 'string' ? raw.playerId.trim() : '';
  if (!playerId) {
    log.warn('Music Assistant output skipped; missing playerId', { zoneId: zone.id });
    return null;
  }
  const cfg: MusicAssistantOutputConfig = { bridgeId, playerId, streamFormat: readStreamFormat(config) };
  log.info('Music Assistant output registered', { zoneId: zone.id, bridgeId: bridgeId || '(auto)', playerId });
  return new MusicAssistantOutput(zone.id, zone.name, cfg, ports.config);
}

function createAirplayOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawEntry = config as unknown as AirPlayOutputConfig;
  const host = rawEntry.host;
  const rawPort = rawEntry.port;
  if (!host) {
    log.warn('AirPlay output skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const extras = rawEntry as unknown as Record<string, unknown>;
  const name = extras?.name as string | undefined;
  const password = extras?.password as string | undefined;
  const debug = extras?.debug;
  const et = extras?.et;
  const md = extras?.md;
  const features = extras?.features;
  const flags = extras?.flags;
  const model = extras?.model;
  const latencyMs = extras?.latencyMs;
  const rawBufferMs = extras?.bufferMs;
  const bufferMs =
    rawBufferMs === undefined || rawBufferMs === null || rawBufferMs === ''
      ? NaN
      : Number(rawBufferMs);
  const port = Number(rawPort);
  const initialVolume = clampVolume(zone.volumes?.default);
  return new AirPlayOutput(
    zone.id,
    zone.name,
    {
      host,
      name,
      password,
      port: Number.isFinite(port) ? port : undefined,
      debug: typeof debug === 'boolean' ? debug : undefined,
      et: typeof et === 'string' ? et : undefined,
      md: typeof md === 'string' ? md : undefined,
      features: typeof features === 'string' ? features : undefined,
      flags: typeof flags === 'string' ? flags : undefined,
      model: typeof model === 'string' ? model : undefined,
      latencyMs: typeof latencyMs === 'number' ? latencyMs : undefined,
      bufferMs: Number.isFinite(bufferMs) ? bufferMs : undefined,
    },
    ports,
    initialVolume,
  );
}

function getPrimaryOutputConfig(zone: ZoneConfig): ZoneTransportConfig | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output as ZoneTransportConfig;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    return zone.transports[0] ?? null;
  }
  return null;
}

function createSonosOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawHost = (config as Record<string, unknown>).host;
  const rawControlUrl = (config as Record<string, unknown>).controlUrl;
  const host = typeof rawHost === 'string' ? rawHost.trim() : '';
  const controlUrl = typeof rawControlUrl === 'string' ? rawControlUrl.trim() : '';
  const rawAutoDiscover = (config as Record<string, unknown>).autoDiscover;

  log.info('Sonos output registered', {
    zoneId: zone.id,
    host,
    controlUrl: controlUrl || undefined,
  });

  return new SonosOutput(zone.id, zone.name, {
    host,
    controlUrl,
    autoDiscover: rawAutoDiscover,
    networkScan: (config as Record<string, unknown>).networkScan,
    householdId: (config as Record<string, unknown>).householdId as string | undefined,
    deviceName: (config as Record<string, unknown>).deviceName as string | undefined,
    streamFormat: readStreamFormat(config),
  } as SonosOutputConfig, ports);
}

function createSnapcastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawClientIds = (config as Record<string, unknown>).clientIds;
  let clientIds: string[] = [];
  if (Array.isArray(rawClientIds)) {
    clientIds = rawClientIds
      .filter((c) => typeof c === 'string' && c.trim())
      .map((c) => c.trim());
  } else if (typeof rawClientIds === 'string' && rawClientIds.trim()) {
    clientIds = rawClientIds
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
  }

  if (clientIds.length === 0) {
    log.warn('Snapcast output skipped; missing clientId mapping', { zoneId: zone.id });
    return null;
  }

  // WebSocket server is shared via HTTP gateway; per-zone output just registers a stream.
  log.info('Snapcast output registered (ws via /snapcast)', { zoneId: zone.id, clientIds });
  const snapConfig: SnapcastOutputConfig = { clientIds };
  return new SnapcastOutput(zone.id, zone.name, snapConfig, ports);
}

function createSendspinOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const rawClientId = (config as Record<string, unknown>).clientId;
  const rawEndpointUrl = (config as Record<string, unknown>).endpointUrl;
  const rawLatency = (config as Record<string, unknown>).latencyMs;
  const clientId = typeof rawClientId === 'string' ? rawClientId.trim() : '';
  const endpointUrl = typeof rawEndpointUrl === 'string' ? rawEndpointUrl.trim() : '';
  const parsedLatency =
    typeof rawLatency === 'number'
      ? rawLatency
      : typeof rawLatency === 'string' && rawLatency.trim() !== ''
        ? Number(rawLatency)
        : undefined;
  if (!clientId) {
    log.warn('Sendspin output skipped; missing clientId', { zoneId: zone.id });
    return null;
  }
  const satellites = parseSendspinSatellites((config as Record<string, unknown>).satellites, clientId);
  const sendspinConfig: SendspinOutputConfig = {
    clientId,
    ...(endpointUrl ? { endpointUrl } : {}),
    ...(typeof parsedLatency === 'number' && Number.isFinite(parsedLatency)
      ? { latencyMs: parsedLatency }
      : {}),
    ...(satellites.length ? { satellites } : {}),
  };
  log.info('Sendspin output registered', {
    zoneId: zone.id,
    clientId,
    endpointUrl: endpointUrl || undefined,
    latencyMs: sendspinConfig.latencyMs,
    satellites: satellites.map((s) => s.clientId),
  });
  return new SendspinOutput(zone.id, zone.name, sendspinConfig, undefined, ports);
}

/**
 * Parse the optional `satellites` field. Accepts a rich array (`[{ clientId, latencyMs?,
 * endpointUrl? }]`), a comma-separated string, or a string[]. Trims, drops empties, dedupes,
 * and excludes the primary clientId so a zone never double-drives one client.
 */
export function parseSendspinSatellites(raw: unknown, primaryClientId: string): SendspinSatelliteConfig[] {
  const out: SendspinSatelliteConfig[] = [];
  const seen = new Set<string>([primaryClientId]);
  const pushClient = (clientId: string, latencyMs?: number, endpointUrl?: string): void => {
    const id = clientId.trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push({
      clientId: id,
      ...(typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? { latencyMs } : {}),
      ...(endpointUrl && endpointUrl.trim() ? { endpointUrl: endpointUrl.trim() } : {}),
    });
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') {
        pushClient(entry);
      } else if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const id = typeof e.clientId === 'string' ? e.clientId : '';
        const latency =
          typeof e.latencyMs === 'number'
            ? e.latencyMs
            : typeof e.latencyMs === 'string' && e.latencyMs.trim() !== ''
              ? Number(e.latencyMs)
              : undefined;
        pushClient(id, latency, typeof e.endpointUrl === 'string' ? e.endpointUrl : undefined);
      }
    }
  } else if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      pushClient(part);
    }
  }
  return out;
}

function createGoogleCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const cfg = config as Record<string, unknown>;
  const host = typeof cfg.host === 'string' ? cfg.host.trim() : '';
  if (!host) {
    log.warn('Google Cast output skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const name = typeof cfg.name === 'string' ? cfg.name : undefined;
  const rawUseSendspin = cfg.useSendspin;
  const useSendspin =
    rawUseSendspin === true ||
    (typeof rawUseSendspin === 'string' && rawUseSendspin.trim().toLowerCase() === 'true');
  if (useSendspin) {
    const namespace =
      typeof cfg.sendspinNamespace === 'string'
        ? cfg.sendspinNamespace
        : undefined;
    const playerId =
      typeof cfg.sendspinPlayerId === 'string'
        ? cfg.sendspinPlayerId
        : undefined;
    const syncDelayRaw = cfg.sendspinSyncDelayMs;
    const syncDelayMs = Number(syncDelayRaw);
    const satellites = parseSendspinSatellites((cfg as Record<string, unknown>).satellites, playerId ?? '');
    const sendspinCastConfig: SendspinCastOutputConfig = {
      host,
      name,
      namespace,
      playerId,
      syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
      ...(satellites.length ? { satellites } : {}),
    };
    log.info('Sendspin Cast output registered', {
      zoneId: zone.id,
      host,
      satellites: satellites.map((s) => s.clientId),
    });
    return new SendspinCastOutput(zone.id, zone.name, sendspinCastConfig, ports);
  }
  const googleCastConfig: GoogleCastOutputConfig = { host, name, streamFormat: readStreamFormat(config) };
  log.info('Google Cast output registered', { zoneId: zone.id, host });
  return new GoogleCastOutput(zone.id, zone.name, googleCastConfig, ports);
}

function createSendspinCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const cfg = config as Record<string, unknown>;
  const host = typeof cfg.host === 'string' ? cfg.host.trim() : '';
  if (!host) {
    log.warn('Sendspin Cast output skipped; missing host', { zoneId: zone.id });
    return null;
  }
  const name = typeof cfg.name === 'string' ? cfg.name : undefined;
  const namespace =
    typeof cfg.namespace === 'string' ? cfg.namespace : undefined;
  const playerId =
    typeof cfg.playerId === 'string' ? cfg.playerId : undefined;
  const syncDelayRaw = cfg.syncDelayMs;
  const syncDelayMs = Number(syncDelayRaw);
  const satellites = parseSendspinSatellites(cfg.satellites, playerId ?? '');
  const sendspinCastConfig: SendspinCastOutputConfig = {
    host,
    name,
    namespace,
    playerId,
    syncDelayMs: Number.isFinite(syncDelayMs) ? syncDelayMs : undefined,
    ...(satellites.length ? { satellites } : {}),
  };
  log.info('Sendspin Cast output registered', {
    zoneId: zone.id,
    host,
    satellites: satellites.map((s) => s.clientId),
  });
  return new SendspinCastOutput(zone.id, zone.name, sendspinCastConfig, ports);
}

function createSnapcastCastOutput(
  config: ZoneTransportConfig,
  zone: ZoneConfig,
  ports: OutputPorts,
): ZoneOutput | null {
  const cfg = config as Record<string, unknown>;
  const host = typeof cfg.host === 'string' ? cfg.host.trim() : '';
  if (!host) {
    log.warn('Snapcast Cast output skipped; missing cast host', { zoneId: zone.id });
    return null;
  }
  const name = typeof cfg.name === 'string' ? cfg.name : undefined;
  const streamId =
    typeof cfg.streamId === 'string' ? cfg.streamId : undefined;
  const clientId =
    typeof cfg.clientId === 'string' ? cfg.clientId : undefined;
  const serverHost =
    typeof cfg.serverHost === 'string'
      ? cfg.serverHost
      : ports.config.getSystemConfig()?.audioserver?.ip;
  const snapcastCastConfig: SnapcastCastOutputConfig = {
    host,
    name,
    streamId,
    clientId,
    serverHost,
  };
  log.info('Snapcast Cast output registered', { zoneId: zone.id, host, streamId });
  return new SnapcastCastOutput(zone.id, zone.name, snapcastCastConfig, ports);
}

function clampVolume(value: number | string | undefined): number | undefined {
  const numeric =
    typeof value === 'string'
      ? Number(value.trim())
      : value;
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(100, Math.max(0, Math.round(numeric as number)));
}
