import assert from 'node:assert/strict';
import { z } from 'zod';
import { test } from './testHarness';
import { createConfigHandlers } from '../src/adapters/loxone/commands/handlers/configHandlers';
import { createProviderHandlers } from '../src/adapters/loxone/commands/handlers/providerHandlers';
import { LoxoneRouter } from '../src/adapters/loxone/commands/router/loxoneRouter';
import { registerRoutes } from '../src/adapters/loxone/commands/router/routeRegistry';
import { serializeResult } from '../src/adapters/loxone/commands/responses';
import { parsePlayerIds, withDefaultPlayers } from '../src/adapters/loxone/commands/utils/loxoneServiceDefaults';

// "Use this account in this room." Every streaming service reaches the Loxone app as a Spotify
// account, so the account a room defaults to is what decides whether it opens on Apple Music
// or on Tidal. We keep the choice on the zone; the app reads it per account, as the list of
// players that account is the default for.

const SERVICES = [
  { cmd: 'spotify', id: 'md123121', name: 'Spotify', user: 'Rudy', configerror: false, asdefault: [] },
  { cmd: 'spotify', id: 'bridge-applemusic-12lijl', name: '', user: 'Apple Music', configerror: false, asdefault: [] },
  { cmd: 'spotify', id: 'bridge-tidal-9zk2', name: '', user: 'Tidal', configerror: false, asdefault: [] },
];

function setup(zones: Array<{ id: number; name: string; streamingAccount?: string }>) {
  const config = { zones };
  const events: string[] = [];
  const configPort = {
    getConfig: () => config,
    updateConfig: async (mutate: (draft: typeof config) => void) => {
      mutate(config);
    },
  };
  const contentManager = { getServices: () => SERVICES };
  const set = createConfigHandlers({} as any, {
    configPort,
    contentManager,
    loxoneNotifier: { notifyServiceChanged: () => events.push('service_changed') },
  } as any).serviceCfgSet;
  const list = createProviderHandlers(contentManager as any, {} as any, configPort as any).audioCfgGetServices;
  const defaults = () => {
    const frame = JSON.parse(serializeResult(list('audio/cfg/getservices') as any));
    return Object.fromEntries(
      (frame.getservices_result as Array<{ id: string; asdefault: number[] }>).map((entry) => [entry.id, entry.asdefault]),
    );
  };
  return { config, events, set, defaults };
}

/** `SetDefaultUserForServiceAtPlayerScheme` (shared-app.js 9656). */
const SetDefaultResponse = z.object({
  command: z.string(),
  servicecfg_result: z.object({ command: z.literal('asdefault'), error: z.number() }),
});

async function answer(set: ReturnType<typeof setup>['set'], command: string): Promise<number> {
  const frame = JSON.parse(serializeResult((await set(command))!));
  assert.equal(frame.command, command);
  return SetDefaultResponse.parse(frame).servicecfg_result.error;
}

test('a room with no chosen account is in no account\'s default list', () => {
  const { defaults } = setup([{ id: 1, name: 'Living' }, { id: 2, name: 'Kitchen' }]);
  assert.deepEqual(defaults(), { md123121: [], 'bridge-applemusic-12lijl': [], 'bridge-tidal-9zk2': [] });
});

test('choosing an account for a room puts that room in the account\'s default list', async () => {
  const { config, events, set, defaults } = setup([{ id: 1, name: 'Living' }, { id: 2, name: 'Kitchen' }]);
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/bridge-applemusic-12lijl/asdefault/player/2'), 0);
  assert.equal(config.zones[1]!.streamingAccount, 'bridge-applemusic-12lijl');
  assert.equal(config.zones[0]!.streamingAccount, undefined, 'the other room is not touched');
  assert.deepEqual(defaults(), { md123121: [], 'bridge-applemusic-12lijl': [2], 'bridge-tidal-9zk2': [] });
  // The app keeps the list of services with their defaults; this is what makes it ask again.
  assert.deepEqual(events, ['service_changed']);
});

test('a room has one default: choosing another account replaces the first', async () => {
  const { set, defaults } = setup([{ id: 1, name: 'Living', streamingAccount: 'md123121' }]);
  assert.deepEqual(defaults().md123121, [1]);
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/bridge-tidal-9zk2/asdefault/player/1'), 0);
  assert.deepEqual(defaults(), { md123121: [], 'bridge-applemusic-12lijl': [], 'bridge-tidal-9zk2': [1] });
});

test('several rooms can be given the same account in one command', async () => {
  const { set, defaults } = setup([{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }]);
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/md123121/asdefault/player/1,3'), 0);
  assert.deepEqual(defaults().md123121, [1, 3]);
});

test('an account that does not exist, or a command that is not this one, changes nothing', async () => {
  const { config, events, set } = setup([{ id: 1, name: 'Living' }]);
  // 8 is the app's "not found".
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/nobody/asdefault/player/1'), 8);
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/md123121/asdefault/player/'), 8);
  assert.equal(await answer(set, 'audio/cfg/servicecfg/set/spotify/md123121/somethingelse/player/1'), 8);
  assert.equal(config.zones[0]!.streamingAccount, undefined);
  assert.deepEqual(events, []);
});

test('an account that was removed leaves its rooms with no default, not with a dangling one', () => {
  const { defaults } = setup([{ id: 1, name: 'Living', streamingAccount: 'bridge-deezer-gone' }]);
  // No entry lists the room, so the app falls back to the first account, as it does for a
  // room that never chose.
  assert.deepEqual(Object.values(defaults()).flat(), []);
});

test('the projection and the id list are plain functions of their input', () => {
  assert.deepEqual(parsePlayerIds('1,3, 7'), [1, 3, 7]);
  assert.deepEqual(parsePlayerIds('1,x,0,-2,2.5'), [1]);
  assert.deepEqual(parsePlayerIds(undefined), []);
  const projected = withDefaultPlayers([{ id: 'a' }, { id: 'b' }], [{ id: 5, streamingAccount: 'b' }, { id: 6 }]);
  assert.deepEqual(projected, [
    { id: 'a', asdefault: [] },
    { id: 'b', asdefault: [5] },
  ]);
});

test('the command has a route of its own', async () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, name) => (name === 'then' ? undefined : anything),
    apply: () => anything,
  });
  const router = new LoxoneRouter();
  registerRoutes(router, new Proxy({}, { get: () => anything }) as any);
  const result = await router.dispatch('audio/cfg/servicecfg/set/spotify/md123121/asdefault/player/1');
  assert.equal(result.name, 'servicecfg');
  assert.equal((result.payload as { command: string }).command, 'asdefault');
});
