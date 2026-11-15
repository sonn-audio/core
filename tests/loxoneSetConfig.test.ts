import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createConfigHandlers } from '../src/adapters/loxone/commands/handlers/configHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import {
  buildZoneConfigs,
  extractZonesFromLoxoneConfig,
} from '../src/adapters/loxone/services/loxoneZoneExtractor';
import type { ZoneConfig } from '../src/domain/config/types';

// The Miniserver's audio/cfg/setconfig, as tobsch traced it on a Miniserver stuck in its handshake:
// the reply went out keyed by the base64 payload (#440), players pushed without a name lost the
// names they had (#441), and every identical push rebuilt all zones, cutting off playback (#441).

const OUR_MAC = '000C29678C56';

function music(players: Array<{ playerid: number; name?: string | null }>): unknown {
  return [
    {
      [OUR_MAC]: {
        master: '504F9411157A',
        players: players.map((p) => ({ uuid: `uuid-${p.playerid}`, playerid: p.playerid, name: p.name, outputs: [] })),
        extensions: [],
      },
    },
  ];
}

function keyOf(result: unknown): string {
  return Object.keys(JSON.parse(serializeResult(result as never)))[0]!;
}

test('setconfig and miniservertime answer under their own names (#440)', async () => {
  const handlers = createConfigHandlers({} as never, {
    notifier: {} as never,
    configService: {
      setRawAudioConfig: async () => 'abcd1234',
      getCurrentConfigInfo: () => ({ crc32: 'abcd1234', extensions: [] }),
    } as never,
    configPort: {} as never,
    contentManager: {} as never,
    spotifyInputService: {} as never,
  });
  const encoded = Buffer.from(JSON.stringify(music([{ playerid: 1, name: 'Kitchen' }]))).toString('base64');
  assert.match(encoded, /^W3si/, 'a payload that starts like a word, which is what fooled the old guess');

  const setconfig = await handlers.setConfig(`audio/cfg/setconfig/${encoded}`);
  assert.equal(keyOf(setconfig), 'setconfig_result');
  assert.deepEqual((setconfig as { payload: unknown }).payload, { crc32: 'abcd1234', extensions: [] });

  const time = await handlers.miniserverTime('audio/cfg/miniservertime/1794746998');
  assert.equal(keyOf(time), 'miniservertime_result');
});

test('a player pushed without a name keeps the name it has (#441)', () => {
  const existing = [
    { id: 1, name: 'Kitchen', output: { type: 'sendspin' }, inputs: {}, volumes: {} },
    { id: 2, name: 'Office', output: null, inputs: {}, volumes: {} },
  ] as unknown as ZoneConfig[];
  const descriptors = extractZonesFromLoxoneConfig(
    music([{ playerid: 1, name: null }, { playerid: 2, name: 'Study' }, { playerid: 3, name: null }]),
    OUR_MAC,
  );
  const zones = buildZoneConfigs(descriptors, existing);

  assert.deepEqual(
    zones.map((z) => [z.id, z.name]),
    [
      [1, 'Kitchen'],
      [2, 'Study'],
      [3, 'Zone 3'],
    ],
    'a known room keeps its name, a real name still wins, only a new room gets a placeholder',
  );
  assert.deepEqual(zones[0]?.output, { type: 'sendspin' });
});
