import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AlertsManager } from '../src/application/alerts/alertsManager';

test('wecker alert uses alarm-clock volume slot', async () => {
  const starts: Array<{ zoneId: number; type: string; volume: number }> = [];
  const manager = new AlertsManager();
  // Resolving real alert media probes the file's duration by spawning ffmpeg, and
  // the suite replaces `spawn` with a fake that only exits when killed — so an
  // unstubbed provider leaves this await pending forever, which silently ends the
  // whole run (Node exits 0 once the loop drains). Stub the seam instead.
  (manager as unknown as { fileProvider: { resolve: (type: string) => Promise<unknown> } }).fileProvider = {
    resolve: async (type: string) => ({
      title: type,
      relativePath: `${type}.mp3`,
      url: `alerts://${type}.mp3`,
    }),
  };
  manager.initOnce({
    zoneManager: {
      prepareAlertStart: () => new Map<number, number>(),
      getZoneVolumes: () => ({
        default: 20,
        alarm: 30,
        fire: 40,
        bell: 50,
        buzzer: 67,
        tts: 60,
        volstep: 1,
        fading: 0,
        maxVolume: 100,
      }),
      startAlert: async (zoneId: number, type: string, _media: unknown, volume: number) => {
        starts.push({ zoneId, type, volume });
      },
      stopAlert: async () => {},
    } as any,
  });

  const result = await manager.handleGroupedAlert(12, 'wecker', 'on', [12]);

  assert.equal(result.success, true);
  assert.deepEqual(starts, [{ zoneId: 12, type: 'wecker', volume: 67 }]);
});
