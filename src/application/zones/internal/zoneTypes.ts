import type { ZoneConfig } from '@/domain/config/types';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { PlaybackQueueNavigator } from '@/application/playback/PlaybackQueueNavigator';
import type { InputAdapter } from '@/application/playback/inputAdapter';
import type { SpotifyInputAdapter } from '@/application/playback/adapters/SpotifyInputAdapter';
import type { ZoneOutput } from '@/ports/OutputsTypes';
import type { ZonePlayer } from '@/application/playback/zonePlayer';
import type { QueueItem } from '@/ports/types/queueTypes';

export type { QueueItem } from '@/ports/types/queueTypes';

export type QueueAuthority =
  | 'local'
  | 'spotify'
  | 'musicassistant'
  | 'applemusic'
  | 'deezer'
  | 'tidal'
  | 'ytmusic'
  | 'youtube'
  | 'soundcloud'
  | 'airplay'
  | `external:${string}`;

export interface QueueState {
  items: QueueItem[];
  shuffle: boolean;
  repeat: number;
  currentIndex: number;
  authority: QueueAuthority;
}

export interface AlertSnapshot {
  mode: ZoneState['mode'];
  inputMode: ZoneContext['inputMode'];
  activeOutput: string | null;
  activeOutputTypes: Set<string>;
  volume: number;
  queue: QueueState;
  statePatch: Partial<ZoneState>;
}

export interface ActiveAlertState {
  type: string;
  title: string;
  url: string;
  /**
   * Duration (seconds) to expose to Loxone clients for progress/UI.
   * This is intentionally separate from `durationMs`, which may include stop margins.
   */
  reportedDurationSec?: number;
  durationMs?: number;
  stopTimer?: NodeJS.Timeout;
  /**
   * Pending announcement-volume change, waiting for the alert's first audible
   * sample. The room only reaches the alert level once the output has played
   * out what it still had buffered, and that buffer holds the previous source.
   */
  volumeTimer?: NodeJS.Timeout;
  snapshot: AlertSnapshot;
}

export interface ZoneContext {
  id: number;
  name: string;
  sourceMac: string;
  config: ZoneConfig;
  state: ZoneState;
  queue: QueueState;
  queueController: PlaybackQueueNavigator;
  inputAdapter: InputAdapter;
  spotifyAdapter: SpotifyInputAdapter;
  metadata: Record<string, unknown>;
  outputs: ZoneOutput[];
  player: ZonePlayer;
  outputTimingActive: boolean;
  /**
   * How far this zone's room is behind the server, in ms, measured from what the
   * output last reported about its own playback position.
   *
   * Only some outputs can state a buffer figure up front, so the ones that report
   * where they are are asked the same question the other way round: the gap between
   * the server's clock and theirs is the audio still in flight. Undefined until an
   * output has said something recent enough to trust.
   */
  outputPlayoutLagMs?: number;
  /** When `outputPlayoutLagMs` was last measured (epoch ms). */
  outputPlayoutLagAt?: number;
  lastOutputTimingAt: number;
  /**
   * Throttle zone state broadcasts so Loxone clients aren't hammered.
   */
  lastZoneBroadcastAt: number;
  /**
   * Throttle player position updates to keep state/metadata churn reasonable.
   */
  lastPositionUpdateAt: number;
  lastPositionValue: number;
  lastPlaybackErrorAt: number;
  lastPlaybackErrorReason?: string;
  /**
   * The level to hand back when this zone is unmuted. Runtime bookkeeping rather
   * than state: no consumer needs it, and after a restart a zone comes up unmuted
   * anyway. Absent when the zone was already silent when it was muted, in which
   * case unmute goes to the configured default instead of back to silence.
   */
  volumeBeforeMute?: number;
  activeOutputTypes: Set<string>;
  /**
   * Single-output slot for the zone; only this output should receive play/pause/stop/metadata/volume.
   */
  activeOutput: string | null;
  activeInput: string | null;
  /**
   * Throttle metadata dispatch so outputs do not get spammed with time-only updates.
   */
  lastMetadataDispatchAt: number;
  /**
   * Explicit input mode so commands/volume can be gated consistently.
   * queue: local queue/streams, spotify: Spotify Connect, airplay: AirPlay input,
   * musicassistant: MA stream proxy, linein: PCM ingest input, bluetooth: a phone in the room
   */
  inputMode:
    | 'queue'
    | 'spotify'
    | 'airplay'
    | 'musicassistant'
    | 'linein'
    | 'dlna'
    | 'bluetooth'
    | 'mixedgroup'
    | 'alert'
    | null;
  alert?: ActiveAlertState;
  /**
   * Pending pause-time volume reset (resetVolumeOnPause). Held long enough
   * that the receiver buffer has drained and any pre-play volume adjustment
   * gets a chance to override it; cancelled on play/resume/stop and on user
   * volume changes during the window.
   */
  resetVolumeTimer?: NodeJS.Timeout;
  /**
   * Is the zone's own player between a start and a stop?
   *
   * The zone *state* cannot answer this: an output that runs dry echoes STOPPED back into
   * `state.mode`, so a zone stepping from one queue track to the next reads as stopped for as long
   * as the gap lasts. This flag follows the player instead — `ZonePlayer.stop()` is the only thing
   * that clears it, and a queue advance never calls it — so a start can tell "the zone was off"
   * apart from "the previous track just finished" (#322).
   *
   * Undefined on a zone that has not played yet, which is a cold start and is treated as one.
   */
  playerActive?: boolean;

  /**
   * Start the next playback at the level the zone already carries, not at the zone default.
   *
   * Set when a volume step is what started the zone: the listener pressed a volume button, so
   * discarding that press and snapping to the default is the one thing the start must not do.
   * One-shot -- `onPlayerStarted` consumes it -- so it cannot leak into the next cold start.
   */
  startAtCurrentVolume?: boolean;
}
