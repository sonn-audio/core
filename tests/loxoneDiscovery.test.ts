import assert from 'node:assert/strict';
import { test } from './testHarness';
import { describeExtensions } from '../src/adapters/loxone/commands/handlers/configHandlers';
import { buildDiscoveryAnswer } from '../src/adapters/loxone/http/loxoneUdpDiscovery';
import { buildLoxoneHttpConfig } from '../src/config/loxone';

/**
 * What Loxone Config makes of a search answer, read out of Loxone Config 17.3.11.12 and
 * confirmed against a Miniserver: an answer that begins with `LoxMedia` is a media server, its
 * fields are found by name in a fixed order, and a `SubType` below 1 is the old Music Server.
 */
const FIELD_ORDER = ['IP:', 'MAC:', 'Product:', 'Version:', 'SubType:', 'Hostname:', 'Paired:', 'Master:'];

function answerFor(system: Record<string, unknown>): string {
  const config = buildLoxoneHttpConfig({ hostname: '0.0.0.0', loxoneAppPort: 7091, loxoneMiniserverPort: 7095 } as any, '504F94FEED01');
  return buildDiscoveryAnswer(config, { getSystemConfig: () => system } as any, '192.168.1.50');
}

test('discovery: a search is answered as an Audioserver, not as a generic network device', () => {
  const answer = answerFor({ audioserver: { name: 'Kitchen', macId: '50:4f:94:fe:ed:01' } });
  assert.ok(answer.startsWith('LoxMedia '), 'the answer has to begin with LoxMedia');
  assert.match(answer, / IP:192\.168\.1\.50 /);
  assert.match(answer, / MAC:504F94FEED01 /);
  assert.match(answer, / Product:Audioserver /);
  // 0 would be offered as a "LOXONE Music Server".
  assert.match(answer, / SubType:1 /);
  assert.match(answer, / Paired:false$/);
  assert.equal(answer.includes('Master:'), false);
});

test('discovery: a paired server names its Miniserver, and the fields keep their order', () => {
  const answer = answerFor({ audioserver: { macId: '504F94FEED01' }, miniserver: { serial: '50:4f:94:11:15:7a' } });
  assert.match(answer, / Paired:true Master:504F9411157A$/);
  const positions = FIELD_ORDER.map((field) => answer.indexOf(` ${field}`));
  assert.ok(positions.every((position) => position > 0), 'every field is present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'fields are in the order Config reads them');
});

test('discovery: every extension is described the way a search can read it', () => {
  // Verified in Loxone Config's "Tree Turbo search": type 3 is listed as "Stereo Extension", and
  // only when type, subtype and id are numbers. A known extension described any other way was
  // listed as an unused "Audio zone" to add.
  const described = describeExtensions(
    '50:4F:94:FE:ED:00',
    [{ mac: '504f94feed01', name: 'Kitchen amp' }],
    ['504F94FEED01', '50:4f:94:fe:ed:02'],
    '18.1.0.0',
  );
  assert.deepEqual(described, [
    { type: 3, subtype: 0, id: 1, mac: '504F94FEED01', version: '18.1.0.0', name: 'Kitchen amp' },
    { type: 3, subtype: 0, id: 2, mac: '504F94FEED02', version: '18.1.0.0' },
  ]);
});
