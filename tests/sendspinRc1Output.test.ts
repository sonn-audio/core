import assert from 'node:assert/strict';
import { Roles, sendspinCore, type SendspinSession, type SendspinSessionHooks } from '@sonn-audio/node-sendspin';
import { test } from './testHarness';
import { buildZoneOutputs } from '../src/adapters/outputs/factory';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import { makeOutputPortsFake } from './fakes/outputPorts';

/*
 * How a sendspin output drives an rc1 client through node-sendspin: what a pause, a stop and
 * the client's own rc1 messages turn into. Every `sendspinCore` method is stubbed and recorded,
 * so these pin the calls core makes, not the wire node-sendspin writes for them.
 */

type Call = [string, ...unknown[]];

/** Replace every method of `sendspinCore` with a recorder; `answers` gives return values. */
function stubCore(answers: Record<string, (...args: unknown[]) => unknown> = {}): {
  calls: Call[];
  restore: () => void;
} {
  const calls: Call[] = [];
  const core = sendspinCore as unknown as Record<string, unknown>;
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(core); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor' && typeof core[name] === 'function') names.add(name);
    }
  }
  for (const name of names) {
    core[name] = (...args: unknown[]) => {
      calls.push([name, ...args]);
      return answers[name] ? answers[name](...args) : undefined;
    };
  }
  return {
    calls,
    restore: () => {
      for (const name of names) delete core[name];
    },
  };
}

function makeZone(transport: Record<string, unknown>): ZoneConfig {
  return {
    id: 7,
    name: 'Kitchen',
    sourceMac: '00:11:22:33:44:07',
    transports: [{ id: 'sendspin', ...transport } as never],
    volumes: {
      default: 30,
      alarm: 50,
      fire: 50,
      bell: 50,
      buzzer: 50,
      tts: 50,
      volstep: 2,
      fading: 0,
      maxVolume: 100,
    },
    inputs: {
      airplay: { enabled: false },
      spotify: { enabled: false },
      musicassistant: { enabled: false },
      lineIn: { enabled: false },
    },
  };
}

type Output = Record<string, any>;

interface Harness {
  output: Output;
  ports: OutputPorts;
  hooks: Map<string, SendspinSessionHooks>;
  session: (clientId: string, extra?: Record<string, unknown>) => SendspinSession;
}

function build(
  transport: Record<string, unknown> = { clientId: 'kitchen' },
  configure: (ports: OutputPorts) => void = () => {},
): Harness {
  const ports = makeOutputPortsFake({} as ConfigPort);
  const hooks = new Map<string, SendspinSessionHooks>();
  ports.sendspinHooks = {
    register: (clientId, clientHooks) => {
      hooks.set(clientId, clientHooks);
      return () => {};
    },
  };
  configure(ports);
  const output = buildZoneOutputs(makeZone(transport), ports).find((o) => o.type === 'sendspin') as Output;
  const sessions = new Map<string, SendspinSession>();
  const session = (clientId: string, extra: Record<string, unknown> = {}): SendspinSession => {
    let found = sessions.get(clientId);
    if (!found) {
      found = {
        getClientId: () => clientId,
        getRoles: () => [Roles.PLAYER],
        getLastGoodbyeReason: () => null,
        getStreamFormat: () => ({ codec: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 }),
        getPlayerPreferredFormat: () => null,
        sendServerCommand: () => {},
        ...extra,
      } as unknown as SendspinSession;
      sessions.set(clientId, found);
    }
    return found;
  };
  return { output, ports, hooks, session };
}

const named = (calls: Call[], ...names: string[]): Call[] => calls.filter(([name]) => names.includes(name));

test('sendspin rc1: a pause ends playback but keeps the cover on the client and its satellites', async () => {
  const core = stubCore();
  try {
    const { output, hooks, session } = build({ clientId: 'kitchen', satellites: ['kitchen-sub'] });
    output.isOwner = () => true;
    hooks.get('kitchen-sub')?.onIdentified?.(session('kitchen-sub'), null);
    core.calls.length = 0;

    await output.pause(null);

    assert.deepEqual(named(core.calls, 'sendStreamEnd', 'endPlaybackStreams', 'sendStreamClear'), [
      ['endPlaybackStreams', 'kitchen'],
      ['sendStreamClear', 'kitchen', ['player']],
      ['endPlaybackStreams', 'kitchen-sub'],
      ['sendStreamClear', 'kitchen-sub', ['player']],
    ], 'a role-less stream/end would end the artwork stream, and an rc1 display blanks with it');
    output.teardown();
  } finally {
    core.restore();
  }
});

test('sendspin rc1: a stop withdraws the playback activity, a pause keeps it', async () => {
  const core = stubCore();
  try {
    const { output, hooks, session } = build({ clientId: 'kitchen', satellites: ['kitchen-sub'] });
    output.isOwner = () => true;
    output.releaseOwnership = () => {};
    hooks.get('kitchen-sub')?.onIdentified?.(session('kitchen-sub'), null);
    core.calls.length = 0;

    await output.pause(null);
    assert.deepEqual(named(core.calls, 'setPlaybackActive'), [], 'a paused group still holds its clients');

    await output.stop(null);
    assert.deepEqual(named(core.calls, 'setPlaybackActive'), [
      ['setPlaybackActive', 'kitchen', false],
      ['setPlaybackActive', 'kitchen-sub', false],
    ]);
  } finally {
    core.restore();
  }
});

test('sendspin rc1: a client held idle for pairing is reported, and cleared once it may play', () => {
  const core = stubCore();
  try {
    const noted: Array<[string, unknown]> = [];
    const { hooks, session } = build({ clientId: 'kitchen' }, (ports) => {
      ports.sendspinConnector = {
        ...ports.sendspinConnector,
        notePairingRequired: (clientId: string, reason: unknown) => noted.push([clientId, reason]),
      } as never;
    });
    const idle = session('kitchen', { getPairingRequired: () => 'unpaired_access_disabled' });
    hooks.get('kitchen')?.onPairingRequired?.(idle, 'unpaired_access_disabled');
    hooks.get('kitchen')?.onIdentified?.(idle, null);
    assert.deepEqual(noted, [
      ['kitchen', 'unpaired_access_disabled'],
      ['kitchen', 'unpaired_access_disabled'],
    ], 'heard from the hook and again on identify, for an output that registered too late for the hook');

    hooks.get('kitchen')?.onDisconnected?.(idle);
    hooks.get('kitchen')?.onIdentified?.(session('kitchen#2', { getClientId: () => 'kitchen', getPairingRequired: () => null }), null);
    assert.deepEqual(noted.at(-1), ['kitchen', null]);
  } finally {
    core.restore();
  }
});

test('sendspin rc1: the format a player states it prefers is the one advertised and streamed', () => {
  const core = stubCore();
  try {
    const clientId = 'rc1-preferred-format';
    const { output, hooks, session } = build({ clientId });
    let preferred: unknown = null;
    const live = session(clientId, { getPlayerPreferredFormat: () => preferred });
    hooks.get(clientId)?.onIdentified?.(live, null);
    const before = output.getPreferredOutput();

    // Stated in client/state while nothing streams: node-sendspin fires no onFormatChanged then.
    preferred = { codec: 'pcm', sampleRate: 96000, channels: 2, bitDepth: 24 };
    assert.deepEqual(
      { sampleRate: output.getPreferredOutput().sampleRate, bitDepth: output.getPreferredOutput().bitDepth },
      { sampleRate: 96000, bitDepth: 24 },
      `still advertising ${before.sampleRate}/${before.bitDepth} after the player stated its preference`,
    );
    // startStream takes it as a request from the client, and remembers it like one.
    assert.equal(output.rememberPreferredFormat()?.sampleRate, 96000);
    assert.equal(output.lastClientNegotiatedFormat?.sampleRate, 96000);

    preferred = null;
    assert.equal(output.rememberPreferredFormat(), null, 'no preference stated, nothing requested');
  } finally {
    core.restore();
  }
});
