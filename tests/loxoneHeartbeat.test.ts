import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ServerHeartbeat } from '../src/adapters/loxone/ws/serverHeartbeat';

// The hw_event used to go out once, when the Miniserver connected. It now repeats while the
// Loxone subsystem runs (#460), and only while a client is connected to hear it.

const configPort = (paired = true) =>
  ({ getSystemConfig: () => ({ audioserver: { paired, macId: '9009D03B43E6', extensions: [] } }) }) as any;

function registry(size: number) {
  const sent: string[] = [];
  return { sent, registry: { size, broadcastMessage: (payload: string) => void sent.push(payload) } as any };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('the heartbeat repeats while a client is connected, until stopped (#460)', async () => {
  const { registry: reg, sent } = registry(1);
  const heartbeat = new ServerHeartbeat(reg);
  heartbeat.start(configPort(), 10);
  await wait(60);
  heartbeat.stop();
  assert.ok(sent.length >= 2, `repeated, saw ${sent.length}`);
  assert.ok(Array.isArray(JSON.parse(sent[0]!).hw_event));
  const stopped = sent.length;
  await wait(40);
  assert.equal(sent.length, stopped);
});

test('no heartbeat without a client, or while not paired', async () => {
  for (const [size, paired] of [[0, true], [1, false]] as const) {
    const { registry: reg, sent } = registry(size);
    const heartbeat = new ServerHeartbeat(reg);
    heartbeat.start(configPort(paired), 10);
    await wait(40);
    heartbeat.stop();
    assert.deepEqual(sent, [], `size ${size}, paired ${paired}`);
  }
});

test('starting again replaces the running heartbeat', async () => {
  const { registry: reg, sent } = registry(1);
  const heartbeat = new ServerHeartbeat(reg);
  heartbeat.start(configPort(), 10);
  heartbeat.start(configPort(), 10);
  heartbeat.stop();
  await wait(40);
  assert.deepEqual(sent, [], 'one stop ends it: no timer was left behind');
});
