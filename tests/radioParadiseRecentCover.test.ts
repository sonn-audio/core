import assert from 'node:assert/strict';
import { test } from './testHarness';
import { RadioParadiseProvider } from '../src/adapters/content/providers/radioparadise/radioParadiseProvider';
import { RADIO_PARADISE_STATIONS } from '../src/adapters/content/providers/radioparadise/radioParadiseConstants';

// A Radio Paradise station showed its logo under LOXONE Radio but the generic radio icon in
// Recently Played (#449): nothing resolved a `radioparadise:<id>` path to its station.

test('a Radio Paradise audiopath resolves to its station and catalogue logo (#449)', () => {
  const provider = new RadioParadiseProvider({ iconBaseUrl: 'http://192.168.1.10:7090/assets/icons' });
  const station = RADIO_PARADISE_STATIONS[0]!;
  for (const path of [`radioparadise:${station.id}`, `radioparadise://${station.id}?x=1`]) {
    const meta = provider.stationMetadata(path);
    assert.equal(meta?.name, station.name, path);
    assert.ok(meta?.coverurl.startsWith('http://192.168.1.10:7090/assets/icons/'), meta?.coverurl);
  }
  assert.equal(provider.stationMetadata('radioparadise:nonexistent'), null);
  assert.equal(provider.stationMetadata('tunein:station:s1234'), null);
});
