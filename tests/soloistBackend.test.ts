import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SoloistPlaybackService } from '../src/adapters/inputs/spotify/soloist/soloistPlaybackService';
import type { ConfigPort } from '../src/ports/ConfigPort';

/**
 * Soloist is the only Spotify client, so there is nothing to switch between and no flag saying
 * which one to use: the API key is what decides. It is personal and Premium-only, so it is never
 * there by accident — and its absence is a normal state a fresh install sits in, which is why the
 * one thing pinned here is that such a setup says what is missing rather than failing later.
 */

type ConfigShape = {
  zones?: Array<{ id: number; name?: string }>;
  content?: { spotify?: { soloist?: { apiKey?: string } } };
};

function fakeConfigPort(config: ConfigShape): ConfigPort {
  return {
    getConfig: () => config,
    updateConfig: async (mutate: (cfg: unknown) => void) => {
      mutate(config);
    },
  } as unknown as ConfigPort;
}

test('an installation with no key does not play spotify', () => {
  // And does not advertise a room in anybody's Spotify app either: a key is the one thing that
  // cannot be defaulted or shipped, so its absence is what an untouched install looks like.
  for (const soloist of [undefined, {}, { apiKey: '' }, { apiKey: '   ' }]) {
    const service = new SoloistPlaybackService(
      fakeConfigPort({ content: { spotify: { soloist } }, zones: [{ id: 1 }] }),
    );
    assert.equal(service.isEnabled(), false, JSON.stringify(soloist));
  }
});

test('a key is the whole of switching it on', () => {
  // There is no second flag to set. One client, so a switch beside the key could only ever be on.
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } } }),
  );
  assert.equal(service.isEnabled(), true);
});

test('readiness names the step that is missing rather than just refusing', async () => {
  // The key is personal and Premium-only, so it can never be defaulted or shipped, which makes
  // "no key" a normal state the screen has to be able to explain rather than a failure.
  const noKey = new SoloistPlaybackService(fakeConfigPort({ content: { spotify: { soloist: {} } } }));
  assert.deepEqual(await noKey.readiness('acc'), { ready: false, reason: 'no_api_key' });

  // With a key but no account named, there is no store to restore a session from.
  const noAccount = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } } }),
  );
  const readiness = await noAccount.readiness('');
  assert.equal(readiness.ready, false);
  // Which of the two it reports depends on whether a program is installed on the host running the
  // tests, and both are honest answers; what matters is that it is named rather than swallowed.
  assert.ok(
    readiness.ready === false && ['no_binary', 'not_executable', 'no_account'].includes(readiness.reason),
    JSON.stringify(readiness),
  );
});

/**
 * The level a room shows in the Spotify app.
 *
 * Its own thing, separate from the level it plays at: Soloist applies no volume — it passes one to
 * the sound server, and ours records it without touching the samples — so what these pin is a
 * label being kept true, never a taper being applied. A device that is never told stands at the
 * 100 it was started with, which is what #372 was: rooms reading full while they were at twelve.
 */

type FakeWs = {
  isLoggedIn: boolean;
  isActive: boolean;
  setVolume: (level: number) => boolean;
};

function withRunner(args: { loggedIn: boolean; owner: string; zoneVolume?: number | null }): {
  service: SoloistPlaybackService;
  sent: number[];
  login: () => void;
} {
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } }, zones: [{ id: 1 }] }),
  );
  const sent: number[] = [];
  const ws: FakeWs = {
    isLoggedIn: args.loggedIn,
    isActive: false,
    setVolume: (level: number) => {
      sent.push(level);
      return true;
    },
  };
  const runner = { ws, owner: args.owner, volume: null, volumeLatch: null };
  (service as unknown as { runners: Map<number, unknown> }).runners.set(1, runner);
  (service as unknown as { controller: unknown }).controller = {
    currentZoneVolume: () => args.zoneVolume ?? null,
  };
  const internals = service as unknown as {
    onEvent: (zoneId: number, event: { type: string; logged_in?: boolean }) => void;
  };
  return { service, sent, login: () => internals.onEvent(1, { type: 'auth_state', logged_in: true }) };
}

test('a room nobody is listening to is still told what it is at', () => {
  // The case that was broken. An idle device is exactly the one somebody is looking at in the
  // device picker, so "only the room that is sounding" was the wrong condition to gate on.
  const { service, sent } = withRunner({ loggedIn: true, owner: 'idle' });
  assert.equal(service.setVolume(1, 12), true);
  assert.deepEqual(sent, [12]);
});

test('a daemon that has not signed in is not told anything', () => {
  // Before its login Soloist answers every command with "requires authentication" and the level
  // is simply lost, so there is nothing to be gained by saying it early.
  const { service, sent } = withRunner({ loggedIn: false, owner: 'idle' });
  assert.equal(service.setVolume(1, 12), false);
  assert.deepEqual(sent, []);
});

test('the level already agreed on is not said again', () => {
  // Every `set_volume` comes back as a `volume_changed`, so repeating one is how a loop starts.
  const { service, sent } = withRunner({ loggedIn: true, owner: 'idle' });
  service.setVolume(1, 40);
  service.setVolume(1, 40);
  assert.deepEqual(sent, [40]);
});

test('signing in is when a room can first say what it is at', () => {
  // A daemon comes up at boot, long before anybody turns a knob — without this the app would show
  // the room at full until the first volume change of the day.
  const { sent, login } = withRunner({ loggedIn: true, owner: 'idle', zoneVolume: 34 });
  login();
  assert.deepEqual(sent, [34]);
});

test('a zone this server does not have leaves the level alone', () => {
  // The reader answers `null` for it, and a room whose level is unknown is better left showing
  // whatever it has than pushed to a made-up number.
  const { sent, login } = withRunner({ loggedIn: true, owner: 'idle', zoneVolume: null });
  login();
  assert.deepEqual(sent, []);
});

/**
 * Quality is read out of a store when a process starts, so a setting that changes it has to reach
 * the processes that are already running or it does not mean anything until the next restart.
 */

function withRunners(owners: string[]): {
  service: SoloistPlaybackService;
  stopped: number[];
  left: number[];
} {
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } } }),
  );
  const stopped: number[] = [];
  const runners = (service as unknown as { runners: Map<number, unknown> }).runners;
  owners.forEach((owner, index) => {
    const zoneId = index + 1;
    runners.set(zoneId, {
      owner,
      track: null,
      stream: null,
      volume: null,
      volumeLatch: null,
      ws: { close: () => undefined },
      handle: { stop: () => stopped.push(zoneId) },
    });
  });
  return { service, stopped, left: [] };
}

test('a quality change gives up the rooms that are not playing', () => {
  // Dropping them is the whole mechanism: the syncZones that follows a settings save starts them
  // again, and starting is what writes the prefs.
  const { service, stopped } = withRunners(['idle', 'queue']);
  service.dropForQualityChange();
  assert.deepEqual(stopped, [1, 2]);
  assert.equal((service as unknown as { runners: Map<number, unknown> }).runners.size, 0);
});

test('a room the app is playing through keeps its daemon', () => {
  // Taking somebody's music away to apply a preference they would hear on the next track is the
  // wrong way round; that room picks the change up when its session ends.
  const { service, stopped } = withRunners(['connect']);
  service.dropForQualityChange();
  assert.deepEqual(stopped, []);
  assert.equal((service as unknown as { runners: Map<number, unknown> }).runners.size, 1);
});

/**
 * A room the Spotify app is asking for sound in, that has none.
 *
 * Adoption used to be gated on the track having changed, which is not the same question. The app
 * says `playing` for the track a room already believes is current every time somebody resumes it,
 * and the labels, queue and position keep arriving either way — so a room whose stream had gone
 * displayed perfect playback and stayed silent, with no event left that could open the pipe. #383.
 */

function withConnectRunner(state: { currentUri: string | null; stream: unknown }): {
  service: SoloistPlaybackService;
  runner: { currentUri: string | null; stream: unknown; currentTrack: unknown };
  adopted: string[];
  fire: (event: Record<string, unknown>) => void;
} {
  const service = new SoloistPlaybackService(
    fakeConfigPort({ content: { spotify: { soloist: { apiKey: 'spak_test' } } }, zones: [{ id: 1 }] }),
  );
  const adopted: string[] = [];
  const runner = {
    owner: 'connect',
    currentUri: state.currentUri,
    currentTrack: { id: 'x' },
    stream: state.stream,
    track: null,
    queue: { previous: [], upcoming: [] },
    volume: null,
    volumeLatch: null,
    ws: { isActive: true, isLoggedIn: true, requestQueue: () => undefined },
  };
  (service as unknown as { runners: Map<number, unknown> }).runners.set(1, runner);
  (service as unknown as { adoptConnectPlayback: unknown }).adoptConnectPlayback = (
    _zoneId: number,
    event: { item?: { uri?: string } },
  ): Promise<void> => {
    adopted.push(event.item?.uri ?? '');
    return Promise.resolve();
  };
  const internals = service as unknown as { onEvent: (id: number, event: unknown) => void };
  return { service, runner, adopted, fire: (event) => internals.onEvent(1, event) };
}

test('playing with nothing carrying the audio is adopted, same track or not', () => {
  const { adopted, fire } = withConnectRunner({ currentUri: 'spotify:track:same', stream: null });
  fire({ type: 'playback_state', status: 'playing', item: { uri: 'spotify:track:same' } });
  assert.deepEqual(adopted, ['spotify:track:same']);
});

test('playing the track that is already sounding is left alone', () => {
  // The app reports `playing` continually while a room plays; acting on those would tear the
  // stream down and open it again under every one of them.
  const { adopted, fire } = withConnectRunner({
    currentUri: 'spotify:track:same',
    stream: { destroy: () => undefined },
  });
  fire({ type: 'playback_state', status: 'playing', item: { uri: 'spotify:track:same' } });
  assert.deepEqual(adopted, []);
});

test('the stream going takes what it was playing with it', () => {
  // The other half of #383: a room stopped here kept the app's last track on the runner, so the
  // app resuming that same track read as "already current" and never reached the adopt above.
  const { service, runner } = withConnectRunner({
    currentUri: 'spotify:track:old',
    stream: { destroy: () => undefined },
  });
  (service as unknown as { finishTrack: (id: number) => void }).finishTrack(1);
  assert.equal(runner.currentUri, null);
  assert.equal(runner.currentTrack, null);
  assert.equal(runner.stream, null);
});
