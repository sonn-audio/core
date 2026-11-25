import type { QueueAuthority, ZoneContext } from '@/application/zones/internal/zoneTypes';
import { isQueueDrivenInput } from '@/application/zones/playback/guards';
import type { ExternalTransportCapabilities } from '@/application/zones/state/StateController';

/**
 * What the transport controls of a zone will actually do right now.
 *
 * Not a setting and not a promise about the source — a reading of `commandHandlers.ts`. Each
 * flag is false exactly where the handler for that command returns without doing anything, so
 * a client can grey out a button instead of offering one that is ignored. Keep the two in
 * step: a handler that learns to forward a command to a new input makes a flag here true.
 */
export type ZoneTransportCapabilities = {
  /** Next and previous. */
  skip: boolean;
  /** Jumping to a position in the track. */
  seek: boolean;
  shuffle: boolean;
  repeat: boolean;
};

export function zoneTransportCapabilities(
  zone: { inputMode: ZoneContext['inputMode']; queue: { authority?: QueueAuthority | null } },
  isLocalQueueAuthority: (authority: QueueAuthority | undefined | null) => boolean,
  /**
   * What the player that owns the zone right now will actually perform.
   *
   * Present only while the zone follows someone else. It then decides the mask on its own: the
   * local queue is not what is playing, so reading it would advertise controls the room has no
   * use for - and seeking, on this server, has historically meant "start our own copy of the
   * item" (see handlePosition), which replaces the session rather than moving it.
   */
  external?: ExternalTransportCapabilities | null,
): ZoneTransportCapabilities {
  if (external) {
    return {
      skip: external.skip,
      seek: external.seek,
      shuffle: external.shuffle,
      repeat: external.repeat,
    };
  }
  const mode = zone.inputMode;
  const queueDriven = isQueueDrivenInput(mode);
  const ownQueue = queueDriven && isLocalQueueAuthority(zone.queue.authority);
  return {
    // `handleQueueStep`: a line-in passes the step to its device, AirPlay and Music Assistant
    // to their sender, Spotify Connect to the app; a queue of our own is stepped here. Any
    // other input — Bluetooth, DLNA, a mixed group — has nobody to pass it to.
    skip:
      mode === 'linein' ||
      mode === 'airplay' ||
      mode === 'musicassistant' ||
      ownQueue ||
      (queueDriven && mode === 'spotify'),
    // `handlePosition`: only a queue-driven input is ever repositioned.
    seek: queueDriven,
    // `handleShuffle` / `handleRepeat` reorder and loop the queue we hold. When someone else
    // decides what plays next, that queue is a mirror and reordering it changes nothing.
    shuffle: ownQueue,
    repeat: ownQueue,
  };
}
