import assert from 'node:assert/strict';
import { test } from './testHarness';
import { fadeController } from '../src/application/zones/fadeController';

const fadingBlob = Buffer.from('fading&fadingTime=120').toString('base64');

test('a wake-up is recognised whichever separator the Miniserver uses', () => {
  for (const command of [
    `audio/10/roomfav/play/1/?q&${fadingBlob}`,
    `audio/10/roomfav/play/1?q&${fadingBlob}`,
    `audio/10/roomfav/play/1/q&${fadingBlob}`,
    `audio/10/roomfav/play/1/?q&${fadingBlob}/`,
  ]) {
    const parsed = fadeController.parseFadeOptions(command);
    assert.equal(parsed.fade, true, `no fade detected in ${command}`);
    assert.equal(parsed.fadeDurationMs, 120_000);
  }
});

test('a plain favourite play and an unrelated parameter blob are not wake-ups', () => {
  const enforceUser = Buffer.from('enforceUser=true').toString('base64');
  assert.equal(fadeController.parseFadeOptions('audio/10/roomfav/play/1').fade, undefined);
  assert.equal(
    fadeController.parseFadeOptions(`audio/10/roomfav/play/1/?q&${enforceUser}`).fade,
    undefined,
  );
});

test('the wake-up level is the buzzer volume as a floor under the zone default', async () => {
  const cases: Array<{ volumes: { default: number; buzzer: number }; expected: number }> = [
    // The reported case: a quiet room must still wake you at the configured minimum.
    { volumes: { default: 10, buzzer: 25 }, expected: 25 },
    // And a minimum below the default must not turn the alarm down.
    { volumes: { default: 20, buzzer: 17 }, expected: 20 },
  ];

  for (const { volumes, expected } of cases) {
    const sent: string[] = [];
    let keep: boolean | undefined;
    const controller = new (Object.getPrototypeOf(fadeController).constructor)();
    controller.initOnce({
      zoneManager: {
        getZoneVolumes: () => volumes,
        handleCommand: (_zone: number, _cmd: string, payload: string) => sent.push(payload),
        keepVolumeOnNextStart: (_zone: number, value: boolean) => {
          keep = value;
        },
      },
    });

    controller.prime(10);
    assert.deepEqual(sent, ['0'], 'the room is muted before the music is asked for');
    assert.equal(keep, true, 'the muted level is claimed against the start-volume default');

    await controller.fadeIn(10, 4000);
    await new Promise((resolve) => setTimeout(resolve, 4500));
    assert.equal(sent.at(-1), String(expected));
    assert.equal(keep, false, 'the claim is handed back when the ramp ends');
    controller.cancel(10);
  }
});
