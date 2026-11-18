import dgram from 'node:dgram';
import os from 'node:os';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import { defaultLocalIp } from '@/shared/utils/net';

const DEFAULT_PORT = 7070;
/**
 * Where a search listens for its answers, whatever port it sent the probe from. The Miniserver
 * probes from this port itself; Loxone Config probes from another and still listens here.
 */
const REPLY_PORT = 7071;
/**
 * What kind of media server answers. Loxone Config reads anything below 1 as the old Music
 * Server and offers to add that instead of an Audioserver.
 */
const AUDIOSERVER_SUBTYPE = 1;

/**
 * Answers the search the Miniserver runs for Loxone Config, so the server can be added from
 * "Audio device search" instead of by typing its address.
 *
 * A search is one zero byte, broadcast to this port. What comes back decides what the device is:
 * Config sorts the answers by how they begin, and an Audioserver is the one that begins with
 * `LoxMedia`. A JSON answer is a generic network device (an intercom), which the audio search
 * leaves out however its fields are filled in.
 */
export class LoxoneUdpDiscovery {
  private readonly log = createLogger('Loxone', 'UDPDiscovery');
  private socket: dgram.Socket | null = null;

  public start(config: LoxoneHttpConfig, configPort: ConfigPort, port: number = DEFAULT_PORT): void {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (error) => {
      this.log.warn('udp discovery socket error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    socket.on('message', (msg, rinfo) => {
      this.log.info('udp discovery probe received', {
        from: `${rinfo.address}:${rinfo.port}`,
        length: msg.length,
        payload: msg.length <= 32 ? msg.toString('hex') : undefined,
      });

      // Built per probe: the address depends on who asks, and pairing can change while we run.
      const answer = buildDiscoveryAnswer(config, configPort, localAddressFacing(rinfo.address));
      const payload = Buffer.from(answer, 'utf8');
      const ports = rinfo.port === REPLY_PORT ? [REPLY_PORT] : [rinfo.port, REPLY_PORT];
      for (const replyPort of ports) {
        // Sent from the socket the probe arrived on, so the answer comes from the discovery port.
        socket.send(payload, replyPort, rinfo.address, (err) => {
          if (err) {
            this.log.warn('udp discovery response failed', {
              to: `${rinfo.address}:${replyPort}`,
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          this.log.info('udp discovery response sent', { to: `${rinfo.address}:${replyPort}`, answer });
        });
      }
    });

    socket.bind(port, () => {
      this.log.info('udp discovery listener started', { port });
    });
  }

  public stop(): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = null;
    socket.close(() => {
      this.log.info('udp discovery listener stopped');
    });
  }
}

/**
 * The line an Audioserver answers a search with. Config reads the fields by name and in this
 * order; everything from `Hostname` on is optional to it. `Paired` is the word `true` or
 * `false`, and `Master` is the Miniserver the server belongs to.
 */
export function buildDiscoveryAnswer(config: LoxoneHttpConfig, configPort: ConfigPort, address: string): string {
  const system = configPort.getSystemConfig();
  const mac = hexOnly(system?.audioserver?.macId || config.macAddress);
  const master = hexOnly(system?.miniserver?.serial);
  const fields = [
    `IP:${address}`,
    `MAC:${mac}`,
    'Product:Audioserver',
    `Version:${config.firmwareVersionNumber}`,
    `SubType:${AUDIOSERVER_SUBTYPE}`,
    `Hostname:${config.hostname}`,
    `Paired:${master ? 'true' : 'false'}`,
    ...(master ? [`Master:${master}`] : []),
  ];
  return `LoxMedia ${fields.join(' ')}`;
}

/** Our address on the network the asker is on, so the answer names one it can reach. */
function localAddressFacing(remote: string): string {
  const target = ipv4ToInt(remote);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue;
      }
      const mask = ipv4ToInt(entry.netmask);
      if (target !== null && mask !== null && (ipv4ToInt(entry.address)! & mask) === (target & mask)) {
        return entry.address;
      }
    }
  }
  return defaultLocalIp();
}

function ipv4ToInt(value: string): number | null {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** A serial as Loxone writes it: twelve hex digits, no separators. */
function hexOnly(value: string | undefined): string {
  return (value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
}
