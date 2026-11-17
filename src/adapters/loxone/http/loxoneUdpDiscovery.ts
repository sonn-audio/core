import dgram from 'node:dgram';
import type { LoxoneHttpConfig } from '@/config/loxone';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';

const DEFAULT_PORT = 7070;
/**
 * Where a search is also answered, besides the port the probe came from. Loxone Config is
 * reported to listen here for the answers to a probe it sent from elsewhere; not confirmed
 * against Config itself, and an answer nobody listens for costs nothing.
 */
const REPLY_PORT = 7071;
const BROADCAST_ADDRESS = '255.255.255.255';

export class LoxoneUdpDiscovery {
  private readonly log = createLogger('Loxone', 'UDPDiscovery');
  private socket: dgram.Socket | null = null;
  private responsePayload = Buffer.alloc(0);
  private readonly fixedTv = '3';
  private readonly fixedDi = '1';

  public start(config: LoxoneHttpConfig, configPort: ConfigPort, port: number = DEFAULT_PORT): void {
    if (this.socket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    this.responsePayload = Buffer.from(
      this.buildPayload(config, configPort, this.fixedTv, this.fixedDi),
      'utf8',
    );

    socket.on('error', (error) => {
      this.log.warn('udp discovery socket error', {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    socket.on('message', (msg, rinfo) => {
      const payload = msg.length ? msg : Buffer.alloc(0);
      this.log.info('udp discovery probe received', {
        from: `${rinfo.address}:${rinfo.port}`,
        length: payload.length,
        payload: payload.length <= 32 ? payload.toString('hex') : undefined,
      });

      // Every answer leaves from the socket the probe arrived on, so it comes from the
      // discovery port itself.
      socket.send(this.responsePayload, rinfo.port, rinfo.address, (err) => {
        if (err) {
          this.log.warn('udp discovery response failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        this.log.info('udp discovery response sent', {
          to: `${rinfo.address}:${rinfo.port}`,
          length: this.responsePayload.length,
          tv: this.fixedTv,
          di: this.fixedDi,
        });
      });

      // The same answer on the reply port: to the machine that asked, and to the whole
      // network for a search whose probe reached us from another address than it listens on.
      const alsoTo = [
        ...(rinfo.port === REPLY_PORT ? [] : [rinfo.address]),
        BROADCAST_ADDRESS,
      ];
      for (const address of alsoTo) {
        socket.send(this.responsePayload, REPLY_PORT, address, (err) => {
          if (err) {
            this.log.debug('udp discovery reply-port response failed', {
              to: `${address}:${REPLY_PORT}`,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
    });

    socket.bind(port, () => {
      socket.setBroadcast(true);
      this.log.info('udp discovery listener started', {
        port,
        response: this.responsePayload.toString('utf8'),
      });
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

  private buildPayload(config: LoxoneHttpConfig, configPort: ConfigPort, tv: string, di: string): string {
    const identity = resolveDiscoveryIdentity(config, configPort);
    const payload = {
      t: 'Audioserver',
      tv,
      n: identity.name,
      s: identity.mac,
      v: config.firmwareVersionNumber,
      p: String(identity.port),
      hn: identity.hostname,
      di,
    };

    return JSON.stringify(payload);
  }
}

/** How this server names itself to a search, whichever way the search is made. */
export interface DiscoveryIdentity {
  /** The name shown in the search result: the one set in Loxone, else the default. */
  name: string;
  /** Host label, without `.local`. */
  hostname: string;
  /** The server's MAC, colon-separated. */
  mac: string;
  /** The port the app and Loxone Config talk to. */
  port: number;
}

export function resolveDiscoveryIdentity(config: LoxoneHttpConfig, configPort: ConfigPort): DiscoveryIdentity {
  const systemConfig = configPort.getSystemConfig();
  const configuredName = systemConfig?.audioserver?.name?.trim();
  const name =
    configuredName && configuredName.toLowerCase() !== 'unconfigured'
      ? configuredName
      : config.mdns.name || 'sonn-core';
  const macId = systemConfig?.audioserver?.macId?.trim();
  const appServer = config.servers.find((server) => server.name === 'appHttp');
  return {
    name,
    hostname: sanitizeHostname(config.mdns.hostname || name),
    mac: formatMacAddress(macId || config.macAddress),
    port: appServer?.port ?? config.mdns.port,
  };
}

function sanitizeHostname(value: string): string {
  const trimmed = value.trim();
  const withoutLocal = trimmed.endsWith('.local') ? trimmed.slice(0, -6) : trimmed;
  return withoutLocal.replace(/\s+/g, '-').replace(/\./g, '-') || 'audioserver';
}

function formatMacAddress(raw: string): string {
  const normalized = raw.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (normalized.length !== 12) {
    return raw;
  }
  return normalized.match(/.{2}/g)?.join(':') ?? raw;
}
