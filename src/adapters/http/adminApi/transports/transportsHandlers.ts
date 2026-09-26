import type { OutputDiscoveryPort } from '@/ports/OutputDiscoveryPort';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { ComponentLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MdnsPort, MdnsServiceRecord } from '@/ports/MdnsPort';
import type { SnapcastCore } from '@/adapters/outputs/snapcast/snapcastCore';
import type { SqueezeliteCore } from '@/adapters/outputs/squeezelite/squeezeliteCore';
import type { MusicAssistantStreamService } from '@/adapters/inputs/musicassistant/musicAssistantStreamService';
import {
  acquireMaApiForBridge,
  findMusicAssistantBridge,
} from '@/shared/musicassistant/maBridgeResolver';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import { bluetoothClientId } from '@/domain/inputs/bluetoothIdentity';
import type { Route } from '@/adapters/http/adminApi/routeTypes';

/** Browser tabs are ephemeral local destinations, not physical output devices. */
const isBrowserClient = (clientId: unknown): boolean =>
  typeof clientId === 'string' && clientId.trim().startsWith('browser-');

const HIDDEN_TRANSPORT_IDS = new Set(['spotify', 'sendspin-cast']);

export type StateControllerDefinition = {
  id: string;
  label: string;
  description: string;
};

export type TransportsHandlerDeps = {
  log: ComponentLogger;
  /** Finds playback devices on the network; see OutputDiscoveryPort. */
  discovery: OutputDiscoveryPort;
  configPort: ConfigPort;
  mdns: MdnsPort;
  snapcastCore: SnapcastCore;
  squeezeliteCore: SqueezeliteCore;
  musicAssistantStreamService: MusicAssistantStreamService;
  stateControllerDefinitions: readonly StateControllerDefinition[];
  readJsonBody: (req: IncomingMessage, res: ServerResponse, maxBytes?: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

export function buildTransportsRoutes(deps: TransportsHandlerDeps): Route[] {
  return [
    { method: 'GET', pattern: /^\/transports$/, handler: (_req, res) => handleTransportDefinitions(res, deps) },
    {
      method: 'GET',
      pattern: /^\/transports\/airplay\/devices$/,
      handler: async (_req, res) => handleAirplayDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/googlecast\/devices$/,
      handler: async (req, res) => handleGoogleCastDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/dlna\/devices$/,
      handler: async (req, res) => handleDlnaDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sonos\/devices$/,
      handler: async (req, res) => handleSonosDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/musicassistant\/bridges$/,
      handler: async (_req, res) => handleMusicAssistantBridges(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/musicassistant\/devices$/,
      handler: async (req, res) => handleMusicAssistantPlayerDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/musicassistant\/status$/,
      handler: async (_req, res) => handleMusicAssistantStatus(res, deps),
    },
    {
      method: 'POST',
      pattern: /^\/transports\/ping$/,
      handler: async (req, res) => handleTransportPing(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/clients$/,
      handler: async (req, res) => handleSendspinDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/mdns-clients$/,
      handler: async (req, res) => handleSendspinMdnsDiscovery(req, res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/sendspin\/sources$/,
      handler: async (_req, res) => handleSendspinSourceDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/snapcast\/clients$/,
      handler: async (_req, res) => handleSnapcastDiscovery(res, deps),
    },
    {
      method: 'GET',
      pattern: /^\/transports\/squeezelite\/clients$/,
      handler: async (_req, res) => handleSqueezeliteDiscovery(res, deps),
    },
  ];
}

function handleTransportDefinitions(res: ServerResponse, deps: TransportsHandlerDeps): void {
  // Every output the build ships is offered; there is no per-type availability gate.
  const payload = deps.discovery.definitions.filter(
    (definition) => !HIDDEN_TRANSPORT_IDS.has(definition.id),
  ).map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description ?? '',
    fields: definition.fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type,
      placeholder: field.placeholder ?? '',
      description: field.description ?? '',
      required: field.required ?? false,
      advanced: field.advanced ?? false,
    })),
  }));
  deps.sendJson(res, 200, { transports: payload, stateControllers: deps.stateControllerDefinitions });
}

async function handleAirplayDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): Promise<void> {
  try {
    const devices = await deps.discovery.airplay();
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('airplay discovery failed', { err });
    deps.sendJson(res, 500, { error: 'airplay-discovery-failed' });
  }
}

async function handleGoogleCastDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const hosts = url.searchParams
      .getAll('host')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const devices = await deps.discovery.googleCast(8000, hosts);
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('google cast discovery failed', { err });
    deps.sendJson(res, 500, { error: 'googlecast-discovery-failed' });
  }
}

async function handleDlnaDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const host = url.searchParams.get('host')?.trim() || undefined;
    const devices = await deps.discovery.dlna({ host });
    deps.sendJson(res, 200, { devices });
  } catch (err) {
    deps.log.warn('dlna discovery failed', { err });
    deps.sendJson(res, 500, { error: 'dlna-discovery-failed' });
  }
}

async function handleSonosDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const preferredName = url.searchParams.get('name')?.trim() || undefined;
    const householdId = url.searchParams.get('householdId')?.trim() || undefined;
    const activeHost = url.searchParams.get('host')?.trim() || undefined;
    const networkScan = url.searchParams.get('networkScan')?.trim();
    const allowNetworkScan =
      typeof networkScan === 'string' &&
      ['true', '1', 'yes', 'on'].includes(networkScan.toLowerCase());
    const devices = await deps.discovery.sonos({
      preferredName,
      householdId,
      allowNetworkScan,
    });
    const payload = devices.map((device) => ({
      id: device.udn || device.host,
      host: device.host,
      name: [device.roomName ?? device.name, device.model, device.host].filter(Boolean).join(' · '),
      model: device.model,
      roomName: device.roomName,
      householdId: device.householdId,
      active: activeHost ? device.host === activeHost : undefined,
    }));
    deps.sendJson(res, 200, { devices: payload });
  } catch (err) {
    deps.log.warn('sonos discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sonos-discovery-failed' });
  }
}

function listMusicAssistantBridges(deps: TransportsHandlerDeps) {
  const bridges = deps.configPort.getConfig().content?.streamingServices ?? [];
  return bridges
    .filter((b) => (b?.provider || '').toLowerCase() === 'musicassistant')
    .map((b) => ({
      id: b.id,
      label: b.label || b.id,
      enabled: b.enabled !== false,
      mode: b.mode === 'sink' ? 'sink' : 'source',
      host: b.host,
      port: b.port,
    }));
}

async function handleMusicAssistantBridges(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  deps.sendJson(res, 200, { bridges: listMusicAssistantBridges(deps) });
}

async function handleMusicAssistantPlayerDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://internal');
    const requestedBridgeId = (url.searchParams.get('bridgeId') ?? '').trim();

    let raw: unknown[] = [];
    let bridgeId: string | null = null;
    let bridgeMode: 'source' | 'sink' = 'source';

    if (requestedBridgeId) {
      const bridge = findMusicAssistantBridge(deps.configPort, requestedBridgeId);
      if (!bridge || (bridge.provider || '').toLowerCase() !== 'musicassistant') {
        deps.sendJson(res, 404, { error: 'musicassistant-bridge-not-found' });
        return;
      }
      bridgeId = bridge.id;
      bridgeMode = bridge.mode === 'sink' ? 'sink' : 'source';
      const api = acquireMaApiForBridge(bridge);
      try {
        await api.connect();
        raw = (await api.getAllPlayers()) as unknown[];
      } finally {
        api.release();
      }
    } else {
      raw = (await deps.musicAssistantStreamService.listPlayers()) as unknown[];
      const bridges = deps.configPort.getConfig().content?.streamingServices ?? [];
      const maBridge = bridges.find((b) => (b?.provider || '').toLowerCase() === 'musicassistant');
      bridgeId = maBridge?.id ?? null;
      bridgeMode = maBridge?.mode === 'sink' ? 'sink' : 'source';
    }

    const devices = raw
      .map((player) => {
        const p = player as Record<string, unknown>;
        const id = (typeof p.player_id === 'string' ? p.player_id : typeof p.id === 'string' ? p.id : '').trim();
        const name = (typeof p.name === 'string' ? p.name : id).trim();
        if (!id) return null;
        const enabled = typeof p.enabled === 'boolean' ? (p.enabled as boolean) : true;
        const available = typeof p.available === 'boolean' ? (p.available as boolean) : true;
        const hideInUi = typeof p.hide_in_ui === 'boolean' ? (p.hide_in_ui as boolean) : false;
        const syncedTo = typeof p.synced_to === 'string' && p.synced_to ? (p.synced_to as string) : null;
        const activeGroup = typeof p.active_group === 'string' && p.active_group ? (p.active_group as string) : null;
        // Hide synced children, group children and ui-hidden players (matches MA frontend playerVisible()).
        if (hideInUi || syncedTo || activeGroup) return null;
        return {
          id,
          deviceId: id,
          name: name || id,
          provider: typeof p.provider === 'string' ? (p.provider as string) : undefined,
          type: typeof p.type === 'string' ? (p.type as string) : undefined,
          enabled,
          available,
        };
      })
      .filter(Boolean);
    deps.sendJson(res, 200, { devices, bridgeId, bridgeMode });
  } catch (err) {
    deps.log.warn('music assistant player discovery failed', { err });
    deps.sendJson(res, 500, { error: 'musicassistant-discovery-failed' });
  }
}

async function handleMusicAssistantStatus(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const status = await deps.musicAssistantStreamService.testConnection();
    deps.sendJson(res, 200, status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn('music assistant status failed', { message });
    deps.sendJson(res, 500, { ok: false, error: 'musicassistant-status-failed', message });
  }
}

async function handleTransportPing(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  const body = (await deps.readJsonBody(req, res)) as { host?: string; port?: number } | null;
  if (res.writableEnded) {
    return;
  }
  const host = body?.host?.trim();
  const rawPort = body?.port;
  const port =
    typeof rawPort === 'number' && Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
      ? rawPort
      : 80;
  if (!host) {
    deps.sendJson(res, 400, { error: 'invalid-host' });
    return;
  }

  try {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port, timeout: 1500 }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    deps.sendJson(res, 200, { reachable });
  } catch (err) {
    deps.log.warn('transport ping failed', { err, host, port });
    deps.sendJson(res, 500, { error: 'transport-ping-failed' });
  }
}

async function handleSendspinDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const roles = url.searchParams
      .getAll('role')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const connected = sendspinCore
      .listClients()
      .filter((client) => (roles.length ? roles.some((role) => client.roles.includes(role)) : true))
      .filter((client) => typeof client.clientId === 'string' && client.clientId.trim().length > 0)
      .filter((client) => !isBrowserClient(client.clientId))
      .map((client) => {
        const clientId = client.clientId;
        const controls = clientId
          ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
          : null;
        return {
          id: client.clientId,
          clientId: client.clientId,
          name: client.name || client.clientId,
          // Legacy fields (kept for backwards compatibility).
          remote: client.remote,
          roles: client.roles,
          playbackState: client.playbackState,
          // UI-friendly fields.
          address: client.remote ?? undefined,
          sourceState: client.sourceState,
          sourceSignal: client.sourceSignal,
          controls,
        };
      });

    if (roles.length > 0) {
      deps.sendJson(res, 200, { clients: connected });
      return;
    }

    const mdnsTimeoutMsRaw = url.searchParams.get('mdnsTimeoutMs');
    const mdnsTimeoutMsParsed = mdnsTimeoutMsRaw ? Number(mdnsTimeoutMsRaw) : null;
    const mdnsTimeoutMs =
      typeof mdnsTimeoutMsParsed === 'number' && Number.isFinite(mdnsTimeoutMsParsed) && mdnsTimeoutMsParsed > 0
        ? Math.min(15_000, Math.max(250, Math.round(mdnsTimeoutMsParsed)))
        : 1_500;

    const discovered = await discoverMdnsServices(deps.mdns, { type: 'sendspin', protocol: 'tcp' }, mdnsTimeoutMs);
    const mdnsClients = discovered
      .map((service) => mapSendspinMdnsService(service))
      .filter((entry) => entry !== null)
      .map((entry) => ({
        id: entry.id,
        clientId: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
        name: entry.name ?? entry.addresses[0] ?? entry.host ?? entry.id,
        host: entry.host ?? undefined,
        address: entry.addresses[0] ?? entry.host ?? undefined,
        port: entry.port,
        path: entry.path,
        controls: null,
        sourceState: null,
        sourceSignal: null,
      }));

    const byClientId = new Set<string>();
    connected.forEach((c) => {
      if (typeof c.clientId === 'string') byClientId.add(c.clientId);
    });
    const merged = [...connected];
    for (const client of mdnsClients) {
      if (!byClientId.has(client.clientId)) {
        merged.push(client as any);
      }
    }

    deps.sendJson(res, 200, { clients: merged });
  } catch (err) {
    deps.log.warn('sendspin discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-discovery-failed' });
  }
}

async function handleSendspinMdnsDiscovery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '', 'http://localhost');
    const timeoutMsRaw = url.searchParams.get('timeoutMs');
    const timeoutMsParsed = timeoutMsRaw ? Number(timeoutMsRaw) : null;
    const timeoutMs =
      typeof timeoutMsParsed === 'number' && Number.isFinite(timeoutMsParsed) && timeoutMsParsed > 0
        ? Math.min(15_000, Math.max(250, Math.round(timeoutMsParsed)))
        : 3_000;

    const discovered = await discoverMdnsServices(deps.mdns, { type: 'sendspin', protocol: 'tcp' }, timeoutMs);
    const clients = discovered
      .map((service) => mapSendspinMdnsService(service))
      .filter((entry) => entry !== null);

    deps.sendJson(res, 200, { clients, timeoutMs });
  } catch (err) {
    deps.log.warn('sendspin mdns discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-mdns-discovery-failed' });
  }
}

async function handleSendspinSourceDiscovery(
  res: ServerResponse,
  deps: TransportsHandlerDeps,
): Promise<void> {
  try {
    // A room's Bluetooth is a source too, and it must not be offered here: it is not something to
    // wire up and point a line-in at, it appears when someone presses play on a phone and vanishes
    // when they stop. The zone that owns it is where it is switched on.
    const bluetoothClients = new Set(
      (deps.configPort.getConfig().zones ?? [])
        .map((zone) => zone.inputs?.bluetooth?.deviceId?.trim())
        .filter((deviceId): deviceId is string => Boolean(deviceId))
        .map((deviceId) => bluetoothClientId(deviceId)),
    );
    const clients = sendspinCore
      .listClients()
      .filter((client) => client.roles.includes('source@v1'))
      .filter((client) => !isBrowserClient(client.clientId))
      .filter((client) => !(client.clientId && bluetoothClients.has(client.clientId)))
      .map((client) => {
        const clientId = client.clientId;
        const controls = clientId
          ? sendspinCore.getSessionByClientId(clientId)?.getSourceSupport()?.controls ?? null
          : null;
        return {
          id: client.clientId,
          clientId: client.clientId,
          name: client.name,
          remote: client.remote,
          roles: client.roles,
          playbackState: client.playbackState,
          sourceState: client.sourceState,
          sourceSignal: client.sourceSignal,
          controls,
        };
      });
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('sendspin source discovery failed', { err });
    deps.sendJson(res, 500, { error: 'sendspin-source-discovery-failed' });
  }
}

function handleSnapcastDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): void {
  try {
    const clients = deps.snapcastCore.listClients().map((client) => ({
      id: client.clientId || client.streamId,
      clientId: client.clientId,
      streamId: client.streamId,
      connected: client.connected,
      connectedAt: client.connectedAt,
      latency: client.latency,
    }));
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('snapcast discovery failed', { err });
    deps.sendJson(res, 500, { error: 'snapcast-discovery-failed' });
  }
}

function handleSqueezeliteDiscovery(res: ServerResponse, deps: TransportsHandlerDeps): void {
  try {
    const cfg = deps.configPort.getConfig();
    const configuredByPlayerId = new Map<
      string,
      { zoneId: number; zoneName: string; latencyMs: number | null }
    >();
    (cfg.zones ?? []).forEach((zone) => {
      const output = zone.output;
      if (!output || typeof output !== 'object') return;
      if (output.id !== 'squeezelite') return;
      const out = output as { playerId?: unknown; latencyMs?: unknown };
      const rawPlayerId = typeof out.playerId === 'string' ? out.playerId : '';
      const normalized = normalizeSqueezelitePlayerId(rawPlayerId);
      if (!normalized) return;
      const rawLatency = out.latencyMs;
      const parsedLatency =
        typeof rawLatency === 'number'
          ? rawLatency
          : typeof rawLatency === 'string'
            ? Number(rawLatency)
            : null;
      const latencyMs = typeof parsedLatency === 'number' && Number.isFinite(parsedLatency)
        ? Math.round(parsedLatency)
        : null;
      configuredByPlayerId.set(normalized, { zoneId: zone.id, zoneName: zone.name, latencyMs });
    });

    const clients = deps.squeezeliteCore.players.map((player) => ({
      id: player.playerId,
      playerId: player.playerId,
      name: player.name,
      address: player.deviceAddress ?? null,
      port: player.devicePort ?? null,
      state: player.state,
      connected: player.connected,
      zoneId: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.zoneId ?? null,
      zoneName: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.zoneName ?? null,
      latency: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
      latencyMs: configuredByPlayerId.get(normalizeSqueezelitePlayerId(player.playerId))?.latencyMs ?? null,
    }));
    deps.sendJson(res, 200, { clients });
  } catch (err) {
    deps.log.warn('squeezelite discovery failed', { err });
    deps.sendJson(res, 500, { error: 'squeezelite-discovery-failed' });
  }
}

function discoverMdnsServices(
  mdns: MdnsPort,
  options: { type: string; protocol?: 'tcp' | 'udp' },
  timeoutMs: number,
): Promise<MdnsServiceRecord[]> {
  return new Promise((resolve) => {
    const byKey = new Map<string, MdnsServiceRecord>();
    const browser = mdns.browse({ type: options.type, protocol: options.protocol ?? 'tcp' }, (service) => {
      const key = `${service.name || service.host || (service.addresses?.[0] ?? 'unknown')}:${service.port}`;
      byKey.set(key, service);
    });
    setTimeout(() => {
      browser.stop();
      resolve([...byKey.values()]);
    }, timeoutMs);
  });
}

function mapSendspinMdnsService(
  service: MdnsServiceRecord,
): {
  id: string;
  name: string | null;
  host: string | null;
  addresses: string[];
  port: number;
  path: string;
  url: string;
  txt: Record<string, unknown> | null;
} | null {
  if (!service.port) {
    return null;
  }

  const addresses = (service.addresses || []).filter(Boolean) as string[];
  const pickAddress = (): string | null => {
    const ipv4 = addresses.find((addr) => addr.includes('.'));
    if (ipv4) return ipv4;
    if (addresses.length) return addresses[0] ?? null;
    if (typeof service.host === 'string' && service.host.trim()) return service.host.trim();
    return null;
  };

  const address = pickAddress();
  if (!address) {
    return null;
  }

  const txt = service.txt && typeof service.txt === 'object' ? (service.txt as Record<string, unknown>) : null;
  const rawPath = typeof txt?.path === 'string' ? txt.path : '/sendspin';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const hostFmt = address.includes(':') ? `[${address}]` : address;
  const url = `ws://${hostFmt}:${service.port}${path || '/sendspin'}`;
  const name = typeof service.name === 'string' && service.name.trim() ? service.name.trim() : null;

  return {
    id: `${name ?? address}:${service.port}`,
    name,
    host: typeof service.host === 'string' && service.host.trim() ? service.host.trim() : null,
    addresses,
    port: service.port,
    path: path || '/sendspin',
    url,
    txt,
  };
}

function normalizeSqueezelitePlayerId(value: string): string {
  if (!value) return '';
  return value.replace(/[^a-f0-9]/gi, '').toLowerCase();
}
