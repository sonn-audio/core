import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosOutput } from '../src/adapters/outputs/sonos/sonosOutput';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import { dispatchOutputs } from '../src/application/zones/services/outputOrchestrator';

// Regression coverage for issue #327 ("play after pause does not work"): a Sonos websocket that
// had gone stale made pause reject, the rejection was escalated to a fatal playback error, and
// the follow-up play was then swallowed by the state controller.

class StaleSocketError extends Error {
  constructor() {
    super('Not connected');
    // node-sonos derives `name` from the error class; the adapter matches on that.
    this.name = 'NotConnected';
  }
}

function createOutput(groupCommand: () => Promise<void>) {
  const soapActions: string[] = [];
  const disconnected: boolean[] = [];
  const output = new SonosOutput(
    5,
    'Büro',
    { controlUrl: 'http://192.168.20.34:1400/MediaRenderer/AVTransport/Control' },
    {
      sonosGroup: { register: () => undefined, unregister: () => undefined },
    } as any,
  ) as any;
  const client = {
    player: { group: { pause: groupCommand, play: groupCommand, stop: groupCommand } },
    disconnect: async () => {
      disconnected.push(true);
    },
  };
  output.s2Client = client;
  output.invokeAction = async (action: string) => {
    soapActions.push(action);
    return true;
  };
  return { output, soapActions, disconnected, client };
}

const session = { zoneId: 5, playbackSource: 'library://track.mp3' } as any;

test('sonos pause falls back to SOAP and drops the client when the websocket is stale', async () => {
  const { output, soapActions, disconnected } = createOutput(async () => {
    throw new StaleSocketError();
  });

  await output.pause(session);

  assert.deepEqual(soapActions, ['Stop'], 'pause of our own stream is sent as Stop; see #345');
  assert.equal(output.s2Client, null, 'stale client must be dropped so the next command reconnects');
  assert.deepEqual(disconnected, [true]);
});

test('sonos pause stops the speaker instead of pausing our own stream', async () => {
  // Issue #345 / music-assistant/support#3758: Sonos cannot hold a length-less HTTP stream. It
  // aborts the track on pause and then refuses to resume it, so the pause lives on our side and
  // the speaker gets a clean stop that playStreamUrl can reload from.
  const calls: string[] = [];
  const { output, soapActions } = createOutput(async () => {
    calls.push('s2');
  });
  output.s2Client.player.group.pause = async () => {
    calls.push('pause');
  };
  output.s2Client.player.group.stop = async () => {
    calls.push('stop');
  };

  await output.pause(session);

  assert.deepEqual(calls, ['stop']);
  assert.deepEqual(soapActions, []);
});

test('sonos stop and resume survive a stale websocket too', async () => {
  const stop = createOutput(async () => {
    throw new StaleSocketError();
  });
  await stop.output.stop(session);
  assert.deepEqual(stop.soapActions, ['Stop']);

  const resume = createOutput(async () => {
    throw new StaleSocketError();
  });
  await resume.output.resume(null);
  assert.deepEqual(resume.soapActions, ['Play']);
});

test('sonos pause keeps a healthy websocket client and skips SOAP', async () => {
  const calls: string[] = [];
  const { output, soapActions } = createOutput(async () => {
    calls.push('s2');
  });

  await output.pause(session);

  assert.deepEqual(calls, ['s2']);
  assert.deepEqual(soapActions, []);
  assert.notEqual(output.s2Client, null);
});

test('sonos keeps the client on a refused command; only connection loss drops it', async () => {
  const { output, soapActions } = createOutput(async () => {
    const err = new Error('Command failed: ERROR_PLAYBACK_FAILED');
    err.name = 'FailedCommand';
    throw err;
  });

  await output.pause(session);

  assert.deepEqual(soapActions, ['Stop'], 'a refused S2 command still falls back to SOAP');
  assert.notEqual(output.s2Client, null, 'a refused command says nothing about the socket');
});

function dispatchWithFailingOutput(action: 'play' | 'pause' | 'stop') {
  const errors: string[] = [];
  const ctx = {
    id: 5,
    config: {},
    activeInput: 'queue',
    activeOutput: 'sonos',
    activeOutputTypes: new Set(['sonos']),
  } as any;
  const outputs = [
    {
      type: 'sonos',
      play: async () => {
        throw new Error('Not connected');
      },
      pause: async () => {
        throw new Error('Not connected');
      },
      stop: async () => {
        throw new Error('Not connected');
      },
    },
  ] as any;
  dispatchOutputs(
    ctx,
    outputs,
    action,
    { zoneId: 5, playbackSource: 'library://track.mp3' } as any,
    { debug: () => undefined, warn: () => undefined, info: () => undefined } as any,
    (_zoneId, reason) => {
      errors.push(String(reason));
    },
  );
  return errors;
}

test('a failed pause or stop is not escalated to a fatal playback error', async () => {
  const pauseErrors = dispatchWithFailingOutput('pause');
  const stopErrors = dispatchWithFailingOutput('stop');
  const playErrors = dispatchWithFailingOutput('play');
  // The rejections are reported asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(pauseErrors, [], 'a session that is still valid must not be torn down');
  assert.deepEqual(stopErrors, []);
  assert.deepEqual(playErrors, ['Not connected'], 'silence after play must still surface');
});

function createStateController() {
  return new SonosStateController({
    zone: { id: 5, name: 'Büro', output: { host: '192.168.20.34' } as any } as any,
    onStatePatch: () => undefined,
  } as any) as any;
}

test('sonos state controller declines transport commands when it has no live group', () => {
  const controller = createStateController();

  assert.equal(controller.handleCommand('play'), false, 'declining hands the command back to local playback');

  let dispatched = 0;
  controller.client = {
    player: { group: { playbackState: 'PLAYBACK_STATE_PAUSED', play: async () => { dispatched += 1; } } },
  };
  assert.equal(controller.handleCommand('play'), true);
  assert.equal(controller.handleCommand('nonsense'), false);
});

test('sonos state controller declines play when the idle speaker has nothing to resume', async () => {
  // Issue #345: after we paused our own stream the speaker sits IDLE with an empty container, so
  // group.play() reaches nothing. Declining hands the play to local playback, which restarts the
  // current queue item — the same conclusion Music Assistant reached for its own queue content.
  const controller = createStateController();
  let played = 0;
  controller.client = {
    player: { group: { playbackState: 'PLAYBACK_STATE_IDLE', play: async () => { played += 1; } } },
  };

  assert.equal(controller.handleCommand('play'), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(played, 0, 'a play the speaker cannot honour must not be sent at all');

  // Non-play transport commands are unaffected: they act on whatever the speaker is doing.
  let stopped = 0;
  controller.client.player.group.stop = async () => { stopped += 1; };
  assert.equal(controller.handleCommand('stop'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, 1);
});

test('sonos state controller reloads an idle speaker through the media url it reported itself', async () => {
  const controller = createStateController();
  const reloads: Array<{ url: string; container: any }> = [];
  controller.client = {
    player: {
      group: {
        playbackState: 'PLAYBACK_STATE_IDLE',
        play: async () => undefined,
        playStreamUrl: async (url: string, container: any) => {
          reloads.push({ url, container });
        },
      },
    },
  };
  controller.lastTrackMediaUrl = 'http://speaker/radio.mp3';
  controller.lastTrackTitle = 'Some Station';

  assert.equal(controller.handleCommand('play'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reloads.length, 1);
  assert.equal(reloads[0]?.url, 'http://speaker/radio.mp3');
  assert.equal(reloads[0]?.container.name, 'Some Station');
});

test('sonos state controller never reloads our own stream once its session is gone', async () => {
  // Issue #418: a radio favourite had played through our own stream, so the speaker reported our
  // URL (and the last song title) as its media. After the session ended, play reloaded that dead
  // URL: Loxone showed play, the speaker stayed silent and fell back to STOPPED.
  const controller = createStateController();
  const reloads: string[] = [];
  let played = 0;
  const group: any = {
    playbackState: 'PLAYBACK_STATE_PLAYING',
    positionSeconds: 0,
    playbackMetadataStatus: {
      container: { name: 'Ibiza Live Radio', id: { serviceId: 'sonn', objectId: 'sonn:1:42' } },
      currentItem: {
        track: { name: 'Sargasso Sea', mediaUrl: 'http://192.168.1.10:7090/streams/1/current.mp3?prime=1' },
      },
    },
    play: async () => {
      played += 1;
    },
    playStreamUrl: async (url: string) => {
      reloads.push(url);
    },
  };
  controller.client = { player: { group } };
  // An older external source must not be what play falls back to either.
  controller.lastTrackMediaUrl = 'x-sonosapi-stream:s1234?sid=254';
  controller.buildSnapshotPatch();
  assert.equal(controller.lastTrackMediaUrl, null, 'our own URL is never cached as a reload target');

  group.playbackState = 'PLAYBACK_STATE_IDLE';
  assert.equal(controller.handleCommand('play'), false, 'declined: local playback restarts the item');

  // The SOAP path carries no container identity; the stream path alone gives it away.
  group.playbackState = 'PLAYBACK_STATE_PAUSED';
  group.playbackMetadataStatus = {
    container: { name: 'Ibiza Live Radio' },
    currentItem: { track: { mediaUrl: 'x-rincon-mp3radio://192.168.1.10:7090/streams/1/current.mp3' } },
  };
  assert.equal(controller.handleCommand('play'), false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reloads, []);
  assert.equal(played, 0);
});
