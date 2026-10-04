import assert from 'node:assert/strict';
import { sendspinCore, type SendspinSession, type SendspinSessionHooks } from '@sonn-audio/node-sendspin';
import { test } from './testHarness';
import { buildZoneOutputs } from '../src/adapters/outputs/factory';
import { AudioAnalysisService, type AudioAnalysisListener } from '../src/application/audio/audioAnalysisService';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';
import { makeOutputPortsFake } from './fakes/outputPorts';

const CORE_METHODS = [
  'getVisualizerSupport',
  'sendVisualizerStreamStartV1',
  'sendVisualizerLoudness',
  'sendStreamStart',
  'sendPcmFrameToClient',
] as const;

const LIGHT_SUPPORT = { types: ['loudness'], rate_max: 30 };

/**
 * Stub the Sendspin core: only the clients in `visualizers` declare visualizer@v1, and every call
 * is recorded as `[method, clientId]`.
 */
function stubCore(visualizers: string[]): { calls: Array<[string, unknown]>; restore: () => void } {
  const calls: Array<[string, unknown]> = [];
  const core = sendspinCore as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of CORE_METHODS) {
    saved.set(name, Object.getOwnPropertyDescriptor(core, name) ? core[name] : undefined);
    core[name] = (clientId: unknown) => {
      calls.push([name, clientId]);
      if (name === 'getVisualizerSupport') {
        return visualizers.includes(clientId as string) ? LIGHT_SUPPORT : null;
      }
      return undefined;
    };
  }
  return {
    calls,
    restore: () => {
      for (const name of CORE_METHODS) {
        const had = saved.get(name);
        if (had === undefined) delete core[name];
        else core[name] = had;
      }
    },
  };
}

function makeZone(): ZoneConfig {
  return {
    id: 1,
    name: 'Sauna',
    sourceMac: '00:11:22:33:44:01',
    transports: [{ id: 'sendspin', clientId: 'sauna-audio', satellites: ['sauna-licht'] } as never],
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

interface Harness {
  output: Record<string, unknown> & {
    setupVisualizer(isPcm: boolean, sampleRate: number, channels: number, bitDepth: number): void;
    teardown(): void;
  };
  listeners: AudioAnalysisListener[];
  connect(clientId: string): void;
  disconnect(clientId: string): void;
}

function build(): Harness {
  const ports = makeOutputPortsFake({} as ConfigPort);
  const listeners: AudioAnalysisListener[] = [];
  ports.audioAnalysis = new AudioAnalysisService((_options, listener) => {
    listeners.push(listener);
    return { push: () => {} };
  });
  const hooks = new Map<string, SendspinSessionHooks>();
  const sessions = new Map<string, SendspinSession>();
  ports.sendspinHooks = {
    register: (clientId, clientHooks) => {
      hooks.set(clientId, clientHooks);
      return () => {};
    },
  };
  const outputs = buildZoneOutputs(makeZone(), ports);
  const output = outputs.find((o) => o.type === 'sendspin') as unknown as Harness['output'];
  const sessionFor = (clientId: string): SendspinSession => {
    let session = sessions.get(clientId);
    if (!session) {
      session = { getClientId: () => clientId, sendServerCommand: () => {} } as unknown as SendspinSession;
      sessions.set(clientId, session);
    }
    return session;
  };
  return {
    output,
    listeners,
    connect: (clientId) => hooks.get(clientId)?.onIdentified?.(sessionFor(clientId), null),
    disconnect: (clientId) => hooks.get(clientId)?.onDisconnected?.(sessionFor(clientId)),
  };
}

const loudnessTargets = (calls: Array<[string, unknown]>): unknown[] =>
  calls.filter(([name]) => name === 'sendVisualizerLoudness').map(([, clientId]) => clientId);

test('a satellite that declares visualizer@v1 is sent frames when the speaker declares none', () => {
  const core = stubCore(['sauna-licht']);
  try {
    const { output, listeners, connect } = build();
    connect('sauna-licht');
    output.setupVisualizer(true, 48000, 2, 16);

    assert.ok(core.calls.some(([name, id]) => name === 'sendVisualizerStreamStartV1' && id === 'sauna-licht'));
    assert.equal(listeners.length, 1, 'one analyzer, for the one client that asked');
    listeners[0]!({ type: 'loudness', value: 0.5, timestampUs: 1 } as never);
    assert.deepEqual(loudnessTargets(core.calls), ['sauna-licht']);
    output.teardown();
  } finally {
    core.restore();
  }
});

test('the speaker and a satellite that both ask each get their own frames', () => {
  const core = stubCore(['sauna-audio', 'sauna-licht']);
  try {
    const { output, listeners, connect } = build();
    connect('sauna-licht');
    output.setupVisualizer(true, 48000, 2, 16);

    assert.equal(listeners.length, 2);
    for (const listener of listeners) {
      listener({ type: 'loudness', value: 0.5, timestampUs: 1 } as never);
    }
    assert.deepEqual(loudnessTargets(core.calls).sort(), ['sauna-audio', 'sauna-licht']);
    output.teardown();
  } finally {
    core.restore();
  }
});

test('a satellite that joins a running stream is asked, and is let go when it leaves', () => {
  const core = stubCore(['sauna-licht']);
  try {
    const { output, listeners, connect, disconnect } = build();
    output.setupVisualizer(true, 48000, 2, 16);
    assert.equal(listeners.length, 0, 'nobody connected has asked yet');

    // A running stream, as the satellite's late-join sees it.
    output.playbackState = 'playing';
    output.isOwner = () => true;
    output.activeOutputFormat = { codec: 'pcm', sampleRate: 48000, channels: 2, bitDepth: 16 };
    connect('sauna-licht');
    assert.ok(core.calls.some(([name, id]) => name === 'sendVisualizerStreamStartV1' && id === 'sauna-licht'));
    assert.equal(listeners.length, 1);

    disconnect('sauna-licht');
    assert.equal((output.analysisSubscriptions as Map<string, unknown>).size, 0);
    output.teardown();
  } finally {
    core.restore();
  }
});

test('a satellite gets no visualizer stream when the zone is not playing PCM', () => {
  const core = stubCore(['sauna-licht']);
  try {
    const { output, listeners, connect } = build();
    connect('sauna-licht');
    output.setupVisualizer(false, 48000, 2, 16);
    assert.equal(listeners.length, 0);
    assert.ok(!core.calls.some(([name]) => name === 'sendVisualizerStreamStartV1'));
    output.teardown();
  } finally {
    core.restore();
  }
});
