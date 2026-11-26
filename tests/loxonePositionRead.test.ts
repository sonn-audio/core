import assert from 'node:assert/strict';
import { test } from './testHarness';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';

// After a Loxone-initiated seek during native Spotify playback the Loxone bar jumped between
// zero and the real position for the rest of the track, while the audioserver's own event stream
// was correct: frames showed 158, 159, 160 with no dip and no backward jump. The client was
// asking for the position and getting zero.
//
//   GET /audio/2/position     -> {"position_result":[{"position":0}]}
//   GET /audio/2/position/266 -> {"position_result":[{"position":266}]}
//
// The handler answered every position command by echoing its payload, and a read has no payload,
// so the read came back as 0. These pin the two forms apart: a seek still answers the position it
// was asked for, a read answers where the zone actually is.

function harness(zoneTime: number | null) {
  const commands: Array<{ zoneId: number; command: string; payload?: string }> = [];
  const zoneManager = {
    getState: (zoneId: number) =>
      zoneId === 2 && zoneTime !== null ? { id: 2, time: zoneTime } : undefined,
    handleCommand: (zoneId: number, command: string, payload?: string) => {
      commands.push({ zoneId, command, payload });
    },
  } as any;
  const handlers = createZoneHandlers(zoneManager, {} as any, {} as any, {} as any, {} as any);
  return { handlers, commands };
}

function positionOf(response: unknown): unknown {
  // buildResponse carries the answer as { command, name, payload }; the `<name>_result` wrapper
  // is added when it is serialized for the client.
  const body = response as { payload?: Array<{ position: unknown }> };
  return body.payload?.[0]?.position;
}

test('a position read answers where the zone is, not zero', () => {
  const { handlers, commands } = harness(297);

  const response = handlers.audioDynamicCommand('audio/2/position');

  assert.equal(positionOf(response), 297, 'the read reports the real position');
  assert.deepEqual(commands, [], 'a read asks nothing to move');
});

test('a position with a value is still a seek and still echoes it', () => {
  const { handlers, commands } = harness(120);

  const response = handlers.audioDynamicCommand('audio/2/position/266');

  assert.equal(positionOf(response), 266, 'the client gets back what it asked for');
  assert.deepEqual(commands, [{ zoneId: 2, command: 'position', payload: '266' }]);
});

test('a read rounds the position the state carries', () => {
  const { handlers } = harness(12.7);
  assert.equal(positionOf(handlers.audioDynamicCommand('audio/2/position')), 13);
});

test('a read for a zone with no state is zero, never a broken number', () => {
  const { handlers } = harness(null);
  const value = positionOf(handlers.audioDynamicCommand('audio/8/position'));
  assert.equal(value, 0);
  assert.ok(Number.isFinite(value as number), 'and it is a number the client can render');
});
