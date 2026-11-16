import {
  chooseStreamProfile,
  parseStreamFormatPreference,
  streamProfileNeedsChunked,
  type StreamFormatPreference,
  type StreamProfileChoice,
} from '@/domain/outputs/streamProfilePolicy';
import { createLogger } from '@/shared/logging/logger';
import type { PlaybackSession } from '@/ports/types/playback';
import type { HttpPreferences, PreferredOutput, OutputConfigDefinition, ZoneOutput } from '@/ports/OutputsTypes';
import { decodeAudiopath } from '@/domain/zones/audiopath';
import { isHttpUrl, resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, normalizeStreamUrl, resolveAbsoluteUrl } from '@/shared/streamUrl';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import { BASE_PLAYABLE_RATES } from '@/adapters/outputs/playableRates';
import {
  DlnaControlPoint,
  type DlnaTransportEvent,
  type DlnaRenderingEvent,
} from '@sonn-audio/node-upnp';

/**
 * Sink MIME types that mean "this renderer can take our FLAC". `audio/x-flac` is the older spelling and
 * still what several renderers publish; the LPCM types are lossless too but not what we send, so they
 * do not qualify.
 */
const LOSSLESS_SINK_TYPES = new Set(['audio/flac', 'audio/x-flac']);

/**
 * How long a renderer gets, after being handed a URI and told to Play, to actually fetch the
 * stream before we conclude it is not playing and re-arm it. Generous on purpose: a renderer that
 * is going to pull does so within a second, and the cost of being wrong is an audible restart.
 */
const STREAM_FETCH_GRACE_MS = 5000;

/**
 * How long a volume we sent stays recognizable as our own GENA echo. Renderers moderate their
 * LastChange events (the Bose SoundTouch batches them at ~1s) and a SetVolume round trip has been
 * seen to take ~2s, so an echo can trail its write considerably — and trail *other* writes made
 * in between. Entries are not consumed on match: one write can surface in several moderated
 * events, and one coalesced event can answer several writes.
 */
const VOLUME_ECHO_WINDOW_MS = 5000;

/**
 * How long the renderer's own volume reports are distrusted around a transport change we
 * initiated. A SoundTouch reports volume 0 when told to Stop and re-asserts its own remembered
 * level after SetAVTransportURI — neither is the user turning a knob, and adopting them left the
 * zone parked at 0 or desynced from what the room actually plays at (issue #358, third report).
 * Reports inside the window still update what we know of the device; they are just not adopted.
 */
const TRANSPORT_TRANSITION_GUARD_MS = 5000;

export interface DlnaOutputConfig {
  host?: string;
  controlUrl?: string;
  autoDiscover?: boolean | string;
  deviceName?: string;
  /** `lossless` sends FLAC, `mp3` forces MP3, `auto` (default) sends MP3 — see DlnaOutput.streamProfile. */
  streamFormat?: string;
}

export const DLNA_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'dlna',
  label: 'DLNA / UPnP AVTransport',
  description: 'Streams audio to a DLNA renderer by issuing AVTransport commands.',
  fields: [
    {
      id: 'host',
      label: 'Renderer IP or hostname',
      type: 'text',
      placeholder: '192.168.1.50',
      description:
        'The renderer this zone plays on. Picking one from the list below fills this in; type an address yourself if it is not listed.',
    },
    {
      id: 'controlUrl',
      label: 'AVTransport control URL',
      type: 'text',
      placeholder: 'http://192.168.1.50:12345/Control/AVTransport',
      advanced: true,
      description:
        'Names the renderer\'s control endpoint by hand. Unlike Sonos, a DLNA renderer can serve its description anywhere, so an address alone is not always enough to find it.',
    },
    {
      id: 'deviceName',
      label: 'Preferred device name',
      type: 'text',
      placeholder: 'Living Room',
      advanced: true,
      description:
        'Matches a renderer by its own name when no address is set. Without it, the zone name is used.',
    },
    {
      id: 'streamFormat',
      label: 'Sound quality',
      type: 'text',
      placeholder: 'auto',
      description:
        "Leave this on 'auto': the server asks the speaker which formats it plays and sends the music unchanged (FLAC) whenever it can, instead of converting it to MP3. Set 'lossless' to insist, or 'mp3' if the speaker answers wrongly or the network cannot keep up.",
    },
  ],
};

function isAutoDiscoverEnabled(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  // Default to true so a zone with neither host nor controlUrl still self-discovers.
  return true;
}

/**
 * DLNA push output — a thin app adapter over the module's {@link DlnaControlPoint},
 * which owns the whole UPnP control-point protocol (endpoint discovery, the
 * Stop→SetURI→Play sequence with its silent-timeout-as-accepted and 701-retry
 * quirks, command serialization, and GENA event subscription).
 *
 * What stays here is app glue the module deliberately leaves to the host: building
 * DIDL from a PlaybackSession, resolving the stream URI + cover art, the per-track
 * dedup, the readiness gate that treats the stream's own HTTP GET as proof of playback
 * (see ensureStreamFetched), the volume anti-feedback guard, and routing GENA volume
 * events into zone state. Transport-state is intentionally NOT reflected back (see
 * onRemoteTransport).
 */
export class DlnaOutput implements ZoneOutput {
  public readonly type = 'dlna';
  private readonly log = createLogger('Output', 'DLNA');
  private readonly cp: DlnaControlPoint;
  // Per-track identity of the stream currently pushed to the renderer. Rotates each track
  // (session.stream.id), so it dedups the intra-track play() storm without swallowing the
  // next track (whose normalized URL is identical).
  private currentStreamKey: string | null = null;
  // Last URI + metadata signature pushed via SetAVTransportURI, so a later
  // updateMetadata can detect a meaningful change (e.g. title/duration arriving
  // after the initial play) and refresh now-playing without restarting playback.
  private lastPushedUri: string | null = null;
  private lastMetadataSignature: string | null = null;
  // Whether the item the renderer currently holds is a duration-less live broadcast. A
  // mid-playback SetAVTransportURI is only worth its risk when that flips to a real track
  // (see updateMetadata).
  private lastPushedBroadcast = false;
  // Whether the renderer has actually fetched the stream we pushed for the current track. A DLNA
  // renderer answers Play with a 200 whether or not it ever pulls a byte, so the stream's first
  // HTTP GET is the only proof of playback — it gates both the re-arm in ensureStreamFetched and
  // the mid-playback metadata re-push.
  private streamFetched = false;
  // A metadata update that arrived before that proof, held until it is safe to send (see
  // updateMetadata). Newest wins; it is folded into the re-arm when there is one.
  private pendingMetadataSession: PlaybackSession | null = null;
  // Anti-feedback guard for VOLUME: our own SetVolume must not bounce back as a spurious user
  // change. Remembering only the last write was not enough (issue #358): with two levels in
  // flight, each delayed echo compared against the *other* value, passed for a user change, was
  // re-sent, and produced the next echo — a self-sustaining oscillation. So every level sent
  // within the window stays suppressible until it ages out.
  // (Transport-state is not reflected back at all — see onRemoteTransport.)
  private readonly recentOutboundVolumes: Array<{ volume: number; at: number }> = [];
  // The renderer's state as we know it: device volume and mute flag from its GENA events combine
  // into the audible level in onRemoteRendering. lastKnownLevel is that level as of the last event
  // OR our last write — the write must move the baseline too, or a device asserting its own level
  // right after a write would look like a repeat of its previous event and be dropped.
  private lastKnownVolume?: number;
  private lastKnownMuted?: boolean;
  private lastKnownLevel?: number;
  // Until when the renderer's own volume reports are transition noise, not user intent.
  private transportTransitionUntil = 0;
  private eventsSubscribed = false;
  private disposed = false;
  private readonly streamFormat: StreamFormatPreference;
  /** Set once this renderer has actually failed on a lossless stream; outranks the preference. */
  private losslessFailed = false;
  /**
   * What the renderer said it accepts, from its ConnectionManager. `undefined` = not asked yet,
   * `null` = asked and it would not say — both mean "do not assume", which is why they are distinct
   * from `false`.
   */
  private losslessSupported?: boolean | null;
  private capabilityProbe?: Promise<void>;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: DlnaOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    const host = typeof config.host === 'string' ? config.host.trim() : '';
    this.streamFormat = parseStreamFormatPreference(config.streamFormat);
    const autoDiscover = isAutoDiscoverEnabled(config.autoDiscover);
    // Fall back to the zone name so auto-discovery can match a renderer by friendly name.
    const deviceName =
      typeof config.deviceName === 'string' && config.deviceName.trim().length > 0
        ? config.deviceName.trim()
        : this.zoneName;
    const controlUrl =
      typeof config.controlUrl === 'string' && config.controlUrl.trim().length > 0
        ? config.controlUrl.trim()
        : undefined;
    this.cp = new DlnaControlPoint({
      host,
      controlUrl,
      autoDiscover,
      deviceName,
      commandTimeoutMs: 2500,
      logger: this.log,
    });
    // Ask a *known* renderer what it accepts straight away, so the answer is in before the first track.
    // With only auto-discovery configured we wait for playback to trigger discovery rather than firing
    // SSDP for a capability question; the probe then runs on the first play().
    if (host || controlUrl) {
      this.probeCapabilities();
    }
    if (controlUrl) {
      this.log.info('DLNA output configured with manual control URL', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        controlUrl,
      });
    } else if (host) {
      this.log.info('DLNA output awaiting discovery', { zoneId: this.zoneId, zone: this.zoneName, host });
    } else if (autoDiscover) {
      this.log.info('DLNA output awaiting SSDP auto-discovery', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        deviceName,
      });
    } else {
      this.log.warn('DLNA output has no host or control URL configured', {
        zoneId: this.zoneId,
        zone: this.zoneName,
      });
    }
  }

  public async play(session: PlaybackSession): Promise<void> {
    this.probeCapabilities();
    if (!session.playbackSource) {
      this.log.debug('DLNA output skipped', { zoneId: this.zoneId, source: session.source });
      return;
    }
    await this.ensureEvents();
    const uri = this.resolveStreamUri(session);
    if (!uri) {
      this.log.warn('no playable URI for session', { zoneId: this.zoneId });
      return;
    }
    const streamUri = this.normalizeDlnaStreamUri(uri);
    // Coalesce the burst of duplicate play() calls WITHIN one track, but always re-push on a
    // new track. The stream URL normalizes to a stable `current.mp3`, so it can't distinguish
    // tracks — but `session.stream.id` rotates per track while staying constant across a
    // track's ffmpeg re-spawn storm. Dedup on that id, not the URL, or track 2 gets swallowed.
    const streamKey = session.stream.id;
    if (streamKey && streamKey === this.currentStreamKey) {
      this.log.debug('DLNA play skipped; stream already active', { zoneId: this.zoneId, streamKey });
      return;
    }
    this.currentStreamKey = streamKey;
    this.streamFetched = false;
    this.pendingMetadataSession = null;
    const didl = this.buildDidlMetadata(streamUri, session);
    // Remember what we pushed so a later metadata update can decide whether to re-push (see
    // updateMetadata). The initial play() often fires before track metadata/duration has
    // resolved, so the first DIDL can be a title-less, duration-less audioBroadcast ("live").
    this.lastPushedUri = streamUri;
    this.lastMetadataSignature = this.metadataSignature(session);
    this.lastPushedBroadcast = this.isBroadcastItem(session);
    const pushedAt = Date.now();
    this.armTransitionGuard();
    await this.cp.setUri(streamUri, didl);
    // Not awaited: if the push worked, audio is already on its way and the caller must not wait
    // out the grace window to hear it.
    void this.ensureStreamFetched(streamUri, didl, streamKey, pushedAt);
  }

  /**
   * Confirm the renderer is playing by the only honest measure — it fetched the stream — and
   * re-arm it once if it did not.
   *
   * The module's setUri() abandons SetAVTransportURI after a short window and presses Play anyway,
   * because several renderers accept the URI and never reply (B&O/QPlay). On a slow renderer that
   * does reply, just not in time (measured: issue #343, ~1.7s), Play then lands before the URI is
   * committed: the transport reports playing, the title is on the display, volume commands work,
   * and not one byte is ever fetched. Play's own 200 cannot tell that apart, and neither can its
   * 701 retry. The stream request can.
   *
   * Deliberately zone-scoped rather than filtered on the renderer's address: a fetch we failed to
   * recognise would restart audio that was fine, so any pull of this zone's stream counts as
   * "something is playing this".
   */
  private async ensureStreamFetched(
    uri: string,
    didl: string,
    streamKey: string,
    pushedAt: number,
  ): Promise<void> {
    let since = pushedAt;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const seen = await this.ports.outputStreamEvents.waitForStreamRequest({
        zoneId: this.zoneId,
        timeoutMs: STREAM_FETCH_GRACE_MS,
        notBefore: since,
      });
      // A new track, a pause or a stop took over; that push owns the renderer now.
      if (this.currentStreamKey !== streamKey) {
        return;
      }
      if (seen) {
        this.onStreamFetched();
        return;
      }
      if (attempt === 2) {
        this.log.warn('DLNA renderer never fetched the stream', {
          zoneId: this.zoneId,
          zone: this.zoneName,
          uri,
        });
        return;
      }
      // Re-arm with the newest metadata we have, so the retry doubles as the metadata push that
      // was being held back — and ends in a Play, which is what the renderer is missing.
      const refreshed = this.pendingMetadataSession;
      let retryDidl = didl;
      if (refreshed) {
        retryDidl = this.buildDidlMetadata(uri, refreshed);
        this.lastMetadataSignature = this.metadataSignature(refreshed);
        this.lastPushedBroadcast = this.isBroadcastItem(refreshed);
        this.pendingMetadataSession = null;
      }
      this.log.warn('DLNA renderer did not fetch the stream; re-arming', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        uri,
      });
      since = Date.now();
      this.armTransitionGuard();
      await this.cp.setUri(uri, retryDidl);
      if (this.currentStreamKey !== streamKey) {
        return;
      }
    }
  }

  /** The renderer is pulling audio: release any metadata update that was waiting on that proof. */
  private onStreamFetched(): void {
    this.streamFetched = true;
    // The renderer has demonstrably settled, so put the zone's level back if the device drifted
    // during the transition — a SoundTouch restores its own remembered volume around a source
    // change and may override a level written mid-transition (issue #358, third report). No-op
    // when the device already stands where the zone does.
    const zoneVolume = this.ports.zoneManager.getZoneState(this.zoneId)?.volume;
    if (typeof zoneVolume === 'number' && Math.round(zoneVolume) !== this.lastKnownLevel) {
      void this.setVolume(zoneVolume).catch((err) => {
        this.log.debug('DLNA post-transition volume re-assert failed', {
          zoneId: this.zoneId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
    const pending = this.pendingMetadataSession;
    this.pendingMetadataSession = null;
    if (!pending) {
      return;
    }
    void this.updateMetadata(pending).catch((err) => {
      this.log.debug('DLNA held metadata update failed', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Refresh the renderer's now-playing when track metadata arrives after the initial play() —
   * specifically when a duration resolves and flips the item from a duration-less
   * `audioBroadcast` ("live") to a `musicTrack` with a progress bar.
   *
   * That flip is the ONLY change worth a mid-playback push. Re-sending SetAVTransportURI without
   * a Stop/Play was assumed to leave playback alone; on a Frontier Silicon renderer (HAMA
   * DIR-3100, issue #343) it tears the transport down instead — measured: the device disconnected
   * from the stream 60ms after the push and went to STOPPED, with no Play to bring it back. Radio
   * made that the every-time case, because an ICY title lands a second into every station.
   *
   * So a title/artist/album change on its own no longer reaches the transport. It costs a stale
   * line on the renderer's display and nothing else: a new track pushes a fresh item through
   * play() anyway, and in-band ICY carries the live title to renderers that ask for it.
   */
  public async updateMetadata(session: PlaybackSession | null): Promise<void> {
    if (!session) {
      return;
    }
    const uri = this.lastPushedUri;
    if (!uri) {
      return;
    }
    const signature = this.metadataSignature(session);
    if (signature === this.lastMetadataSignature) {
      return;
    }
    // Nothing may touch the transport before the renderer has started pulling. A SetAVTransportURI
    // that arrives while it is still arming replaces the URI it was told to play, and nothing
    // presses Play again — silence with the new title on the display (issue #343). Radio makes this
    // the common case: the station's first title resolves within a second of the initial push.
    if (!this.streamFetched) {
      this.pendingMetadataSession = session;
      return;
    }
    // Record the update either way, so the next comparison is against what we last saw rather
    // than against a signature we already declined to send.
    this.lastMetadataSignature = signature;
    const isBroadcast = this.isBroadcastItem(session);
    if (!this.lastPushedBroadcast || isBroadcast) {
      this.log.debug('DLNA now-playing update not sent to a playing renderer', {
        zoneId: this.zoneId,
        title: session.metadata?.title ?? '',
      });
      return;
    }
    // The renderer is about to hold a track, so nothing arriving after this is worth a push.
    this.lastPushedBroadcast = false;
    const didl = this.buildDidlMetadata(uri, session);
    await this.cp.updateMetadata(uri, didl);
  }

  public async pause(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    // Clear the dedup key so a resume/play of the SAME track re-issues transport commands
    // instead of being coalesced away (its stream.id is unchanged across pause→resume).
    this.currentStreamKey = null;
    this.armTransitionGuard();
    if (await this.cp.pause()) {
      return;
    }
    // Pause is optional in AVTransport and plenty of renderers leave it out, or refuse it for a
    // stream they cannot seek in. A refusal used to be the end of it: the zone showed paused and
    // the room went on playing. Stop is the one transport action every renderer has, and resuming
    // sends the stream again whichever way the pause went.
    this.log.debug('DLNA renderer refused pause; stopping instead', { zoneId: this.zoneId });
    await this.cp.stop();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    if (session) {
      await this.play(session);
      return;
    }
    this.armTransitionGuard();
    await this.cp.play();
  }

  public async stop(session: PlaybackSession | null): Promise<void> {
    if (!session?.playbackSource) {
      return;
    }
    this.currentStreamKey = null;
    this.armTransitionGuard();
    await this.cp.stop();
  }

  public async setVolume(level: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(level)));
    // Record before sending so the GENA echo of this write is recognized whenever it arrives —
    // the renderer may report it back well after we have already sent another level.
    this.recentOutboundVolumes.push({ volume: clamped, at: Date.now() });
    this.lastKnownVolume = clamped;
    this.lastKnownLevel = clamped;
    if (await this.cp.setVolume(clamped)) {
      this.log.info('DLNA volume set', { zoneId: this.zoneId, volume: clamped });
    }
  }

  public dispose(): void {
    // The flag, not just cp.dispose(): unsubscribing is asynchronous and best-effort, so a
    // NOTIFY already in flight (or a renderer that keeps notifying a dead SID) would still
    // land in onRemoteRendering — and a replaced instance must never write into the zone it
    // no longer serves (the issue #358 zombie).
    this.disposed = true;
    this.cp.dispose();
    this.log.debug('disposed', { zoneId: this.zoneId });
  }

  public getPreferredOutput(): PreferredOutput {
    return { profile: this.streamProfile(), sampleRate: 44100, sampleRates: BASE_PLAYABLE_RATES, channels: 2 };
  }

  public getHttpPreferences(): HttpPreferences {
    // Many DLNA renderers prefer an explicit Content-Length, and a strict one (B&O) reads a
    // length-less response as a live stream. FLAC cannot honour that: it is variable-bitrate, so a
    // length derived from the track duration would be a guess, and a body ending short of its
    // advertised length is what clipped the tail off Cast playback. Lossless therefore goes out chunked.
    const profile = this.streamProfile();
    return {
      httpProfile: streamProfileNeedsChunked(profile) ? 'chunked' : 'forced_content_length',
      icyEnabled: false,
    };
  }

  /**
   * Lossless when this renderer says it can decode it, MP3 otherwise.
   *
   * The answer comes from the device itself — `GetProtocolInfo`'s sink list — because a renderer that
   * cannot decode what it is given does not complain, it plays silence. Until that answer is in, `auto`
   * resolves to MP3: the query is asynchronous and this is not, so the first session after a restart may
   * still be MP3 and the next one lossless. An explicit `streamFormat` skips the wait entirely.
   */
  private streamProfile(): StreamProfileChoice {
    return chooseStreamProfile({
      preference: this.streamFormat,
      losslessSupported: this.losslessSupported ?? null,
      losslessFailed: this.losslessFailed,
    });
  }

  /**
   * Ask the renderer once what it accepts. Best-effort and fire-and-forget: playback never waits on it,
   * and a device that stays silent keeps the MP3 default.
   */
  private probeCapabilities(): void {
    if (this.capabilityProbe || this.losslessSupported !== undefined) {
      return;
    }
    this.capabilityProbe = (async () => {
      const types = await this.cp.getSinkContentTypes();
      if (!types) {
        this.losslessSupported = null;
        return;
      }
      this.losslessSupported = types.some((type) => LOSSLESS_SINK_TYPES.has(type.split(';')[0]!.trim()));
      this.log.info('DLNA renderer sound-format support resolved', {
        zoneId: this.zoneId,
        zone: this.zoneName,
        lossless: this.losslessSupported,
        types,
        streamFormat: this.streamFormat,
        using: this.streamProfile(),
      });
    })().catch(() => {
      this.losslessSupported = null;
    });
  }

  /** Start the GENA event subscription once, so device-side volume flows into zone state. */
  private async ensureEvents(): Promise<void> {
    if (this.eventsSubscribed) {
      return;
    }
    this.eventsSubscribed = true;
    const localHost = this.ports.config.getSystemConfig().audioserver?.ip?.trim() || '127.0.0.1';
    try {
      await this.cp.subscribeEvents(
        {
          onTransport: (event) => this.onRemoteTransport(event),
          onRendering: (event) => this.onRemoteRendering(event),
        },
        localHost,
      );
    } catch (err) {
      this.log.debug('DLNA event subscription failed', {
        zoneId: this.zoneId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A compact fingerprint of the now-playing-relevant metadata. Changes when the
   * title/artist/album/duration or the broadcast-vs-track distinction changes, so
   * updateMetadata re-pushes exactly when the renderer's display would differ.
   */
  private metadataSignature(session: PlaybackSession): string {
    const m = session.metadata;
    const duration = session.duration || m?.duration || 0;
    const isStream = m?.isRadio || m?.isAlert || !duration ? 1 : 0;
    return [m?.title ?? '', m?.artist ?? '', m?.album ?? '', duration, isStream].join('|');
  }

  private buildDidlMetadata(uri: string, session: PlaybackSession): string {
    const title = session.metadata?.title || this.zoneName;
    const artist = session.metadata?.artist || '';
    const album = session.metadata?.album || '';
    const cover = this.resolveCoverArt(session);
    // Radio/alerts are open-ended broadcasts; a track advertises its duration so the renderer
    // can show a progress bar. Alerts must stay duration-less (see Sonos notes) to avoid a clip.
    const isStream = this.isBroadcastItem(session);
    const duration = isStream ? '' : this.formatDlnaDuration(session.duration);
    const mediaClass = isStream
      ? 'object.item.audioItem.audioBroadcast'
      : 'object.item.audioItem.musicTrack';
    const durationAttr = duration ? ` duration="${duration}"` : '';
    // The 4th protocolInfo field names the DLNA profile. Strict sinks (B&O) validate it and can refuse
    // an item's now-playing metadata when no recognized profile is present — the same fix applied to the
    // MediaServer's <res>. OP=00 stays consistent with the stream's Accept-Ranges: none.
    //
    // FLAC has no DLNA profile name (it is not in the DLNA media-format tables at all), so the field is
    // left empty rather than filled with an invented token: a sink that validates it would reject a
    // profile that does not exist. The MIME type still has to match what the stream actually sends, or
    // the renderer decodes the wrong thing.
    const protocolInfo =
      this.streamProfile() === 'flac'
        ? 'http-get:*:audio/flac:DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000'
        : 'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=8D500000000000000000000000000000';
    const art = cover ? `<upnp:albumArtURI>${escapeXml(cover)}</upnp:albumArtURI>` : '';
    return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title><dc:creator>${escapeXml(artist)}</dc:creator><upnp:artist>${escapeXml(artist)}</upnp:artist><upnp:album>${escapeXml(album)}</upnp:album>${art}<upnp:class>${mediaClass}</upnp:class><res${durationAttr} protocolInfo="${protocolInfo}">${escapeXml(uri)}</res></item></DIDL-Lite>`;
  }

  private resolveCoverArt(session: PlaybackSession): string {
    const coverSource = resolveSessionCover(session);
    if (!coverSource) {
      return '';
    }
    // Prefer a real, externally-fetchable cover URL; otherwise fall back to our /cover proxy
    // path made absolute so the renderer can fetch it. Mirrors the Sonos output's approach.
    if (isHttpUrl(coverSource)) {
      return coverSource;
    }
    return resolveAbsoluteUrl(this.buildBaseUrl(), session.stream.coverUrl) ?? coverSource;
  }

  /**
   * Whether the renderer is (or would be) holding a duration-less live broadcast rather than a
   * track with a timeline — the `upnp:class` buildDidlMetadata puts on the item.
   */
  private isBroadcastItem(session: PlaybackSession): boolean {
    if (session.metadata?.isRadio || session.metadata?.isAlert) {
      return true;
    }
    return !this.formatDlnaDuration(session.duration);
  }

  private formatDlnaDuration(durationSeconds: number | undefined): string {
    const total = Math.max(0, Math.floor(Number(durationSeconds ?? 0)));
    if (!total) {
      return '';
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
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

  private normalizeDlnaStreamUri(uri: string): string {
    return normalizeStreamUrl(uri, this.buildBaseUrl(), ['mp3']);
  }

  private buildBaseUrl(): string {
    const sys = this.ports.config.getSystemConfig();
    return buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
  }

  private onRemoteTransport(event: DlnaTransportEvent): void {
    if (this.disposed) {
      return;
    }
    // We subscribe to AVTransport so the renderer keeps sending RenderingControl (volume)
    // events on the same connection, and for future use, but we deliberately do NOT reflect
    // device-side play/pause back into zone state. For a push output feeding a non-resumable
    // source (line-in/AirPlay/radio), routing the device's transport state into the zone either
    // tears the engine down (pause pipeline) or fights the zone state machine — both observed to
    // break playback and disable volume. Device pause/resume still works audibly (the renderer
    // pauses its own read of our stream); only the UI play/pause indicator won't mirror it.
    this.log.debug('DLNA remote transport event (state reflection disabled)', {
      zoneId: this.zoneId,
      transportState: event.transportState,
    });
  }

  /**
   * One decision per RenderingControl event. Volume and Mute are read as a single report of the
   * renderer's audible level (`muted ? 0 : volume`) and answered with at most one zone command —
   * reacting to the two fields separately sent two SetVolumes per event, and on renderers that
   * flip Mute alongside volume (Bose SoundTouch) it doubled the very echoes that fed the
   * oscillation of issue #358.
   *
   * An event arriving before any level is known (no write yet, nothing evented) only seeds: it
   * is the GENA initial state dump, not a user change. An unchanged level is a keep-alive/renew
   * snapshot (issue #314, stiwy18) and stays silent. A level that matches a recent write of ours
   * is our own echo — recorded, never answered. A change reported while we are moving the
   * renderer's transport is its own transition noise (0 at Stop, a self-restored level after
   * SetURI) — recorded, not adopted; onStreamFetched re-asserts the zone's level if the device
   * drifted. What remains is a genuine device-side change, which the zone adopts; its answering
   * dispatch back to us lands in the echo window, so the exchange converges instead of
   * oscillating.
   */
  private onRemoteRendering(event: DlnaRenderingEvent): void {
    if (this.disposed) {
      return;
    }
    const reportedVolume =
      typeof event.volume === 'number' && Number.isFinite(event.volume)
        ? Math.min(100, Math.max(0, Math.round(event.volume)))
        : undefined;
    const volumeChanged = reportedVolume !== undefined && reportedVolume !== this.lastKnownVolume;
    const muteFlipped =
      typeof event.muted === 'boolean' &&
      this.lastKnownMuted !== undefined &&
      event.muted !== this.lastKnownMuted;
    if (reportedVolume !== undefined) {
      this.lastKnownVolume = reportedVolume;
    }
    if (typeof event.muted === 'boolean') {
      this.lastKnownMuted = event.muted;
    }
    if (this.lastKnownVolume === undefined) {
      // A mute flag with no level ever seen to attach it to says nothing actionable yet.
      return;
    }
    const level = this.lastKnownMuted === true ? 0 : this.lastKnownVolume;
    const seed = this.lastKnownLevel === undefined;
    const unchanged = level === this.lastKnownLevel;
    const echo = this.isRecentOutboundVolume(level);
    const transitioning = Date.now() < this.transportTransitionUntil;
    this.lastKnownLevel = level;
    const decision = seed
      ? 'seed'
      : echo
        ? 'echo'
        : unchanged
          ? 'unchanged'
          : transitioning
            ? 'transition'
            : muteFlipped && !volumeChanged
              ? 'mute'
              : 'volume';
    this.log.debug('DLNA remote volume event', {
      zoneId: this.zoneId,
      volume: reportedVolume,
      muted: event.muted,
      level,
      decision,
    });
    if (decision === 'mute') {
      // The renderer's own mute key, volume standing still. Routed as the zone's mute so the
      // level survives in volumeBeforeMute instead of being clobbered by a bare zero — a bare
      // zero in zone state is what the next play start would dispatch (issue #358's ignition).
      this.ports.zoneManager.handleCommand(this.zoneId, 'mute', this.lastKnownMuted ? 'on' : 'off');
    } else if (decision === 'volume') {
      this.ports.zoneManager.handleCommand(this.zoneId, 'volume_set', String(level));
    }
  }

  /** Distrust the renderer's own volume reports for a while: we are moving its transport. */
  private armTransitionGuard(): void {
    this.transportTransitionUntil = Date.now() + TRANSPORT_TRANSITION_GUARD_MS;
  }

  /** True when this level matches one we sent recently — the echo of our own write. */
  private isRecentOutboundVolume(level: number): boolean {
    const cutoff = Date.now() - VOLUME_ECHO_WINDOW_MS;
    while (this.recentOutboundVolumes[0] !== undefined && this.recentOutboundVolumes[0].at < cutoff) {
      this.recentOutboundVolumes.shift();
    }
    // ±2 absorbs renderers that quantize to their own volume steps.
    return this.recentOutboundVolumes.some((entry) => Math.abs(entry.volume - level) <= 2);
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
