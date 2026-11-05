import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from './testHarness';
import { SendspinLineInService } from '../src/adapters/inputs/linein/sendspinLineInService';
import { sendspinCore, SourceControl } from '@sonn-audio/node-sendspin';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { AudioServerConfig, RawAudioConfig } from '../src/domain/config/types';

class FakeConfigPort implements ConfigPort {
  private readonly config: AudioServerConfig;

  constructor(config: AudioServerConfig) {
    this.config = config;
  }

  public async load(): Promise<AudioServerConfig> {
    return this.config;
  }

  public getConfig(): AudioServerConfig {
    return this.config;
  }

  public getSystemConfig(): AudioServerConfig['system'] {
    return this.config.system;
  }

  public getRawAudioConfig(): RawAudioConfig {
    return this.config.rawAudioConfig;
  }

  public ensureInputs(): void {
    /* noop */
  }

  public async updateConfig(
    mutator: (config: AudioServerConfig) => void | Promise<void>,
  ): Promise<AudioServerConfig> {
    await mutator(this.config);
    return this.config;
  }
}

class FakeHookRegistry {
  public readonly byClientId = new Map<string, any>();

  public register(clientId: string, hooks: any): () => void {
    this.byClientId.set(clientId, hooks);
    return () => {
      this.byClientId.delete(clientId);
    };
  }
}

class FakeLineInRegistry {
  public lastStarted: { inputId: string; stream: PassThrough; options: any } | null = null;
  public stopCalls: Array<{ inputId: string; reason?: string }> = [];

  public start(inputId: string, stream: PassThrough, options: any): any {
    this.lastStarted = { inputId, stream, options };
    return { id: inputId, stream, startedAt: Date.now(), bytesIn: 0, stop: () => {} };
  }

  public stop(inputId: string, reason?: string): void {
    this.stopCalls.push({ inputId, reason });
  }
}

function createConfig(): AudioServerConfig {
  return {
    system: {
      miniserver: { ip: '127.0.0.1', serial: 'miniserver' },
      audioserver: {
        ip: '127.0.0.1',
        name: 'audioserver',
        uuid: 'uuid',
        macId: 'AABBCCDDEEFF',
        paired: false,
        extensions: [],
      },
      logging: { consoleLevel: 'info', fileLevel: 'info' },
      adminHttp: { enabled: true },
    },
    content: { radio: {}, spotify: { accounts: [], bridges: [] } },
    zones: [],
    inputs: {
      lineIn: {
        inputs: [
          {
            id: 'linein-1',
            name: 'LineIn1',
            source: { type: 'sendspin', clientId: 'client-1' },
          },
        ],
      },
    },
    rawAudioConfig: {} as RawAudioConfig,
  };
}

test('SendspinLineInService resolveFormat selects first valid pcm format from advertised list', () => {
  const originalGetSession = sendspinCore.getSessionByClientId;
  const originalSendCommand = sendspinCore.sendServerCommand;
  try {
    (sendspinCore as any).getSessionByClientId = () => ({
      getSourceStreamFormat: () => null,
      getSourceSupport: () => ({
        supported_formats: [
          { codec: 'aac', sample_rate: 48000, channels: 2, bit_depth: 16 },
          { codec: 'pcm_s16le', sample_rate: 44100, channels: 2, bit_depth: 16 },
        ],
      }),
    });
    (sendspinCore as any).sendServerCommand = () => {};

    const registry = new FakeLineInRegistry();
    const hooks = new FakeHookRegistry();
    const service = new SendspinLineInService(
      registry as any,
      hooks as any,
      new FakeConfigPort(createConfig()),
    );
    service.start();

    const clientHooks = hooks.byClientId.get('client-1');
    assert.ok(clientHooks, 'missing sendspin hooks');
    clientHooks.onSourceAudio?.({} as any, { data: Buffer.alloc(8) });

    assert.ok(registry.lastStarted, 'ingest should start');
    assert.equal(registry.lastStarted?.options?.format?.sampleRate, 44100);
    assert.equal(registry.lastStarted?.options?.format?.bitDepth, 16);
    assert.equal(registry.lastStarted?.options?.format?.pcmFormat, 's16le');
  } finally {
    (sendspinCore as any).getSessionByClientId = originalGetSession;
    (sendspinCore as any).sendServerCommand = originalSendCommand;
  }
});

test('SendspinLineInService drops additional chunks while stream is backpressured', () => {
  const originalGetSession = sendspinCore.getSessionByClientId;
  const originalSendCommand = sendspinCore.sendServerCommand;
  try {
    (sendspinCore as any).getSessionByClientId = () => ({
      getSourceStreamFormat: () => null,
      getSourceSupport: () => ({
        supported_formats: [{ codec: 'pcm', sample_rate: 48000, channels: 2, bit_depth: 16 }],
      }),
    });
    (sendspinCore as any).sendServerCommand = () => {};

    const registry = new FakeLineInRegistry();
    const hooks = new FakeHookRegistry();
    const service = new SendspinLineInService(
      registry as any,
      hooks as any,
      new FakeConfigPort(createConfig()),
    );
    service.start();
    const clientHooks = hooks.byClientId.get('client-1');
    assert.ok(clientHooks, 'missing sendspin hooks');

    const chunk = Buffer.alloc(90 * 1024);
    clientHooks.onSourceAudio?.({} as any, { data: chunk });
    const stream = registry.lastStarted?.stream;
    assert.ok(stream, 'expected active line-in stream');
    const firstLength = stream.writableLength;
    assert.ok(firstLength > 0, 'expected buffered bytes after first write');

    clientHooks.onSourceAudio?.({} as any, { data: chunk });
    clientHooks.onSourceAudio?.({} as any, { data: chunk });
    assert.equal(stream.writableLength, firstLength);
  } finally {
    (sendspinCore as any).getSessionByClientId = originalGetSession;
    (sendspinCore as any).sendServerCommand = originalSendCommand;
  }
});

test('SendspinLineInService getControlSupport filters unknown control values', () => {
  const originalGetSession = sendspinCore.getSessionByClientId;
  const originalSendCommand = sendspinCore.sendServerCommand;
  try {
    (sendspinCore as any).getSessionByClientId = () => ({
      getSourceStreamFormat: () => null,
      getSourceSupport: () => ({
        controls: [SourceControl.PLAY, 999],
      }),
    });
    (sendspinCore as any).sendServerCommand = () => {};

    const service = new SendspinLineInService(
      new FakeLineInRegistry() as any,
      new FakeHookRegistry() as any,
      new FakeConfigPort(createConfig()),
    );
    service.start();

    const controls = service.getControlSupport('linein-1');
    assert.deepEqual(controls, ['play']);
  } finally {
    (sendspinCore as any).getSessionByClientId = originalGetSession;
    (sendspinCore as any).sendServerCommand = originalSendCommand;
  }
});

test('SendspinLineInService starts a wanted rc1 source again when it reports its signal present', () => {
  const originalGetSession = sendspinCore.getSessionByClientId;
  const originalSendCommand = sendspinCore.sendServerCommand;
  const sent: unknown[] = [];
  try {
    (sendspinCore as any).getSessionByClientId = () => ({
      getSourceStreamFormat: () => null,
      getSourceSupport: () => ({}),
    });
    (sendspinCore as any).sendServerCommand = (_clientId: string, payload: unknown) => sent.push(payload);

    const hooks = new FakeHookRegistry();
    const service = new SendspinLineInService(
      new FakeLineInRegistry() as any,
      hooks as any,
      new FakeConfigPort(createConfig()),
    );
    service.start();
    const clientHooks = hooks.byClientId.get('client-1');
    assert.ok(clientHooks, 'missing sendspin hooks');

    // Not wanted: a source with signal is not started just because it has some.
    clientHooks.onSourceSignalChanged?.({} as any, 'present');
    assert.deepEqual(sent, []);

    service.requestStart('linein-1');
    sent.length = 0;
    // A reconnected source reports its signal afresh; its new session never got the start.
    clientHooks.onSourceSignalChanged?.({} as any, 'present');
    assert.deepEqual(sent, [{ source: { command: 'start' } }]);

    // Absent ends nothing; the source closes its own stream.
    sent.length = 0;
    clientHooks.onSourceSignalChanged?.({} as any, 'absent');
    assert.deepEqual(sent, []);

    service.requestStop('linein-1');
    sent.length = 0;
    clientHooks.onSourceSignalChanged?.({} as any, 'present');
    assert.deepEqual(sent, [], 'a deselected input is not started again');
  } finally {
    (sendspinCore as any).getSessionByClientId = originalGetSession;
    (sendspinCore as any).sendServerCommand = originalSendCommand;
  }
});
