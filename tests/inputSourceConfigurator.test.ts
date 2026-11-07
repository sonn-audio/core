import assert from 'node:assert/strict';
import { test } from './testHarness';
import { InputSourceConfigurator } from '../src/application/zones/services/InputSourceConfigurator';
import type {
  AirplayController,
  SpotifyConnectController,
  InputsPort,
} from '../src/ports/InputsPort';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneState } from '../src/domain/zones/zoneState';

type ConfiguratorFakes = {
  airplay: AirplayController | null;
  dlna: AirplayController | null;
  bluetooth: AirplayController | null;
  spotify: SpotifyConnectController | null;
  airplayResolverSet: number;
  ctx: ZoneContext;
  playbackCalls: string[];
  applyPatchCalls: Array<{ zoneId: number; patch: Partial<ZoneState>; force?: boolean }>;
  stateStorePatches: Array<{ zoneId: number; patch: Partial<ZoneState> }>;
  outputVolumeCalls: Array<{ zoneId: number; volume: number; outputTypes: string[] }>;
  spotifyAdapterEvents: string[];
  airplayStops: Array<{ zoneId: number; reason?: string }>;
};

function buildConfigurator(opts: { activeInput?: ZoneContext['activeInput'] } = {}): {
  configurator: InputSourceConfigurator;
  fakes: ConfiguratorFakes;
} {
  const fakes: ConfiguratorFakes = {
    airplay: null,
    dlna: null,
    bluetooth: null,
    spotify: null,
    airplayResolverSet: 0,
    ctx: {
      id: 1,
      activeInput: opts.activeInput ?? null,
      queue: { authority: 'local' } as never,
      state: { volume: 30 } as never,
      config: { id: 1, volumes: { default: 25, min: 0, max: 100 } } as never,
      outputs: [{ type: 'squeezelite' }] as never,
      spotifyAdapter: {
        start: (...args: unknown[]) => fakes.spotifyAdapterEvents.push(`start:${args[0]}`),
        updateMetadata: () => fakes.spotifyAdapterEvents.push('updateMetadata'),
        updateTiming: () => fakes.spotifyAdapterEvents.push('updateTiming'),
        pause: () => fakes.spotifyAdapterEvents.push('pause'),
        resume: () => fakes.spotifyAdapterEvents.push('resume'),
        stop: () => fakes.spotifyAdapterEvents.push('stop'),
      } as never,
    } as unknown as ZoneContext,
    playbackCalls: [],
    applyPatchCalls: [],
    stateStorePatches: [],
    outputVolumeCalls: [],
    spotifyAdapterEvents: [],
    airplayStops: [],
  };

  const inputsPort: Pick<
    InputsPort,
    | 'configureAirplay'
    | 'configureDlna'
    | 'configureBluetooth'
    | 'configureSpotify'
    | 'setAirplayPlayerResolver'
    | 'stopAirplaySession'
  > = {
    configureAirplay: (controller) => {
      fakes.airplay = controller;
    },
    configureDlna: (controller) => {
      fakes.dlna = controller;
    },
    configureBluetooth: (controller) => {
      fakes.bluetooth = controller;
    },
    configureSpotify: (controller) => {
      fakes.spotify = controller;
    },
    setAirplayPlayerResolver: () => {
      fakes.airplayResolverSet += 1;
    },
    stopAirplaySession: (zoneId, reason) => {
      fakes.airplayStops.push({ zoneId, reason });
    },
  };

  const configurator = new InputSourceConfigurator({
    inputsPort: inputsPort as InputsPort,
    zoneRepo: { get: (id) => (id === 1 ? fakes.ctx : undefined) },
    playback: {
      playInputSource: (zoneId, label) => fakes.playbackCalls.push(`play:${zoneId}:${label}`),
      stopInputSource: (zoneId) => fakes.playbackCalls.push(`stop:${zoneId}`),
      pauseInputSource: (zoneId) => fakes.playbackCalls.push(`pause:${zoneId}`),
      resumeInputSource: (zoneId) => fakes.playbackCalls.push(`resume:${zoneId}`),
      updateInputMetadata: (zoneId) => fakes.playbackCalls.push(`updateMeta:${zoneId}`),
      updateInputCover: (zoneId) => {
        fakes.playbackCalls.push(`updateCover:${zoneId}`);
        return undefined;
      },
      updateInputVolume: (zoneId, volume) => fakes.playbackCalls.push(`updateVol:${zoneId}:${volume}`),
      updateInputTiming: (zoneId) => fakes.playbackCalls.push(`updateTiming:${zoneId}`),
      setInputMode: (_ctx, mode) => fakes.playbackCalls.push(`setInputMode:${mode}`),
      alignOutputFormat: (zoneId) => fakes.playbackCalls.push(`alignFormat:${zoneId}`),
      handleCommand: () => {
        /* noop */
      },
    },
    outputRouter: {
      dispatchVolume: (ctx, outputs, level) =>
        fakes.outputVolumeCalls.push({ zoneId: ctx.id, volume: level, outputTypes: outputs.map((o) => o.type) }),
    },
    stateStore: {
      applyPatch: (zoneId, patch) => fakes.stateStorePatches.push({ zoneId, patch }),
    },
    applyPatch: (zoneId, patch, force) => fakes.applyPatchCalls.push({ zoneId, patch, force }),
    updateQueue: () => {
      /* noop */
    },
  });

  return { configurator, fakes };
}

test('InputSourceConfigurator configure() wires AirPlay + Spotify + resolver once', () => {
  const { configurator, fakes } = buildConfigurator();
  configurator.configure();
  assert.ok(fakes.airplay, 'airplay controller should be registered');
  assert.ok(fakes.spotify, 'spotify controller should be registered');
  // Every input that pushes into a zone gets the same controller: AirPlay, DLNA and the Bluetooth
  // radio in a Sonn Client all hand over audio the same way.
  assert.ok(fakes.dlna, 'dlna controller should be registered');
  assert.ok(fakes.bluetooth, 'bluetooth controller should be registered');
  assert.equal(fakes.airplayResolverSet, 1);
});

test('InputSourceConfigurator configure() is idempotent', () => {
  const { configurator, fakes } = buildConfigurator();
  configurator.configure();
  configurator.configure();
  configurator.configure();
  assert.equal(fakes.airplayResolverSet, 1, 'resolver should only be set once');
});

test('AirPlay controller passes through to playback coordinator', () => {
  const { configurator, fakes } = buildConfigurator();
  configurator.configure();
  fakes.airplay!.startPlayback(1, 'airplay', { kind: 'pipe', path: 'x' } as never);
  fakes.airplay!.pausePlayback(1);
  fakes.airplay!.resumePlayback(1);
  fakes.airplay!.stopPlayback(1);
  assert.deepEqual(fakes.playbackCalls, ['play:1:airplay', 'pause:1', 'resume:1', 'stop:1']);
});

test('an AirPlay sender that ends its session hands back a zone AirPlay still owns (#420)', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'airplay' });
  configurator.configure();
  fakes.airplay!.stopPlayback(1);
  assert.deepEqual(fakes.playbackCalls, ['stop:1']);
});

test('an AirPlay sender that ends its session leaves alone a zone another input has taken', () => {
  // The phone kept its session open while the zone moved on to a queue; its late TEARDOWN must
  // not stop that queue or clear its input mode.
  const { configurator, fakes } = buildConfigurator({ activeInput: 'queue' });
  configurator.configure();
  fakes.airplay!.stopPlayback(1);
  assert.deepEqual(fakes.playbackCalls, []);
});

test('Spotify Connect takes a zone over from AirPlay and drops the AirPlay sender (#420)', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'airplay' });
  configurator.configure();
  fakes.spotify!.startPlayback(1, 'spotify-connect', { kind: 'pipe', path: 'x' } as never);
  // A `switch_to_` reason is what makes the AirPlay receiver restart and let go of the phone.
  assert.deepEqual(fakes.airplayStops, [{ zoneId: 1, reason: 'switch_to_spotify' }]);
  assert.ok(fakes.playbackCalls.includes('setInputMode:spotify'));
  assert.deepEqual(fakes.spotifyAdapterEvents, ['start:spotify-connect']);
});

test('Spotify Connect leaves AirPlay alone when AirPlay does not own the zone', () => {
  const { configurator, fakes } = buildConfigurator();
  configurator.configure();
  fakes.spotify!.startPlayback(1, 'spotify-connect', { kind: 'pipe', path: 'x' } as never);
  assert.deepEqual(fakes.airplayStops, []);
});

test('a regular Spotify start still cannot claim a zone AirPlay owns', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'airplay' });
  configurator.configure();
  fakes.spotify!.startPlayback(1, 'spotify', { kind: 'pipe', path: 'x' } as never);
  assert.deepEqual(fakes.airplayStops, []);
  assert.deepEqual(fakes.spotifyAdapterEvents, []);
});

test('Spotify Connect startPlayback sets inputMode and dispatches initial volume', () => {
  const { configurator, fakes } = buildConfigurator();
  configurator.configure();
  fakes.spotify!.startPlayback(1, 'spotify-connect', { kind: 'pipe', path: 'x' } as never);
  assert.equal(fakes.ctx.queue.authority, 'spotify');
  assert.ok(fakes.playbackCalls.includes('setInputMode:spotify'));
  assert.equal(fakes.outputVolumeCalls.length, 1);
  assert.equal(fakes.outputVolumeCalls[0]?.volume, 30);
  assert.deepEqual(fakes.spotifyAdapterEvents, ['start:spotify-connect']);
});

test('Spotify Connect updateVolume bypasses player.setVolume to avoid feedback loop', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'spotify' });
  configurator.configure();
  fakes.spotify!.updateVolume(1, 55);
  assert.equal(fakes.stateStorePatches.length, 1, 'state-store should be patched');
  assert.equal(fakes.outputVolumeCalls.length, 1);
  assert.deepEqual(fakes.outputVolumeCalls[0]?.outputTypes, ['squeezelite']);
});

test('Spotify Connect non-connect events are ignored when activeInput is not spotify', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'airplay' });
  configurator.configure();
  fakes.spotify!.updateMetadata(1, { title: 'X' });
  fakes.spotify!.pausePlayback(1);
  fakes.spotify!.stopPlayback(1);
  assert.deepEqual(fakes.spotifyAdapterEvents, []);
});

test('Spotify Connect stopPlayback clears track metadata and resets queue authority', () => {
  const { configurator, fakes } = buildConfigurator({ activeInput: 'spotify' });
  configurator.configure();
  fakes.spotify!.stopPlayback(1);
  assert.equal(fakes.applyPatchCalls.length, 1);
  assert.deepEqual(fakes.applyPatchCalls[0]?.patch, { title: '', artist: '', album: '', coverurl: '' });
  assert.equal(fakes.ctx.queue.authority, 'local');
  assert.ok(fakes.playbackCalls.includes('setInputMode:null'));
  assert.deepEqual(fakes.spotifyAdapterEvents, ['stop']);
});
