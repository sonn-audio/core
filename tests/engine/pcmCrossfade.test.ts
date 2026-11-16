import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { test } from '../testHarness';
import {
  blendPcmStreams,
  streamChunkSource,
  processStdoutChunkSource,
} from '../../src/engine/pcmCrossfade';

const silentLog = { debug: () => {}, warn: () => {} };

test('streamChunkSource collects data and flips ended on stream end', () => {
  const stream = new PassThrough();
  const source = streamChunkSource(stream);
  const chunks: Buffer[] = [];
  source.attach(chunks);
  stream.write(Buffer.from([1, 2, 3]));
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(chunks.length, 1);
    assert.equal(source.isEnded(), false);
    stream.end();
    setImmediate(() => {
      assert.equal(source.isEnded(), true);
      source.detach();
      resolve();
    });
  }));
});

test('streamChunkSource.detach removes data listener', () => {
  const stream = new PassThrough();
  const source = streamChunkSource(stream);
  const chunks: Buffer[] = [];
  source.attach(chunks);
  source.detach();
  stream.write(Buffer.from([1, 2, 3]));
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(chunks.length, 0);
    resolve();
  }));
});

test('processStdoutChunkSource uses process exit as end signal', () => {
  const stream = new PassThrough();
  const fakeProc = new EventEmitter() as EventEmitter & { stdout: PassThrough };
  fakeProc.stdout = stream;
  const source = processStdoutChunkSource(fakeProc as never, stream);
  const chunks: Buffer[] = [];
  source.attach(chunks);
  stream.write(Buffer.from([10, 20]));
  return new Promise<void>((resolve) => setImmediate(() => {
    assert.equal(chunks.length, 1);
    assert.equal(source.isEnded(), false);
    // Stream 'end' does NOT flip ended for process source — only exit does.
    stream.end();
    setImmediate(() => {
      assert.equal(source.isEnded(), false, 'process source ignores stream end');
      fakeProc.emit('exit');
      assert.equal(source.isEnded(), true);
      source.detach();
      resolve();
    });
  }));
});

test('blendPcmStreams produces totalFrames frames and detaches both sources', async () => {
  const oldStream = new PassThrough();
  const newStream = new PassThrough();
  const oldSrc = streamChunkSource(oldStream);
  const newSrc = streamChunkSource(newStream);

  // 2 channels × 2 bytes/sample = 4 bytes/frame
  // Pre-fill both streams with enough PCM (10 frames each = 40 bytes).
  const silentFrame = Buffer.alloc(40);
  oldStream.write(silentFrame);
  newStream.write(silentFrame);

  const blended: Buffer[] = [];
  const result = await blendPcmStreams(oldSrc, newSrc, {
    channels: 2,
    totalFrames: 5,
    onBlendedFrame: (b) => blended.push(b),
    log: silentLog,
    logContext: { zoneId: 1 },
  });
  assert.equal(result.framesProcessed, 5);
  oldStream.end();
  newStream.end();
});

// A straight ramp keeps the two gains adding up to one, which for two unrelated tracks puts the
// loudness 3 dB down halfway through. The gains follow a quarter sine, so their squares add up to
// one all the way across.
test('blendPcmStreams holds the power steady across the blend', async () => {
  const oldStream = new PassThrough();
  const newStream = new PassThrough();
  const oldSrc = streamChunkSource(oldStream);
  const newSrc = streamChunkSource(newStream);
  const frames = 1000;
  // Mono, 16 bit: the old track a constant 10000, the new one silent, so each blended sample is
  // the old track's gain at that point, times 10000.
  const loud = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) loud.writeInt16LE(10000, i * 2);
  oldStream.write(loud);
  newStream.write(Buffer.alloc(frames * 2));

  const blended: Buffer[] = [];
  await blendPcmStreams(oldSrc, newSrc, {
    channels: 1,
    totalFrames: frames,
    onBlendedFrame: (b) => blended.push(b),
    log: silentLog,
    logContext: { zoneId: 1 },
  });
  const out = Buffer.concat(blended);
  const gainAt = (frame: number): number => out.readInt16LE(frame * 2) / 10000;
  assert.ok(Math.abs(gainAt(0) - 1) < 0.01, 'starts at full level');
  // Half way: cos(45°) ≈ 0.707, where a straight ramp would be at 0.5.
  assert.ok(Math.abs(gainAt(frames / 2) - Math.SQRT1_2) < 0.01, `mid gain ${gainAt(frames / 2)}`);
  assert.ok(gainAt(frames - 1) < 0.01, 'ends silent');
  oldStream.end();
  newStream.end();
});
