import { createLogger } from '@/shared/logging/logger';
import path from 'node:path';
import { FileAlertProvider } from '@/application/alerts/fileAlertProvider';
import { GoogleTtsProvider } from '@/application/alerts/googleTtsProvider';
import { createTtsProvider, isExternalTtsProvider } from '@/application/alerts/ttsProviderFactory';
import type { TtsProvider } from '@/application/alerts/ttsProvider';
import type { AlertAction, AlertActionResult, AlertMediaResource } from '@/application/alerts/types';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { TtsProviderConfig, ZoneVolumesConfig } from '@/domain/config/types';
import type { ConfigPort } from '@/ports/ConfigPort';

const DEFAULT_ALERT_VOLUME = 30;
const MIN_VOLUME = 0;
const MAX_VOLUME = 100;
const CUSTOM_URL_PREFIX = 'custom_url/';

export class AlertsManager {
  private readonly log = createLogger('Alerts', 'Manager');
  private readonly fileProvider = new FileAlertProvider();
  private readonly internalTtsProvider = new GoogleTtsProvider();
  private readonly externalProviders = new Map<string, TtsProvider>();
  private zoneManager: ZoneManagerFacade | null = null;
  private configPort: ConfigPort | null = null;

  public initOnce(deps: { zoneManager: ZoneManagerFacade; configPort?: ConfigPort }): void {
    if (this.zoneManager) {
      throw new Error('alerts manager already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('alerts manager missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
    this.configPort = deps.configPort ?? null;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public async handleGroupedAlert(
    leaderId: number,
    type: string,
    action: AlertAction,
    targetZones?: number[],
    ttsText?: string,
    ttsLang?: string,
    volumeOverride?: number,
  ): Promise<AlertActionResult> {
    const zones = targetZones?.length ? targetZones : leaderId ? [leaderId] : [];
    const normalizedType = type.toLowerCase();

    if (!zones.length) {
      return { success: false, type: normalizedType, action, reason: 'invalid-zones' };
    }

    this.log.info(`${action.toUpperCase()} alert`, { type: normalizedType, zones });

    if (action === 'off') {
      await Promise.all(zones.map((zoneId) => this.zones.stopAlert(zoneId)));
      return { success: true, type: normalizedType, action };
    }

    const media = await this.resolveMedia(normalizedType, ttsText, ttsLang);
    if (!media) {
      this.log.warn('no media resolved for alert', { type: normalizedType });
      return { success: false, type: normalizedType, action, reason: 'media-unavailable' };
    }
    const startDelays = this.zones.prepareAlertStart(zones);
    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, normalizedType, volumeOverride);
        await this.zones.startAlert(
          zoneId,
          normalizedType,
          media,
          volume,
          startDelays.get(zoneId) ?? 0,
        );
      }),
    );

    return { success: true, type: normalizedType, action };
  }

  public async handleUploadedAlert(
    filename: string,
    targetZones: number[],
  ): Promise<AlertActionResult> {
    const zones = targetZones?.length ? targetZones : [];
    if (!filename || !zones.length) {
      return { success: false, type: 'uploaded', action: 'on', reason: 'invalid-input' };
    }
    this.log.info('ON uploaded alert', { filename, zones });

    const media = await this.fileProvider.resolveUploaded(filename);
    if (!media) {
      return { success: false, type: 'uploaded', action: 'on', reason: 'media-unavailable' };
    }
    const startDelays = this.zones.prepareAlertStart(zones);
    await Promise.all(
      zones.map(async (zoneId) => {
        const volume = this.resolveAlertVolume(zoneId, 'uploaded');
        await this.zones.startAlert(zoneId, 'uploaded', media, volume, startDelays.get(zoneId) ?? 0);
      }),
    );

    return { success: true, type: 'uploaded', action: 'on' };
  }

  public async handlePlayEventFile(
    relativePath: string,
    targets: Array<{ zoneId: number; volume?: number }>,
  ): Promise<AlertActionResult> {
    const normalizedTargets = targets.filter((entry) => Number.isFinite(entry.zoneId) && entry.zoneId > 0);
    if (!relativePath || !normalizedTargets.length) {
      return { success: false, type: 'playeventfile', action: 'on', reason: 'invalid-input' };
    }

    this.log.info('ON playeventfile alert', {
      relativePath,
      targets: normalizedTargets,
    });
    const media = await this.resolvePlayEventMedia(relativePath);
    if (!media) {
      return { success: false, type: 'playeventfile', action: 'on', reason: 'media-unavailable' };
    }
    const startDelays = this.zones.prepareAlertStart(
      normalizedTargets.map((entry) => entry.zoneId),
    );
    await Promise.all(
      normalizedTargets.map(async ({ zoneId, volume }) => {
        const resolvedVolume = this.resolveAlertVolume(zoneId, 'playeventfile', volume);
        await this.zones.startAlert(
          zoneId,
          'playeventfile',
          media,
          resolvedVolume,
          startDelays.get(zoneId) ?? 0,
        );
      }),
    );

    return { success: true, type: 'playeventfile', action: 'on' };
  }

  private async resolvePlayEventMedia(input: string): Promise<AlertMediaResource | undefined> {
    const customUrl = parseCustomEventUrl(input);
    if (customUrl) {
      return {
        title: inferCustomUrlTitle(customUrl),
        relativePath: `${CUSTOM_URL_PREFIX}${customUrl}`,
        url: customUrl,
      };
    }
    const filename = path.basename(input) || input;
    return this.fileProvider.resolveRelative(input, filename);
  }

  private async resolveMedia(
    type: string,
    ttsText?: string,
    ttsLang?: string,
  ): Promise<AlertMediaResource | undefined> {
    if (type === 'tts') {
      if (!ttsText) {
        return undefined;
      }
      return this.resolveTtsMedia(ttsText, ttsLang ?? 'en');
    }
    return this.fileProvider.resolve(type);
  }

  private async resolveTtsMedia(text: string, language: string): Promise<AlertMediaResource | undefined> {
    const ttsConfig = this.configPort?.getConfig().content?.tts;
    const providerConfig = ttsConfig?.provider;
    const fallbackToInternal = ttsConfig?.fallbackToInternal !== false;
    const external = this.getExternalProvider(providerConfig);
    if (external) {
      const media = await external.generate(text, language);
      if (media || !fallbackToInternal) {
        return media;
      }
      this.log.warn('falling back to internal TTS provider', { provider: providerConfig?.type });
    } else if (isExternalTtsProvider(providerConfig) && !fallbackToInternal) {
      // An external provider is configured but switched off, and the operator
      // asked for no fallback — staying silent is the configured answer.
      return undefined;
    }
    return this.internalTtsProvider.generate(text, language);
  }

  private getExternalProvider(providerConfig: TtsProviderConfig | undefined): TtsProvider | null {
    if (!isExternalTtsProvider(providerConfig)) {
      return null;
    }
    const cacheKey = JSON.stringify(providerConfig);
    const existing = this.externalProviders.get(cacheKey);
    if (existing) {
      return existing;
    }
    const provider = createTtsProvider(providerConfig);
    if (provider) {
      this.externalProviders.set(cacheKey, provider);
    }
    return provider;
  }

  private resolveAlertVolume(zoneId: number, type: string, override?: number): number {
    const volumes = this.zones.getZoneVolumes(zoneId);
    const maxVolume =
      typeof volumes?.maxVolume === 'number' && volumes.maxVolume > 0 ? volumes.maxVolume : MAX_VOLUME;
    if (typeof override === 'number' && Number.isFinite(override)) {
      return Math.min(Math.max(Math.round(override), MIN_VOLUME), maxVolume);
    }
    if (!volumes) {
      return DEFAULT_ALERT_VOLUME;
    }
    const key = mapAlertTypeToVolumeKey(type);
    const requested = (volumes as unknown as Record<string, number | undefined>)[key] ?? volumes.default ?? DEFAULT_ALERT_VOLUME;
    const clamped = Math.min(
      Math.max(Number(requested) || DEFAULT_ALERT_VOLUME, MIN_VOLUME),
      maxVolume,
    );
    return clamped;
  }

}

function mapAlertTypeToVolumeKey(type: string): keyof ZoneVolumesConfig | 'default' {
  switch (type) {
    case 'alarm':
      return 'alarm';
    case 'fire':
    case 'firealarm':
      return 'fire';
    case 'bell':
      return 'bell';
    case 'buzzer':
    case 'wecker':
    case 'clock':
    case 'alarmclock':
    case 'alarm-clock':
      return 'buzzer';
    case 'tts':
      return 'tts';
    default:
      return 'default';
  }
}

function parseCustomEventUrl(input: string): string | null {
  const raw = String(input ?? '').trim();
  if (!raw.toLowerCase().startsWith(CUSTOM_URL_PREFIX)) {
    return null;
  }
  const candidate = raw.slice(CUSTOM_URL_PREFIX.length).trim();
  if (!candidate) {
    return null;
  }
  const decoded = safeDecodeURIComponent(candidate);
  const url = tryParseHttpUrl(decoded) ?? tryParseHttpUrl(candidate);
  return url?.toString() ?? null;
}

function tryParseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
  } catch {
    // ignore invalid urls
  }
  return null;
}

function inferCustomUrlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = path.posix.basename(parsed.pathname || '').trim();
    if (segment) {
      return safeDecodeURIComponent(segment);
    }
    return parsed.host || 'custom_url';
  } catch {
    return 'custom_url';
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export const alertsManager = new AlertsManager();
