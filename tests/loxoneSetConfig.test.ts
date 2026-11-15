import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createConfigHandlers } from '../src/adapters/loxone/commands/handlers/configHandlers';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import { LoxoneConfigService } from '../src/adapters/loxone/services/loxoneConfigService';
import {
  buildZoneConfigs,
  extractZonesFromLoxoneConfig,
} from '../src/adapters/loxone/services/loxoneZoneExtractor';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { NotifierPort } from '../src/ports/NotifierPort';
import type { ContentManager } from '../src/adapters/content/contentManager';
import type { AudioServerConfig, ZoneConfig } from '../src/domain/config/types';

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

test('the same config pushed again leaves the zones alone (#441)', async () => {
  let rebuilds = 0;
  const cfg = {
    system: { audioserver: { macId: OUR_MAC, extensions: [] }, miniserver: {} },
    rawAudioConfig: { raw: null, rawString: null, crc32: null },
    zones: [],
    groups: { mixedGroupEnabled: false, powerGroups: [], audioGroups: [] },
  } as unknown as AudioServerConfig;
  const configPort = {
    getConfig: () => cfg,
    updateConfig: async (fn: (c: AudioServerConfig) => unknown) => {
      await fn(cfg);
      return cfg;
    },
  } as unknown as ConfigPort;
  const service = new LoxoneConfigService(
    {
      replaceAll: async () => {
        rebuilds += 1;
      },
    } as unknown as ZoneManagerFacade,
    configPort,
    { refreshFromConfig: () => {} } as unknown as ContentManager,
    {} as NotifierPort,
  );
  const push = (raw: unknown) => service.setRawAudioConfig({ raw, rawString: JSON.stringify(raw) });

  const first = await push(music([{ playerid: 1, name: 'Kitchen' }]));
  assert.equal(rebuilds, 1);
  assert.ok(first);

  const again = await push(music([{ playerid: 1, name: 'Kitchen' }]));
  assert.equal(rebuilds, 1, 'nothing changed, so nothing is rebuilt');
  assert.equal(again, first, 'and the Miniserver gets the same crc back');

  await push(music([{ playerid: 1, name: 'Kitchen' }, { playerid: 2, name: 'Office' }]));
  assert.equal(rebuilds, 2, 'a changed config still applies');
  assert.equal(cfg.zones.length, 2);
});
