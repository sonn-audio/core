import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { PcmRing } from '../src/adapters/outputs/airplay/pcmRing';

// #386. The AirPlay 1 lane opened, but the audio never reached it: the AirPlay 2 attempt before it
// had held the source back for its own buffer, and handing the stream on does not undo a pause().
// The receiver looked like the problem ("no PCM arrived") while the stream was simply stopped.

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One second of silence — enough to trip the ring's backpressure gate on its own. */
function second(): Buffer {
  return Buffer.alloc(44_100 * 4);
}

test('a ring attaching to a stopped stream starts it again', async () => {
  const source = new PassThrough();
  source.pause();
  const ring = new PcmRing();
  ring.attach(source);
  source.write(second());
  await tick();
  assert.ok(ring.bufferedBytes > 0, 'a paused source must not stay paused once a ring wants it');
});

test('a ring that gave up hands the source back running', async () => {
  const source = new PassThrough();
  const first = new PcmRing();
  first.attach(source);
  // Two seconds at once: past the 1.2 s gate, so the ring holds the source back.
  source.write(second());
  source.write(second());
  await tick();
  assert.equal(first.isSourcePaused, true, 'a fast source is supposed to trip the gate');

  first.detach();
  const second_ = new PcmRing();
  second_.attach(source);
  source.write(second());
  await tick();
  assert.ok(second_.bufferedBytes > 0, 'the next lane must receive audio, not a stalled stream');
});
