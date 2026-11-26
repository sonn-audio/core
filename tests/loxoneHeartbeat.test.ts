import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ServerHeartbeat } from '../src/adapters/loxone/ws/serverHeartbeat';

// hw_event is the only message that tells the Miniserver the audioserver is still there; it
// carries no zone state, so nothing else stands in for it. It used to be sent once, when an
// msHttp client connected, and an installation that stayed connected then had no liveness
// signal at all: the Miniserver and the app treat the audioserver, and every Audio Player
// block with it, as offline while the sockets stay up and the zone states keep flowing.

function configPort(paired = true) {
  return {
    getSystemConfig: () => ({
      audioserver: {
        paired,
        macId: '9009D03B43E6',
        extensions: [],
      },
    }),
  } as any;
}

function registryWith(size: number) {
  const sent: string[] = [];
  const registry = {
    size,
    broadcastMessage: (payload: string) => {
      sent.push(payload);
    },
  } as any;
  return { registry, sent };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('an on-demand heartbeat carries the audioserver identity', () => {
  const { registry, sent } = registryWith(1);
  const heartbeat = new ServerHeartbeat(registry);

  heartbeat.emit(configPort());

  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]!);
  assert.ok(Array.isArray(payload.hw_event), 'the frame is an hw_event');
  assert.equal(payload.hw_event[0].client_id, '9009D03B43E6#1', 'it names the audioserver');
  assert.equal(payload.hw_event.length, 7, 'with the full base event set');
});

test('nothing is said while the audioserver is not paired', () => {
  const { registry, sent } = registryWith(1);
  const heartbeat = new ServerHeartbeat(registry);

  heartbeat.emit(configPort(false));

  assert.deepEqual(sent, [], 'an unpaired server stays quiet');
});

test('the heartbeat repeats while a client is attached', async () => {
  const { registry, sent } = registryWith(1);
  const heartbeat = new ServerHeartbeat(registry);

  heartbeat.start(configPort(), 10);
  await wait(120);
  heartbeat.stop();

  assert.ok(sent.length >= 2, `expected repeated heartbeats, saw ${sent.length}`);

  const afterStop = sent.length;
  await wait(80);
  assert.equal(sent.length, afterStop, 'stop() ends the repetition');
});

test('no periodic heartbeat is sent when nobody is attached', async () => {
  const { registry, sent } = registryWith(0);
  const heartbeat = new ServerHeartbeat(registry);

  heartbeat.start(configPort(), 10);
  await wait(80);
  heartbeat.stop();

  assert.deepEqual(sent, [], 'a server nobody listens to does not talk to itself');
});
