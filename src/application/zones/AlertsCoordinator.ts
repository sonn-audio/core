import type { ComponentLogger } from '@/shared/logging/logger';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { AlertMediaResource } from '@/application/alerts/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { AlertSnapshot, ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { PlaybackMetadata, PlaybackSession } from '@/ports/types/playback';
import type { NativeAlertRequest, ZoneOutput } from '@/ports/OutputsTypes';
import { AudioType } from '@/domain/zones/enums';
import { cloneQueueState, clampVolumeForZone } from '@/application/zones/helpers/stateHelpers';
import { resolveSessionPreDelayMs } from '@/application/playback/playbackPreDelay';
import { buildBaseUrl } from '@/shared/streamUrl';
import type { ZoneAudioHelpers } from '@/application/zones/internal/zoneAudioHelpers';
import { PlaybackCoordinator } from '@/application/zones/PlaybackCoordinator';
import { ZoneRepository } from '@/application/zones/ZoneRepository';

const MIN_ALERT_DURATION_MS = 20000;
const TTS_FIXED_GAIN_DB = 6;
// Keep alerts playing long enough for slower outputs to actually become audible.
// This is a safety net; we also try to reduce output buffering for alerts where possible.
const MIN_ALERT_AUDIBLE_MS = 2500;
const ALERT_STOP_MARGIN_MS = 750;
/** Slack on top of the measured window, so a rounding error cannot cost the last syllable. */
const ALERT_STOP_GUARD_MS = 150;
/**
 * How long the stop window waits for the engine's first byte before settling for its estimate.
 * An alert that has produced nothing by then is not going to be rescued by waiting longer.
 */
const ALERT_FIRST_AUDIO_WAIT_MS = 5000;
/**
 * How far ahead of the alert's first audible sample the announcement volume is set.
 *
 * The level has to travel to the device, so aiming exactly at the sample risks the
 * first moment of the bell coming out at the music level. Early by this much is the
 * safe side of that: it costs a fraction of a second of outgoing music at alert
 * volume instead of the whole output buffer's worth (#359).
 */
const ALERT_VOLUME_LEAD_MARGIN_MS = 250;

type AlertsCoordinatorDeps = {
  zones: ZoneRepository;
  playbackCoordinator: PlaybackCoordinator;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  log: ComponentLogger;
  audioHelpers: ZoneAudioHelpers;
  zoneAudioPrefs: ZoneAudioPreferences;
  configPort: ConfigPort;
};

type NativeAlertOutput = ZoneOutput & {
  playNativeAlert: (request: NativeAlertRequest) => Promise<boolean>;
};

export class AlertsCoordinator {
  private readonly zoneRepo: ZoneRepository;
  private readonly playbackCoordinator: PlaybackCoordinator;
  private readonly applyPatch: (
    zoneId: number,
    patch: Partial<ZoneState>,
    force?: boolean,
  ) => void;

  private readonly log: ComponentLogger;
  private readonly audioHelpers: ZoneAudioHelpers;
  private readonly zoneAudioPrefs: ZoneAudioPreferences;
  private readonly configPort: ConfigPort;
  // Per-zone serialization. Concurrent start/stop calls used to corrupt the
  // restore snapshot — caller B could capture state mid-flight from caller A
  // and on stopAlert restore to A's alert metadata instead of the original
  // queue. Public methods chain through this so each zone runs at most one
  // alert op at a time.
  private readonly opChain = new Map<number, Promise<void>>();

  constructor(deps: AlertsCoordinatorDeps) {
    this.zoneRepo = deps.zones;
    this.playbackCoordinator = deps.playbackCoordinator;
    this.applyPatch = deps.applyPatch;
    this.log = deps.log;
    this.audioHelpers = deps.audioHelpers;
    this.zoneAudioPrefs = deps.zoneAudioPrefs;
    this.configPort = deps.configPort;
  }

  public startAlert(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
    startDelayMs = 0,
  ): Promise<void> {
    return this.runSerialized(zoneId, () =>
      this.startAlertLocked(zoneId, type, media, volume, startDelayMs),
    );
  }

  public stopAlert(zoneId: number): Promise<void> {
    return this.runSerialized(zoneId, () => this.stopAlertLocked(zoneId));
  }

  private runSerialized(zoneId: number, fn: () => Promise<void>): Promise<void> {
    const previous = this.opChain.get(zoneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    // Stash the swallow-error variant so the next caller is not affected by
    // an earlier rejection but still waits for completion.
    const tracker = next.catch(() => undefined);
    this.opChain.set(zoneId, tracker);
    void tracker.then(() => {
      if (this.opChain.get(zoneId) === tracker) {
        this.opChain.delete(zoneId);
      }
    });
    return next;
  }

  private async startAlertLocked(
    zoneId: number,
    type: string,
    media: AlertMediaResource,
    volume: number,
    startDelayMs = 0,
  ): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    if (!ctx) {
      return;
    }

    await this.stopAlertLocked(zoneId);

    await this.waitForOutputReady(ctx);

    // Native overlay path (e.g. Sonos AudioClip): for non-looping alerts on outputs that
    // support it, duck-and-overlay instead of stopping the music. This leaves the engine
    // stream and zone state untouched (the music keeps playing under the announcement) and
    // sidesteps the transport-swap tail-clipping the fallback path has to drain around
    // (issues #262/#276/#279). Looping alerts (alarm/firealarm) never take this path —
    // AudioClip cannot loop indefinitely.
    if (!media.loop && (await this.tryNativeAlert(zoneId, ctx, type, media, volume))) {
      return;
    }

    const snapshot = this.createAlertSnapshot(ctx);
    const rawDurationMs =
      !media.loop && typeof media.duration === 'number' && media.duration > 0
        ? Math.round(media.duration * 1000)
        : undefined;
	    const reportedDurationSec =
	      !media.loop && typeof media.duration === 'number' && media.duration > 0
	        ? Math.max(0, Math.round(media.duration))
	        : undefined;
	    const durationMs = media.loop
	      ? undefined
	      : rawDurationMs !== undefined
	        ? Math.max(rawDurationMs + ALERT_STOP_MARGIN_MS, MIN_ALERT_AUDIBLE_MS, 0)
	        : MIN_ALERT_DURATION_MS;
	    const playUrl = media.url;
	    const title = media.title ?? type;

	    const alertRecord: NonNullable<ZoneContext['alert']> = {
	      type,
	      title,
	      url: playUrl,
	      reportedDurationSec,
	      durationMs,
	      snapshot,
	    };
	    ctx.alert = alertRecord;

    this.playbackCoordinator.setInputMode(ctx, 'alert');

    const clampedVolume = clampVolumeForZone(ctx.config, volume);

	    const metadata: PlaybackMetadata = {
	      title,
	      artist: '',
	      album: '',
	      coverurl: '',
	      // Use a longer internal duration so outputs have time to start and render the alert.
	      // Loxone-facing duration is overridden separately via `reportedDurationSec`.
	      duration: durationMs ? Math.round(durationMs / 1000) : reportedDurationSec ?? media.duration,
	      audiopath: playUrl,
	      station: '',
	      isAlert: true,
	    };

    if (/tts/i.test(type)) {
      this.zoneAudioPrefs.setTransientGainDb(zoneId, TTS_FIXED_GAIN_DB);
    }

    // Keep multi-zone alerts in sync: the caller works out how much silence this
    // zone has to lead with so its first audible sample lands with every sibling's
    // — a cold zone's amp wake-up and a slow output's buffer both count (#359).
    this.zoneAudioPrefs.setAlertPreDelayFloorMs(zoneId, startDelayMs > 0 ? startDelayMs : null);

    // Align the engine to the sink's preferred format (e.g. a 48 kHz/24-bit sendspin
    // client) BEFORE playing the alert. The bell/TTS file is 44.1 kHz; without this the
    // engine starts at 44.1 kHz and restarts mid-clip to 48 kHz — that race renders the
    // short alert as noise (the "doorbell noise" report).
    this.playbackCoordinator.alignOutputFormat(zoneId, playUrl);
    // Music takes its end-of-track guard from the output's latency on every start; the
    // alert path never did, so a clip inherited whatever the previous track left behind
    // (a forced end-of-track resets it to zero) and ended before the sink had played it.
    this.playbackCoordinator.applyOutputEndGuard(ctx);

    const session = ctx.player.playUri(playUrl, metadata);
    if (!session) {
      this.log.warn('alert playback skipped; no session', { zoneId, type });
      await this.stopAlertLocked(zoneId);
      return;
    }

    // Apply the announcement volume only after playUri has switched the active output to the
    // alert source. Setting it earlier dispatched SetVolume to the *previous* stream's transport,
    // so the still-playing radio briefly blasted at the alert volume before the source swapped
    // (issue #279). The Sonos output stashes this as pendingVolume and applies it after its Play.
    //
    // Switching the source is not the same as being heard, though: the alert leads with the
    // engine's wake-up silence, and the output still has to play out what it had buffered —
    // which is the outgoing music. Raising the room the instant playUri returned made that
    // music blast at announcement level before the bell arrived (#359), so the level waits
    // out the lead and lands with the alert's first audible sample.
    const volumeDelayMs = Math.max(
      this.resolveAudibleLeadMs(ctx, session, snapshot.mode === 'play') -
        ALERT_VOLUME_LEAD_MARGIN_MS,
      0,
    );
    this.scheduleAlertVolume(ctx, alertRecord, clampedVolume, volumeDelayMs);

    if (durationMs && durationMs > 0) {
      this.armAlertStopTimer(ctx, alertRecord, session, durationMs);
    }

	    this.applyPatch(zoneId, {
	      title,
	      artist: '',
	      album: '',
	      coverurl: '',
	      audiopath: playUrl,
	      station: '',
	      mode: 'play',
	      clientState: 'on',
	      power: 'on',
      audiotype: AudioType.File,
      type: this.audioHelpers.resolveAlertEventType(type),
      sourceName: ctx.name,
    });
	  }

  /**
   * End the alert once the *room* has heard it out, not once the server has finished sending it.
   *
   * Three things sit between `playUri` and the first sample in the room: the engine's own
   * start-up, the wake-up silence it prepends, and the audio the output is still holding.
   * The window used to count the silence alone — everything else came off the tail, because
   * a clip that starts late with a fixed-length window can only end early. That was survivable
   * while the deficit was small; when the engine grew a second stage (the float DSP bus, which
   * every TTS clip takes for its gain) the start-up cost grew with it and announcements began
   * ending a word short (#387).
   *
   * The timer is armed twice, deliberately. First on the modelled lead, so a zone whose engine
   * never produces a byte still gets its music back; then again the moment the first byte
   * actually exists, which is when the clock the tail depends on truly starts.
   */
  private armAlertStopTimer(
    ctx: ZoneContext,
    alert: NonNullable<ZoneContext['alert']>,
    session: PlaybackSession,
    durationMs: number,
  ): void {
    const zoneId = ctx.id;
    // Read what the engine actually prepended off the session rather than re-deriving it, so the
    // window can never disagree with the stream it is timing (#293).
    const preDelayMs = resolveSessionPreDelayMs(session);
    const roomLagMs = this.resolveOutputLagMs(ctx);

    const arm = (engineStartMs: number): void => {
      // The alert can be replaced or stopped while we wait for the engine.
      if (this.zoneRepo.get(zoneId) !== ctx || ctx.alert !== alert) {
        return;
      }
      if (alert.stopTimer) {
        clearTimeout(alert.stopTimer);
      }
      const leadMs = engineStartMs + preDelayMs + roomLagMs;
      const clampedMs = Math.min(leadMs + durationMs + ALERT_STOP_GUARD_MS, 2147483647);
      this.log.debug('alert stop window', {
        zoneId,
        engineStartMs,
        preDelayMs,
        roomLagMs,
        durationMs,
        stopInMs: clampedMs,
      });
      alert.stopTimer = setTimeout(() => {
        // Timer fires after we release the lock, so go through the public
        // path so a concurrent caller cannot race the auto-stop.
        void this.stopAlert(zoneId);
      }, clampedMs);
    };

    // Nothing measured yet: a clip the engine never gets a byte out of is silent anyway, so
    // assuming no start-up cost is the right way to be wrong about this one.
    arm(0);
    void this.playbackCoordinator
      .waitForFirstAudioMs(ctx, ALERT_FIRST_AUDIO_WAIT_MS)
      .then((engineStartMs) => {
        if (engineStartMs !== null) {
          arm(engineStartMs);
        }
      })
      .catch(() => {
        // Best-effort; the modelled window stands.
      });
  }

  /**
   * How long after `playUri` the alert's first sample actually reaches the room:
   * the silence the engine prepended to this very stream, plus the audio the output
   * is still holding. The silence is read off the running session rather than
   * re-derived, so it can never disagree with what is playing.
   *
   * `wasPlaying` decides whether the buffer matters at all. What the wait protects is
   * the *previous* source — a zone that was stopped or paused has nothing in flight to
   * be blasted, and making its bell wait would only risk the opposite fault.
   */
  private resolveAudibleLeadMs(
    ctx: ZoneContext,
    session: PlaybackSession | null,
    wasPlaying: boolean,
  ): number {
    const preDelayMs = resolveSessionPreDelayMs(session);
    if (!wasPlaying) {
      return preDelayMs > 0 ? Math.round(preDelayMs) : 0;
    }
    const total = preDelayMs + this.resolveOutputLagMs(ctx);
    return total > 0 ? Math.round(total) : 0;
  }

  /** How far behind the server this zone's room is; the coordinator owns the answer. */
  private resolveOutputLagMs(ctx: ZoneContext): number {
    try {
      const value = this.playbackCoordinator.getRoomLagMs(ctx);
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    } catch {
      // Best-effort; a failure here must not cost the alert its volume.
      return 0;
    }
  }

  /** Put the room at the announcement level, waiting `delayMs` for the alert to be audible. */
  private scheduleAlertVolume(
    ctx: ZoneContext,
    alert: NonNullable<ZoneContext['alert']>,
    volume: number,
    delayMs: number,
  ): void {
    const apply = (): void => {
      ctx.player.setVolume(volume);
      this.applyPatch(ctx.id, { volume });
    };

    if (delayMs <= 0) {
      apply();
      return;
    }

    const timer = setTimeout(() => {
      // The alert can end while we wait — a short clip, or a stop from the
      // Miniserver. Its restore has put the room back by then, and the level it
      // restored must not be overwritten with the announcement's.
      if (this.zoneRepo.get(ctx.id) !== ctx || ctx.alert !== alert) {
        return;
      }
      alert.volumeTimer = undefined;
      apply();
    }, Math.min(delayMs, 2147483647));
    timer.unref?.();
    alert.volumeTimer = timer;
  }

  /**
   * Try to play the alert as a native overlay on the zone's output(s). Mirrors MA's
   * native-vs-fallback announcement dispatch: only used when EVERY real output supports
   * native alerts (otherwise some output would miss the alert), and falls back on any
   * failure. Returns true when the alert was fully handled natively.
   */
  private async tryNativeAlert(
    zoneId: number,
    ctx: ZoneContext,
    type: string,
    media: AlertMediaResource,
    volume: number,
  ): Promise<boolean> {
    const realOutputs = ctx.outputs;
    if (realOutputs.length === 0) {
      return false;
    }
    const nativeOutputs = realOutputs.filter(
      (o): o is NativeAlertOutput =>
        typeof (o as Partial<NativeAlertOutput>).playNativeAlert === 'function',
    );
    if (nativeOutputs.length !== realOutputs.length) {
      // At least one output cannot overlay — use the engine-stream fallback for all of them.
      this.log.debug('alert has no native overlay; using the stream path', {
        zoneId,
        outputs: realOutputs.map((o) => o.type),
        nativeCount: nativeOutputs.length,
      });
      return false;
    }

    const url = this.resolveAlertHttpUrl(media);
    if (!url) {
      // The renderer fetches this URL itself, so a loopback address is no use to it: without a
      // LAN-reachable host configured there is nothing to hand over. Worth saying out loud —
      // the fallback is the path that has to stop the music, and a log that passes over the
      // choice in silence leaves no way to tell a deliberate fallback from a misconfigured one.
      this.log.debug('alert overlay has no reachable url; using the stream path', {
        zoneId,
        url: media.url,
        hasRelativePath: Boolean(media.relativePath),
      });
      return false;
    }
    const request: NativeAlertRequest = {
      url,
      volume: clampVolumeForZone(ctx.config, volume),
      title: media.title ?? type,
      type,
    };

    try {
      const results = await Promise.all(nativeOutputs.map((o) => o.playNativeAlert(request)));
      if (results.every((handled) => handled === true)) {
        this.log.debug('alert played as native overlay', { zoneId, type });
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('native alert failed; using fallback', { zoneId, message });
    }
    return false;
  }

  /**
   * Resolve an alert media resource to an absolute http(s) URL the renderer can fetch
   * directly. Custom/event alerts may already be absolute; alerts:// / alerts-loop://
   * resources are served as static files under /alerts on the audioserver. Returns null
   * when no LAN-reachable host is configured (the device could not fetch a loopback URL).
   */
  private resolveAlertHttpUrl(media: AlertMediaResource): string | null {
    if (/^https?:\/\//i.test(media.url)) {
      return media.url;
    }
    if (!media.relativePath) {
      return null;
    }
    const host = this.configPort.getSystemConfig().audioserver.ip?.trim();
    if (!host) {
      return null;
    }
    const baseUrl = buildBaseUrl({ host });
    const encoded = media.relativePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${baseUrl}/alerts/${encoded}`;
  }

  private resolveHandoffDrainMs(ctx: ZoneContext): number {
    const outputs = ctx.outputs ?? [];
    let max = 0;
    for (const output of outputs) {
      const fn = (output as { getAlertHandoffDrainMs?: () => number | null }).getAlertHandoffDrainMs;
      if (typeof fn !== 'function') continue;
      try {
        const value = fn.call(output);
        if (typeof value === 'number' && Number.isFinite(value) && value > max) {
          max = value;
        }
      } catch {
        // ignore; drain is best-effort
      }
    }
    return max;
  }

  private async stopAlertLocked(zoneId: number): Promise<void> {
    const ctx = this.zoneRepo.get(zoneId);
    const activeAlert = ctx?.alert;
    if (!ctx || !activeAlert) {
      return;
    }
    if (activeAlert.stopTimer) {
      clearTimeout(activeAlert.stopTimer);
    }
    if (activeAlert.volumeTimer) {
      clearTimeout(activeAlert.volumeTimer);
      activeAlert.volumeTimer = undefined;
    }
    this.zoneAudioPrefs.setTransientGainDb(zoneId, null);
    this.zoneAudioPrefs.setAlertPreDelayFloorMs(zoneId, null);
    ctx.alert = undefined;

    try {
      ctx.player.stop('alert_stop');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('alert stop failed to stop player cleanly', { zoneId, message });
    }

    // Wait for the renderer's own buffer to drain before swapping its transport URI.
    // Without this, outputs like Sonos clip the tail of short alerts because we push
    // the next SetAVTransportURI while ~1.5s of audio is still in their buffer.
    if (activeAlert.snapshot.mode === 'play') {
      const drainMs = this.resolveHandoffDrainMs(ctx);
      if (drainMs > 0) {
        this.log.debug('waiting for output drain before alert handoff', { zoneId, drainMs });
        await new Promise<void>((resolve) => setTimeout(resolve, drainMs));
      }
    }

    this.playbackCoordinator.setInputMode(ctx, activeAlert.snapshot.inputMode);
    ctx.activeOutput = activeAlert.snapshot.activeOutput;
    ctx.activeOutputTypes = new Set(activeAlert.snapshot.activeOutputTypes);
    ctx.queue.shuffle = activeAlert.snapshot.queue.shuffle;
    ctx.queue.repeat = activeAlert.snapshot.queue.repeat;
    ctx.queueController.setItems(
      activeAlert.snapshot.queue.items,
      activeAlert.snapshot.queue.currentIndex,
    );

    const restoreVolume = clampVolumeForZone(ctx.config, activeAlert.snapshot.volume);
    ctx.player.setVolume(restoreVolume);

    this.applyPatch(zoneId, {
      ...activeAlert.snapshot.statePatch,
      mode: activeAlert.snapshot.mode,
      clientState: 'on',
      power: 'on',
    });

    if (activeAlert.snapshot.mode === 'play') {
      const current = ctx.queueController.current();
      let resumed = false;
      if (current) {
        const resumeAtSecRaw = Number(activeAlert.snapshot.statePatch.time ?? 0);
        const resumeAtSec =
          Number.isFinite(resumeAtSecRaw) && resumeAtSecRaw > 0 ? Math.round(resumeAtSecRaw) : undefined;
        const session = await this.playbackCoordinator.startQueuePlayback(ctx, current.audiopath, {
          title: current.title,
          artist: current.artist,
          album: current.album,
          coverurl: current.coverurl,
          audiopath: current.audiopath,
          duration: current.duration,
          station: current.station,
          isRadio: this.audioHelpers.isRadioAudiopath(current.audiopath, current.audiotype),
        }, {
          startAtSec: resumeAtSec,
        });
        if (session) {
          resumed = true;
          const resumedAudiotype = this.audioHelpers.getStateAudiotype(ctx, current);
          const sourceName = this.audioHelpers.resolveSourceName(resumedAudiotype, ctx, current);
          this.applyPatch(zoneId, {
            title: current.title,
            artist: current.artist,
            album: current.album,
            coverurl: current.coverurl,
            audiopath: current.audiopath,
            station: current.station,
            qindex: ctx.queueController.currentIndex(),
            qid: current.unique_id,
            mode: 'play',
            clientState: 'on',
            power: 'on',
            ...(resumedAudiotype != null ? { audiotype: resumedAudiotype } : {}),
            type: this.audioHelpers.getStateFileType(),
            ...(sourceName ? { sourceName } : {}),
          });
        }
      }
      if (!resumed) {
        // Could not actually resume playback (empty queue or failed start).
        // Leaving the zone in the optimistic 'play' restored above would keep a
        // shared power-group relay energized with nothing playing (#293), so
        // fall back to a stopped state that releases the relay.
        this.log.debug('alert restore could not resume playback; settling to stop', { zoneId });
        this.applyPatch(zoneId, { mode: 'stop', clientState: 'on', power: 'on' });
      }
    } else if (activeAlert.snapshot.mode === 'pause') {
      this.applyPatch(zoneId, { mode: 'pause', clientState: 'on', power: 'on' });
    } else if (activeAlert.snapshot.mode === 'stop') {
      this.applyPatch(zoneId, { mode: 'stop', clientState: 'on', power: 'on' });
    }
  }

  private createAlertSnapshot(ctx: ZoneContext): AlertSnapshot {
    const queueClone = cloneQueueState(ctx.queue);
    return {
      mode: ctx.state.mode,
      inputMode: ctx.inputMode,
      activeOutput: ctx.activeOutput,
      activeOutputTypes: new Set(ctx.activeOutputTypes),
      volume: ctx.state.volume ?? 0,
      queue: queueClone,
      statePatch: {
        title: ctx.state.title,
        artist: ctx.state.artist,
        album: ctx.state.album,
        coverurl: ctx.state.coverurl,
        audiopath: ctx.state.audiopath,
        station: ctx.state.station,
        time: ctx.state.time,
        duration: ctx.state.duration,
        qindex: ctx.state.qindex,
        qid: ctx.state.qid,
        audiotype: ctx.state.audiotype,
        sourceName: ctx.state.sourceName,
        // An announcement is meant to be heard, so it raises the volume of a muted
        // zone like it raises a quiet one — and putting the flag back here is what
        // stops a doorbell from leaving the zone permanently unmuted.
        muted: ctx.state.muted,
      },
    };
  }

  private async waitForOutputReady(ctx: ZoneContext, timeoutMs = 2000): Promise<void> {
    const outputs = ctx.outputs;
    if (!outputs.length) {
      return;
    }
    const start = Date.now();
    const ready = (): boolean =>
      outputs.some((t) => {
        const maybe = (t as { isReady?: () => boolean }).isReady;
        if (typeof maybe === 'function') {
          try {
            return maybe.call(t) === true;
          } catch {
            return false;
          }
        }
        return true;
      });
    if (ready()) {
      return;
    }
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (ready() || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 50);
    });
  }
}
