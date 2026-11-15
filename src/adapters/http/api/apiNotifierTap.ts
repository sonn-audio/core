/**
 * Fans zone-state changes out to the public API without giving the API its own
 * source of truth.
 *
 * `notifyZoneStateChanged` is the one internal signal that a zone changed, and
 * the Loxone adapter is currently its only consumer. Rather than have the API
 * poll (or tap the Loxone connection registry, which would bind the public
 * contract to Loxone's frame format), this decorator sits in front of the real
 * notifier: the wrapped notifier keeps behaving exactly as before, and the hub
 * additionally receives the projected public payload.
 *
 * It is a decorator and not a second call site so that no future emit path can
 * forget to publish — anything that notifies Loxone notifies the API.
 */
import type { NotifierPort } from '@/ports/NotifierPort';
import type { ApiEvent } from '@/domain/zones/apiTypes';
import type { ApiEventHub } from '@/adapters/http/api/apiEventHub';
import type {
  ApiAudioFormat,
  ApiOutputCapabilities,
  ApiOutputSync,
  ApiPowerState,
  ApiVolumeLimits,
} from '@/domain/zones/apiTypes';
import type { ZoneSessionStats } from '@/application/zones/zoneSessionStats';
import {
  toApiZoneState,
  type OutputDeviceLookup,
  type OutputProtocolLookup,
  type ServiceLabelLookup,
  type InputLabelLookup,
} from '@/adapters/http/api/zoneProjection';

export function withApiEvents(
  inner: NotifierPort,
  hub: ApiEventHub,
  // Same lookup the request path uses, so an event carries the identical zone shape
  // a GET would — a client must not see `output.device` appear and disappear.
  lookups: {
    device?: OutputDeviceLookup;
    outputProtocol?: OutputProtocolLookup;
    outputCapabilities?: (zoneId: number) => ApiOutputCapabilities | null;
    outputSync?: (zoneId: number) => ApiOutputSync | null;
    group?: (zoneId: number) => { leader: number; members: number[] } | null;
    serviceLabel?: ServiceLabelLookup;
    inputLabel?: InputLabelLookup;
    streamFormat?: (zoneId: number) => ApiAudioFormat | null;
    volumeLimits?: (zoneId: number) => ApiVolumeLimits | undefined;
    powerState?: (zoneId: number) => ApiPowerState | null;
    /**
     * The session counters, observed here rather than in the projection.
     *
     * This decorator is the one place that sees *every* zone change; the projection below it runs
     * only while somebody is subscribed. Counting there would mean a house that nobody was watching
     * played its tracks uncounted, and the numbers would then depend on who had a browser open.
     */
    sessions?: ZoneSessionStats;
  } = {},
): NotifierPort {
  /**
   * Publishes to the hub without letting a failure reach the caller: the public API must
   * never be able to break Loxone delivery, which is why every publish here is guarded.
   */
  const publish = (event: ApiEvent): void => {
    if (hub.subscriberCount === 0) {
      return;
    }
    try {
      hub.publishCollectionChanged(event);
    } catch {
      /* a subscriber's failure is its own problem; the hub already drops it */
    }
  };

  return {
    notifyZoneStateChanged: (state) => {
      inner.notifyZoneStateChanged(state);
      /*
       * Guarded, like every other thing this decorator does.
       *
       * The file's own rule is that the public API must never be able to break the signal it is
       * tapping — and this block was the one place that ignored it. It runs on the hot path of every
       * playback transition and calls two lookups into the engine and the output; one throw there and
       * `notifyZoneStateChanged` fails, which means *starting a track* fails. Counters are the least
       * important thing on this path and must be the first to give way.
       */
      try {
        if (lookups.sessions) {
        const format = lookups.streamFormat?.(state.id) ?? null;
        const output = format?.output ?? null;
        const syncState = lookups.outputSync?.(state.id)?.state ?? null;
        lookups.sessions.observe(state.id, {
          playing: state.mode === 'play',
          stopped: state.mode === 'stop',
          // The audiopath *is* the track's identity here — the same string the rest of the server
          // resolves playback from. Title alone would merge two live-stream tracks with no metadata.
          trackKey: state.audiopath || state.title || '',
          formatKey: output
            ? `${output.codec}/${output.sampleRate}/${output.bitDepth ?? 0}/${output.channels}`
            : '',
          bitPerfect: format?.bitPerfect === true,
          synchronized: syncState === null ? null : syncState === 'synchronized',
        });
        }
      } catch {
        /* A counter that cannot be kept is a counter that goes unkept. */
      }
      // The public API must never be able to break Loxone delivery, so failures
      // here are contained rather than propagated to the caller.
      if (hub.subscriberCount > 0) {
        hub.publishZoneChanged(
          toApiZoneState(state, {
            device: lookups.device,
            outputProtocol: lookups.outputProtocol,
            outputCapabilities: lookups.outputCapabilities,
            outputSync: lookups.outputSync,
            group: lookups.group,
            serviceLabel: lookups.serviceLabel,
            inputLabel: lookups.inputLabel,
            streamFormat: lookups.streamFormat,
            volumeLimits: lookups.volumeLimits?.(state.id),
            powerState: lookups.powerState,
            session: (zoneId) => lookups.sessions?.get(zoneId) ?? null,
          }),
        );
      }
    },
    // These three were forwarded to Loxone and dropped here, so a client on our own API
    // could not tell that a queue, favourite or recents list had changed — including when
    // another client changed it. The Loxone protocol has carried them all along; the tap
    // simply passed them through without publishing.
    notifyQueueUpdated: (zoneId, queueSize) => {
      inner.notifyQueueUpdated(zoneId, queueSize);
      publish({ type: 'queue.changed', id: zoneId, size: queueSize });
    },
    notifyRoomFavoritesChanged: (zoneId, count) => {
      inner.notifyRoomFavoritesChanged(zoneId, count);
      publish({ type: 'favorites.changed', id: zoneId, count });
    },
    notifyRecentlyPlayedChanged: (zoneId, timestamp) => {
      inner.notifyRecentlyPlayedChanged(zoneId, timestamp);
      // The timestamp is Loxone's own change marker and says nothing a caller can use, so
      // only the zone travels: re-read the list.
      publish({ type: 'recents.changed', id: zoneId });
    },
    notifyRescan: (status, folders, files) => inner.notifyRescan(status, folders, files),
    notifyReloadMusicApp: (action, provider, userId) =>
      inner.notifyReloadMusicApp(action, provider, userId),
    notifyAudioSyncEvent: (payload) => inner.notifyAudioSyncEvent(payload),
    notifyPlaybackFailed: (zoneId, failure) => inner.notifyPlaybackFailed?.(zoneId, failure),
  };
}
