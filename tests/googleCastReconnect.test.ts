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

// Stopping the media left our receiver app running, and a running app is a device still being
// cast to: a television stayed on its cast screen and the device showed as in use.
async function stoppedCastOutput(frontAppId: string) {
  const original = (loader as Loader).loadGoogleCastModule;
  const calls: string[] = [];
  const device = fakeDevice();
  (device.media as Record<string, unknown>).stopCurrent = async () => {};
  device.launchApp = async () => {
    calls.push('launch');
    return { appId: 'CC1AD845', transportId: 't', sessionId: 's1' };
  };
  device.receiver = {
    getSessions: async () => [{ appId: frontAppId, sessionId: 's1', transportId: 't' }],
    stop: async (sessionId: string) => {
      calls.push(`stop:${sessionId}`);
    },
  };
  (loader as Loader).loadGoogleCastModule = (async () => ({
    connect: async () => device,
  })) as unknown as typeof loader.loadGoogleCastModule;
  const ports = {
    config: { getSystemConfig: () => ({ audioserver: { ip: '10.0.0.2' } }) },
  } as unknown as OutputPorts;
  const output = new GoogleCastOutput(2, 'Probe 2', { host: '10.0.0.9' }, ports);
  (output as unknown as { receiverReleaseDelayMs: number }).receiverReleaseDelayMs = 5;
  const session = {
    zoneId: 2,
    playbackSource: { kind: 'pipe' },
    stream: { url: '/streams/2/current.flac' },
    metadata: { title: 'x' },
  } as unknown as PlaybackSession;
  const wait = () => new Promise((resolve) => setTimeout(resolve, 40));
  const restore = () => {
    (loader as Loader).loadGoogleCastModule = original;
  };
  return { output, session, calls, wait, restore };
}

test('a stopped cast device gets its receiver app closed, and the next play launches it again', async () => {
  const { output, session, calls, wait, restore } = await stoppedCastOutput('CC1AD845');
  try {
    await output.play(session);
    await output.stop(session);
    await wait();
    assert.deepEqual(calls, ['stop:s1']);
    await output.play(session);
    assert.deepEqual(calls, ['stop:s1', 'launch'], 'the app is gone, so it is launched before loading');
  } finally {
    restore();
  }
});

test('a play that follows a stop straight away keeps the running app', async () => {
  const { output, session, calls, wait, restore } = await stoppedCastOutput('CC1AD845');
  try {
    await output.play(session);
    await output.stop(session);
    await output.play(session);
    await wait();
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});

test('an app somebody else started on the device is left alone', async () => {
  const { output, session, calls, wait, restore } = await stoppedCastOutput('233637DE');
  try {
    await output.play(session);
    await output.stop(session);
    await wait();
    assert.deepEqual(calls, []);
  } finally {
    restore();
  }
});
