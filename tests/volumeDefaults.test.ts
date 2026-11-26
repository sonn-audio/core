import assert from 'node:assert/strict';
import { test } from './testHarness';
import { getZoneDefaultVolume } from '../src/application/zones/helpers/stateHelpers';
import {
  isVolumeOwnedByStateController,
  shouldUseStateControllerForCommand,
} from '../src/application/zones/state/authorityPolicies';
import { keepsSpeakerLevelOnStart } from '../src/application/zones/playback/playerListeners';
import type { ZoneConfig } from '../src/domain/config/types';

// Two defects in one path. The configuration writes -1 for "no default volume" and the API
// reports that -1 unchanged, but the helper read any number as a level and clamped it, so every
// zone resolved to 0. And a Sonos zone was not recognised as owning its own volume, so the
// startup path pushed that 0 to the speakers. Measured: all three speakers at 0 one second after
// a container start, twice in one evening.

function zone(volumes: Partial<ZoneConfig['volumes']>): ZoneConfig {
  return {
    id: 2,
    name: 'Wohnzimmer',
    volumes: {
      default: -1,
      alarm: 75,
      fire: 75,
      bell: 40,
      buzzer: 10,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
      ...volumes,
    },
  } as unknown as ZoneConfig;
}

test('a negative default volume means "not set", not silence', () => {
  const unset = getZoneDefaultVolume(zone({ default: -1 }));
  const absent = getZoneDefaultVolume(
    { id: 3, name: 'Ohne Default', volumes: undefined } as unknown as ZoneConfig,
  );

  assert.equal(unset, absent, 'the sentinel resolves exactly like an absent value');
  assert.ok(unset > 0, 'and that is a level, not mute');
});

test('an explicit default volume is still honoured, including an explicit zero', () => {
  assert.equal(getZoneDefaultVolume(zone({ default: 40 })), 40);
  assert.equal(getZoneDefaultVolume(zone({ default: 0 })), 0, 'zero stays the user choice');
});

test('the default is held to the zone maximum', () => {
  assert.equal(getZoneDefaultVolume(zone({ default: 90, maxVolume: 60 })), 60);
});

test('a Sonos zone owns its own volume', () => {
  assert.equal(isVolumeOwnedByStateController('sonos'), true);
  assert.equal(isVolumeOwnedByStateController('internal'), false);
  assert.equal(isVolumeOwnedByStateController('musicassistant'), true);
});

test('the Sonos policy does not hand commands to the controller during our own playback', () => {
  // The policy only says who owns the level. Command authority while this server is playing is
  // unchanged: the controller does not take a command away from a running local session.
  assert.equal(shouldUseStateControllerForCommand('sonos', true, 'volume'), false);
  assert.equal(shouldUseStateControllerForCommand('sonos', false, 'volume'), true);
});

test('a start keeps the room level when a speaker owns it and no default is configured', () => {
  const sonosUnset = { config: { state: { controller: 'sonos' }, volumes: { default: -1 } } } as any;
  const sonosConfigured = { config: { state: { controller: 'sonos' }, volumes: { default: 40 } } } as any;
  const internalUnset = { config: { state: { controller: 'internal' }, volumes: { default: -1 } } } as any;

  assert.equal(keepsSpeakerLevelOnStart(sonosUnset), true, 'the speaker level is the room level');
  assert.equal(keepsSpeakerLevelOnStart(sonosConfigured), false, 'a configured default applies');
  assert.equal(keepsSpeakerLevelOnStart(internalUnset), false, 'other zones keep their behaviour');
});
