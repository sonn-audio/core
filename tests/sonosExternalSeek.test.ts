import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import type { ZoneConfig } from '../src/domain/config/types';

// A seek in Loxone while the Sonos speaker plays something of its own (Spotify from the app,
// Alexa) went to the local queue and started sonn's own playback, replacing the speaker's
// session (#451). It now goes to the speaker, and shuffle and repeat stay away from the queue.

function speaker(actions: Record<string, boolean> | null) {
  const seeks: number[] = [];
  const controller = new SonosStateController({
    zone: { id: 5, name: 'Wohnzimmer', output: { host: '192.168.20.34' } } as unknown as ZoneConfig,
    configPort: { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any,
    onStatePatch: () => {},
  }) as any;
  const group: any = { playbackState: 'PLAYBACK_STATE_PLAYING', positionSeconds: 10 };
  if (actions) {
    group.playbackActionsWrapper = { raw: actions };
    group.seek = async (ms: number) => void seeks.push(ms);
  }
  controller.client = { player: { group } };
  return { controller, seeks };
}

test('a seek during the speaker\'s own playback goes to the speaker (#451)', () => {
  const { controller, seeks } = speaker({ canSeek: true, canSkip: true });
  assert.equal(controller.handleCommand('position', '95'), true, 'taken, not handed to the queue');
  assert.deepEqual(seeks, [95_000]);
});

test('a seek the speaker cannot do, or a read, is taken and does nothing', () => {
  const cannot = speaker({ canSeek: false });
  assert.equal(cannot.controller.handleCommand('position', '95'), true);
  assert.deepEqual(cannot.seeks, []);
  const read = speaker({ canSeek: true });
  assert.equal(read.controller.handleCommand('position', ''), true);
  assert.deepEqual(read.seeks, []);
  const s1 = speaker(null);
  assert.equal(s1.controller.handleCommand('position', '95'), true);
});

test('shuffle and repeat do not reach the local queue during the speaker\'s own playback', () => {
  const { controller } = speaker({ canSeek: true });
  assert.equal(controller.handleCommand('shuffle', '1'), true);
  assert.equal(controller.handleCommand('repeat', '1'), true);
});

test('the controls offered follow what the speaker can do', () => {
  assert.deepEqual(speaker({ canSeek: true, canSkip: true }).controller.getTransportCapabilities(), {
    skip: true,
    seek: true,
    shuffle: false,
    repeat: false,
  });
  assert.deepEqual(speaker({ canSeek: false, canSkip: false }).controller.getTransportCapabilities(), {
    skip: false,
    seek: false,
    shuffle: false,
    repeat: false,
  });
  assert.equal(speaker(null).controller.getTransportCapabilities().skip, true, 'S1 cannot say, but skips');
});
