import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { AirPlayReceiver, type ReceiverEvent } from '@sonn-audio/node-airplay';
import { test } from './testHarness';
import { RaopSender } from '../src/adapters/outputs/airplay/raopSender';

// #386. The AirPlay 1 lane exists for devices nobody here owns, so this drives it against
// node-airplay's own RAOP receiver: a real ANNOUNCE/SETUP/RECORD, real ALAC over UDP, and the
// decoded bytes as proof. It also pins that a pause ENDS the session -- the lane cannot move its
// frame counter, so a resume on the old timeline describes a moment the device has already passed.

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for a condition rather than for a duration: a handshake is not a stopwatch. */
async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await wait(25);
  }
  return condition();
}

/**
 * A source that runs ahead of realtime, like the engine does. A realtime one never
 * reaches the ring's backpressure gate, which is where the earlier bugs lived.
 */
function fastSource(): { stream: PassThrough; stop: () => void } {
  const stream = new PassThrough({ highWaterMark: 1 << 22 });
  const chunk = (frames: number): Buffer => Buffer.alloc(frames * 4, 1);
  stream.write(chunk(44_100));
  const timer = setInterval(() => stream.write(chunk(4410)), 50);
  return { stream, stop: () => clearInterval(timer) };
}

test('the RAOP lane plays, and a pause ends the session so a resume can start a live one', async () => {
  let decoded = 0;
  const receiver = new AirPlayReceiver({ name: 'test', port: 0 }, (event: ReceiverEvent) => {
    if (event.type === 'pcm') {
      decoded += event.data.length;
    }
  });
  const advertisement = await receiver.start();
  const source = fastSource();
  const sender = new RaopSender(
    { host: '127.0.0.1', port: advertisement.port },
    { zoneId: 1, zoneName: 'Test' },
  );
  try {
    assert.equal(await sender.start(source.stream, 40), true, 'the session should open');
    assert.ok(await waitUntil(() => decoded > 0), 'audio should reach the receiver');
    assert.equal(sender.isRunning(), true);

    sender.pause();
    assert.equal(sender.isRunning(), false, 'a pause must end the session, not just go quiet');
    await wait(300);
    // Packets already on the wire when the pause lands still arrive, so this is a
    // bound rather than an equality: what must not happen is the stream carrying on.
    const atPause = decoded;
    await wait(300);
    assert.equal(decoded, atPause, 'nothing should still be sent 300 ms into a pause');

    // What the output does with a sender that is no longer running.
    assert.equal(await sender.start(source.stream, 40), true, 'a fresh session should open');
    assert.ok(
      await waitUntil(() => decoded > atPause),
      'audio should flow again after the restart',
    );
  } finally {
    sender.stop();
    source.stop();
    receiver.stop();
  }
});
