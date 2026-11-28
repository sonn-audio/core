import assert from 'node:assert/strict';
import { test } from './testHarness';
import { MdnsService } from '../src/adapters/discovery/mdnsService';

/**
 * A soft restart must leave the server findable.
 *
 * Everything else survives one: the HTTP API answers, zones come back, music plays. mDNS did not —
 * the responder was destroyed on the way down and the same dead object reused on the way up, so the
 * server stopped announcing itself and no speaker could find it again. Nothing logged an error,
 * because publishing on a destroyed responder simply does nothing.
 */
test('mDNS still advertises after a shutdown and a restart', () => {
  const service = new MdnsService();

  const first = service.publish({ name: 'Test Audioserver', type: 'sonncore', port: 7090 });
  first.stop();
  service.shutdown();

  // The proof is the responder, not the return value: a destroyed one hands back a registration
  // just the same and quietly puts nothing on the wire.
  const before = (service as unknown as { instance: unknown }).instance;
  assert.equal(before, null, 'shutdown lets go of the responder');

  service.publish({ name: 'Test Audioserver', type: 'sonncore', port: 7090 });
  const after = (service as unknown as { instance: unknown }).instance;
  assert.notEqual(after, null, 'publishing again builds a new one');

  service.shutdown();
});

// Every service of a type shares its PTR name, and the library removed records by name alone:
// restarting one zone's AirPlay receiver took every AirPlay zone off the network (#455).
test('unpublishing one service leaves the others of its type advertised (#455)', async () => {
  const service = new MdnsService();
  const zones = ['01-Wohnen', '02-Kueche', '03-Bad'].map((name, i) =>
    service.publish({ name, type: 'raop', port: 7100 + i }),
  );
  const pointers = () => {
    const registry = (service as unknown as { instance: { server: { registry: Record<string, Array<{ name: string; data: string }>> } } })
      .instance.server.registry;
    return (registry.PTR ?? []).filter((record) => record.name === '_raop._tcp.local').map((record) => record.data);
  };
  // Records are registered once the name has been probed, about a second after publishing.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(pointers().length, 3);

  zones[1]!.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    pointers().sort(),
    ['01-Wohnen._raop._tcp.local', '03-Bad._raop._tcp.local'],
    'only the stopped zone is gone',
  );

  service.shutdown();
});
