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

test('TV audio a soundbar reports as stopped is still a takeover (#430)', () => {
  // The reporter's soundbar showed its TV input as STOPPED while the TV played through it, so the
  // session went on and its next track took the speaker back.
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  report(speaker('PLAYBACK_STATE_IDLE', TV, { type: 'linein', name: 'TV Audio' }));
  assert.equal(takeovers.length, 1);
  assert.equal(takeovers[0]?.sourceName, 'TV Audio');
});

test('a line-in reported without a URL after our stream is a takeover (#430)', () => {
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  report(speaker('PLAYBACK_STATE_IDLE', '', { type: 'linein', name: 'TV Audio' }));
  assert.equal(takeovers.length, 1);
});

test('our own stream, under any URL of ours, is never a takeover (#430)', () => {
  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', OWN_TRACK_1));
  // The next track is a new URL on our own host; the SOAP path rewrites it to x-rincon-mp3radio.
  report(speaker('PLAYBACK_STATE_BUFFERING', OWN_TRACK_2));
  report(speaker('PLAYBACK_STATE_PLAYING', 'x-rincon-mp3radio://192.168.1.10:7090/streams/5/current.mp3'));
  // The playStreamUrl path is known by its container, whatever URL the speaker shows.
  report(speaker('PLAYBACK_STATE_PLAYING', 'https://cdn.example.com/x.mp3', { service: { name: 'sonn', id: 'sonn' } }));
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

test('a command Sonos refuses because the group moved is sent again after a reconnect (#430)', async () => {
  const { controller } = createController();
  const sent: string[] = [];
  controller.client = {
    player: {
      group: {
        stop: async () => {
          throw new Error('Command failed: groupCoordinatorChanged');
        },
      },
    },
  };
  controller.connect = async () => {
    controller.client = { player: { group: { stop: async () => void sent.push('stop') } } };
  };
  await controller.dispatchCommand('stop');
  assert.deepEqual(sent, ['stop']);

  // Once only: a group that keeps moving is not chased forever.
  let attempts = 0;
  const moving = () => ({
    player: {
      group: {
        stop: async () => {
          attempts += 1;
          throw new Error('Command failed: groupCoordinatorChanged');
        },
      },
    },
  });
  controller.client = moving();
  controller.connect = async () => {
    controller.client = moving();
  };
  await controller.dispatchCommand('stop');
  assert.equal(attempts, 2, 'the first try and one retry');
});

test('a following speaker is stopped in the group it is in now, not the one it was in (#430)', async () => {
  // The soundbar went to TV and Sonos made the speaker that followed it a group of its own,
  // still on our stream. Our view still had the old group, so the stop reached the soundbar.
  const { controller } = createController();
  const stopped: string[] = [];
  controller.client = {
    player: { isCoordinator: false, group: { stop: async () => void stopped.push('soundbar group') } },
  };
  controller.connect = async () => {
    controller.client = {
      player: { isCoordinator: true, group: { stop: async () => void stopped.push('own group') } },
    };
  };
  await controller.dispatchCommand('stop');
  assert.deepEqual(stopped, ['own group']);

  // A coordinator is stopped straight away.
  let reconnects = 0;
  controller.connect = async () => {
    reconnects += 1;
  };
  await controller.dispatchCommand('stop');
  assert.equal(reconnects, 0);
  assert.deepEqual(stopped, ['own group', 'own group']);
});

test('our stream is known by the service id or object id Sonos hands back (#430)', () => {
  // lars909's soundbar echoed our container's name but not `id.serviceId`, so our stream was
  // never recognised and TV audio never counted as a takeover.
  for (const container of [
    { name: 'Jessie', service: { name: 'sonn', id: 'sonn' } },
    { name: 'Jessie', id: { objectId: 'sonn:5:5-abc' } },
  ]) {
    const { takeovers, report } = createController();
    report(speaker('PLAYBACK_STATE_PLAYING', '', container));
    report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein.homeTheater.hdmi' }));
    assert.equal(takeovers.length, 1, JSON.stringify(container));
  }

  const { takeovers, report } = createController();
  report(speaker('PLAYBACK_STATE_PLAYING', '', { name: 'Jessie', id: { objectId: 'spotify:track:1' } }));
  report(speaker('PLAYBACK_STATE_PLAYING', TV, { type: 'linein.homeTheater.hdmi' }));
  assert.deepEqual(takeovers, [], 'a container of someone else is not ours');
});
