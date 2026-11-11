import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { asyncCrc32 } from '@/shared/utils/crc32';
import { createLogger } from '@/shared/logging/logger';
import type { AudioServerConfig } from '@/domain/config/types';
import { extractZonesFromLoxoneConfig, buildZoneConfigs } from '@/adapters/loxone/services/loxoneZoneExtractor';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ContentManager } from '@/adapters/content/contentManager';
import type { NotifierPort } from '@/ports/NotifierPort';
import type { FixedGroupsPort } from '@/application/groups/groupManager';
import { extractFixedGroupsFromLoxoneConfig } from '@/adapters/loxone/services/loxoneFixedGroups';

type RawConfigPayload = {
  raw: unknown;
  rawString: string;
};

/**
 * Lightweight domain service that exposes configuration operations required by
 * the Loxone HTTP handlers.
 */
export class LoxoneConfigService {
  private readonly log = createLogger('Loxone', 'ConfigService');
  constructor(
    private readonly zoneManager: ZoneManagerFacade,
    private readonly configPort: ConfigPort,
    private readonly contentManager: ContentManager,
    private readonly notifier: NotifierPort,
    private readonly fixedGroups: FixedGroupsPort | null = null,
  ) {}

  private get zones(): ZoneManagerFacade {
    return this.zoneManager;
  }

  private get config(): ConfigPort {
    return this.configPort;
  }

  private get content(): ContentManager {
    return this.contentManager;
  }

  private get notifications(): NotifierPort {
    return this.notifier;
  }

  public getCurrentConfigInfo(): { crc32: string | null; extensions: unknown[] } {
    const cfg = this.config.getConfig();
    return {
      crc32: cfg.rawAudioConfig.crc32,
      extensions: cfg.system.audioserver.extensions ?? [],
    };
  }

  public async setRawAudioConfig(payload: RawConfigPayload): Promise<string | null> {
    let crc32: string | null = null;

    await this.config.updateConfig(async (cfg) => {
      crc32 = await this.persistRawConfig(cfg, payload);
      await this.applySystemMetadata(cfg, payload.raw);
      this.extractZonesFromPayload(cfg, payload.raw);
      await this.zones.replaceAll(cfg.zones, cfg.inputs, cfg.groups ?? null);
      this.content.refreshFromConfig();
    });
    this.applyFixedGroups();

    return crc32;
  }

  /**
   * Applies the fixed groups of the stored Miniserver config (`rawAudioConfig`).
   *
   * Runs after every setconfig, and at startup: the Miniserver only sends its config again
   * when the CRC differs, so after a restart the stored copy is all there is.
   */
  public applyFixedGroups(): void {
    if (!this.fixedGroups) {
      return;
    }
    try {
      const cfg = this.config.getConfig();
      const macId = cfg.system?.audioserver?.macId?.trim().toUpperCase();
      const stored = cfg.rawAudioConfig;
      const raw = stored?.raw ?? stored?.rawString ?? null;
      const definitions = macId && raw ? extractFixedGroupsFromLoxoneConfig(raw, macId) : [];
      if (definitions.length) {
        this.log.info('applying fixed groups', {
          groups: definitions.map((group) => ({ id: group.externalId, players: group.members })),
        });
      }
      this.fixedGroups.reconcileFixedGroups(definitions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn('applying fixed groups failed', { message });
    }
  }

  public async applyVolumePreset(players: unknown[]): Promise<number> {
    const entries = Array.isArray(players) ? players : [];
    let updated = 0;

    await this.config.updateConfig((cfg) => {
      entries.forEach((entry) => {
        if (!entry || typeof entry !== 'object') {
          return;
        }
        const payload = entry as Record<string, unknown>;
        const zoneId = Number(payload.playerid);
        if (!Number.isFinite(zoneId)) {
          return;
        }
        const zone = cfg.zones.find((z) => z.id === zoneId);
        if (!zone) {
          this.log.debug('volume preset ignored; unknown zone', { zoneId });
          return;
        }
        const volumes = zone.volumes as unknown as Record<string, number>;
        let changed = false;
        for (const [key, value] of Object.entries(payload)) {
          if (key in volumes && typeof value === 'number') {
            volumes[key] = value;
            changed = true;
          }
        }
        if (changed) {
          updated += 1;
        }
      });
    });

    this.log.info('volume preset applied', {
      players: entries.length,
      updated,
    });
    return updated;
  }

  public async applyDefaultVolume(zoneId: number, value: number): Promise<void> {
    await this.updateZone(zoneId, (zone) => {
      zone.volumes.default = value;
    });
  }

  public async applyMaxVolume(zoneId: number, value: number): Promise<void> {
    await this.updateZone(zoneId, (zone) => {
      zone.volumes.maxVolume = value;
    });
  }

  public async applyEventVolumes(
    zoneId: number,
    updater: Record<string, unknown>,
  ): Promise<boolean> {
    let applied = false;
    await this.config.updateConfig((cfg) => {
      const zone = cfg.zones.find((z) => z.id === zoneId);
      if (!zone) {
        this.log.warn('zone not found for event volumes update', { zoneId });
        return;
      }
      const volumes = zone.volumes as unknown as Record<string, number>;
      for (const [key, value] of Object.entries(updater)) {
        if (typeof value === 'number' && Number.isFinite(value) && key in volumes) {
          volumes[key] = value;
          applied = true;
        }
      }
    });
    return applied;
  }

  public async applyPlayerNames(
    updates: Array<{ zoneId: number; name: string }>,
  ): Promise<void> {
    if (!updates.length) {
      return;
    }
    await this.config.updateConfig((cfg) => {
      for (const { zoneId, name } of updates) {
        const zone = cfg.zones.find((z) => z.id === zoneId);
        if (zone) {
          zone.name = name;
        } else {
          this.log.debug('player name update ignored; unknown zone', { zoneId, name });
        }
      }
    });
    updates.forEach(({ zoneId, name }) => this.zones.renameZone(zoneId, name));
  }

  private async updateZone(
    zoneId: number,
    updateFn: (zone: AudioServerConfig['zones'][number]) => void,
  ): Promise<void> {
    await this.config.updateConfig((cfg) => {
      const zone = cfg.zones.find((z) => z.id === zoneId);
      if (!zone) {
        this.log.warn('zone not found for config update', { zoneId });
        return;
      }
      updateFn(zone);
    });
  }

  private async persistRawConfig(
    cfg: AudioServerConfig,
    payload: RawConfigPayload,
  ): Promise<string> {
    const crc32 = await this.computeCrc(payload.rawString);
    cfg.rawAudioConfig = {
      raw: payload.raw,
      rawString: payload.rawString,
      crc32,
    };
    return crc32;
  }

  public notifyReloadMusicApp(
    action: 'useradd' | 'userdel',
    provider: string,
    userId: string,
  ): void {
    this.notifications.notifyReloadMusicApp(action, provider, userId);
  }

  private extractZonesFromPayload(cfg: AudioServerConfig, parsed: unknown): void {
    const macId = cfg.system.audioserver.macId?.trim().toUpperCase();
    if (!macId || !parsed) {
      return;
    }

    const descriptors = extractZonesFromLoxoneConfig(parsed, macId);
    if (!descriptors.length) {
      return;
    }

    cfg.zones = buildZoneConfigs(descriptors, cfg.zones ?? []);
  }

  private async computeCrc(rawString: string): Promise<string> {
    return asyncCrc32(rawString);
  }

  private async applySystemMetadata(cfg: AudioServerConfig, parsed: unknown): Promise<void> {
    const macId = cfg.system.audioserver.macId?.trim().toUpperCase();
    if (!macId) {
      return;
    }
    const section = this.findServerSection(parsed, macId);
    if (!section) {
      return;
    }

    const serverIp = this.normalizeString(section.host);
    const name = this.normalizeString(section.name);
    const uuid = this.normalizeString(section.uuid);
    const hostIp = this.normalizeString(section.ip);
    const hostPort = this.normalizePort(section.port);
    const masterSerial = this.normalizeString(section.master);

    if (serverIp) {
      cfg.system.audioserver.ip = serverIp;
    }
    if (name) {
      cfg.system.audioserver.name = name;
    }
    if (uuid) {
      cfg.system.audioserver.uuid = uuid;
    }
    cfg.system.audioserver.paired = true;

    if (Array.isArray(section.extensions)) {
      const baseMac = macId.trim().toUpperCase();
      const seen = new Set<string>();
      if (baseMac) {
        seen.add(baseMac);
      }
      let fallbackIndex = 1;

      cfg.system.audioserver.extensions = section.extensions
        .map((entry: any) => {
          let mac = this.normalizeString(entry?.serial)?.toUpperCase();
          const extName = this.normalizeString(entry?.name);

          if (!mac || seen.has(mac)) {
            mac = this.computeExtensionSerial(baseMac, fallbackIndex);
            fallbackIndex += 1;
            while (mac && seen.has(mac)) {
              mac = this.computeExtensionSerial(baseMac, fallbackIndex);
              fallbackIndex += 1;
            }
          }

          if (!mac) {
            return null;
          }
          seen.add(mac);
          return {
            mac,
            name: extName || `Extension ${mac.slice(-4)}`,
          };
        })
        .filter(
          (
            entry: { mac: string; name: string } | null,
          ): entry is { mac: string; name: string } => Boolean(entry),
        );
    }

    if (hostIp) {
      cfg.system.miniserver.ip = hostIp;
      const previousPort = cfg.system.miniserver.port;
      if (hostPort !== undefined) {
        cfg.system.miniserver.port = hostPort;
      }
      const shouldProbeProtocol =
        typeof hostPort === 'number' &&
        Number.isInteger(hostPort) &&
        hostPort > 0 &&
        hostPort <= 65535 &&
        previousPort !== hostPort;
      if (shouldProbeProtocol) {
        cfg.system.miniserver.protocol = await this.detectProtocolViaTlsProbe(hostIp, hostPort);
      }
    }
    if (masterSerial) {
      cfg.system.miniserver.serial = masterSerial;
    }
  }

  private computeExtensionSerial(baseMac: string, index: number): string | undefined {
    const normalized = baseMac.trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    if (!normalized) return undefined;
    const offset = BigInt(Math.max(0, index));
    try {
      const baseValue = BigInt(`0x${normalized}`);
      const next = baseValue + offset;
      return next.toString(16).toUpperCase().padStart(normalized.length, '0');
    } catch {
      return undefined;
    }
  }

  private findServerSection(parsed: unknown, macId: string): any | undefined {
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const needle = macId.trim().toUpperCase();
    const items: Record<string, unknown>[] = parsed as Record<string, unknown>[];
    for (let index = 0; index < items.length; index += 1) {
      const entry: Record<string, unknown> | undefined = items[index];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      const matchKey = Object.keys(entry).find(
        (key) => key.trim().toUpperCase() === needle,
      );
      if (matchKey) {
        return entry[matchKey];
      }
    }
    return undefined;
  }

  private normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private normalizePort(value: unknown): number | undefined {
    let parsed: number | undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed = value;
    } else if (typeof value === 'string' && value.trim()) {
      parsed = Number.parseInt(value.trim(), 10);
    }

    if (parsed === undefined) {
      return undefined;
    }
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return undefined;
    }
    return parsed;
  }

  private async detectProtocolViaTlsProbe(host: string, port: number): Promise<'http' | 'https'> {
    const socketHost = this.normalizeSocketHost(host);
    if (!socketHost) {
      return 'http';
    }

    const isTls = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      const socket = tlsConnect(
        {
          host: socketHost,
          port,
          rejectUnauthorized: false,
          servername: isIP(socketHost) ? undefined : socketHost,
          timeout: 1500,
        },
        () => {
          socket.end();
          finish(true);
        },
      );

      socket.once('error', () => finish(false));
      socket.once('timeout', () => {
        socket.destroy();
        finish(false);
      });
      socket.once('close', () => finish(false));
    });

    return isTls ? 'https' : 'http';
  }

  private normalizeSocketHost(host: string): string {
    const trimmed = host.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

}
