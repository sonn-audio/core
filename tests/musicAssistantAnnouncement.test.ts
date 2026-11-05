import assert from 'node:assert/strict';
import { test } from './testHarness';
import { MusicAssistantOutput } from '../src/adapters/outputs/musicassistant/musicAssistantOutput';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { NativeAlertRequest } from '../src/ports/OutputsTypes';

// No bridge is configured, so the output cannot build an api of its own; each test hands it one.
const configPortStub = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
  getConfig: () => ({ system: { audioserver: { ip: '127.0.0.1' } }, zones: [], content: {} }),
  getZones: () => [],
} as unknown as ConfigPort;

const bell: NativeAlertRequest = {
  url: 'http://192.168.1.10:7091/alerts/bell.mp3',
  volume: 55,
  title: 'bell',
  type: 'bell',
};

function makeOutput(playAnnouncement: (playerId: string, url: string, volume?: number) => Promise<void>) {
  const output = new MusicAssistantOutput(1, 'Hall', { bridgeId: 'ma', playerId: 'ap1234abcd' }, configPortStub);
  const calls: Array<{ playerId: string; url: string; volume?: number }> = [];
  (output as unknown as { api: unknown }).api = {
    getAllPlayers: async () => [{ player_id: 'ap1234abcd' }],
    playAnnouncement: (playerId: string, url: string, volume?: number) => {
      calls.push({ playerId, url, volume });
      return playAnnouncement(playerId, url, volume);
    },
  };
  return { output, calls };
}

test('a Music Assistant player rings the bell as an MA announcement (#416)', async () => {
  // MA answers once the announcement is over and the music is back; a short clip does that at once.
  const { output, calls } = makeOutput(async () => undefined);
  assert.equal(await output.playNativeAlert(bell), true);
  assert.deepEqual(calls, [{ playerId: 'ap1234abcd', url: bell.url, volume: 55 }]);
});

test('an MA announcement still playing is an announcement taken, not one refused (#416)', async () => {
  // MA holds its answer for as long as the clip plays, which can be longer than any sensible wait.
  const { output } = makeOutput(() => new Promise<void>(() => undefined));
  assert.equal(await output.playNativeAlert(bell), true);
});

test('an announcement MA refuses falls back to the stream path (#416)', async () => {
  const { output } = makeOutput(async () => {
    throw new Error('Player ap1234abcd does not support announcements');
  });
  assert.equal(await output.playNativeAlert(bell), false);
});

test('without a Music Assistant connection the alert takes the stream path', async () => {
  const output = new MusicAssistantOutput(1, 'Hall', { bridgeId: 'ma', playerId: 'p' }, configPortStub);
  assert.equal(await output.playNativeAlert(bell), false);
});
