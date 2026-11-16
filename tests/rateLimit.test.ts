import assert from 'node:assert/strict';
import { test } from './testHarness';
import { RateLimiter, retryAfterMs } from '../src/adapters/content/utils/rateLimit';

function harness(options: { maxWaitMs?: number; maxAttempts?: number } = {}) {
  const clock = { now: 1_000_000 };
  const slept: number[] = [];
  const limiter = new RateLimiter({
    ...options,
    now: () => clock.now,
    sleep: async (ms) => {
      slept.push(ms);
      clock.now += ms;
    },
  });
  return { limiter, slept, clock };
}

const limited = (retryAfter?: string): Response =>
  new Response(null, { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

test('retry-after: seconds and an http date both read as a wait', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 4000), 6000);
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('soon'), null);
});

test('rate limit: a 429 is waited out for as long as the service asked, then answered', async () => {
  const { limiter, slept } = harness();
  const answers = [limited('2'), new Response('ok', { status: 200 })];
  const res = await limiter.fetch(async () => answers.shift()!);
  assert.equal(res.status, 200);
  assert.deepEqual(slept, [2000]);
});

test('rate limit: a second request on the same account waits with the first', async () => {
  const { limiter, slept } = harness();
  let sent = 0;
  await limiter.fetch(async () => {
    sent += 1;
    return sent === 1 ? limited('3') : new Response(null, { status: 200 });
  });
  assert.deepEqual(slept, [3000]);
  // A pause noted while another request is under way holds the next one back before it is sent.
  limiter.block(1500);
  await limiter.fetch(async () => new Response(null, { status: 200 }));
  assert.deepEqual(slept, [3000, 1500]);
});

test('rate limit: a pause too long to sit through is handed back, and nothing is sent during it', async () => {
  const { limiter, slept, clock } = harness({ maxWaitMs: 5000 });
  let sent = 0;
  const first = await limiter.fetch(async () => {
    sent += 1;
    return limited('600');
  });
  assert.equal(first.status, 429);
  assert.equal(sent, 1);
  const second = await limiter.fetch(async () => {
    sent += 1;
    return new Response(null, { status: 200 });
  });
  assert.equal(second.status, 429, 'answered from what is already known');
  assert.equal(sent, 1);
  assert.deepEqual(slept, []);
  clock.now += 600_000;
  const third = await limiter.fetch(async () => new Response(null, { status: 200 }));
  assert.equal(third.status, 200);
});

test('rate limit: the tries run out', async () => {
  const { limiter } = harness({ maxAttempts: 3 });
  let sent = 0;
  const res = await limiter.fetch(async () => {
    sent += 1;
    return limited('1');
  });
  assert.equal(res.status, 429);
  assert.equal(sent, 3);
});
