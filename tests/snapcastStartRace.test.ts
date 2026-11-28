import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SnapcastOutput } from '../src/adapters/outputs/snapcast/snapcastOutput';

// Spotify Connect into a Snapcast zone: a play and the resume right behind it both started a
// stream while neither had registered one yet. Both registered the zone's stream, and the client
// was left with neither: playing, but no sound (#457).

test('a play overtaken by a resume registers one stream, the latest (#457)', async () => {
  const registered: string[] = [];
  const destroyed: string[] = [];
  let created = 0;
  const firstChunks: Array<() => void> = [];
  const ports = {
    snapcastGroup: {
      register: () => undefined,
      unregister: () => undefined,
      buildPlan: () => ({ streamId: '6', clientIds: ['ec:66'], shouldPlay: true, leaderZoneId: null }),
    },
    snapcastCore: {
      setClientLatency: () => undefined,
      clearStream: () => undefined,
      setStream: (_id: string, _zone: number, _settings: unknown, stream: { name: string }) =>
        void registered.push(stream.name),
    },
    engine: {
      createStream: () => {
        const name = `stream-${++created}`;
        return { name, destroy: () => void destroyed.push(name) };
      },
      waitForFirstChunk: () => new Promise<boolean>((resolve) => firstChunks.push(() => resolve(true))),
    },
  } as any;
  const output = new SnapcastOutput(6, 'Pracovna', { clientIds: 'ec:66' }, ports);
  const session = { playbackSource: { kind: 'pipe' } } as any;

  const play = output.play(session);
  const resume = output.resume(session);
  firstChunks.forEach((release) => release());
  await Promise.all([play, resume]);

  assert.deepEqual(registered, ['stream-2'], 'only the latest start reaches the clients');
  assert.ok(destroyed.includes('stream-1'), 'the overtaken one is let go of');
});
