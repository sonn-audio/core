import type { AirplayInputService } from '@/adapters/inputs/airplay/airplayInputService';
import type { MusicAssistantInputService } from '@/adapters/inputs/musicassistant/musicAssistantInputService';
import type { SendspinLineInService } from '@/adapters/inputs/linein/sendspinLineInService';
import type { LineInActivationRegistry } from '@/adapters/inputs/linein/lineInActivationRegistry';
import type { LineInActivationService } from '@/application/inputs/lineInActivationService';
import type { SpotifyInputService } from '@/adapters/inputs/spotify/spotifyInputService';
import type { DlnaInputService } from '@/adapters/inputs/dlna/dlnaInputService';
import type { BluetoothInputService } from '@/adapters/inputs/bluetooth/bluetoothInputService';
import type { InputsPort } from '@/ports/InputsPort';

type AirplayController = Parameters<InputsPort['configureAirplay']>[0];
type SpotifyConnectController = Parameters<InputsPort['configureSpotify']>[0];
type AirplayResolver = Parameters<InputsPort['setAirplayPlayerResolver']>[0];

export type InputsAdapterDeps = {
  airplay: AirplayInputService;
  spotify: SpotifyInputService;
  musicAssistant: MusicAssistantInputService;
  sendspinLineIn: SendspinLineInService;
  lineInActivation: LineInActivationRegistry;
  /**
   * Resolved lazily: the activation service is constructed after this adapter, and
   * it owns whether an input is controllable — which decides whether releasing it
   * should also tell the hardware to stop.
   */
  lineInActivationService?: () => LineInActivationService | null;
  dlna: DlnaInputService;
  bluetooth: BluetoothInputService;
};

export class InputsAdapter implements InputsPort {
  constructor(private readonly deps: InputsAdapterDeps) {}

  public configureAirplay(controller: AirplayController): void {
    this.deps.airplay.configure(controller);
  }

  public setAirplayPlayerResolver(resolver: AirplayResolver): void {
    this.deps.airplay.setPlayerResolver(resolver);
  }

  public syncAirplayZones(...args: Parameters<InputsPort['syncAirplayZones']>): void {
    this.deps.airplay.syncZones(...args);
  }

  public renameAirplayZone(...args: Parameters<InputsPort['renameAirplayZone']>): Promise<void> {
    return this.deps.airplay.renameZone(...args);
  }

  public shutdownAirplay(): Promise<void> {
    return this.deps.airplay.shutdown();
  }

  public configureDlna(controller: AirplayController): void {
    this.deps.dlna.configure(controller);
  }

  public syncDlnaZones(...args: Parameters<InputsPort['syncDlnaZones']>): void {
    this.deps.dlna.syncZones(...args);
  }

  public shutdownDlna(): void {
    this.deps.dlna.shutdown();
  }

  public configureBluetooth(controller: AirplayController): void {
    this.deps.bluetooth.configure(controller);
  }

  public syncBluetoothZones(...args: Parameters<InputsPort['syncBluetoothZones']>): void {
    this.deps.bluetooth.syncZones(...args);
  }

  public shutdownBluetooth(): void {
    this.deps.bluetooth.shutdown();
  }

  public configureSpotify(controller: SpotifyConnectController): void {
    this.deps.spotify.configure(controller);
  }

  public syncSpotifyZones(...args: Parameters<InputsPort['syncSpotifyZones']>): void {
    this.deps.spotify.syncZones(...args);
  }

  public renameSpotifyZone(...args: Parameters<InputsPort['renameSpotifyZone']>): Promise<void> {
    return this.deps.spotify.renameZone(...args);
  }

  public shutdownSpotify(): Promise<void> {
    return this.deps.spotify.shutdown();
  }

  public configureMusicAssistant(
    handlers?: Parameters<InputsPort['configureMusicAssistant']>[0],
    switchAwayHandlers?: Parameters<InputsPort['configureMusicAssistant']>[1],
  ): void {
    this.deps.musicAssistant.configure(handlers, switchAwayHandlers);
  }

  public syncMusicAssistantZones(...args: Parameters<InputsPort['syncMusicAssistantZones']>): Promise<void> {
    return this.deps.musicAssistant.syncZones(...args);
  }

  public shutdownMusicAssistant(): void {
    this.deps.musicAssistant.shutdown();
  }

  public getMusicAssistantProviderId(): string {
    return this.deps.musicAssistant.getProviderId();
  }

  public startStreamForAudiopath(...args: Parameters<InputsPort['startStreamForAudiopath']>): ReturnType<InputsPort['startStreamForAudiopath']> {
    return this.deps.musicAssistant.startStreamForAudiopath(...args);
  }

  public getPlaybackSourceForUri(...args: Parameters<InputsPort['getPlaybackSourceForUri']>): ReturnType<InputsPort['getPlaybackSourceForUri']> {
    return this.deps.spotify.getPlaybackSourceForUri(...args);
  }

  public prefetchPlaybackSourceForUri(): ReturnType<InputsPort['prefetchPlaybackSourceForUri']> {
    return this.deps.spotify.prefetchPlaybackSourceForUri();
  }

  public getPlaybackSource(...args: Parameters<InputsPort['getPlaybackSource']>): ReturnType<InputsPort['getPlaybackSource']> {
    return this.deps.spotify.getPlaybackSource(...args);
  }

  public stopAirplaySession(...args: Parameters<InputsPort['stopAirplaySession']>): void {
    this.deps.airplay.stopActiveSession(...args);
  }

  public resumeAirplaySession(...args: Parameters<InputsPort['resumeAirplaySession']>): boolean {
    return this.deps.airplay.resumeSession(...args);
  }

  public stopSpotifySession(...args: Parameters<InputsPort['stopSpotifySession']>): void {
    this.deps.spotify.stopActiveSession(...args);
  }

  public switchAway(...args: Parameters<InputsPort['switchAway']>): ReturnType<InputsPort['switchAway']> {
    return this.deps.musicAssistant.switchAway(...args);
  }

  public remoteControl(...args: Parameters<InputsPort['remoteControl']>): void {
    this.deps.airplay.remoteControl(...args);
  }

  public remoteVolume(...args: Parameters<InputsPort['remoteVolume']>): void {
    this.deps.airplay.remoteVolume(...args);
  }

  public spotifyVolume(...args: Parameters<InputsPort['spotifyVolume']>): void {
    this.deps.spotify.setDeviceVolume(...args);
  }

  public async playerCommand(
    ...args: Parameters<InputsPort['playerCommand']>
  ): ReturnType<InputsPort['playerCommand']> {
    // Spotify first: when the app owns a zone's queue, only Spotify can step it, and asking Music
    // Assistant about a zone it does not have would answer for the wrong player.
    if (this.deps.spotify.playerCommand(args[0], args[1])) {
      return true;
    }
    return this.deps.musicAssistant.playerCommand(...args);
  }

  public requestLineInStop(...args: Parameters<InputsPort['requestLineInStop']>): void {
    // The service knows whether this source can be told to stop; when it is wired
    // up it owns the whole teardown so a controllable device does not keep playing
    // into a room that has moved on.
    const service = this.deps.lineInActivationService?.();
    if (service) {
      service.releaseLineIn(args[0]);
      return;
    }
    this.deps.sendspinLineIn.requestStop(...args);
    this.deps.lineInActivation.deactivate(args[0]);
  }

  /**
   * A line-in input is served by one of two transports: a sendspin client, which we can command
   * over its open connection, or a polling bridge, which picks up desired state on its next status
   * post. Both speak the same activate/deactivate vocabulary, so route to both rather than
   * assuming sendspin -- an unmapped input is a no-op there, and vice versa.
   */
  public requestLineInControl(...args: Parameters<InputsPort['requestLineInControl']>): void {
    const [inputId, command] = args;
    this.deps.sendspinLineIn.requestControl(inputId, command);
    if (command === 'activate') {
      this.deps.lineInActivation.activate(inputId);
    } else if (command === 'deactivate') {
      this.deps.lineInActivation.deactivate(inputId);
    } else {
      // Transport commands (play/pause/next/previous) go to the bridge's hook, which is where the
      // knowledge of how to drive the attached hardware lives. activate/deactivate are already
      // expressed as the start/stop the bridge derives from source_active, so they are not queued
      // twice.
      //
      // An input marked uncontrollable gets nothing: queueing for a turntable would
      // leave the command sitting until some later selection drained it.
      const service = this.deps.lineInActivationService?.();
      if (service) {
        service.sendCommandIfControllable(inputId, command);
        return;
      }
      this.deps.lineInActivation.enqueueCommand(inputId, command);
    }
  }

}

export function createInputsAdapter(deps: InputsAdapterDeps): InputsAdapter {
  return new InputsAdapter(deps);
}
