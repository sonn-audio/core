import assert from 'node:assert/strict';
import type { AudioManager } from '../src/application/playback/audioManager';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import { ExternalStateRouter } from '../src/application/zones/state/ExternalStateRouter';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { ZoneStateStore } from '../src/application/zones/ZoneStateStore';
import { applyZonePatch } from '../src/domain/zones/reducer';
import { createLogger } from '../src/shared/logging/logger';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ZoneState } from '../src/domain/zones/zoneState';

// A Sonos speaker reports its own volume — from the Sonos app, its touch controls, a remote —
// through the state controller the zone already listens to. Nothing adopted it, so the zone (and
// therefore Loxone) kept showing the last level sonn had sent, while the speaker played at
// another. These pin the adoption, its shape for mute, and that it never writes back.

const configPort = { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any;

const TRACK = {
  container: { name: 'Spotify', type: 'trackList', service: { name: 'Sonos', id: '9' } },
  currentItem: {
    track: {
      name: 'A track',
      mediaUrl: 'x-sonos-spotify:spotify:track:1',
      artist: { name: 'An artist' },
    },
  },
};

type VolumeSource = {
  /** S2: `player.volumeLevel` / `player.volumeMuted`. */
  playerVolume?: number;
  playerMuted?: boolean;
  /** S1: `group.volume` / `group.muted`. */
  groupVolume?: number;
  groupMuted?: boolean;
};

function createController(
  volumes: { maxVolume: number; volstep: number } = { maxVolume: 100, volstep: 1 },
) {
  const patches: Array<Partial<ZoneState>> = [];
  const outbound: string[] = [];
  const controller = new SonosStateController({
    zone: {
      id: 5,
      name: 'Wohnzimmer',
      output: { host: '192.168.20.34' },
      volumes,
    } as unknown as ZoneConfig,
    configPort,
    onStatePatch: (_zoneId: number, patch: Partial<ZoneState>) => patches.push(patch),
  }) as any;

  const report = (source: VolumeSource, playbackState = 'PLAYBACK_STATE_PLAYING'): void => {
    const player: any = {
      group: {
        playbackState,
        positionSeconds: 0,
        name: 'Wohnzimmer',
        playbackMetadataStatus: TRACK,
        setVolume: async () => void outbound.push('group.setVolume'),
      },
      setVolume: async () => void outbound.push('player.setVolume'),
    };
    if (typeof source.playerVolume === 'number') player.volumeLevel = source.playerVolume;
    if (typeof source.playerMuted === 'boolean') player.volumeMuted = source.playerMuted;
    if (typeof source.groupVolume === 'number') player.group.volume = source.groupVolume;
    if (typeof source.groupMuted === 'boolean') player.group.muted = source.groupMuted;
    controller.client = { player };
    controller.emitSnapshotPatch();
  };

  const lastPatch = (): Partial<ZoneState> => patches[patches.length - 1] ?? {};
  return { controller, patches, outbound, report, lastPatch };
}

test('a volume change made in the Sonos app reaches the zone', () => {
  const { report, lastPatch } = createController();
  report({ playerVolume: 42 });
  assert.equal(lastPatch().volume, 42, 'the zone shows the level the speaker is at');
});

test('the zone keeps the level of a speaker that has not reported one yet', () => {
  const { report, lastPatch } = createController();
  // No volume in the model yet: the first snapshot must not read that as silence.
  report({});
  assert.equal('volume' in lastPatch(), false);
  assert.equal('muted' in lastPatch(), false);
});

test('a malformed level is not adopted', () => {
  for (const level of [Number.NaN, Number.POSITIVE_INFINITY, -5, 101]) {
    const { report, lastPatch } = createController();
    report({ playerVolume: level });
    assert.equal('volume' in lastPatch(), false, `level ${level} is outside what the speaker may report`);
  }
});

test('a level above the zone maximum is held to it', () => {
  // The zone's limit governs what this server sends; the speaker's own knob is still reported
  // through the zone, but never above the configured maximum.
  const { report, lastPatch } = createController({ maxVolume: 60, volstep: 5 });
  report({ playerVolume: 80 });
  assert.equal(lastPatch().volume, 60);
});

test('a speaker reported as muted silences the zone and keeps its restore level', () => {
  const { report, lastPatch } = createController();
  report({ playerVolume: 31, playerMuted: true });
  assert.equal(lastPatch().volume, 0);
  assert.equal(lastPatch().muted, true);

  // An unmute is just a level again — the reducer is what clears the flag, so the patch does
  // not have to claim anything about mute it cannot know.
  report({ playerVolume: 31, playerMuted: false });
  assert.equal(lastPatch().volume, 31);
  assert.equal('muted' in lastPatch(), false);

  const muted = applyZonePatch(
    { volume: 0, muted: true } as ZoneState,
    lastPatch(),
  );
  assert.equal(muted.muted, false, 'a zone that is audible is not muted');
});

test('a muted speaker never clears a mute the zone set itself', () => {
  // Loxone muted the zone by writing volume 0; the speaker echoes that as level 0 with no mute,
  // which must not flip the zone back to "unmuted at zero".
  const { report, lastPatch } = createController();
  report({ playerVolume: 0, playerMuted: false });
  const next = applyZonePatch({ volume: 0, muted: true } as ZoneState, lastPatch());
  assert.equal(next.muted, true);
});

test('an S1 speaker reports its level on the group', () => {
  const { report, lastPatch } = createController();
  report({ groupVolume: 45 });
  assert.equal(lastPatch().volume, 45);

  report({ groupVolume: 45, groupMuted: true });
  assert.equal(lastPatch().volume, 0);
  assert.equal(lastPatch().muted, true);
});

test('adopting a level never writes it back to the speaker', async () => {
  const { outbound, report, lastPatch } = createController();
  // A burst, as a finger on the app's slider produces, and then the settled value.
  report({ playerVolume: 20 });
  report({ playerVolume: 60 });
  report({ playerVolume: 45 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(outbound, [], 'the state controller only reports state; the output owns the volume');
  assert.equal(lastPatch().volume, 45, 'the last level the speaker reported wins');
});

test('a connection starts the zone at the level the speaker has', () => {
  // connect() emits a snapshot as soon as the client is up and again on the CONNECTED event, so
  // the first patch after a (re)connect carries the speaker's level.
  const { report, lastPatch } = createController();
  report({ playerVolume: 17 }, 'PLAYBACK_STATE_IDLE');
  assert.equal(lastPatch().volume, 17);
  report({ playerVolume: 17 }, 'PLAYBACK_STATE_IDLE');
  assert.equal(lastPatch().volume, 17);
});

/**
 * The whole path a level takes in the running server: state controller → external state router →
 * zone state store → the notifier the Loxone clients listen to.
 */
function buildZonePath(options: { controller: string; ownSession: boolean }) {
  const zones = new ZoneRepository();
  const broadcasts: ZoneState[] = [];
  const ctx = {
    id: 5,
    config: { id: 5, name: 'Wohnzimmer', state: { controller: options.controller } },
    state: {
      id: 5,
      name: 'Wohnzimmer',
      album: '',
      artist: '',
      audiopath: '',
      audiotype: 0,
      clientState: 'on',
      coverurl: '',
      duration: 0,
      eq: [],
      mode: 'stop',
      plrepeat: 0,
      plshuffle: 0,
      power: 'on',
      qindex: 0,
      sourceName: '',
      station: '',
      time: 0,
      title: '',
      muted: false,
      type: 3,
      volume: 20,
    } as unknown as ZoneState,
    metadata: {},
    lastZoneBroadcastAt: 0,
    outputs: [],
    activeOutput: null,
    inputMode: null,
    activeInput: null,
  } as unknown as ZoneContext;
  zones.set(5, ctx);

  const store = new ZoneStateStore(zones, {
    isRadioAudiopath: () => false,
    isLineInAudiopath: () => false,
    syncGroupMembersPatch: () => undefined,
    onStatePatch: () => undefined,
    notifyOutputMetadata: () => undefined,
    notifier: {
      notifyZoneStateChanged: (state) => broadcasts.push(state),
      notifyQueueUpdated: () => undefined,
      notifyRoomFavoritesChanged: () => undefined,
      notifyRecentlyPlayedChanged: () => undefined,
      notifyRescan: () => undefined,
      notifyReloadMusicApp: () => undefined,
      notifyAudioSyncEvent: () => undefined,
    },
    audioManager: {
      getSession: () => null,
      updateSessionTiming: () => undefined,
      updateSessionMetadata: () => null,
    } satisfies Pick<
      AudioManager,
      'getSession' | 'updateSessionTiming' | 'updateSessionMetadata'
    > as unknown as AudioManager,
  });

  const router = new ExternalStateRouter({
    zones,
    audioManager: {
      hasActiveLocalSession: () => options.ownSession,
      getSession: () => null,
      stopPlayback: () => null,
    },
    applyPatch: (zoneId, patch, force) => store.applyPatch(zoneId, patch, force),
    notifyQueueUpdated: () => undefined,
    yieldToExternalSource: () => false,
    log: createLogger('Test', 'ExternalStateRouter'),
  });

  return { store, router, broadcasts, state: () => ctx.state };
}

function withController(
  path: ReturnType<typeof buildZonePath>,
): (source: VolumeSource) => void {
  const controller = new SonosStateController({
    zone: {
      id: 5,
      name: 'Wohnzimmer',
      output: { host: '192.168.20.34' },
      volumes: { maxVolume: 100, volstep: 1 },
    } as unknown as ZoneConfig,
    configPort,
    onStatePatch: (zoneId, patch) => path.router.onStatePatch(zoneId, patch),
  }) as any;
  return (source: VolumeSource): void => {
    const player: any = {
      group: {
        playbackState: 'PLAYBACK_STATE_PLAYING',
        positionSeconds: 0,
        name: 'Wohnzimmer',
        playbackMetadataStatus: TRACK,
      },
    };
    if (typeof source.playerVolume === 'number') player.volumeLevel = source.playerVolume;
    if (typeof source.playerMuted === 'boolean') player.volumeMuted = source.playerMuted;
    controller.client = { player };
    controller.emitSnapshotPatch();
  };
}

test('an external level reaches the zone notifier while our own stream plays', () => {
  // The speaker is playing our stream, so ExternalStateRouter keeps time/duration local — but
  // the level is the speaker's, and Loxone has to see it.
  const path = buildZonePath({ controller: 'sonos', ownSession: true });
  const report = withController(path);
  report({ playerVolume: 47 });

  assert.equal(path.broadcasts.at(-1)?.volume, 47);
  assert.equal(path.broadcasts.at(-1)?.time, 0, 'the local ticker still owns the position');
});
