import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import { ExternalStateRouter } from '../src/application/zones/state/ExternalStateRouter';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { createLogger } from '../src/shared/logging/logger';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';
import type { ExternalTakeover } from '../src/application/zones/state/StateController';

// #430: a Sonos soundbar that switches itself to TV audio while it plays a Spotify session of ours.
// The session went on, and its next track was handed to the speaker again, taking it back from
// the TV. The speaker leaving our stream for a source of its own now ends the zone's session.

const configPort = { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any;
const OWN_TRACK_1 = 'http://192.168.1.10:7090/streams/5/current.mp3?prime=1';
const OWN_TRACK_2 = 'http://192.168.1.10:7090/streams/5/current.mp3?prime=2';
const TV = 'x-sonos-htastream:RINCON_000E58A0B1C201400:spdif';

function speaker(state: string, mediaUrl: string, container: Record<string, unknown> = {}) {
  return {
    playbackState: state,
    positionSeconds: 0,
    name: 'Wohnzimmer',
    playbackMetadataStatus: {
      container,
      currentItem: { track: { name: mediaUrl === TV ? '' : 'A track', mediaUrl } },
    },
  };
}

function createController() {
  const events: string[] = [];
  const takeovers: ExternalTakeover[] = [];
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' } as any } as any,
    configPort,
    onStatePatch: (_zoneId: number, patch: Partial<ZoneState>) => events.push(`patch:${patch.mode}`),
    onExternalTakeover: (_zoneId: number, takeover: ExternalTakeover) => {
      takeovers.push(takeover);
      events.push('takeover');
    },
  }) as any;
  const report = (group: unknown): void => {
    controller.client = { player: { group } };
    controller.emitSnapshotPatch();
  };
  return { controller, events, takeovers, report };
}

test('a sonos speaker that goes to TV audio while it plays our stream is a takeover (#430)', () => {
  const { events, takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein', name: 'TV' }));

  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.mediaUrl, TV);
  assert.equal(takeovers[0]?.sourceName, 'TV');
  assert.deepEqual(events, ['patch:play', 'takeover', 'patch:play'], 'the zone lets go before it shows the TV');

  // Reported once: the TV going on playing is the same takeover.
  report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein', name: 'TV' }));
  assert.equal(takeovers.length, 1);
});

test('our own stream, under any URL of ours, is never a takeover (#430)', () => {
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  // The next track is a new URL on our own host; the SOAP path rewrites it to x-rincon-mp3radio.
  report(speaker('PLAYBACK_STATE_BUFFERING', OWN_TRACK_2));
  report(speaker('PLAYBACK_STATE_PLAYING', 'x-rincon-mp3radio://192.168.1.10:7090/streams/5/current.mp3'));
  // The playStreamUrl path is known by its container, whatever URL the speaker shows.
  report(speaker('PLAYBACK_STATE_PLAYING', 'https://cdn.example.com/x.mp3', { id: { serviceId: 'sonn' } }));
  assert.deepEqual(takeovers, []);
});

test('a foreign source the speaker reports while our play switches it over is not a takeover (#430)', () => {
  const { takeovers, report } = createController();
  // The TV was on before anyone picked something in Loxone; our play() is mid-SOAP and the
  // speaker still reports it, then nothing for a moment while it loads ours.
  report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein' }));
  report(speaker('PLAYBACK_STATE_BUFFERING', ''));
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  assert.deepEqual(takeovers, []);

  // Between two of our tracks the speaker can show no URL at all; that is not a source either.
  report(speaker('PLAYBACK_STATE_BUFFERING', ''));
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_2));
  assert.deepEqual(takeovers, []);
});

test('our own pause coming back from the speaker is not a takeover (#430)', () => {
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  // Sonos drops a paused length-less stream and reports it STOPPED (#345).
  report(speaker('PLAYBACK_STATE_IDLE', OWN_TRACK_1));
  report(speaker('PLAYBACK_STATE_IDLE', ''));
  assert.deepEqual(takeovers, []);
});

test('a sonos speaker following a group coordinator is not a takeover (#430)', () => {
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  report(speaker('PLAYBACK_STATE_PLAYING', 'x-rincon:RINCON_000E58A0B1C201400'));
  assert.deepEqual(takeovers, []);
});

function createRouter(controller: string) {
  const zones = new ZoneRepository();
  zones.set(5, { id: 5, config: { state: { controller } } } as unknown as ZoneContext);
  const yielded: number[] = [];
  const applied: Array<Partial<ZoneState>> = [];
  let ownSession = true;
  const router = new ExternalStateRouter({
    zones,
    audioManager: {
      hasActiveLocalSession: () => ownSession,
      getSession: () => null,
      stopPlayback: () => null,
    },
    applyPatch: (_zoneId, patch) => applied.push(patch),
    notifyQueueUpdated: () => undefined,
    yieldToExternalSource: (zoneId) => {
      if (!ownSession) return false;
      ownSession = false;
      yielded.push(zoneId);
      return true;
    },
    log: createLogger('Test', 'ExternalStateRouter'),
  });
  return { router, yielded, applied };
}

test('a TV takeover during a local Spotify session ends the session before the TV shows (#430)', () => {
  const { router, yielded, applied } = createRouter('sonos');
  const sonos = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' } as any } as any,
    configPort,
    onStatePatch: (zoneId, patch) => router.onStatePatch(zoneId, patch),
    onExternalTakeover: (zoneId, takeover) => router.onExternalTakeover(zoneId, takeover),
  }) as any;
  const report = (group: unknown): void => {
    sonos.client = { player: { group } };
    sonos.emitSnapshotPatch();
  };

  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  assert.deepEqual(yielded, []);
  report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein', name: 'TV' }));
  assert.deepEqual(yielded, [5], 'the session is over, so its next track never reaches the speaker');
  assert.equal(applied.at(-1)?.mode, 'play');
  assert.equal(applied.at(-1)?.title, 'TV', 'the zone shows what the speaker plays now');
});

test('a takeover reaches only a zone that has something of its own to end (#430)', () => {
  const { router, yielded } = createRouter('sonos');
  router.onExternalTakeover(5, { mediaUrl: TV, sourceName: 'TV' });
  router.onExternalTakeover(5, { mediaUrl: TV, sourceName: 'TV' });
  assert.deepEqual(yielded, [5]);

  const internal = createRouter('internal');
  internal.router.onExternalTakeover(5, { mediaUrl: TV, sourceName: 'TV' });
  internal.router.onExternalTakeover(99, { mediaUrl: TV, sourceName: 'TV' });
  assert.deepEqual(internal.yielded, []);
});
