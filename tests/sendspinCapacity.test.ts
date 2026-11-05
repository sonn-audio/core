import assert from 'node:assert/strict';
import { sendspinCore } from '@sonn-audio/node-sendspin';
import { test } from './testHarness';
import { SendspinClientSender } from '../src/adapters/outputs/sendspin/sendspinClientSender';

/** Stub the handful of core methods the sender's capacity check reads, recording what it asks. */
function stubCore(answers: Record<string, (...args: any[]) => unknown>): { asked: unknown[][]; restore: () => void } {
  const core = sendspinCore as unknown as Record<string, unknown>;
  const asked: unknown[][] = [];
  for (const [name, answer] of Object.entries(answers)) {
    core[name] = (...args: unknown[]) => {
      asked.push([name, ...args]);
      return answer(...args);
    };
  }
  return {
    asked,
    restore: () => {
      for (const name of Object.keys(answers)) delete core[name];
    },
  };
}

type Sender = Pick<SendspinClientSender, 'beginStream' | 'registerCapacity'> & {
  timeUntilCapacityUs(bytes: number): number;
};

function sender(): Sender {
  return new SendspinClientSender('kitchen', 0, 7) as unknown as Sender;
}

test('sendspin capacity: a player that declared a capacity is gated on node-sendspin\'s count, header included', () => {
  const core = stubCore({
    getPlayerBufferCapacity: () => 32_000,
    getAudioHeaderSize: () => 13,
    timeUntilPlayerCapacityUs: () => 4_000,
  });
  try {
    const s = sender();
    s.beginStream(32_000);
    assert.equal(s.timeUntilCapacityUs(1_000), 4_000);
    assert.deepEqual(core.asked.find(([name]) => name === 'timeUntilPlayerCapacityUs'), [
      'timeUntilPlayerCapacityUs',
      'kitchen',
      1_013,
    ], 'rc1 counts the whole audio message, its 13-byte header included');
  } finally {
    core.restore();
  }
});

test('sendspin capacity: a chunk bigger than the whole buffer goes out rather than stalling the stream', () => {
  const core = stubCore({
    getPlayerBufferCapacity: () => 1_000,
    getAudioHeaderSize: () => 13,
    timeUntilPlayerCapacityUs: () => Infinity,
  });
  try {
    assert.equal(sender().timeUntilCapacityUs(4_000), 0);
  } finally {
    core.restore();
  }
});

test('sendspin capacity: without a declared capacity the local gate still paces', () => {
  const core = stubCore({
    getPlayerBufferCapacity: () => null,
  });
  try {
    const s = sender();
    s.beginStream(1_000);
    s.registerCapacity(Number.MAX_SAFE_INTEGER, 900);
    assert.ok(s.timeUntilCapacityUs(500) > 0, 'the local count is full, so the sender waits');
    assert.ok(!core.asked.some(([name]) => name === 'timeUntilPlayerCapacityUs'));
  } finally {
    core.restore();
  }
});
