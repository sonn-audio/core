import {
  EventType,
  S1Client,
  SonosClient,
  detectGeneration,
  type S1SonosGroup,
  type SonosGroup,
} from '@sonn-audio/node-sonos';

// Either backend exposes the same `player.group.*` shape that the snapshot
// builder consumes; the union here keeps the dispatcher type-safe without
// templating the whole controller.
type AnySonosGroup = SonosGroup | S1SonosGroup;
type AnySonosClient = SonosClient | S1Client;
import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import { AudioType } from '@/domain/zones/enums';
import { SONOS_OWN_CONTAINER_SERVICE_ID, isOwnStreamUrl } from '@/domain/outputs/sonosIdentity';
import { buildBaseUrl } from '@/shared/streamUrl';
import type { ConfigPort } from '@/ports/ConfigPort';
import { createLogger } from '@/shared/logging/logger';
import type { ZoneStateController } from '@/application/zones/state/StateController';

type SonosControllerOptions = {
  zone: ZoneConfig;
  configPort: ConfigPort;
  onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
};

const TIME_TICK_MS = 1000;
const RECONNECT_INITIAL_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_BACKOFF_FACTOR = 2;
// Cap how long the initial start may block the StateControllerManager loop.
// A speaker that accepts TCP but stalls during the TLS/WebSocket handshake (or
// the S1 UPnP probe) would otherwise hang start() indefinitely, blocking every
// later zone's controller from coming up. On timeout we drop to the reconnect
// schedule and return so the manager can move on.
const START_TIMEOUT_MS = 15_000;
// How long teardown waits for the old client's listen loop to wind down before moving on. The
// loop normally ends the moment its transport is closed; this only bounds a loop that will not.
const TEARDOWN_TIMEOUT_MS = 5_000;
// While we believe the speaker is playing, ask it directly this often (UPnP GetTransportInfo,
// which S1 and S2 firmware both answer). Events are what keep the state current; this only
// catches the case where they silently stopped arriving (#413).
const TRANSPORT_CHECK_INTERVAL_MS = 20_000;
const TRANSPORT_CHECK_TIMEOUT_MS = 5_000;
// Consecutive "not playing" answers before we believe them over the cached state; one alone can
// be a track change or a rebuffer caught at the wrong moment.
const TRANSPORT_STALE_THRESHOLD = 2;

export class SonosStateController implements ZoneStateController {
  private readonly log = createLogger('Zones', 'StateController:Sonos');
  private readonly zone: ZoneConfig;
  private readonly onStatePatch: (zoneId: number, patch: Partial<ZoneState>) => void;
  private readonly host: string | null;
  private readonly configPort: ConfigPort;

  private client: AnySonosClient | null = null;
  private startPromise: Promise<void> | null = null;
  private stopRequested = false;
  private unsubscribeEvent: (() => void) | null = null;
  private timeTicker: NodeJS.Timeout | null = null;
  private transportCheckTimer: NodeJS.Timeout | null = null;
  private transportCheckInFlight = false;
  private transportStaleCount = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
  private connectionGeneration = 0;
  private lastCoverRaw: string | null = null;
  private coverRevision = 0;
  private lastTrackSignature = '';
  private lastLoggedSnapshotSignature = '';
  private lastTrackMediaUrl: string | null = null;
  private lastTrackTitle: string | null = null;

  constructor(options: SonosControllerOptions) {
    this.zone = options.zone;
    this.onStatePatch = options.onStatePatch;
    this.configPort = options.configPort;
    this.host = resolveSonosHost(this.zone);
  }

  /** Base of the stream URLs SonosOutput hands the speaker; read per call so config edits apply. */
  private ownStreamBaseUrl(): string {
    return buildBaseUrl({
      host: this.configPort.getSystemConfig().audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  public async start(): Promise<void> {
    this.stopRequested = false;
    this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), START_TIMEOUT_MS);
      timeoutHandle.unref?.();
    });
    try {
      const result = await Promise.race([
        this.connect().then(() => 'done' as const),
        timeoutPromise,
      ]);
      if (result === 'timeout') {
        this.log.warn('sonos state controller start timed out; scheduling reconnect', {
          zoneId: this.zone.id,
          host: this.host,
          timeoutMs: START_TIMEOUT_MS,
        });
        // Tear down whatever half-initialised client we may have so the next
        // attempt starts clean. We do not await — destroy can itself hang on a
        // pathological speaker, and we are already past the budget.
        void this.destroyClient();
        this.scheduleReconnect();
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopRequested) {
      return;
    }

    if (!this.host) {
      this.log.warn('state controller sonos enabled but zone output has no usable host/ip');
      return;
    }

    await this.destroyClient();
    const generation = ++this.connectionGeneration;

    // Probe S2 vs S1 firmware before instantiating the backend client. Sonos
    // S2 speakers expose the modern WebSocket API on TLS:1443; S1 speakers do
    // not, and need the legacy UPnP/SOAP path. `unknown` is treated as S2 so
    // we don't change behaviour for healthy S2 fleets that happen to be slow
    // to respond — the existing failure paths still log and reconnect.
    const generationKind = await detectGeneration(this.host).catch(() => 'unknown' as const);
    if (this.connectionGeneration !== generation || this.stopRequested) {
      return;
    }
    const client: AnySonosClient =
      generationKind === 'S1'
        ? new S1Client(this.host, { logger: console })
        : new SonosClient(this.host, { logger: console });
    this.log.info('sonos state controller backend selected', {
      zoneId: this.zone.id,
      host: this.host,
      generation: generationKind,
    });

    this.client = client;

    this.unsubscribeEvent = client.subscribe((event) => {
      if (this.connectionGeneration !== generation || this.client !== client) {
        return;
      }
      if (
        event.eventType === EventType.CONNECTED ||
        event.eventType === EventType.GROUP_UPDATED ||
        event.eventType === EventType.GROUP_ADDED ||
        event.eventType === EventType.PLAYER_UPDATED
      ) {
        this.emitSnapshotPatch();
      }

      if (event.eventType === EventType.DISCONNECTED) {
        this.log.warn('sonos websocket disconnected', { zoneId: this.zone.id, host: this.host });
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      this.log.info('sonos state controller connected', {
        zoneId: this.zone.id,
        zoneName: this.zone.name,
        host: this.host,
      });

      this.reconnectDelay = RECONNECT_INITIAL_DELAY_MS;

      this.emitSnapshotPatch();
      this.startTicker();

      this.startPromise = client.start().catch((err) => {
        if (!this.stopRequested && this.connectionGeneration === generation && this.client === client) {
          this.log.warn('sonos state stream stopped', {
            zoneId: this.zone.id,
            host: this.host,
            message: err instanceof Error ? err.message : String(err),
          });
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      if (this.connectionGeneration !== generation || this.client !== client) {
        return;
      }
      this.log.warn('sonos state controller failed to start', {
        zoneId: this.zone.id,
        host: this.host,
        message: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopRequested || this.reconnectTimer) {
      return;
    }

    this.log.info('sonos reconnect scheduled', {
      zoneId: this.zone.id,
      host: this.host,
      delayMs: this.reconnectDelay,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopRequested) {
        void this.connect();
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * RECONNECT_BACKOFF_FACTOR,
      RECONNECT_MAX_DELAY_MS,
    );
  }

  public async stop(): Promise<void> {
    this.stopRequested = true;
    this.stopTicker();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await this.destroyClient();

    this.log.info('stopped sonos state controller', { zoneId: this.zone.id });
  }

  private async destroyClient(): Promise<void> {
    this.connectionGeneration += 1;
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent();
      this.unsubscribeEvent = null;
    }

    const client = this.client;
    const startPromise = this.startPromise;
    this.client = null;
    this.startPromise = null;

    if (client) {
      try {
        await client.disconnect();
      } catch (err) {
        // The S2 client unsubscribes its groups before it closes the socket, and that throws
        // when the socket is already gone, which is exactly when we reconnect. The socket was
        // then never closed and its listen loop never told to stop, so the start promise below
        // never settled and this teardown hung forever: the controller was wedged, the old
        // client kept reconnecting on its own with nobody listening, and the zone kept its
        // last state until the controllers were re-initialised (#413). Close it directly.
        this.log.debug('sonos client disconnect failed; closing its transport directly', {
          zoneId: this.zone.id,
          message: err instanceof Error ? err.message : String(err),
        });
        await closeTransport(client);
      }
    }
    if (startPromise) {
      await settleWithin(startPromise, TEARDOWN_TIMEOUT_MS);
    }
  }

  public handleCommand(command: string): boolean {
    const action = normalizeCommand(command);
    if (!action) {
      return false;
    }
    if (!this.client?.player?.group) {
      // Decline instead of accepting-and-dropping: returning true told the caller the speaker
      // had it, so a play with no live group (websocket down, speaker rebooted, zone regrouped)
      // went nowhere at all. Declining hands the command back to local playback, which can
      // restart the queue where it left off (issue #327).
      this.log.warn('sonos command declined; no active group', { zoneId: this.zone.id, action });
      return false;
    }
    if (action === 'play') {
      const strategy = this.resolvePlayStrategy(this.client.player.group);
      if (strategy.kind === 'none') {
        // Same reasoning as above, one layer deeper: the speaker is idle and holds nothing of
        // ours to reload, so every way of saying "play" to it is a no-op. Declining hands the
        // command to local playback, which restarts the current queue item (issue #345).
        this.log.debug('sonos play declined; speaker has nothing to resume', {
          zoneId: this.zone.id,
          reason: strategy.reason,
        });
        return false;
      }
    }
    void this.dispatchCommand(action);
    return true;
  }

  private startTicker(): void {
    if (this.timeTicker) {
      clearInterval(this.timeTicker);
    }
    this.timeTicker = setInterval(() => {
      this.emitTimeTick();
    }, TIME_TICK_MS);
    if (this.transportCheckTimer) {
      clearInterval(this.transportCheckTimer);
    }
    this.transportStaleCount = 0;
    this.transportCheckTimer = setInterval(() => {
      void this.checkTransportState();
    }, TRANSPORT_CHECK_INTERVAL_MS);
    this.transportCheckTimer.unref?.();
  }

  private stopTicker(): void {
    if (this.timeTicker) {
      clearInterval(this.timeTicker);
      this.timeTicker = null;
    }
    if (this.transportCheckTimer) {
      clearInterval(this.transportCheckTimer);
      this.transportCheckTimer = null;
    }
  }

  /**
   * Safety net for events that stop arriving without an error: a half-open socket, or a lapsed
   * subscription the speaker no longer pushes to. Either way the cache keeps saying 'play' while
   * the speaker sits stopped (#413). While the cache says 'play' we ask the speaker itself; when
   * it disagrees twice in a row we report what it says and rebuild the connection, which
   * re-subscribes and re-reads the full state.
   */
  private async checkTransportState(): Promise<void> {
    const group = this.client?.player?.group;
    if (!group || !this.host || this.stopRequested || this.transportCheckInFlight) {
      return;
    }
    if (mapPlaybackState(group.playbackState) !== 'play') {
      this.transportStaleCount = 0;
      return;
    }
    const generation = this.connectionGeneration;
    this.transportCheckInFlight = true;
    let state: string | null;
    try {
      state = await this.fetchTransportState(this.host);
    } finally {
      this.transportCheckInFlight = false;
    }
    if (generation !== this.connectionGeneration || this.stopRequested) {
      return;
    }
    const observed = mapTransportInfoState(state);
    if (observed === 'play') {
      this.transportStaleCount = 0;
      return;
    }
    if (observed === null) {
      // No answer, or a transitional one, says nothing about our events.
      return;
    }
    if (mapPlaybackState(this.client?.player?.group?.playbackState) !== 'play') {
      this.transportStaleCount = 0;
      return;
    }
    this.transportStaleCount += 1;
    if (this.transportStaleCount < TRANSPORT_STALE_THRESHOLD) {
      return;
    }
    this.transportStaleCount = 0;
    this.log.warn('sonos state stale; speaker is not playing but no event said so, reconnecting', {
      zoneId: this.zone.id,
      host: this.host,
      transportState: state,
    });
    this.onStatePatch(this.zone.id, { mode: observed });
    void this.connect();
  }

  private async fetchTransportState(host: string): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSPORT_CHECK_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await fetch(`http://${formatHost(host)}:1400/MediaRenderer/AVTransport/Control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"',
        },
        body: GET_TRANSPORT_INFO_BODY,
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const match = /<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i.exec(await response.text());
      return match?.[1]?.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitTimeTick(): void {
    const group = this.client?.player?.group;
    if (!group) {
      return;
    }
    const mode = mapPlaybackState(group.playbackState);
    if (mode !== 'play') {
      return;
    }
    const time = Math.max(0, Math.floor(group.positionSeconds));
    this.onStatePatch(this.zone.id, { time });
  }

  private emitSnapshotPatch(): void {
    const patch = this.buildSnapshotPatch();
    if (!patch || Object.keys(patch).length === 0) {
      return;
    }

    const snapshotSignature = [
      String(patch.mode ?? ''),
      String(patch.audiotype ?? ''),
      String(patch.sourceName ?? ''),
      String(patch.title ?? ''),
      String(patch.artist ?? ''),
      String(patch.album ?? ''),
      String(patch.station ?? ''),
    ].join('|');

    if (snapshotSignature !== this.lastLoggedSnapshotSignature) {
      this.lastLoggedSnapshotSignature = snapshotSignature;
      this.log.debug('sonos state update', {
        zoneId: this.zone.id,
        mode: patch.mode,
        audiotype: patch.audiotype,
        sourceName: patch.sourceName,
        title: patch.title,
        artist: patch.artist,
        album: patch.album,
        hasCover: Boolean(patch.coverurl),
        keys: Object.keys(patch),
      });
    }

    this.onStatePatch(this.zone.id, patch);
  }

  private buildSnapshotPatch(): Partial<ZoneState> | null {
    const player = this.client?.player;
    const group = player?.group;

    if (!player || !group) {
      return null;
    }

    const metadata = group.playbackMetadataStatus;
    const track = metadata?.currentItem?.track;
    const container = metadata?.container;

    const trackMediaUrl = cleanString(track?.mediaUrl);
    if (isOwnStream(trackMediaUrl, container, this.ownStreamBaseUrl())) {
      // Our own stream lives exactly as long as the session that feeds it, so it is never a
      // reload target: once that session ends the URL leads nowhere, and an older external URL
      // still in the cache is not what the zone was last playing either (#418).
      if (this.lastTrackMediaUrl) {
        this.log.debug('sonos play-cache cleared; speaker is playing our own stream', {
          zoneId: this.zone.id,
          mediaUrl: trackMediaUrl || null,
        });
      }
      this.lastTrackMediaUrl = null;
      this.lastTrackTitle = null;
    } else if (trackMediaUrl) {
      const isNew = this.lastTrackMediaUrl !== trackMediaUrl;
      this.lastTrackMediaUrl = trackMediaUrl;
      this.lastTrackTitle = cleanString(track?.name) || cleanString(container?.name) || null;
      if (isNew) {
        this.log.debug('sonos play-cache updated', {
          zoneId: this.zone.id,
          mediaUrl: trackMediaUrl,
          title: this.lastTrackTitle,
        });
      }
    }

    const mode = mapPlaybackState(group.playbackState);
    const audiotype = resolveAudiotype(group, track?.mediaUrl ?? '', container?.type ?? '');
    const sourceName = resolveSourceName(audiotype, container?.name ?? '', group.name, this.zone.name);
    const title = cleanString(track?.name) || cleanString(container?.name) || sourceName;
    const artist = cleanString(track?.artist?.name) || cleanString(metadata?.streamInfo) || '';
    const album = cleanString(track?.album?.name) || '';

    const trackDurationSec =
      typeof track?.durationMillis === 'number' && Number.isFinite(track.durationMillis)
        ? Math.max(0, Math.round(track.durationMillis / 1000))
        : null;

    const time = Math.max(0, Math.floor(group.positionSeconds));

    const rawCover =
      normalizeCoverUrl(firstImage(track?.images), this.host) ||
      normalizeCoverUrl(firstImage(container?.images), this.host);

    const signature = `${title}|${artist}|${album}`;

    let coverurl = '';
    if (rawCover) {
      const coverChanged = this.lastCoverRaw !== rawCover;
      const trackChanged = this.lastTrackSignature !== signature;

      if (coverChanged || trackChanged) {
        this.coverRevision += 1;
        this.lastCoverRaw = rawCover;
      }

      coverurl = withCacheBust(rawCover, this.coverRevision);
    }

    this.lastTrackSignature = signature;

    const patch: Partial<ZoneState> = {
      audiopath: '',
      mode,
      power: 'on',
      clientState: 'on',
      audiotype,
      sourceName,
      title,
      artist,
      album,
      time,
    };

    if (typeof trackDurationSec === 'number') {
      patch.duration = trackDurationSec;
    }

    if (coverurl) {
      patch.coverurl = coverurl;
    }

    if ((audiotype === AudioType.LineIn || audiotype === AudioType.Bluetooth) && !artist && !album) {
      patch.station = '';
      patch.title = sourceName;
    }

    return patch;
  }

  private async dispatchCommand(action: 'play' | 'pause' | 'stop' | 'next' | 'previous'): Promise<void> {
    const group = this.client?.player?.group;
    if (!group) {
      // handleCommand() already declines in this case; this only catches a group disappearing
      // between the decision and this async continuation.
      this.log.warn('sonos command ignored; group disappeared', { zoneId: this.zone.id, action });
      return;
    }

    try {
      if (action === 'play') {
        await this.dispatchPlay(group);
      } else if (action === 'pause') await group.pause();
      else if (action === 'stop') await group.stop();
      else if (action === 'next') await group.skipToNextTrack();
      else await group.skipToPreviousTrack();

      this.log.info('sonos command sent', { zoneId: this.zone.id, action });
    } catch (err) {
      this.log.warn('sonos command failed', {
        zoneId: this.zone.id,
        action,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * What, if anything, the speaker itself can do with a play command.
   *
   * - `resume`: it holds a paused source of its own; group.play() picks it up where it left off.
   * - `reload`: it is idle but we know the media URL it last reported, so playStreamUrl can put
   *   the source back. A bare group.play() would not: the device's internal queue decays after
   *   idle (stream sessions expire, the container goes stale), so it flips to PLAYING for ~200ms
   *   and drops back to STOPPED.
   * - `none`: idle with nothing of ours to reload — which is the normal state after we paused our
   *   own HTTP stream, because Sonos does not pause a length-less stream, it drops it. There is no
   *   command that revives that, so the caller must hand the play back to local playback (#345).
   *
   * Our own stream is never resumed or reloaded, whatever the speaker reports for it: the
   * speaker can name its URL (and the title of whatever the radio played last), but that URL is
   * dead once the session behind it ended, so `reload` is strictly the external-source path
   * (#418). Music Assistant reaches the same conclusion from the other side and never asks the
   * speaker to resume its own queue content either (providers/sonos/player.py).
   */
  private resolvePlayStrategy(
    group: AnySonosGroup,
  ): { kind: 'resume' } | { kind: 'reload'; url: string } | { kind: 'none'; reason: string } {
    const metadata = group.playbackMetadataStatus;
    if (isOwnStream(cleanString(metadata?.currentItem?.track?.mediaUrl), metadata?.container, this.ownStreamBaseUrl())) {
      // The speaker still holds our stream, but play only reaches this controller once the local
      // session behind it is gone, so neither resuming nor reloading that URL can produce sound:
      // the speaker flips to PLAYING and drops back to STOPPED (#418). Local playback restarts the
      // current queue item instead.
      return { kind: 'none', reason: 'own-stream-ended' };
    }
    const rawState = String(group.playbackState ?? '');
    if (rawState.toUpperCase().includes('PAUSED')) {
      return { kind: 'resume' };
    }
    const hasPlayStreamUrl =
      'playStreamUrl' in group && typeof (group as SonosGroup).playStreamUrl === 'function';
    if (this.lastTrackMediaUrl && hasPlayStreamUrl) {
      return { kind: 'reload', url: this.lastTrackMediaUrl };
    }
    return {
      kind: 'none',
      reason: !this.lastTrackMediaUrl
        ? 'no-cached-media-url'
        : 'no-s2-playStreamUrl (S1 or unsupported client)',
    };
  }

  // Diagnostic logging is intentionally verbose: when this code misbehaves we want a single
  // SPAM log to tell us exactly which branch ran, why, and with what cached state. Tune down
  // once the path is proven reliable.
  private async dispatchPlay(group: AnySonosGroup): Promise<void> {
    const metadata = group.playbackMetadataStatus;
    const currentTrack = metadata?.currentItem?.track;
    const currentContainer = metadata?.container;
    const strategy = this.resolvePlayStrategy(group);

    this.log.debug('sonos dispatch play: entry', {
      zoneId: this.zone.id,
      playbackState: String(group.playbackState ?? ''),
      strategy: strategy.kind,
      observedTrackMediaUrl: currentTrack?.mediaUrl ?? null,
      observedTrackName: currentTrack?.name ?? null,
      cachedMediaUrl: this.lastTrackMediaUrl,
      cachedTitle: this.lastTrackTitle,
      containerName: currentContainer?.name ?? null,
      containerType: currentContainer?.type ?? null,
      containerServiceId: currentContainer?.id?.serviceId ?? null,
      containerObjectId: currentContainer?.id?.objectId ?? null,
      containerAccountId: currentContainer?.id?.accountId ?? null,
    });

    if (strategy.kind === 'reload') {
      const container = {
        _objectType: 'container' as const,
        name: this.lastTrackTitle ?? this.zone.name,
        type: 'trackList',
      };
      await (group as SonosGroup).playStreamUrl(strategy.url, container);
      return;
    }

    // `none` can still land here when the speaker changed state between handleCommand's check
    // and this async continuation. group.play() is the only thing left to try, and it is what
    // the old code did unconditionally.
    await group.play();
  }
}

const GET_TRANSPORT_INFO_BODY = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:GetTransportInfo>
  </s:Body>
</s:Envelope>`;

/** UPnP transport state to zone mode; null for anything that is not a settled answer. */
function mapTransportInfoState(state: string | null): ZoneState['mode'] | null {
  switch (String(state ?? '').toUpperCase()) {
    case 'PLAYING':
      return 'play';
    case 'PAUSED_PLAYBACK':
      return 'pause';
    case 'STOPPED':
    case 'NO_MEDIA_PRESENT':
      return 'stop';
    default:
      // TRANSITIONING, or no answer at all.
      return null;
  }
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Closes a client's transport without going through its own disconnect(), which can throw
 * before it gets that far. Only the S2 client has a socket to close; S1 disconnect() does not
 * throw on a dead speaker.
 */
async function closeTransport(client: AnySonosClient): Promise<void> {
  const api = (client as { api?: { disconnect?: () => Promise<void> } }).api;
  try {
    await api?.disconnect?.();
  } catch {
    // nothing left to close
  }
}

/** Waits for a promise to settle, but never longer than `ms`; its outcome is not needed. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([promise.then(() => undefined, () => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeCommand(command: string): 'play' | 'pause' | 'stop' | 'next' | 'previous' | null {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'play' || normalized === 'resume') return 'play';
  if (normalized === 'pause') return 'pause';
  if (normalized === 'stop') return 'stop';
  if (normalized === 'next' || normalized === 'queueplus' || normalized === 'skip') return 'next';
  if (normalized === 'previous' || normalized === 'prev' || normalized === 'queueminus') return 'previous';
  return null;
}

function resolveSonosHost(zone: ZoneConfig): string | null {
  const output = resolvePrimaryOutput(zone);
  const controlUrl = output ? pickString(output.controlUrl) : null;
  const candidate =
    (output ? pickString(output.host) : null) ??
    (output ? pickString(output.ip) : null) ??
    (output ? pickString(output.address) : null) ??
    extractHostname(controlUrl);
  return candidate || null;
}

function resolvePrimaryOutput(zone: ZoneConfig): Record<string, unknown> | null {
  if (zone.output && typeof zone.output === 'object') {
    return zone.output as Record<string, unknown>;
  }
  if (Array.isArray(zone.transports) && zone.transports.length > 0) {
    const first = zone.transports[0];
    if (first && typeof first === 'object') {
      return first as Record<string, unknown>;
    }
  }
  return null;
}

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractHostname(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function mapPlaybackState(state: string | null | undefined): ZoneState['mode'] {
  const token = String(state ?? '').toUpperCase();
  if (token.includes('PAUSED')) return 'pause';
  if (token.includes('PLAYING') || token.includes('BUFFERING')) return 'play';
  return 'stop';
}

/**
 * True when the speaker is playing something this server streams to it. The container identity
 * is what SonosOutput's playStreamUrl path sets; the stream URL on our own host also catches the
 * SOAP path (including its `x-rincon-mp3radio://` form), which carries no identity of ours.
 */
function isOwnStream(
  mediaUrl: string,
  container: { id?: { serviceId?: string | null } | null } | null | undefined,
  ownBaseUrl: string,
): boolean {
  if (cleanString(container?.id?.serviceId) === SONOS_OWN_CONTAINER_SERVICE_ID) {
    return true;
  }
  return isOwnStreamUrl(mediaUrl, ownBaseUrl);
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstImage(images: Array<{ url?: string }> | undefined): string {
  if (!Array.isArray(images)) return '';
  for (const image of images) {
    const url = typeof image?.url === 'string' ? image.url.trim() : '';
    if (url) return url;
  }
  return '';
}

function resolveAudiotype(group: AnySonosGroup, mediaUrl: string, containerType: string): number {
  const media = mediaUrl.toLowerCase();
  const type = containerType.toLowerCase();
  const service = String(group.activeService ?? '').toLowerCase();

  if (type.includes('linein') || media.startsWith('x-rincon-stream:') || media.startsWith('x-sonos-htastream:')) {
    return AudioType.LineIn;
  }
  if (type.includes('airplay')) {
    return AudioType.AirPlay;
  }
  if (media.startsWith('x-sonos-spotify:') || media.includes('spotify') || service === '9') {
    return AudioType.Spotify;
  }
  if (type.includes('station') || media.startsWith('x-rincon-mp3radio:') || media.startsWith('x-sonosapi-radio:')) {
    return AudioType.Radio;
  }
  return AudioType.File;
}

function resolveSourceName(
  audiotype: number,
  containerName: string,
  groupName: string,
  fallbackZoneName: string,
): string {
  if (audiotype === AudioType.Spotify) return 'Spotify';
  if (audiotype === AudioType.AirPlay) return 'AirPlay';
  if (audiotype === AudioType.LineIn) return containerName || 'Line In';
  return containerName || groupName || fallbackZoneName || 'Sonos';
}

function normalizeCoverUrl(value: string, host: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!host) return null;
  if (trimmed.startsWith('/')) {
    return `http://${host}:1400${trimmed}`;
  }
  return `http://${host}:1400/${trimmed}`;
}

function withCacheBust(url: string, revision: number): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('cb', String(revision));
    return parsed.toString();
  } catch {
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}cb=${revision}`;
  }
}
