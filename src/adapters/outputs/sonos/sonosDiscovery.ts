import type { SonosDiscoveredDevice, SonosDiscoveryOptions } from '@/ports/OutputDiscoveryPort';
import {
  resolveEndpointsFromDescription,
  type DlnaEndpointInfo,
} from '@/adapters/outputs/dlna/dlnaDiscovery';
import dgram from 'node:dgram';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';

interface SsdpResponse {
  location: string;
  responder: string;
  usn?: string;
  st?: string;
}

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:ZonePlayer:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'ssdp:all',
];
const log = createLogger('Transport', 'SonosDiscovery');

export async function discoverSonosDevice(
  options: SonosDiscoveryOptions = {},
): Promise<SonosDiscoveredDevice | null> {
  const candidates = await discoverSonosDevices(options);
  if (!candidates.length) {
    return null;
  }
  const preferredName = options.preferredName?.toLowerCase();
  if (preferredName) {
    const match = candidates.find((device) => {
      const name = device.name?.toLowerCase();
      const room = device.roomName?.toLowerCase();
      return name === preferredName || room === preferredName;
    });
    if (match) {
      return match;
    }
  }
  return candidates[0] ?? null;
}

export async function discoverSonosDevices(
  options: SonosDiscoveryOptions = {},
): Promise<SonosDiscoveredDevice[]> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const responses = await searchSsdp(timeoutMs);
  const devices: SonosDiscoveredDevice[] = [];
  const seen = new Set<string>();
  for (const { location, responder } of responses) {
    try {
      const device = await resolveDeviceFromLocation(location, responder, options.householdId);
      if (!device) {
        continue;
      }
      const key = `${device.host}|${device.udn ?? ''}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      devices.push(device);
    } catch (err) {
      log.debug('sonos ssdp parse failed', {
        location,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (devices.length || !options.allowNetworkScan) {
    return enrichWithTopology(devices, options.householdId, timeoutMs);
  }

  const scanned = await scanNetworkForSonos(options.householdId, timeoutMs);
  for (const device of scanned) {
    const key = `${device.host}|${device.udn ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    devices.push(device);
  }
  return enrichWithTopology(devices, options.householdId, timeoutMs);
}

/**
 * Best-effort mapping to hide passive/bonded satellites and improve naming.
 *
 * SSDP will often return all members (including passive satellites of stereo pairs/surround)
 * as individual responders, which makes the output picker misleading.
 */
async function enrichWithTopology(
  devices: SonosDiscoveredDevice[],
  requestedHouseholdId: string | undefined,
  timeoutMs: number,
): Promise<SonosDiscoveredDevice[]> {
  if (!devices.length) {
    return devices;
  }
  try {
    // Group by household so we don't accidentally apply topology across households.
    const buckets = new Map<string, SonosDiscoveredDevice[]>();
    for (const device of devices) {
      const householdKey = device.householdId?.trim() || requestedHouseholdId?.trim() || '';
      const bucket = buckets.get(householdKey) ?? [];
      bucket.push(device);
      buckets.set(householdKey, bucket);
    }

    const results: SonosDiscoveredDevice[] = [];
    const seen = new Set<string>();

    for (const [householdKey, bucket] of buckets.entries()) {
      const seedHost = bucket.find((d) => d.host)?.host;
      const topologyXml = seedHost
        ? await fetchTopology(seedHost, Math.min(Math.max(timeoutMs, 800) + 300, 2200))
        : null;
      const topology = topologyXml ? parseTopology(topologyXml) : null;

      for (const device of bucket) {
        const host = normalizeHost(device.host);
        const info = topology?.hosts.get(host);
        if (info?.passiveSatellite) {
          continue;
        }
        const merged: SonosDiscoveredDevice = {
          ...device,
          host,
          name: device.name ?? info?.zoneName ?? device.roomName,
          roomName: device.roomName ?? info?.zoneName,
          udn: device.udn ?? info?.udn,
          householdId: device.householdId ?? (householdKey || undefined),
        };
        const key = `${merged.host}|${merged.udn ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(merged);
      }
    }

    return results;
  } catch {
    return devices;
  }
}

type TopologyHostInfo = {
  host: string;
  udn?: string;
  zoneName?: string;
  passiveSatellite?: boolean;
  coordinatorHost?: string;
};

function parseTopology(xml: string): { hosts: Map<string, TopologyHostInfo> } {
  const hosts = new Map<string, TopologyHostInfo>();

  const groupRe = /<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/gi;
  let groupMatch: RegExpExecArray | null;
  while ((groupMatch = groupRe.exec(xml))) {
    const groupAttrs = parseXmlAttrs(groupMatch[1] ?? '');
    const coordinatorUdn = normalizeUdn(groupAttrs.Coordinator ?? groupAttrs.coordinator);
    const body = groupMatch[2] ?? '';

    const members: Array<{
      host: string;
      udn?: string;
      zoneName?: string;
      passiveSatellite: boolean;
    }> = [];

    const memberRe = /<ZoneGroupMember\b([^>]*?)(?:\/>|>)/gi;
    let memberMatch: RegExpExecArray | null;
    while ((memberMatch = memberRe.exec(body))) {
      const attrs = parseXmlAttrs(memberMatch[1] ?? '');
      const location = attrs.Location ?? attrs.location ?? '';
      const host = normalizeHost(extractHost(location) || '');
      if (!host) continue;
      const udn = normalizeUdn(
        attrs.UUID ?? attrs.Uuid ?? attrs.uuid ?? attrs.UDN ?? attrs.Udn ?? attrs.udn,
      );
      const zoneName = (attrs.ZoneName ?? attrs.zonename ?? attrs.zoneName ?? '').trim() || undefined;
      const invisible = String(attrs.Invisible ?? attrs.invisible ?? '').trim().toLowerCase();
      const satellite = String(attrs.Satellite ?? attrs.satellite ?? '').trim().toLowerCase();
      const isPassive = invisible === '1' || invisible === 'true' || satellite === '1' || satellite === 'true';
      members.push({ host, udn: udn ?? undefined, zoneName, passiveSatellite: isPassive });
    }

    const coordinatorHost =
      members.find((m) => coordinatorUdn && normalizeUdn(m.udn) === coordinatorUdn)?.host ??
      members[0]?.host ??
      undefined;

    for (const member of members) {
      hosts.set(member.host, {
        host: member.host,
        udn: member.udn,
        zoneName: member.zoneName,
        passiveSatellite: member.passiveSatellite,
        coordinatorHost,
      });
    }
  }

  return { hosts };
}

function parseXmlAttrs(fragment: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment))) {
    out[match[1]!] = match[2] ?? '';
  }
  return out;
}

function normalizeUdn(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/^uuid:/i, '').trim();
  return normalized || null;
}

async function fetchTopology(host: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(300, timeoutMs));
  timeout.unref();
  try {
    const url = `http://${host}:1400/status/topology`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Endpoints for a player we already have an address for, without asking the network.
 *
 * A zone that names its Sonos by IP still had its endpoints resolved over SSDP, so a
 * speaker that answers every HTTP request we make came back as "no Sonos endpoints
 * discovered" wherever multicast replies do not reach us — a bridged Docker network,
 * a VLAN without an IGMP querier (#374). Music Assistant draws the line in the same
 * place: a configured address is talked to directly, and discovery exists only to
 * find the players nobody named.
 */
export async function resolveSonosEndpointsByHost(
  host: string,
  timeoutMs = 2000,
): Promise<DlnaEndpointInfo | null> {
  const normalized = normalizeHost(host);
  if (!normalized) {
    return null;
  }
  return resolveEndpointsFromDescription(
    `http://${normalized}:1400/xml/device_description.xml`,
    timeoutMs,
  );
}

export async function resolveSonosCoordinatorHost(options: {
  host: string;
  timeoutMs?: number;
}): Promise<string> {
  const host = normalizeHost(options.host);
  if (!host) return '';
  const xml = await fetchTopology(host, Math.min(Math.max(500, options.timeoutMs ?? 1200), 2500));
  if (!xml) return host;
  const topology = parseTopology(xml);
  const info = topology.hosts.get(host);
  if (!info?.passiveSatellite || !info.coordinatorHost) {
    return host;
  }
  const coordinator = normalizeHost(info.coordinatorHost);
  return coordinator || host;
}

async function resolveDeviceFromLocation(
  location: string,
  responder: string,
  householdId?: string,
): Promise<SonosDiscoveredDevice | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1800);
  timeout.unref();
  try {
    const response = await fetch(location, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const xml = await response.text();
    if (!xml.includes('Sonos')) {
      return null;
    }
    const host = normalizeHost(responder) || extractHost(location);
    if (!host) {
      return null;
    }
    const description = readSonosDescription(xml);
    const status = await fetchStatus(host, householdId);
    const roomName = description.roomName ?? status?.roomName;
    return {
      host,
      // friendlyName is "<ip> - <model>": it names the box, not the room, so it only stands in
      // when the speaker tells us nothing better.
      name: roomName ?? description.friendlyName,
      roomName,
      model: description.model,
      udn: description.udn,
      householdId: status?.householdId,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStatus(
  host: string,
  householdId?: string,
): Promise<{ roomName?: string; householdId?: string } | null> {
  const url = `http://${host}:1400/status/zp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  timeout.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const status = readSonosStatus(await response.text());
    if (householdId && status.householdId && householdId !== status.householdId) {
      return null;
    }
    return status;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function scanNetworkForSonos(
  householdId: string | undefined,
  timeoutMs: number,
): Promise<SonosDiscoveredDevice[]> {
  const hosts = buildLocalScanHosts();
  if (!hosts.length) {
    return [];
  }
  const concurrency = 40;
  const devices: SonosDiscoveredDevice[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < hosts.length) {
      const host = hosts[index]!;
      index += 1;
      try {
        const status = await fetchStatus(host, householdId);
        if (!status) {
          continue;
        }
        devices.push({
          host,
          name: status.roomName,
          roomName: status.roomName,
          householdId: status.householdId,
        });
      } catch {
        /* ignore */
      }
      await delay(5);
    }
  };
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.race([Promise.all(workers), delay(timeoutMs)]);
  return devices;
}

async function searchSsdp(timeoutMs: number): Promise<SsdpResponse[]> {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const responses: SsdpResponse[] = [];
  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(() => resolve());
  });
  const requests = SEARCH_TARGETS.map((target) => buildSearchRequest(2, target));
  for (const request of requests) {
    socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS);
  }
  socket.on('message', (msg, rinfo) => {
    try {
      const headers = parseSsdpResponse(msg.toString());
      const location = headers.location;
      if (!location) {
        return;
      }
      const key = `${rinfo.address}|${location}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      responses.push({
        location,
        responder: rinfo.address,
        usn: headers.usn,
        st: headers.st ?? headers.nt,
      });
    } catch {
      /* ignore */
    }
  });
  await delay(timeoutMs);
  socket.close();
  return responses;
}

function parseSsdpResponse(payload: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = payload.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }
  return headers;
}

function buildSearchRequest(mx: number, target: string): Buffer {
  const payload = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${target}`,
    '',
    '',
  ].join('\r\n');
  return Buffer.from(payload);
}

/**
 * What a speaker's UPnP device description says about itself. The first match of each tag is
 * the root device's; the embedded MediaRenderer/MediaServer devices come after it.
 */
export function readSonosDescription(xml: string): {
  friendlyName?: string;
  roomName?: string;
  model?: string;
  udn?: string;
} {
  return {
    friendlyName: matchTag(xml, 'friendlyName') ?? undefined,
    // The room name as the user set it in the Sonos app — on S1 and S2 alike.
    roomName: matchTag(xml, 'roomName') ?? undefined,
    model: matchTag(xml, 'modelName') ?? undefined,
    udn: matchTag(xml, 'UDN')?.replace(/^uuid:/i, '') || undefined,
  };
}

/**
 * What /status/zp says. S2 firmware dropped <RoomName> there; its <ZoneName> is the room name
 * with the speaker's channels appended — "Living Room (LF,RF)" for a stereo pair.
 */
export function readSonosStatus(xml: string): { roomName?: string; householdId?: string } {
  return {
    roomName: matchTag(xml, 'RoomName') ?? stripChannelSuffix(matchTag(xml, 'ZoneName')) ?? undefined,
    householdId: matchTag(xml, 'HouseholdControlID') ?? undefined,
  };
}

// Only Sonos channel codes, so a room the user named "Office (AV)" keeps its name.
const CHANNEL_SUFFIX = /\s*\((?:LF|RF|SW\d?|LR|RR)(?:,(?:LF|RF|SW\d?|LR|RR))*\)$/;

function stripChannelSuffix(value: string | null): string | null {
  if (!value) return null;
  return value.replace(CHANNEL_SUFFIX, '').trim() || null;
}

function matchTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'));
  const value = match?.[1] ? decodeXmlEntities(match[1]).trim() : '';
  return value || null;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (whole, dec, hex, named) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    const map: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return map[String(named).toLowerCase()] ?? whole;
  });
}

function extractHost(location: string): string {
  try {
    const parsed = new URL(location);
    return normalizeHost(parsed.hostname);
  } catch {
    return '';
  }
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
}

function buildLocalScanHosts(): string[] {
  const interfaces = os.networkInterfaces();
  const hosts = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') {
        continue;
      }
      if (entry.internal) {
        continue;
      }
      const parts = entry.address.split('.');
      if (parts.length !== 4) {
        continue;
      }
      const base = parts.slice(0, 3).join('.');
      for (let i = 1; i <= 254; i += 1) {
        hosts.add(`${base}.${i}`);
      }
    }
  }
  return Array.from(hosts);
}
