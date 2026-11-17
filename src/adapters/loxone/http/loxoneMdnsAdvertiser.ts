import type { LoxoneHttpConfig } from '@/config/loxone';
import { resolveDiscoveryIdentity } from '@/adapters/loxone/http/loxoneUdpDiscovery';
import { createLogger } from '@/shared/logging/logger';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { MdnsPort, MdnsRegistration } from '@/ports/MdnsPort';

/**
 * Announces the server over mDNS the way an Audioserver does, next to the answer it gives a
 * UDP search: a search that browses the network finds what one that probes it would.
 */
export class LoxoneMdnsAdvertiser {
  private readonly log = createLogger('Loxone', 'Mdns');
  private registration: MdnsRegistration | null = null;

  constructor(private readonly mdns: MdnsPort) {}

  public start(config: LoxoneHttpConfig, configPort: ConfigPort): void {
    this.stop();
    const identity = resolveDiscoveryIdentity(config, configPort);
    const txt = {
      version: config.mdns.version,
      txtvers: config.mdns.txtVersion,
      devicetype: config.mdns.deviceType,
      deviceinstance: config.mdns.deviceInstance,
      mac: identity.mac,
    };
    try {
      this.registration = this.mdns.publish({
        name: identity.name,
        type: config.mdns.type,
        protocol: 'tcp',
        port: identity.port,
        host: `${identity.hostname}.local`,
        txt,
      });
      this.log.info('audioserver advertised via mDNS', { name: identity.name, port: identity.port, txt });
    } catch (error) {
      this.log.warn('mdns advertisement failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public stop(): void {
    this.registration?.stop();
    this.registration = null;
  }
}
