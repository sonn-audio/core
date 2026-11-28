import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  resolveZoneStateControllerId,
  shouldUseStateControllerForCommand,
  isVolumeOwnedByStateController,
} from '../src/application/zones/state/authorityPolicies';
import type { ZoneConfig } from '../src/domain/config/types';

function zoneWith(controller?: string): ZoneConfig {
  return { id: 1, state: controller !== undefined ? { controller } : undefined } as ZoneConfig;
}

// ---- resolveZoneStateControllerId ----

test('resolveZoneStateControllerId returns "internal" when controller is unset', () => {
  assert.equal(resolveZoneStateControllerId({ id: 1 } as ZoneConfig), 'internal');
  assert.equal(resolveZoneStateControllerId(zoneWith('')), 'internal');
  assert.equal(resolveZoneStateControllerId(zoneWith('   ')), 'internal');
  assert.equal(resolveZoneStateControllerId(zoneWith('internal')), 'internal');
});

test('resolveZoneStateControllerId normalizes known controller aliases', () => {
  assert.equal(resolveZoneStateControllerId(zoneWith('beolink')), 'beolink');
  assert.equal(resolveZoneStateControllerId(zoneWith('BeoLink')), 'beolink');
  assert.equal(resolveZoneStateControllerId(zoneWith('beo-link')), 'beolink');
  assert.equal(resolveZoneStateControllerId(zoneWith('sonos')), 'sonos');
  assert.equal(resolveZoneStateControllerId(zoneWith('Music Assistant')), 'musicassistant');
  assert.equal(resolveZoneStateControllerId(zoneWith('musicassistant')), 'musicassistant');
  assert.equal(resolveZoneStateControllerId(zoneWith('MA')), 'musicassistant');
  assert.equal(resolveZoneStateControllerId(zoneWith('ma')), 'musicassistant');
});

test('resolveZoneStateControllerId preserves unknown controller ids verbatim (lowercased)', () => {
  assert.equal(resolveZoneStateControllerId(zoneWith('homepod')), 'homepod');
  assert.equal(resolveZoneStateControllerId(zoneWith('Custom123')), 'custom123');
});

// ---- shouldUseStateControllerForCommand ----

test('shouldUseStateControllerForCommand returns false for internal controller', () => {
  assert.equal(shouldUseStateControllerForCommand('internal', false, 'play'), false);
  assert.equal(shouldUseStateControllerForCommand('internal', true, 'volume'), false);
});

test('shouldUseStateControllerForCommand routes all commands to external controller when no local session', () => {
  assert.equal(shouldUseStateControllerForCommand('beolink', false, 'play'), true);
  assert.equal(shouldUseStateControllerForCommand('beolink', false, 'volume'), true);
  assert.equal(shouldUseStateControllerForCommand('musicassistant', false, 'next'), true);
});

test('shouldUseStateControllerForCommand: beolink with active local session only owns volume commands', () => {
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'volume'), true);
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'volume_set'), true);
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'VOLUME'), true);
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'play'), false);
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'next'), false);
  assert.equal(shouldUseStateControllerForCommand('beolink', true, 'stop'), false);
});

test('shouldUseStateControllerForCommand: musicassistant with active local session owns everything', () => {
  assert.equal(shouldUseStateControllerForCommand('musicassistant', true, 'play'), true);
  assert.equal(shouldUseStateControllerForCommand('musicassistant', true, 'volume'), true);
  assert.equal(shouldUseStateControllerForCommand('musicassistant', true, 'next'), true);
});

test('shouldUseStateControllerForCommand: unknown controller with active session yields false (no policy)', () => {
  assert.equal(shouldUseStateControllerForCommand('homepod', true, 'volume'), false);
});

// ---- isVolumeOwnedByStateController ----

test('isVolumeOwnedByStateController: internal does not own volume', () => {
  assert.equal(isVolumeOwnedByStateController('internal'), false);
});

test('isVolumeOwnedByStateController: beolink, musicassistant and sonos own volume', () => {
  assert.equal(isVolumeOwnedByStateController('beolink'), true);
  assert.equal(isVolumeOwnedByStateController('musicassistant'), true);
  // A restart does not push a level to a Sonos speaker (#458).
  assert.equal(isVolumeOwnedByStateController('sonos'), true);
});

test('isVolumeOwnedByStateController: unknown controllers do not own volume', () => {
  assert.equal(isVolumeOwnedByStateController('homepod'), false);
});
