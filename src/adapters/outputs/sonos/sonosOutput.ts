import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@/shared/logging/logger';
import { safeReadText } from '@/shared/bestEffort';
import type { PlaybackSession } from '@/ports/types/playback';
import type {
  HttpPreferences,
  NativeAlertRequest,
  PreferredOutput,
  OutputConfigDefinition,
  ZoneOutput,
} from '@/ports/OutputsTypes';
import {
  SonosClient,
  type Container as SonosContainer,
  type SonosGroup,
  type SonosPlayer,
} from '@sonn-audio/node-sonos';
import { resolveDlnaEndpoints, type DlnaEndpointInfo } from '@/adapters/outputs/dlna/dlnaDiscovery';
import { resolveSessionCover, isHttpUrl } from '@/shared/coverArt';
import {
  chooseStreamProfile,
  parseStreamFormatPreference,
  streamProfileNeedsChunked,
  type StreamFormatPreference,
  type StreamProfileChoice,
} from '@/domain/outputs/streamProfilePolicy';
import { buildBaseUrl, normalizeStreamUrl, resolveAbsoluteUrl, upsertQueryParam } from '@/shared/streamUrl';
import { decodeAudiopath } from '@/domain/zones/audiopath';
import {
  discoverSonosDevice,
  resolveSonosCoordinatorHost,
  resolveSonosEndpointsByHost,
} from '@/adapters/outputs/sonos/sonosDiscovery';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';

export interface SonosOutputConfig {
  host?: string;
  /** `lossless` sends FLAC, `mp3`/`auto` (default) sends MP3 — see SonosOutput.streamProfile. */
  streamFormat?: string;
  controlUrl?: string;
  autoDiscover?: boolean | string;
  networkScan?: boolean | string;
  householdId?: string;
  deviceName?: string;
}

/**
 * What a Sonos zone actually needs answered.
 *
 * How good it should sound. Which speaker is answered by picking one from the
 * list, so the address behind it is an escape hatch rather than a setting, and
 * it folds away with the rest of the plumbing. That is where Music Assistant
 * keeps it too: their entire Sonos configuration is one advanced field for a
 * manual address, because discovery answers the question everywhere else.
 *
 * Two fields that used to live here are gone. `controlUrl` was the escape hatch
 * for a speaker whose endpoints we could not resolve, which is no longer a state
 * a reachable speaker can be in (#374); a value already in config.json is still
 * honoured, it is simply not offered any more. `autoDiscover` only ever applied
 * when no address was given — and having chosen a Sonos output and named no
 * speaker, searching for one is the only thing left to do.
 */
export const SONOS_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'sonos',
  label: 'Sonos',
  description: 'Streams audio to a Sonos renderer via UPnP AVTransport.',
  fields: [
    {
      id: 'streamFormat',
      label: 'Sound quality',
      type: 'text',
      placeholder: 'auto',
      description:
        "Sonos players can play FLAC. Set this to 'lossless' to send the music unchanged instead of converting it to MP3; leave it on 'auto' if radio streams or this speaker misbehave.",
    },
    {
      id: 'host',
      label: 'Sonos IP or hostname',
      type: 'text',
      placeholder: '192.168.1.60',
      advanced: true,
      description:
        'Names the speaker by address instead of picking it from the list. Needed where the search cannot reach the speaker — a bridged container, a VLAN — and the list stays empty.',
    },
    {
      id: 'deviceName',
      label: 'Preferred device name',
      type: 'text',
      placeholder: 'Living Room',
      advanced: true,
      description:
        'Matches a speaker by its Sonos room name when no address is set. Without it, the zone name is used.',
    },
    {
      id: 'householdId',
      label: 'Household ID',
      type: 'text',
      placeholder: 'Sonos household id',
      advanced: true,
      description:
        'Only needed with more than one Sonos household on the network: restricts the search to this one.',
    },
    {
      id: 'networkScan',
      label: 'Network scan fallback',
      type: 'boolean',
      advanced: true,
      description:
        'If no speaker answers the search, look for Sonos players by trying every address on the local network. Slower, and only useful where the search is blocked.',
    },
  ],
};

/**
 * S2 errors that mean the websocket itself is gone rather than the command being refused.
 * Matched by error name because node-sonos derives `name` from the error class, which survives
 * a duplicated module instance in a way `instanceof` does not.
 *
 * `InvalidState` is in here for the 'Already connected' a wedged reconnect loop reports
 * (node-sonos ≤ 0.2.3): the socket is just as dead, and the client must be replaced.
 */
const S2_CONNECTION_LOST_ERRORS = new Set([
  'NotConnected',
  'ConnectionClosed',
  'ConnectionFailed',
  'CannotConnect',
  'InvalidState',
]);

function isS2ConnectionLost(err: unknown): boolean {
  return err instanceof Error && S2_CONNECTION_LOST_ERRORS.has(err.name);
}

/** Identity we stamp on the containers we hand to Sonos; see buildS2Container. */
const SONOS_CONTAINER_SERVICE_ID = 'sonn';
const SONOS_CONTAINER_SERVICE_NAME = 'Sonn';

export class SonosOutput implements ZoneOutput {
  public readonly type = 'sonos';

  /** Grouped zones stay in step here: members join the leader's Sonos group on the device itself. */
  public supportsNativeGrouping(): boolean {
    return true;
  }

  private readonly log = createLogger('Output', 'Sonos');
  private readonly streamFormat: StreamFormatPreference;
  private readonly controllers = new Set<AbortController>();
  private readonly commandTimeoutMs = 2500;
  private readonly slowCommandMs = 1200;
  private readonly host: string;
  private readonly autoDiscover: boolean;
  private readonly networkScan: boolean;
  private readonly householdId: string | null;
  private readonly preferredName: string | null;
  private discoveredHost: string | null = null;
  private effectiveHost: string | null = null;
  private controlUrl?: string;
  private renderingControlUrl?: string;
  private discoveryPromise?: Promise<boolean>;
  private deviceUdn: string | null = null;
  private deviceInfoPromise?: Promise<string | null>;
  private s2Client: SonosClient | null = null;
  private s2ClientPromise?: Promise<SonosClient | null>;
  private s2RetryAfter = 0;
  private pendingVolume: number | null = null;
  private volumeRetryTimer: NodeJS.Timeout | null = null;
  private volumeRetryCount = 0;
  private volumeApplyInFlight = false;
  // True while play() is mid-SOAP (SetAVTransportURI → Play). During this window we stash
  // any setVolume() call instead of sending a separate RenderingControl request, because
  // the volume SOAP races ahead of the transport swap and lands on the *previous* stream's
  // URI — briefly blasting the old source at the new volume (issue #279). play() calls
  // applyPendingVolume() after Play succeeds, so the stashed value lands on the new source.
  private playInProgress = false;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SonosOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.host = typeof config.host === 'string' ? config.host.trim() : '';
    this.streamFormat = parseStreamFormatPreference(config.streamFormat);
    this.autoDiscover = parseBoolDefaultTrue(config.autoDiscover);
    this.networkScan = parseBoolDefaultFalse(config.networkScan);
    this.householdId =
      typeof config.householdId === 'string' && config.householdId.trim()
        ? config.householdId.trim()
        : null;
    this.preferredName =
      typeof config.deviceName === 'string' && config.deviceName.trim()
        ? config.deviceName.trim()
        : null;
    if (typeof config.controlUrl === 'string' && config.controlUrl.trim().length > 0) {
      this.controlUrl = config.controlUrl.trim();
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
      this.log.info('Sonos output configured with manual control URL', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        controlUrl: this.controlUrl,
      });
    } else if (this.host) {
      this.log.info('Sonos output awaiting discovery', { zoneId: this.zoneId, host: this.host });
    } else if (this.autoDiscover) {
      this.log.info('Sonos output will auto-discover device', { zoneId: this.zoneId });
    } else {
      this.log.warn('Sonos output has no host or control URL configured', { zoneId: this.zoneId });
    }
    this.ports.sonosGroup.register(this.zoneId, this);
  }

  public getZoneId(): number {
    return this.zoneId;
  }

  public getDeviceUdn(): string | null {
    return this.deviceUdn;
  }

  public getS2GroupId(): string | null {
    return this.s2Client?.player?.group?.id ?? null;
  }

  public async ensureDeviceInfo(): Promise<string | null> {
    if (this.deviceUdn) {
      return this.deviceUdn;
    }
    if (this.deviceInfoPromise) {
      return this.deviceInfoPromise;
    }
    this.deviceInfoPromise = this.fetchDeviceInfo()
      .catch((err) => {
        this.log.debug('sonos device info fetch failed', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .finally(() => {
        this.deviceInfoPromise = undefined;
      });
    this.deviceUdn = await this.deviceInfoPromise;
    return this.deviceUdn;
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Sonos output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'sonos no source');
      return;
    }
    this.playInProgress = true;
    try {
      if (await this.ports.sonosGroup.tryJoinLeader(this)) {
        return;
      }
      const uri = this.resolveStreamUri(session);
      if (!uri) {
        this.log.warn('no playable URI for session', { zoneId: this.zoneId });
        this.ports.outputHandlers.onOutputError(this.zoneId, 'sonos no stream uri');
        return;
      }
      const httpStreamUri = this.withPrimeToken(this.normalizeStreamUri(uri), session);
      const s2Played = await this.playViaS2(httpStreamUri, session);
      if (s2Played) {
        this.playInProgress = false;
        void this.applyPendingVolume('play-s2');
        return;
      }
      if (!(await this.ensureEndpoints())) {
        return;
      }
      await this.ports.sonosGroup.syncGroupMembers(this);
      await this.sendPlaybackWithSoap(httpStreamUri, session);
    } finally {
      this.playInProgress = false;
    }
    void this.applyPendingVolume('play-soap');
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    // Sonos cannot pause a source it did not queue itself. Our stream is a length-less HTTP
    // resource with no range support, and pausing one makes the speaker abort the track rather
    // than hold it: it reports STOPPED, drops the connection, and afterwards refuses to resume.
    // Music Assistant hit the same wall and settled on the same answer — stop the speaker and
    // let the server side own the pause (music-assistant/support#3758, our issue #345). The
    // resume path re-issues playStreamUrl with the position we kept, which does work.
    await this.stop(session);
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
      return;
    }
    if (await this.tryS2Group('resume', (group) => group.play(), this.commandTimeoutMs)) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.runCommand('Play', this.buildPlayBody());
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    if (await this.tryS2Group('stop', (group) => group.stop(), this.commandTimeoutMs)) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.runCommand('Stop', this.buildStopBody());
  }

  public async setVolume(level: number): Promise<void> {
    this.pendingVolume = clampSonosVolume(level);
    if (this.playInProgress) {
      // play() will apply pendingVolume after its SOAP Play succeeds; sending SetVolume now
      // would land on the previous transport URI before the swap completes (issue #279).
      return;
    }
    await this.applyPendingVolume('setVolume');
  }

  private async applyPendingVolume(reason: string): Promise<void> {
    if (this.volumeApplyInFlight || this.pendingVolume === null) {
      return;
    }
    this.volumeApplyInFlight = true;
    try {
      while (this.pendingVolume !== null) {
        const level: number = this.pendingVolume;
        const applied = await this.tryApplyVolume(level);
        if (!applied) {
          this.scheduleVolumeRetry(reason);
          return;
        }
        if (this.pendingVolume === level) {
          this.pendingVolume = null;
        }
        this.clearVolumeRetry();
        this.volumeRetryCount = 0;
      }
    } finally {
      this.volumeApplyInFlight = false;
    }
  }

  private async tryApplyVolume(level: number): Promise<boolean> {
    if (await this.tryS2Player('volume', (player) => player.setVolume(level))) {
      this.log.info('Sonos volume set', { zoneId: this.zoneId, volume: level, path: 's2' });
      return true;
    }
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    const url = this.renderingControlUrl;
    if (!url) {
      this.log.debug('rendering control URL missing; skipping volume update', { zoneId: this.zoneId });
      return false;
    }
    if (
      await this.invokeRenderingAction('SetVolume', this.buildSetVolumeBody(level), {
        optional: true,
      })
    ) {
      this.log.info('Sonos volume set', { zoneId: this.zoneId, volume: level, path: 'soap' });
      return true;
    }
    return false;
  }

  private scheduleVolumeRetry(reason: string): void {
    if (this.pendingVolume === null || this.volumeRetryTimer) {
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(this.volumeRetryCount, 5));
    this.volumeRetryCount += 1;
    this.log.debug('Sonos volume retry scheduled', {
      zoneId: this.zoneId,
      volume: this.pendingVolume,
      delayMs,
      reason,
    });
    this.volumeRetryTimer = setTimeout(() => {
      this.volumeRetryTimer = null;
      void this.applyPendingVolume('retry');
    }, delayMs);
    this.volumeRetryTimer.unref?.();
  }

  private clearVolumeRetry(): void {
    if (!this.volumeRetryTimer) {
      return;
    }
    clearTimeout(this.volumeRetryTimer);
    this.volumeRetryTimer = null;
  }

  public async joinToLeader(leaderUdn: string): Promise<boolean> {
    if (!(await this.ensureEndpoints())) {
      return false;
    }
    const normalized = normalizeUdn(leaderUdn);
    if (!normalized) {
      return false;
    }
    const uri = `x-rincon:${normalized}`;
    const body = this.buildSetUriBody(uri, '');
    return this.invokeAction('SetAVTransportURI', body, { optional: true });
  }

  public async joinToLeaderS2(groupId: string): Promise<boolean> {
    // Bail out before the retry loop when there is no websocket API at all (S1, or a device
    // that never connected): the caller falls back to SOAP grouping and should not wait.
    if (!(await this.ensureS2Client())?.player) {
      return false;
    }
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (await this.tryS2Player('join', (player) => player.joinGroup(groupId))) {
        return true;
      }
      if (attempt < 2) {
        await delay(300);
      }
    }
    return false;
  }

  public async leaveGroup(): Promise<void> {
    if (await this.tryS2Player('leave group', (player) => player.leaveGroup())) {
      return;
    }
    if (!(await this.ensureEndpoints())) {
      return;
    }
    await this.invokeAction('BecomeCoordinatorOfStandaloneGroup', this.buildStandaloneBody(), {
      optional: true,
    });
  }

  /**
   * Play an alert as a native overlay via the S2 AudioClip API. Sonos ducks whatever the
   * player is currently rendering, plays the clip on top, and restores playback itself — so
   * the engine stream is never swapped and the alert coordinator skips its snapshot/drain/
   * resume dance (which otherwise clips short alert tails, issues #262/#276/#279).
   *
   * Requires the modern S2 (websocket) API; returns false on S1 or when the clip cannot be
   * loaded so the coordinator falls back to the engine-stream path.
   */
  public async playNativeAlert(request: NativeAlertRequest): Promise<boolean> {
    const client = await this.ensureS2Client();
    if (!client?.player) {
      this.log.debug('no S2 client for the native alert; falling back to the stream path', {
        zoneId: this.zoneId,
      });
      return false;
    }
    const playerId = client.playerId || client.player.id;
    if (!playerId) {
      this.log.debug('S2 client has no player id for the native alert', { zoneId: this.zoneId });
      return false;
    }
    try {
      // A custom stream URL requires clipType CUSTOM (CHIME plays a built-in sound and
      // ignores streamUrl); HIGH priority makes Sonos duck current playback immediately.
      await client.api.audioClip.loadAudioClip(playerId, {
        name: request.title || 'Alert',
        appId: 'lox-sonos',
        streamUrl: request.url,
        clipType: 'CUSTOM',
        priority: 'HIGH',
        volume: request.volume,
      });
      this.log.info('Sonos native alert played', {
        zoneId: this.zoneId,
        type: request.type,
        url: request.url,
      });
      return true;
    } catch (err) {
      this.log.debug('sonos native alert failed; falling back to stream path', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      this.invalidateS2ClientIfLost(err, client);
      return false;
    }
  }

  public dispose(): void {
    this.ports.sonosGroup.unregister(this.zoneId);
    this.clearVolumeRetry();
    if (this.s2Client) {
      void this.s2Client.disconnect();
      this.s2Client = null;
    }
    for (const controller of this.controllers) {
      controller.abort();
    }
    this.controllers.clear();
    this.log.debug('disposed', { zoneId: this.zoneId });
  }

  public getPreferredOutput(): PreferredOutput {
    return { profile: this.streamProfile(), sampleRate: 44100, channels: 2 };
  }

  public getHttpPreferences(): HttpPreferences {
    // FLAC is variable-bitrate, so no honest Content-Length can be derived from a duration.
    return {
      httpProfile: streamProfileNeedsChunked(this.streamProfile())
        ? 'chunked'
        : 'forced_content_length',
      icyEnabled: false,
    };
  }

  /**
   * Sonos players do decode FLAC, but `auto` still means MP3 here for two reasons that have nothing to
   * do with the codec: MP3 is what enables radio-mode ingest (`x-rincon-mp3radio://`, which
   * `buildTransportUri` selects on the extension and skips for anything else), and a live length-less
   * FLAC stream over that path has not been tried on Sonos hardware. Set `streamFormat: "lossless"` to
   * take it — everything downstream, including the DIDL MIME type, already follows the extension.
   */
  private streamProfile(): StreamProfileChoice {
    return chooseStreamProfile({ preference: this.streamFormat, losslessSupported: null });
  }

  public getAlertHandoffDrainMs(): number {
    // Sonos buffers ~1.5–2s ahead of the playback head. Swapping AVTransportURI
    // before that buffer drains clips the tail of short alerts (issue #262).
    return 2000;
  }

  private async fetchDeviceInfo(): Promise<string | null> {
    const host = this.effectiveHost || this.host || this.discoveredHost || this.hostFromControlUrl();
    if (!host) {
      return null;
    }
    const url = `http://${host}:1400/xml/device_description.xml`;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 2000);
    timeout.unref();
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return await this.fetchDeviceInfoFromStatus(host);
      }
      const xml = await response.text();
      const match = xml.match(/<UDN>\s*uuid:([^<]+)\s*<\/UDN>/i);
      const udn = match?.[1]?.trim() ?? null;
      const normalized = normalizeUdn(udn);
      if (normalized) {
        this.log.info('Sonos device info resolved', { zoneId: this.zoneId, udn: normalized });
      }
      return normalized;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return await this.fetchDeviceInfoFromStatus(host);
      }
      return null;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private async fetchDeviceInfoFromStatus(host: string): Promise<string | null> {
    const url = `http://${host}:1400/status/zp`;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 2000);
    timeout.unref();
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      const xml = await response.text();
      const udnMatch = xml.match(/<UDN>\s*uuid:([^<]+)\s*<\/UDN>/i);
      const uidMatch = xml.match(/<LocalUID>\s*([^<]+)\s*<\/LocalUID>/i);
      const udn = (udnMatch?.[1] ?? uidMatch?.[1] ?? '').trim();
      const normalized = normalizeUdn(udn);
      if (normalized) {
        this.log.info('Sonos device info resolved (status)', {
          zoneId: this.zoneId,
          udn: normalized,
        });
      }
      return normalized;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private hostFromControlUrl(): string {
    if (!this.controlUrl) {
      return '';
    }
    try {
      const parsed = new URL(this.controlUrl);
      return parsed.hostname;
    } catch {
      return '';
    }
  }

  private async ensureEndpoints(): Promise<boolean> {
    if (this.controlUrl) {
      return true;
    }
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }
    const host = await this.ensureHost();
    if (!host) {
      this.log.warn('Sonos command skipped; no host or control URL configured', { zoneId: this.zoneId });
      return false;
    }
    this.discoveryPromise = this.resolveEndpoints(host)
      .then((info) => {
        if (info) {
          this.applyDiscoveredEndpoints(info);
          return true;
        }
        this.log.warn('no Sonos endpoints discovered', { zoneId: this.zoneId, host });
        return false;
      })
      .finally(() => {
        this.discoveryPromise = undefined;
      });
    return this.discoveryPromise;
  }

  /**
   * Endpoints for a host we already know, preferring a direct read over a search.
   *
   * The description fetch is one HTTP GET to an address the config already names.
   * The SSDP fallback behind it is a multicast window measured in seconds that a
   * bridged container never hears an answer in, which is how a reachable speaker
   * ended up reported as undiscoverable (#374). Keeping the search as a fallback
   * costs nothing and still covers a player that serves its description somewhere
   * other than the usual place.
   */
  private async resolveEndpoints(host: string): Promise<DlnaEndpointInfo | null> {
    const direct = await resolveSonosEndpointsByHost(host);
    if (direct) {
      return direct;
    }
    this.log.debug('Sonos description not readable; falling back to SSDP', {
      zoneId: this.zoneId,
      host,
    });
    return resolveDlnaEndpoints({ host });
  }

  private async ensureHost(): Promise<string | null> {
    if (this.effectiveHost) {
      return this.effectiveHost;
    }
    if (this.host) {
      this.effectiveHost = await this.resolveCoordinatorHost(this.host);
      return this.effectiveHost;
    }
    if (this.discoveredHost) {
      this.effectiveHost = await this.resolveCoordinatorHost(this.discoveredHost);
      return this.effectiveHost;
    }
    if (!this.autoDiscover) {
      return null;
    }
    const preferredName = this.preferredName || this.zoneName;
    const device = await discoverSonosDevice({
      preferredName,
      householdId: this.householdId ?? undefined,
      allowNetworkScan: this.networkScan,
      timeoutMs: 1800,
    });
    if (!device?.host) {
      return null;
    }
    this.discoveredHost = device.host;
    this.effectiveHost = await this.resolveCoordinatorHost(this.discoveredHost);
    this.log.info('Sonos device discovered', {
      zoneId: this.zoneId,
      host: this.effectiveHost,
      name: device.name ?? device.roomName,
      householdId: device.householdId,
    });
    return this.effectiveHost;
  }

  private async resolveCoordinatorHost(host: string): Promise<string> {
    const trimmed = host.trim();
    if (!trimmed) return '';
    try {
      const mapped = await resolveSonosCoordinatorHost({ host: trimmed, timeoutMs: 1200 });
      if (mapped && mapped !== trimmed) {
        this.log.info('Sonos host mapped to coordinator', {
          zoneId: this.zoneId,
          host: trimmed,
          coordinator: mapped,
        });
      }
      return mapped || trimmed;
    } catch {
      return trimmed;
    }
  }

  private async ensureS2Client(): Promise<SonosClient | null> {
    if (this.s2Client) {
      return this.s2Client;
    }
    const now = Date.now();
    if (now < this.s2RetryAfter) {
      return null;
    }
    if (this.s2ClientPromise) {
      return this.s2ClientPromise;
    }
    const host = await this.ensureHost();
    if (!host) {
      return null;
    }

    const pending = (async (): Promise<SonosClient | null> => {
      const client = new SonosClient(host, { logger: console });
      try {
        await withTimeout(client.connect(), 4000);
        this.s2Client = client;
        void client.start().catch((err) => {
          this.log.debug('sonos s2 client stopped', {
            zoneId: this.zoneId,
            message: err instanceof Error ? err.message : String(err),
          });
          if (this.s2Client === client) {
            this.s2Client = null;
          }
        });
        return client;
      } catch (err) {
        this.log.debug('sonos s2 connect failed', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
        this.s2RetryAfter = Date.now() + 30000;
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
        return null;
      }
    })();

    this.s2ClientPromise = pending.finally(() => {
      if (this.s2ClientPromise === pending) {
        this.s2ClientPromise = undefined;
      }
    });

    return this.s2ClientPromise;
  }

  private async playViaS2(uri: string, session: PlaybackSession): Promise<boolean> {
    const container = this.buildS2Container(session);
    return this.tryS2Group('play', (group) => group.playStreamUrl(uri, container));
  }

  /**
   * Runs a transport command on the S2 group, returning false when the websocket API is
   * unavailable or the command failed so the caller can fall back to SOAP.
   *
   * Every S2 path must have this shape. play() and volume always did; pause/resume/stop let the
   * error through, so a stale websocket turned an ordinary pause into a fatal playback error
   * that tore down a healthy stream and left the zone unable to resume (issue #327). Speaking
   * SOAP to the same speaker keeps working in exactly that situation.
   *
   * `timeoutMs` is optional because a half-open socket accepts the frame but never answers;
   * transport commands cap their wait and fall through to SOAP, while play/join/alert keep
   * waiting rather than risk issuing the same command twice over both transports.
   */
  private tryS2Group(
    label: string,
    run: (group: SonosGroup) => Promise<unknown>,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.tryS2(label, (client) => client.player?.group ?? null, run, timeoutMs);
  }

  /** Player-scoped counterpart of tryS2Group (volume, grouping); same fall-back contract. */
  private tryS2Player(
    label: string,
    run: (player: SonosPlayer) => Promise<unknown>,
    timeoutMs?: number,
  ): Promise<boolean> {
    return this.tryS2(label, (client) => client.player, run, timeoutMs);
  }

  private async tryS2<T>(
    label: string,
    select: (client: SonosClient) => T | null | undefined,
    run: (target: T) => Promise<unknown>,
    timeoutMs?: number,
  ): Promise<boolean> {
    const client = await this.ensureS2Client();
    const target = client ? select(client) : null;
    if (!client || !target) {
      return false;
    }
    try {
      const call = run(target);
      await (timeoutMs ? withTimeout(call, timeoutMs) : call);
      return true;
    } catch (err) {
      this.log.debug(`sonos s2 ${label} failed`, {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
      this.invalidateS2ClientIfLost(err, client);
      return false;
    }
  }

  /**
   * Drops the cached S2 client when its websocket is gone, so the next command reconnects
   * instead of hitting the same dead socket forever. Anything else (a refused command, a
   * timeout) leaves the client in place — it is still the fastest path once it recovers.
   */
  private invalidateS2ClientIfLost(err: unknown, client: SonosClient): void {
    if (!isS2ConnectionLost(err) || this.s2Client !== client) {
      return;
    }
    this.s2Client = null;
    this.log.info('Sonos S2 client dropped after connection loss; reconnecting on next command', {
      zoneId: this.zoneId,
    });
    void client.disconnect().catch(() => undefined);
  }

  /**
   * Metadata that travels with the stream URL. The `id`/`service` block is what makes the
   * speaker hand our own identity back in its playback metadata: without it the container comes
   * back as `objectId=-1, serviceId=null` and nothing downstream can tell our stream apart from
   * something a user started in the Sonos app. Music Assistant tags its containers the same way
   * and keys its whole "is this mine?" decision off it (providers/sonos/player.py).
   */
  private buildS2Container(session: PlaybackSession): SonosContainer {
    const title = session.metadata?.title || this.zoneName;
    return {
      _objectType: 'container',
      name: title,
      type: 'trackList',
      id: {
        _objectType: 'id',
        serviceId: SONOS_CONTAINER_SERVICE_ID,
        objectId: `${SONOS_CONTAINER_SERVICE_ID}:${this.zoneId}:${session.stream.id}`,
      },
      service: {
        _objectType: 'service',
        name: SONOS_CONTAINER_SERVICE_NAME,
      },
    };
  }

  private async sendPlaybackWithSoap(httpUri: string, session: PlaybackSession): Promise<void> {
    const transportUri = this.buildTransportUri(httpUri, session);
    this.log.info('sending playback command', { zoneId: this.zoneId, uri: transportUri });
    // Do not block on Stop; it can take multiple seconds when switching sources.
    // SetAVTransportURI should be enough for most transitions.
    const didl = this.buildDidlMetadata(httpUri, session, {
      minimal: this.isRadioSession(session),
    });
    let timedOut = false;
    const setResult = await this.invokeActionWithRetry(
      'SetAVTransportURI',
      this.buildSetUriBody(transportUri, didl),
      1,
      {
        retryDelayMs: 1000,
        timeoutMs: 30000,
        timeoutOk: true,
        softFaultOk: true,
        onTimeout: () => {
          timedOut = true;
        },
      },
    );
    if (!setResult && timedOut) {
      this.log.warn('Sonos SetAVTransportURI timed out; skipping Play', { zoneId: this.zoneId });
      return;
    }
    await delay(250);
    if (
      !(await this.invokeActionWithRetry('Play', this.buildPlayBody(), 3, {
        retryDelayMs: 300,
        softFaultOk: true,
      }))
    ) {
      return;
    }
    this.log.info('Sonos playback started', { zoneId: this.zoneId, uri: transportUri });
  }

  private async runCommand(action: string, body: string, options: InvokeOptions = {}): Promise<void> {
    await this.invokeAction(action, body, options);
  }

  private async invokeActionWithRetry(
    action: string,
    body: string,
    attempts: number,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const success = await this.invokeAction(action, body, options);
      if (success) {
        return true;
      }
      if (attempt < attempts) {
        await delay(options.retryDelayMs ?? 150);
      }
    }
    return false;
  }

  private async invokeAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.controlUrl) {
      this.log.warn('AVTransport command skipped; endpoint unknown', {
        action,
        zoneId: this.zoneId,
      });
      return false;
    }
    return this.invokeServiceAction(this.controlUrl, 'AVTransport', action, body, options);
  }

  private async invokeRenderingAction(
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    if (!this.renderingControlUrl) {
      this.log.debug('RenderingControl command skipped; endpoint unknown', {
        action,
        zoneId: this.zoneId,
      });
      return false;
    }
    return this.invokeServiceAction(
      this.renderingControlUrl,
      'RenderingControl',
      action,
      body,
      options,
    );
  }

  private async invokeServiceAction(
    url: string,
    service: 'AVTransport' | 'RenderingControl',
    action: string,
    body: string,
    options: InvokeOptions = {},
  ): Promise<boolean> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeoutMs = options.timeoutMs ?? this.commandTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    const startedAt = Date.now();
    const urlHost = (() => {
      try {
        return new URL(url).host;
      } catch {
        return '';
      }
    })();
    try {
      this.log.debug('Sonos soap request', { action, service, zoneId: this.zoneId });
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"urn:schemas-upnp-org:service:${service}:1#${action}"`,
        },
        body,
        signal: controller.signal,
      });

      const text = await safeReadText(response, '', {
        onError: 'debug',
        log: this.log,
        label: 'sonos output response read failed',
        context: { status: response.status },
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (!response.ok && response.status !== 500) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      if (response.ok) {
        if (durationMs >= this.slowCommandMs) {
          this.log.warn('Sonos action slow', {
            action,
            service,
            zoneId: this.zoneId,
            host: urlHost || undefined,
            durationMs,
            timeoutMs,
          });
        }
        this.log.info('Sonos action succeeded', {
          action,
          service,
          zoneId: this.zoneId,
          host: urlHost || undefined,
          status: response.status,
          durationMs,
        });
        return true;
      }
      const fault = text.slice(0, 2000);
      this.log.warn('Sonos action returned SOAP fault', {
        action,
        status: response.status,
        service,
        zoneId: this.zoneId,
        host: urlHost || undefined,
        durationMs,
        body: fault,
      });
      if (options.softFaultOk) {
        return true;
      }
      return options.optional ?? false;
    } catch (error) {
      const durationMs = Math.max(0, Date.now() - startedAt);
      const message = error instanceof Error ? error.message : String(error);
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort && options.timeoutOk) {
        this.log.debug('Sonos request timed out; continuing', {
          action,
          service,
          zoneId: this.zoneId,
          host: urlHost || undefined,
          durationMs,
          timeoutMs,
        });
        options.onTimeout?.();
        return false;
      }
      if (options.optional) {
        this.log.debug('optional command failed', {
          action,
          service,
          message,
          zoneId: this.zoneId,
          host: urlHost || undefined,
          durationMs,
          timeoutMs,
        });
      } else {
        this.log.warn('command failed', {
          action,
          service,
          message,
          zoneId: this.zoneId,
          host: urlHost || undefined,
          durationMs,
          timeoutMs,
        });
      }
      return options.optional ?? false;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private buildSetUriBody(uri: string, didl: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>${escapeXml(uri)}</CurrentURI>
      <CurrentURIMetaData>${escapeXml(didl)}</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>`;
  }

  private buildPlayBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>`;
  }

  private buildStopBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>`;
  }

  private buildStandaloneBody(): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:BecomeCoordinatorOfStandaloneGroup xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:BecomeCoordinatorOfStandaloneGroup>
  </s:Body>
</s:Envelope>`;
  }

  private buildSetVolumeBody(volume: number): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>${volume}</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>`;
  }

  private buildDidlMetadata(
    uri: string,
    session: PlaybackSession,
    options: { minimal?: boolean } = {},
  ): string {
    const cover = this.resolveCoverArt(session);
    const title = session.metadata?.title || this.zoneName;
    const album = session.metadata?.album || '';
    const artist = session.metadata?.artist || '';
    // Alerts must not advertise a duration: Sonos honors the DIDL res duration strictly and
    // stops at that mark, clipping the tail of short announcements (issues #262/#276/#279).
    // Treating the alert as an open-ended broadcast lets it play until we close the stream.
    const duration = session.metadata?.isAlert ? '' : this.formatDlnaDuration(session.duration);
    const isStream = !duration;
    const protocolInfo = this.buildProtocolInfo(uri, isStream);
    const mediaClass = isStream
      ? 'object.item.audioItem.audioBroadcast'
      : 'object.item.audioItem.musicTrack';
    const durationAttr = duration ? ` duration="${duration}"` : '';

    if (options.minimal) {
      const art = cover ? `<upnp:albumArtURI>${escapeXmlMetadata(cover)}</upnp:albumArtURI>` : '';
      return `<?xml version="1.0"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${escapeXmlMetadata(title)}</dc:title>
    ${art}
    <upnp:class>${mediaClass}</upnp:class>
    <res${durationAttr} protocolInfo="${protocolInfo}">${escapeXmlMetadata(uri)}</res>
  </item>
</DIDL-Lite>`;
    }

    return `<?xml version="1.0"?>
<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"
           xmlns:dc="http://purl.org/dc/elements/1.1/"
           xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
  <item id="0" parentID="0" restricted="1">
    <dc:title>${escapeXmlMetadata(title)}</dc:title>
    <dc:creator>${escapeXmlMetadata(artist)}</dc:creator>
    <upnp:artist>${escapeXmlMetadata(artist)}</upnp:artist>
    <upnp:album>${escapeXmlMetadata(album)}</upnp:album>
    <upnp:albumArtURI>${escapeXmlMetadata(cover)}</upnp:albumArtURI>
    <upnp:class>${mediaClass}</upnp:class>
    <res${durationAttr} protocolInfo="${protocolInfo}">${escapeXmlMetadata(uri)}</res>
  </item>
</DIDL-Lite>`;
  }

  private resolveCoverArt(session: PlaybackSession): string {
    const coverSource = resolveSessionCover(session);
    if (!coverSource) {
      return '';
    }
    // Embed the real, externally-fetchable cover when we have one. The Sonos
    // state controller reflects whatever albumArtURI we put here straight back
    // as the zone cover, so a real URL works both in the Sonos app and on the
    // round-trip. Forcing everything through our own /streams/<id>/cover proxy
    // made that reflection point back at us and self-fetch (#167). Only fall
    // back to the proxy for embedded-byte art with no public URL — there
    // resolveSessionCover returns the relative /cover path, which the proxy
    // serves directly from session.cover (no round-trip).
    if (isHttpUrl(coverSource)) {
      return coverSource;
    }
    return resolveAbsoluteUrl(this.buildBaseUrl(), session.stream.coverUrl) ?? coverSource;
  }

  private resolveStreamUri(session: PlaybackSession): string | null {
    const streamUrl = session.stream.url;
    if (streamUrl) {
      const absolute = resolveAbsoluteUrl(this.buildBaseUrl(), streamUrl);
      if (absolute) {
        return absolute;
      }
    }
    const decoded = decodeAudiopath(session.source);
    if (isHttpUrl(decoded)) {
      return decoded;
    }
    return null;
  }

  private normalizeStreamUri(uri: string): string {
    return normalizeStreamUrl(uri, this.buildBaseUrl(), ['mp3', 'aac']);
  }

  private isRadioSession(session: PlaybackSession): boolean {
    // Alerts are streamed open-ended (see buildDidlMetadata) so Sonos plays until we close the
    // connection rather than stopping at a declared duration (issues #262/#276/#279).
    if (session.metadata?.isAlert) {
      return true;
    }
    const duration = Number(session.duration ?? 0);
    const metaDuration = Number(session.metadata?.duration ?? 0);
    return !(duration > 0) && !(metaDuration > 0);
  }

  private buildTransportUri(httpUri: string, session: PlaybackSession): string {
    if (!this.isRadioSession(session)) {
      return httpUri;
    }
    const ext = httpUri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
    if (ext !== 'mp3' && ext !== 'mpeg') {
      return httpUri;
    }
    // Sonos radio mode expects x-rincon-mp3radio:// and treats the item as a broadcast stream.
    // Keep DIDL resource as the HTTP URL; only the transport URI is converted.
    return httpUri.replace(/^https?:\/\//i, 'x-rincon-mp3radio://');
  }

  private withPrimeToken(uri: string, session: PlaybackSession): string {
    // Sonos (especially when switching between sources/alerts) can ignore a "same URI" update.
    // Add a stable cache-busting query param to force a fresh fetch.
    try {
      const parsed = new URL(uri);
      if (!parsed.pathname.startsWith('/streams/')) {
        return uri;
      }
    } catch {
      return uri;
    }
    const token = session.playRequestAt ?? Date.now();
    return upsertQueryParam(uri, 'prime', String(token));
  }

  private buildBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  private buildProtocolInfo(uri: string, isStream: boolean): string {
    const mime = this.resolveMimeType(uri);
    const flags = isStream
      ? 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000'
      : 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01500000000000000000000000000000';
    return `http-get:*:${mime}:${flags}`;
  }

  private resolveMimeType(uri: string): string {
    const ext = uri.split('?')[0]?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'wav':
        return 'audio/wav';
      case 'flac':
        return 'audio/flac';
      case 'aac':
        return 'audio/aac';
      case 'm4a':
      case 'mp4':
        return 'audio/mp4';
      case 'mp3':
      case 'mpeg':
      default:
        return 'audio/mpeg';
    }
  }

  private formatDlnaDuration(durationSeconds: number): string {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return '';
    }
    const total = Math.floor(durationSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
      seconds,
    ).padStart(2, '0')}`;
  }

  private deriveRenderingUrl(avTransportUrl: string): string | undefined {
    try {
      const parsed = new URL(avTransportUrl);
      if (parsed.pathname.toLowerCase().includes('avtransport')) {
        parsed.pathname = parsed.pathname.replace(/AVTransport/gi, 'RenderingControl');
      } else {
        parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/RenderingControl/Control`;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private applyDiscoveredEndpoints(info: { controlUrl?: string; renderingControlUrl?: string }): void {
    if (info.controlUrl) {
      this.controlUrl = info.controlUrl;
    }
    if (info.renderingControlUrl) {
      this.renderingControlUrl = info.renderingControlUrl;
    } else if (this.controlUrl && !this.renderingControlUrl) {
      this.renderingControlUrl = this.deriveRenderingUrl(this.controlUrl);
    }
    this.log.info('Sonos discovery completed', {
      zoneId: this.zoneId,
      host: this.host,
      controlUrl: this.controlUrl,
    });
  }
}

interface InvokeOptions {
  optional?: boolean;
  retryDelayMs?: number;
  timeoutMs?: number;
  timeoutOk?: boolean;
  softFaultOk?: boolean;
  onTimeout?: () => void;
}

function normalizeUdn(udn: string | null | undefined): string | null {
  if (!udn) return null;
  return udn.replace(/^uuid:/i, '').trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeXmlInner(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlMetadata(value: string): string {
  const escaped = escapeXmlInner(value);
  let result = '';
  for (const char of escaped) {
    const code = char.codePointAt(0);
    if (code && code > 127) {
      result += `&#${code};`;
    } else {
      result += char;
    }
  }
  return result;
}

function parseBoolDefaultTrue(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return true;
}

function parseBoolDefaultFalse(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
  }
  return false;
}

function clampSonosVolume(level: number): number {
  const numeric = Number(level);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
