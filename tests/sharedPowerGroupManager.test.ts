import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SharedPowerGroupManager } from '../src/application/zones/services/sharedPowerGroupManager';
import type { PowerManagerExecutor } from '../src/application/zones/services/powerManager';

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

test('shared power group turns on while any member zone is active', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          offDelayMs: 0,
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
      {
        id: 2,
        name: 'Kitchen',
        sourceMac: '00:00:00:00:00:02',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(2, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  manager.onStatePatch(2, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('shared power group respects member activeModes during pause', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          offDelayMs: 0,
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living', activeModes: ['play', 'pause'] },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'pause' } as any, { ...baseState, mode: 'pause' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('shared power group applies offDelayMs only to the final OFF transition', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          offDelayMs: 40,
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [{ type: 'gpio', signal: 1 }]);

  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  assert.deepEqual(executor.calls, [{ type: 'gpio', signal: 1 }]);

  await wait(50);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('shared power group does not latch a failed OFF and retries it (#293)', async () => {
  // The relay card open can fail intermittently; a failed OFF must leave the group marked ON
  // so a later OFF transition retries instead of leaving the amp stuck energized.
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
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: { offDelayMs: 0, crelay: { enabled: true, relay: '1' } },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  // OFF failed; turning on then off again must re-attempt the OFF.
  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);

  assert.deepEqual(executor.calls, [
    { type: 'crelay', signal: 1 },
    { type: 'crelay', signal: 0 },
    { type: 'crelay', signal: 0 },
  ]);
});

test('shared power group cancels pending offDelayMs when another zone becomes active again', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [
      {
        id: 'amp-living',
        powerManager: {
          offDelayMs: 50,
          gpio: { enabled: true, pin: 22 },
        },
      },
    ],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
      {
        id: 2,
        name: 'Kitchen',
        sourceMac: '00:00:00:00:00:02',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(20);
  manager.onStatePatch(2, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(50);
  manager.onStatePatch(2, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(60);

  assert.deepEqual(executor.calls, [
    { type: 'gpio', signal: 1 },
    { type: 'gpio', signal: 0 },
  ]);
});

test('a group whose last zone returns mid-switch does not leave the relay stuck (#359)', async () => {
  // Same race as the per-zone relay: an alert stops the only active zone and restores it
  // while the group's "off" is still executing. Latching only when the group still wanted
  // that signal left the relay off with the books saying on, and nothing put it right.
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

  const manager = new SharedPowerGroupManager(noopLogger, executor);
  manager.configure(
    [{ id: 'amp-living', powerManager: { offDelayMs: 0, gpio: { enabled: true, pin: 22 } } }],
    [
      {
        id: 1,
        name: 'Living',
        sourceMac: '00:00:00:00:00:01',
        volumes: {} as any,
        powerManager: { powerGroupId: 'amp-living' },
      } as any,
    ],
  );

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  assert.deepEqual(calls, [{ signal: 1 }]);

  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  assert.deepEqual(calls, [{ signal: 1 }, { signal: 0 }]);

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);

  releaseOff?.();
  await wait(20);

  assert.deepEqual(calls, [{ signal: 1 }, { signal: 0 }, { signal: 1 }]);
});

test('a shared power group carries its wake-up delay and tells members when its amp is on (#402)', async () => {
  const executor = new FakeExecutor();
  const manager = new SharedPowerGroupManager(noopLogger, executor);
  const zone = (id: number, powerGroupId?: string) =>
    ({
      id,
      name: `Zone ${id}`,
      sourceMac: `00:00:00:00:00:0${id}`,
      volumes: {} as any,
      powerManager: powerGroupId ? { powerGroupId } : undefined,
    }) as any;
  manager.configure(
    [
      {
        id: 'amp',
        powerManager: {
          playbackPreDelayMs: 1500,
          offDelayMs: 50,
          crelay: { enabled: true, relay: '1' },
        },
      },
    ],
    [zone(1, 'amp'), zone(2, 'amp'), zone(3)],
  );

  assert.equal(manager.getZoneWakeUpMs(1), 1500);
  assert.equal(manager.getZoneWakeUpMs(3), 0);
  assert.equal(manager.isZoneGroupOn(3), null);
  assert.equal(manager.isZoneGroupOn(2), false);

  manager.onStatePatch(1, { mode: 'play' } as any, { ...baseState, mode: 'play' } as any);
  await wait(10);
  // Zone 2 starting now finds the amp already on and need not wait for it.
  assert.equal(manager.isZoneGroupOn(2), true);

  manager.onStatePatch(1, { mode: 'stop' } as any, { ...baseState, mode: 'stop' } as any);
  await wait(10);
  // Still on through the standby timeout...
  assert.equal(manager.isZoneGroupOn(2), true);
  await wait(80);
  // ...and cold again once it has switched off.
  assert.equal(manager.isZoneGroupOn(2), false);
});
