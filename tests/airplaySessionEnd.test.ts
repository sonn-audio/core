import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AirplayInstance } from '../src/adapters/inputs/airplay/airplayInstance';
import type { AirplayInstanceController } from '../src/adapters/inputs/airplay/airplayInstance';
import type { MdnsPort } from '../src/ports/MdnsPort';
import type { PlayerRegistryPort } from '../src/ports/PlayerRegistryPort';

// #420. A sender ending its session (TEARDOWN, or the stream closing) stopped the zone's player
// directly and never told the zone, so the zone kept `activeInput === 'airplay'` for good and
// refused a Spotify Connect takeover long after the phone had gone.

const noop = (): void => {};

test('an AirPlay session that ends hands the zone back through the zone, not just its player (#420)', () => {
  const calls: string[] = [];
  const controller: AirplayInstanceController = {
    startPlayback: noop,
    updateMetadata: noop,
    updateCover: () => undefined,
    updateVolume: noop,
    updateTiming: noop,
    pausePlayback: noop,
    resumePlayback: noop,
    stopPlayback: (zoneId) => calls.push(`controller.stop:${zoneId}`),
  };
  // A registered player is the normal case, and the one that used to skip the zone.
  const player = {
    stop: (reason?: string) => calls.push(`player.stop:${reason}`),
    updateMetadata: noop,
    updateCover: () => undefined,
    updateTiming: noop,
  };
  const playerRegistry = { getPlayer: () => player } as unknown as PlayerRegistryPort;
  const mdns = {
    publish: () => ({ stop: noop }),
    browse: () => ({ stop: noop }),
    shutdown: noop,
  } as unknown as MdnsPort;
  const zone = new AirplayInstance(
    2,
    'Sypialnia',
    '88AEDD681068',
    { enabled: true, port: 6299 },
    controller,
    playerRegistry,
    mdns,
  );

  (zone as unknown as { sessionActive: boolean }).sessionActive = true;
  (zone as unknown as { handleRaopEvent: (event: { type: string }) => void }).handleRaopEvent({ type: 'stop' });

  assert.deepEqual(
    calls.filter((call) => call.includes('stop')),
    ['controller.stop:2'],
  );
});

// A sender tells the receiver the level it remembers for it as it connects. That is the slider on
// someone's phone, not a choice made for this room, and following it overwrote the room's volume
// at the start of every session.
test('the volume a sender reports on connecting leaves the zone level alone', () => {
  const volumes: number[] = [];
  const controller: AirplayInstanceController = {
    startPlayback: noop,
    updateMetadata: noop,
    updateCover: () => undefined,
    updateVolume: (_zoneId, volume) => volumes.push(volume),
    updateTiming: noop,
    pausePlayback: noop,
    resumePlayback: noop,
    stopPlayback: noop,
  };
  const playerRegistry = { getPlayer: () => null } as unknown as PlayerRegistryPort;
  const mdns = {
    publish: () => ({ stop: noop }),
    browse: () => ({ stop: noop }),
    shutdown: noop,
  } as unknown as MdnsPort;
  const zone = new AirplayInstance(2, 'Sypialnia', '88AEDD681068', { enabled: true, port: 6299 }, controller, playerRegistry, mdns);
  const raop = (event: { type: string; value?: number }): void =>
    (zone as unknown as { handleRaopEvent: (event: unknown) => void }).handleRaopEvent(event);

  raop({ type: 'volume', value: 0.8 });
  assert.deepEqual(volumes, [], 'the stored level is not applied');
  raop({ type: 'volume', value: 0.8 });
  assert.deepEqual(volumes, [], 'nor is a repeat of it');
  raop({ type: 'volume', value: 0.5 });
  assert.deepEqual(volumes, [50], 'a change after that is the listener');

  // The next session starts with its own report.
  (zone as unknown as { sessionActive: boolean }).sessionActive = true;
  raop({ type: 'stop' });
  raop({ type: 'volume', value: 0.9 });
  assert.deepEqual(volumes, [50]);
});
