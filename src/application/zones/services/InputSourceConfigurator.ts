import type { InputsPort, AirplayController } from '@/ports/InputsPort';
import type { OutputRouter } from '@/application/zones/OutputRouter';
import type { PlaybackCoordinator } from '@/application/zones/PlaybackCoordinator';
import type { ZoneStateStore } from '@/application/zones/ZoneStateStore';
import type { ZoneRepository } from '@/application/zones/ZoneRepository';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { QueueItem } from '@/ports/types/queueTypes';
import { buildVolumePatch } from '@/application/zones/playback/patchBuilder';
import { mapSpotifyTracksToQueue } from '@/application/zones/state/spotifyQueueMirror';
import {
  clampVolumeForZone,
  getZoneDefaultVolume,
} from '@/application/zones/helpers/stateHelpers';

export type InputSourceConfiguratorDeps = {
  inputsPort: Pick<
    InputsPort,
    | 'configureAirplay'
    | 'configureDlna'
    | 'configureBluetooth'
    | 'configureSpotify'
    | 'setAirplayPlayerResolver'
    | 'stopAirplaySession'
  >;
  zoneRepo: Pick<ZoneRepository, 'get'>;
  playback: Pick<
    PlaybackCoordinator,
    | 'playInputSource'
    | 'stopInputSource'
    | 'pauseInputSource'
    | 'resumeInputSource'
    | 'updateInputMetadata'
    | 'updateInputCover'
    | 'updateInputVolume'
    | 'updateInputTiming'
    | 'setInputMode'
    | 'alignOutputFormat'
    | 'handleCommand'
  >;
  outputRouter: Pick<OutputRouter, 'dispatchVolume'>;
  stateStore: Pick<ZoneStateStore, 'applyPatch'>;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  updateQueue: (zoneId: number, items: QueueItem[], currentIndex: number) => void;
};

/**
 * Wires the AirPlay and Spotify Connect input controllers to the playback
 * coordinator. Idempotent: configure() is a no-op after the first call.
 *
 * AirPlay is a straight pass-through to playback-coordinator input methods.
 * Spotify Connect has authority gates (e.g. AirPlay blocks Connect take-over)
 * and dedicated volume handling that avoids feedback loops with the input.
 */
export class InputSourceConfigurator {
  private readonly deps: InputSourceConfiguratorDeps;
  private configured = false;

  constructor(deps: InputSourceConfiguratorDeps) {
    this.deps = deps;
  }

  public configure(): void {
    if (this.configured) {
      return;
    }
    this.configureAirplay();
    this.configureDlna();
    this.configureBluetooth();
    this.configureSpotify();
    this.deps.inputsPort.setAirplayPlayerResolver(
      (zoneId) => this.deps.zoneRepo.get(zoneId)?.player ?? null,
    );
    this.configured = true;
  }

  /**
   * The generic input controller: turns an input's callbacks into zone playback.
   * Shared by AirPlay, the DLNA renderer input and Bluetooth — none is protocol-specific.
   */
  private buildInputController(): AirplayController {
    const { playback } = this.deps;
    return {
      startPlayback: (zoneId, label, source, metadata) => {
        playback.playInputSource(zoneId, label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        playback.updateInputMetadata(zoneId, metadata);
      },
      updateCover: (zoneId, cover) => playback.updateInputCover(zoneId, cover),
      updateVolume: (zoneId, volume) => playback.updateInputVolume(zoneId, volume),
      updateTiming: (zoneId, elapsed, duration) => {
        playback.updateInputTiming(zoneId, elapsed, duration);
      },
      pausePlayback: (zoneId) => playback.pauseInputSource(zoneId),
      resumePlayback: (zoneId) => playback.resumeInputSource(zoneId),
      stopPlayback: (zoneId) => {
        playback.stopInputSource(zoneId);
      },
    };
  }

  private configureAirplay(): void {
    this.deps.inputsPort.configureAirplay(this.buildInputController());
  }

  private configureDlna(): void {
    this.deps.inputsPort.configureDlna(this.buildInputController());
  }

  private configureBluetooth(): void {
    this.deps.inputsPort.configureBluetooth(this.buildInputController());
  }

  private configureSpotify(): void {
    const { playback, zoneRepo, outputRouter, stateStore, applyPatch, updateQueue } = this.deps;
    this.deps.inputsPort.configureSpotify({
      startPlayback: (zoneId, label, source, metadata) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx) {
          return;
        }
        // Spotify Connect may take over from any active input. Regular Spotify
        // callbacks only proceed when Spotify already owns the zone.
        if (
          label !== 'spotify-connect' &&
          ctx.activeInput &&
          ctx.activeInput !== 'spotify'
        ) {
          return;
        }
        // Spotify Connect sessions use a dedicated label. Mark the zone as Connect-
        // controlled so resolveSourceName returns 'Spotify Connect' and
        // buildActiveItemPatch preserves the live-source audiotype (no shuffle/repeat).
        // Also set activeInput/inputMode so subsequent metadata callbacks are not
        // blocked by the ctx.activeInput !== 'spotify' guards.
        if (label === 'spotify-connect') {
          // Spotify Connect is the newly selected source. If AirPlay still owns
          // the zone, stop and restart its receiver so the sender is disconnected
          // and falls back to its local audio output.
          if (ctx.activeInput === 'airplay') {
            this.deps.inputsPort.stopAirplaySession(
              zoneId,
              'switch_to_spotify-connect',
            );
          }

          ctx.queue.authority = 'spotify';
          playback.setInputMode(ctx, 'spotify');
          // Sync zone volume to the Connect device immediately so it does not
          // start at the input's own default (100%).
          const initialVolume = ctx.state.volume ?? getZoneDefaultVolume(ctx.config);
          outputRouter.dispatchVolume(ctx, ctx.outputs, initialVolume);
        }
        // Align the engine to the sink's preferred format (e.g. a 48 kHz/24-bit sendspin
        // client) BEFORE the play. Both the Connect pipe (spotify-connect://) and the
        // direct stream-proxy (spotify:track:) start here; without this the engine starts
        // at the source's 44.1 kHz and either restarts mid-stream (Connect) or, on the
        // direct-pipe-passthrough path (resume after pause), never restarts and plays
        // 44.1 kHz into a 48 kHz client → noise.
        playback.alignOutputFormat(zoneId, metadata?.audiopath ?? label);
        ctx.spotifyAdapter.start(label, source, metadata);
      },
      updateMetadata: (zoneId, metadata) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.updateMetadata(metadata);
      },
      updateCover: (zoneId, cover) => {
        // Route through updateInputCover so current.coverurl in the queue item
        // is also updated. Without this, the next updateQueueFromOutput call
        // from Squeezelite would overwrite the coverurl with the stale empty
        // value from the queue item, wiping the cover immediately after it loads.
        return playback.updateInputCover(zoneId, cover);
      },
      updateVolume: (zoneId, volume) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        const level = clampVolumeForZone(ctx.config, volume);
        // Patch zone state so the Loxone UI reflects the change.
        // Do NOT route through player.setVolume: that triggers onPlayerVolume, and
        // the volume we are handling here came from the input in the first place —
        // sending it back would have it echo another event → infinite loop.
        stateStore.applyPatch(zoneId, buildVolumePatch(level));
        outputRouter.dispatchVolume(ctx, ctx.outputs, level);
      },
      // The Spotify app's slider on a backend that has not touched the audio, so this is an
      // ordinary volume request and travels the ordinary way: the zone's own volume, whichever
      // input mode it is in. Soloist plays through the engine like any queue source, so a zone
      // it is carrying is often not in spotify mode at all — the guard above would drop it.
      zoneVolume: (zoneId, level) => playback.updateInputVolume(zoneId, level),
      // Read straight off the zone, because a Connect daemon can sign in at any moment — at boot,
      // or after its process was replaced — and what the room is at by then is the room's own
      // business rather than something the input service kept a copy of.
      currentZoneVolume: (zoneId) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx) {
          return null;
        }
        return ctx.state.volume ?? getZoneDefaultVolume(ctx.config);
      },
      updateTiming: (zoneId, elapsed, duration) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.updateTiming(elapsed, duration);
      },
      pausePlayback: (zoneId) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.pause();
      },
      resumePlayback: (zoneId) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        ctx.spotifyAdapter.resume();
      },
      stopPlayback: (zoneId) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        // Clear track metadata before the player stops so the zone resets cleanly
        // instead of showing the last track's title/artist/cover in stopped state.
        applyPatch(zoneId, { title: '', artist: '', album: '', coverurl: '' });
        ctx.queue.authority = 'local';
        playback.setInputMode(ctx, null);
        ctx.spotifyAdapter.stop();
      },
      // Pressed on the phone, meant for this room: the same instruction the zone's own buttons
      // give, so it takes the same route and obeys the same queue.
      transport: (zoneId, command) => {
        playback.handleCommand(zoneId, command);
      },
      updateQueue: (zoneId, tracks, currentIndex) => {
        const ctx = zoneRepo.get(zoneId);
        if (!ctx || ctx.activeInput !== 'spotify') {
          return;
        }
        updateQueue(zoneId, mapSpotifyTracksToQueue(tracks, ctx.config?.name ?? ''), currentIndex);
      },
    });
  }
}
