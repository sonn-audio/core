import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createAcknowledgedSettingHandler } from '../src/adapters/loxone/commands/handlers/settingHandlers';

/**
 * The settings a Miniserver pushes on every connection are acknowledged, not answered as not
 * implemented. Payloads as captured from a Miniserver on 17.3.11.12.
 */
test('settings: what the Miniserver pushes on connecting is acknowledged', async () => {
  const cases: Array<[string, string]> = [
    [
      'playeropts',
      'audio/cfg/playeropts/eyJwbGF5ZXJzIjpbeyJwbGF5ZXJpZCI6MjksInJmIjoib2ZmIiwibG9jayI6Im9mZiIsImFwIjoib24iLCJzcCI6Im9uIn1dfQ',
    ],
    ['presencemode', 'audio/cfg/presencemode/29,30,31/off'],
    ['miniserverip', 'audio/cfg/miniserverip/192.168.1.200/255.255.255.0/192.168.1.1/192.168.1.1/192.168.1.158/static'],
    ['bluetooth', 'audio/cfg/bluetooth/29/visible'],
  ];
  for (const [name, command] of cases) {
    const answer = await createAcknowledgedSettingHandler(name)(command);
    assert.equal(answer?.command, command);
    assert.equal(answer?.name, name);
    assert.deepEqual(answer?.payload, { success: true });
  }
});
