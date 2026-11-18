import assert from 'node:assert/strict';
import { test } from './testHarness';
import { LoxoneRouter } from '../src/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '../src/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '../src/adapters/loxone/commands/responses';

/**
 * Removing the Audioserver in Loxone Config ends with `secure/forget/<token>` from the Miniserver.
 * Without an answer it retries the token and drops the connection.
 */
test('secure/forget is acknowledged in the shape of the other secure answers', async () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === 'then' ? undefined : anything),
    apply: () => anything,
  });
  const router = new LoxoneRouter();
  registerRoutes(router, new Proxy({}, { get: () => anything }) as any);

  const command = 'secure/forget/q1Zr8XnB0c2V-ZW5jcnlwdGVk_dG9rZW4';
  const result = await router.dispatch(command);

  assert.deepEqual(JSON.parse(serializeResult(result)), {
    secure_forget_result: { command: 'secure/forget', error: 0 },
    command,
  });
});
