import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from './testHarness';
import {
  PowerManager,
  SystemPowerManagerExecutor,
  normalizePowerManagerConfig,
  type PowerCommandRunner,
  type PowerManagerExecutor,
} from '../src/application/zones/services/powerManager';

type Call = { type: string; signal: 0 | 1 };

class FakeExecutor implements PowerManagerExecutor {
  public calls: Call[] = [];

  public async execute(action: { type: string }, signal: 0 | 1): Promise<void> {
    this.calls.push({ type: action.type, signal });
  }
}

const noopLogger = {
  debug: () => {},
  spam: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  isEnabled: () => false,
} as any;

const baseState = { mode: 'stop' } as any;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('power manager keeps default off delay aligned with admin UI', () => {
  const normalized = normalizePowerManagerConfig(null);
  assert.equal(normalized.offDelayMs, 300000);

  const explicitImmediate = normalizePowerManagerConfig({ offDelayMs: 0 });
  assert.equal(explicitImmediate.offDelayMs, 0);
});

test('explicit power commands apply immediately despite the automatic off delay', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.forceSignal(1, zoneConfig, 0);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'url', signal: 1 },
    { type: 'url', signal: 0 },
  ]);
});

test('power manager stays active for state tracking when no config exists', async () => {
  const executor = new FakeExecutor();
  const signalUpdates: Array<{ zoneId: number; signal: 0 | 1 }> = [];
  const pm = new PowerManager(noopLogger, executor, (zoneId, signal) => {
    signalUpdates.push({ zoneId, signal });
  });
  pm.onStatePatch(
    1,
    { id: 1, name: 'Living', sourceMac: '00:00:00:00:00:01', volumes: {} as any } as any,
    { mode: 'play' } as any,
    { ...baseState, mode: 'play' } as any,
  );
  await wait(10);
  pm.onStatePatch(
    1,
    { id: 1, name: 'Living', sourceMac: '00:00:00:00:00:01', volumes: {} as any } as any,
    { mode: 'stop' } as any,
    { ...baseState, mode: 'stop' } as any,
  );
  await wait(10);
  assert.equal(executor.calls.length, 0);
  assert.deepEqual(signalUpdates, [{ zoneId: 1, signal: 1 }]);
  pm.clearAll();
});

test('power manager runs all configured action types', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayMs: 0,
      gpio: { enabled: true, pin: 21 },
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
      udp: { enabled: true, host: '127.0.0.1', port: 1234, onPayload: 'ON', offPayload: 'OFF' },
      crelay: { enabled: true, serial: '/dev/ttyUSB0', relay: '1' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
    { type: 'udp', signal: 1 },
    { type: 'crelay', signal: 1 },
  ]);

  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
    { type: 'udp', signal: 1 },
    { type: 'crelay', signal: 1 },
    { type: 'gpio', signal: 0 },
    { type: 'url', signal: 0 },
    { type: 'udp', signal: 0 },
    { type: 'crelay', signal: 0 },
  ]);
});

test('power manager forwards gpio backend details to executor', async () => {
  const calls: Array<{ type: string; signal: 0 | 1; action: any }> = [];
  const executor: PowerManagerExecutor = {
    async execute(action: any, signal: 0 | 1): Promise<void> {
      calls.push({ type: action.type, signal, action });
    },
  };
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      gpio: {
        enabled: true,
        pin: 22,
        driver: 'gpioset',
        chip: 'gpiochip4',
        gpiosetPath: '/usr/bin/gpioset',
      },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);

  assert.deepEqual(calls, [
    {
      type: 'gpio',
      signal: 1,
      action: {
        type: 'gpio',
        config: {
          pin: 22,
          activeHigh: true,
          chip: 'gpiochip4',
          gpiosetPath: '/usr/bin/gpioset',
        },
      },
    },
  ]);
});

test('power manager accepts crelay without serial', async () => {
  const calls: Array<{ type: string; signal: 0 | 1; action: any }> = [];
  const executor: PowerManagerExecutor = {
    async execute(action: any, signal: 0 | 1): Promise<void> {
      calls.push({ type: action.type, signal, action });
    },
  };
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      crelay: { enabled: true, relay: '1' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);

  assert.deepEqual(calls, [
    {
      type: 'crelay',
      signal: 1,
      action: {
        type: 'crelay',
        config: {
          serial: null,
          relay: '1',
          binaryPath: '/usr/local/bin/crelay',
        },
      },
    },
  ]);
});

test('system power manager sends Basic Auth for URL credentials', async () => {
  const executor = new SystemPowerManagerExecutor();
  let authorization: string | undefined;
  await withHttpServer(
    (req, res) => {
      authorization = req.headers.authorization;
      res.writeHead(200);
      res.end('ok');
    },
    async (baseUrl) => {
      const target = baseUrl.replace('://', '://user:p%40ss@');
      await executor.execute(
        {
          type: 'url' as const,
          config: {
            onUrl: `${target}/dev/sps/io/Amp/Ein`,
            onMethod: 'GET',
            onBody: null,
            offUrl: '',
            offMethod: 'GET',
            offBody: null,
          },
        },
        1,
      );
    },
  );

  assert.equal(authorization, `Basic ${Buffer.from('user:p@ss').toString('base64')}`);
});

test('system power manager reports URL client errors as failures', async () => {
  const executor = new SystemPowerManagerExecutor();
  await withHttpServer(
    (_req, res) => {
      res.writeHead(401);
      res.end('unauthorized');
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          executor.execute(
            {
          type: 'url' as const,
          config: {
            onUrl: `${baseUrl}/dev/sps/io/Amp/Ein`,
            onMethod: 'GET',
            onBody: null,
            offUrl: '',
            offMethod: 'GET',
            offBody: null,
          },
        },
            1,
          ),
        /http 401/,
      );
    },
  );
});

test('system power manager supports method and JSON body for an off-only URL', async () => {
  const executor = new SystemPowerManagerExecutor();
  let method: string | undefined;
  let contentType: string | undefined;
  let body = '';
  await withHttpServer(
    (req, res) => {
      method = req.method;
      contentType = req.headers['content-type'];
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    },
    async (baseUrl) => {
      const config = normalizePowerManagerConfig({
        url: {
          enabled: true,
          onUrl: '',
          offUrl: `${baseUrl}/BeoDevice/powerManagement/standby`,
          offMethod: 'PUT',
          offBody: { standby: { powerState: 'standby' } },
        },
      });
      assert.deepEqual(config.actions, [
        {
          type: 'url',
          config: {
            onUrl: '',
            onMethod: 'GET',
            onBody: null,
            offUrl: `${baseUrl}/BeoDevice/powerManagement/standby`,
            offMethod: 'PUT',
            offBody: '{"standby":{"powerState":"standby"}}',
          },
        },
      ]);
      await executor.execute(config.actions[0]!, 0);
      await executor.execute(config.actions[0]!, 1);
    },
  );

  assert.equal(method, 'PUT');
  assert.equal(contentType, 'application/json');
  assert.equal(body, '{"standby":{"powerState":"standby"}}');
});

test('power manager applies off delay and cancels pending off when play resumes', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayMs: 40,
      gpio: { enabled: true, pin: 21 },
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(20);
  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(50);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'url', signal: 1 },
  ]);
});

test('a zone going idle does not switch off a relay another playing zone shares (#359)', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  // Two zones pointed at the same relay channel, no shared power group configured.
  const relayZone = (id: number, name: string) =>
    ({
      id,
      name,
      sourceMac: `00:00:00:00:00:${id}`,
      volumes: {} as any,
      powerManager: { offDelayMs: 30, crelay: { enabled: true, relay: '1' } },
    }) as any;
  const flur = relayZone(13, 'Flur');
  const kueche = relayZone(14, 'Küche');
  const patch = (zone: any, mode: string) =>
    pm.onStatePatch(zone.id, zone, { mode } as any, { ...baseState, mode } as any);

  // Flur plays radio, Küche is paused; a doorbell plays in both, then each is restored.
  patch(flur, 'play');
  patch(kueche, 'pause');
  await wait(60);
  patch(flur, 'stop');
  patch(kueche, 'play');
  await wait(10);
  patch(flur, 'play');
  patch(kueche, 'pause');
  await wait(60);

  // Küche's idle off would have cut the relay under Flur, which never sent ON again.
  assert.deepEqual(
    executor.calls.filter((call) => call.signal === 0),
    [],
  );
  assert.equal(pm.isSignalOn(13), true);
  assert.equal(pm.isSignalOn(14), false);

  // Once the last zone on the relay goes idle, it is switched off.
  patch(flur, 'stop');
  await wait(60);
  assert.deepEqual(executor.calls.at(-1), { type: 'crelay', signal: 0 });
});

test('power manager delays pause off by default', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [{ type: 'gpio', signal: 1 }]);
  pm.clearAll();
});

test('power manager can stay on during pause via activeModes', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      activeModes: ['play', 'pause'],
      offDelayMs: 0,
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('power manager does not latch a failed switch and retries on the next OFF (#293)', async () => {
  // A crelay OFF that fails (e.g. "unable to open HID API device") must not be recorded as
  // applied; otherwise the relay stays physically energized while the manager thinks it is off
  // and never retries. The signal stays unconfirmed so the next OFF transition tries again.
  class FlakyOffExecutor implements PowerManagerExecutor {
    public calls: Call[] = [];
    private offAttempts = 0;
    public async execute(action: { type: string }, signal: 0 | 1): Promise<void> {
      this.calls.push({ type: action.type, signal });
      if (signal === 0) {
        this.offAttempts += 1;
        if (this.offAttempts === 1) {
          throw new Error('unable to open HID API device');
        }
      }
    }
  }

  const executor = new FlakyOffExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayMs: 0,
      crelay: { enabled: true, relay: '1' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  assert.equal(pm.isSignalOn(1), true);

  // OFF fails: relay must still be considered ON so a later OFF retries.
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  assert.equal(pm.isSignalOn(1), true);

  // Play again (relay already on → no redundant ON), then stop again → OFF retried, succeeds.
  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'crelay', signal: 1 },
    { type: 'crelay', signal: 0 },
    { type: 'crelay', signal: 0 },
  ]);
  assert.equal(pm.isSignalOn(1), false);
  pm.clearAll();
});

test('system power manager serializes concurrent calls to the same device (#293)', async () => {
  // Two managers driving channels on the same relay card share one executor; concurrent
  // opens of the same HID device collide. The executor must serialize per device so at most
  // one call runs at a time.
  const executor = new SystemPowerManagerExecutor();
  let active = 0;
  let maxActive = 0;
  await withHttpServer(
    (_req, res) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        res.writeHead(200);
        res.end('ok');
      }, 40);
    },
    async (baseUrl) => {
      const action = { type: 'url', config: { onUrl: `${baseUrl}/on`, offUrl: '' } } as const;
      await Promise.all([
        executor.execute(action as any, 1),
        executor.execute(action as any, 1),
        executor.execute(action as any, 1),
      ]);
    },
  );
  assert.equal(maxActive, 1);
});

function gpioAction(overrides: Partial<{ pin: number; activeHigh: boolean; chip: string; gpiosetPath: string }> = {}) {
  return {
    type: 'gpio',
    config: {
      pin: 62,
      activeHigh: true,
      chip: 'gpiochip0',
      gpiosetPath: 'gpioset',
      ...overrides,
    },
  } as any;
}

test('system power manager uses v1 gpioset arguments on libgpiod v1 (#354)', async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: PowerCommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { stdout: args[0] === '--version' ? 'gpioset (libgpiod) v1.6.3\n' : '', stderr: '' };
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await executor.execute(gpioAction(), 1);

  assert.deepEqual(calls, [
    { file: 'gpioset', args: ['--version'] },
    { file: 'gpioset', args: ['/dev/gpiochip0', '62=1'] },
  ]);
});

test('system power manager uses v2 gpioset arguments on libgpiod v2 (#354)', async () => {
  // Trixie ships libgpiod v2: the chip must be passed via -c, and -t0 makes gpioset set the
  // value and exit instead of holding the line forever.
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: PowerCommandRunner = async (file, args) => {
    calls.push({ file, args });
    return { stdout: args[0] === '--version' ? 'gpioset (libgpiod) v2.2.1\n' : '', stderr: '' };
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await executor.execute(gpioAction({ pin: 21, activeHigh: false }), 1);

  assert.deepEqual(calls, [
    { file: 'gpioset', args: ['--version'] },
    { file: 'gpioset', args: ['-t', '0', '-c', '/dev/gpiochip0', '21=0'] },
  ]);
});

test('system power manager probes the gpioset version once per binary (#354)', async () => {
  let versionProbes = 0;
  const runner: PowerCommandRunner = async (_file, args) => {
    if (args[0] === '--version') {
      versionProbes += 1;
      return { stdout: 'gpioset (libgpiod) v2.2.1\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await executor.execute(gpioAction(), 1);
  await executor.execute(gpioAction(), 0);

  assert.equal(versionProbes, 1);
});

test('system power manager falls back to v1 gpioset arguments when the probe fails (#354)', async () => {
  const calls: Array<string[]> = [];
  const runner: PowerCommandRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === '--version') {
      throw new Error('spawn gpioset ENOENT');
    }
    return { stdout: '', stderr: '' };
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await executor.execute(gpioAction(), 1);
  // A failed probe is not cached, so the next write probes again.
  await executor.execute(gpioAction(), 0);

  assert.deepEqual(calls, [
    ['--version'],
    ['/dev/gpiochip0', '62=1'],
    ['--version'],
    ['/dev/gpiochip0', '62=0'],
  ]);
});

test('system power manager retries crelay on transient HID errors (#293)', async () => {
  let attempts = 0;
  const runner: PowerCommandRunner = async (_file, _args) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error('Command failed: crelay 1 ON\nunable to open HID API device');
    }
    return undefined;
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await executor.execute(
    { type: 'crelay', config: { serial: null, relay: '1', binaryPath: '/usr/local/bin/crelay' } } as any,
    1,
  );
  // One transient failure + one success = two attempts.
  assert.equal(attempts, 2);
});

test('system power manager gives up crelay after the retry budget (#293)', async () => {
  let attempts = 0;
  const runner: PowerCommandRunner = async () => {
    attempts += 1;
    throw new Error('unable to open HID API device');
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await assert.rejects(
    () =>
      executor.execute(
        { type: 'crelay', config: { serial: null, relay: '1', binaryPath: '/usr/local/bin/crelay' } } as any,
        0,
      ),
    /unable to open HID API device/,
  );
  // Bounded to three attempts total.
  assert.equal(attempts, 3);
});

test('system power manager does not retry crelay on a non-transient error (#293)', async () => {
  let attempts = 0;
  const runner: PowerCommandRunner = async () => {
    attempts += 1;
    throw new Error('crelay: invalid relay number');
  };
  const executor = new SystemPowerManagerExecutor(runner);
  await assert.rejects(() =>
    executor.execute(
      { type: 'crelay', config: { serial: null, relay: '9', binaryPath: '/usr/local/bin/crelay' } } as any,
      1,
    ),
  );
  assert.equal(attempts, 1);
});

test('power manager ignores offDelayMs when offDelayEnabled is false', async () => {
  const executor = new FakeExecutor();
  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayEnabled: false,
      offDelayMs: 1000,
      gpio: { enabled: true, pin: 21 },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(20);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('a zone that flips back mid-switch does not leave the relay stuck (#359)', async () => {
  // Switching takes real time. Every alert flips the zone twice in quick succession —
  // the player stops, the restore starts it again — so the "on" can land while the "off"
  // is still executing. The books then said on while the relay was off, and the equality
  // guards suppressed the correction: the room played on in silence.
  let releaseOff: (() => void) | undefined;
  const calls: Array<{ signal: 0 | 1 }> = [];
  const executor: PowerManagerExecutor = {
    execute: async (_action, signal) => {
      calls.push({ signal });
      if (signal === 0 && !releaseOff) {
        await new Promise<void>((resolve) => {
          releaseOff = resolve;
        });
      }
    },
  };

  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    // "Switch off immediately" — the setting that makes every alert race.
    powerManager: {
      offDelayEnabled: false,
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' }, { mode: 'play' } as any);
  await wait(10);
  assert.deepEqual(calls, [{ signal: 1 }]);

  // The alert stops the player: off starts switching and hangs there.
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' }, { mode: 'stop' } as any);
  await wait(10);
  assert.deepEqual(calls, [{ signal: 1 }, { signal: 0 }]);

  // The alert restores playback while that off is still in flight.
  pm.onStatePatch(1, zoneConfig, { mode: 'play' }, { mode: 'play' } as any);
  await wait(10);

  releaseOff?.();
  await wait(20);

  // The relay must end up back on, matching the zone that is playing again.
  assert.deepEqual(calls, [{ signal: 1 }, { signal: 0 }, { signal: 1 }]);
  assert.equal(pm.isSignalOn(1), true);
});

test('an on that lands mid-switch still honours the idle delay for the following off (#359)', async () => {
  // The mirror case: the zone stops while the "on" is still executing. Correcting course
  // must not short-circuit the idle delay and cut the amp the instant it settled.
  let releaseOn: (() => void) | undefined;
  const calls: Array<{ signal: 0 | 1 }> = [];
  const executor: PowerManagerExecutor = {
    execute: async (_action, signal) => {
      calls.push({ signal });
      if (signal === 1 && !releaseOn) {
        await new Promise<void>((resolve) => {
          releaseOn = resolve;
        });
      }
    },
  };

  const pm = new PowerManager(noopLogger, executor);
  const zoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {} as any,
    powerManager: {
      offDelayMs: 60_000,
      url: { enabled: true, onUrl: 'http://amp/on', offUrl: 'http://amp/off' },
    },
  } as any;

  pm.onStatePatch(1, zoneConfig, { mode: 'play' }, { mode: 'play' } as any);
  await wait(10);
  pm.onStatePatch(1, zoneConfig, { mode: 'stop' }, { mode: 'stop' } as any);
  await wait(10);

  releaseOn?.();
  await wait(20);

  // On applied, off left waiting out the minute rather than fired on the spot.
  assert.deepEqual(calls, [{ signal: 1 }]);
  assert.equal(pm.isSignalOn(1), true);
});
