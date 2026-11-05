import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import * as loader from '../src/adapters/outputs/googleCast/googlecastLoader';
import { GoogleCastOutput } from '../src/adapters/outputs/googleCast/googleCastOutput';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

/*
 * Issue #424: a Cast speaker that was powered off failed its first play with EHOSTUNREACH, and
 * every play after it, long after it was back, failed the same way within milliseconds. The
 * failed connect attempt was kept as the in-flight one and handed to every later play, so the
 * device was never dialled again. Each play after a failure must open a fresh connection.
 */

type Loader = { loadGoogleCastModule: typeof loader.loadGoogleCastModule };

function fakeDevice(): EventEmitter & Record<string, unknown> {
  const device = new EventEmitter() as EventEmitter & Record<string, unknown>;
  device.getSession = () => ({ appId: 'CC1AD845', transportId: 't' });
  device.media = {
    load: async () => ({ status: [{ mediaSessionId: 1 }] }),
    getStatusModel: async () => ({ playerState: 'PLAYING' }),
  };
  device.disconnect = async () => {};
  return device;
}

test('a cast output whose speaker was unreachable dials it again on the next play', async () => {
  const original = (loader as Loader).loadGoogleCastModule;
  let dials = 0;
  let reachable = false;
  (loader as Loader).loadGoogleCastModule = (async () => ({
    connect: async () => {
      dials += 1;
      if (!reachable) throw new Error('connect EHOSTUNREACH 10.0.0.9:8009');
      return fakeDevice();
    },
  })) as unknown as typeof loader.loadGoogleCastModule;
  try {
    const ports = {
      config: { getSystemConfig: () => ({ audioserver: { ip: '10.0.0.2' } }) },
    } as unknown as OutputPorts;
    const output = new GoogleCastOutput(2, 'Probe 2', { host: '10.0.0.9' }, ports);
    const session = {
      zoneId: 2,
      playbackSource: { kind: 'pipe' },
      stream: { url: '/streams/2/current.flac' },
      metadata: { title: 'x' },
    } as unknown as PlaybackSession;

    await assert.rejects(output.play(session), /EHOSTUNREACH/);
    await assert.rejects(output.play(session), /EHOSTUNREACH/);
    assert.equal(dials, 2, 'each play after a failure dials the speaker again');

    reachable = true;
    await output.play(session);
    assert.equal(dials, 3);
    assert.equal(output.isReady(), true);
  } finally {
    (loader as Loader).loadGoogleCastModule = original;
  }
});
