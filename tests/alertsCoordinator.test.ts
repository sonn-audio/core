import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AlertsCoordinator } from '../src/application/zones/AlertsCoordinator';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { buildInitialState } from '../src/application/zones/helpers/stateHelpers';
import type { ZoneContext } from '../src/application/zones/internal/zoneTypes';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ConfigPort } from '../src/ports/ConfigPort';

// The coordinator reads exactly one thing off config: the host it builds alert URLs from.
const alertConfigPort = {
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }),
} as unknown as ConfigPort;

test('startAlert applies alert volume after switching to the alert source', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const patches: Array<Record<string, unknown>> = [];
  const playerVolumes: number[] = [];
  const inputModes: Array<ZoneContext['inputMode']> = [];
  const callOrder: string[] = [];
  // Held on an object: TS narrows a `let` to its initialiser here, because the
  // assignment below happens inside a callback it cannot see run.
  const played: { metadata: Record<string, unknown> | null } = { metadata: null };
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: buildInitialState(zone),
    queue: {
      items: [],
      shuffle: false,
      repeat: 0,
      currentIndex: 0,
      authority: 'local',
    },
    queueController: {
      setItems: () => {},
      currentIndex: () => 0,
      current: () => null,
    },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: (level: number) => {
        playerVolumes.push(level);
        callOrder.push('setVolume');
      },
      playUri: (_uri: string, metadata: Record<string, unknown>) => {
        played.metadata = metadata;
        callOrder.push('playUri');
        return {} as any;
      },
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'sendspin-cast',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        inputModes.push(mode);
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      waitForFirstAudioMs: async () => null,
    } as any,
    applyPatch: (zoneId, patch) => {
      assert.equal(zoneId, zone.id);
      patches.push(patch as Record<string, unknown>);
      ctx.state = { ...ctx.state, ...patch };
    },
    log: {
      warn: () => {},
      debug: () => {},
    } as any,
    audioHelpers: {
      resolveAlertEventType: () => 0,
    } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  await coordinator.startAlert(
    zone.id,
    'bell',
    {
      title: 'bell',
      url: 'alerts://bell.mp3',
      relativePath: 'bell.mp3',
      duration: 4,
    },
    55,
  );

  assert.deepEqual(inputModes, ['alert']);
  assert.deepEqual(playerVolumes, [55]);
  assert.equal(patches[0]?.volume, 55);
  assert.equal(ctx.state.volume, 55);
  assert.equal(patches[1]?.mode, 'play');
  // Volume must be applied only after the source has switched to the alert (issue #279),
  // otherwise the previous stream briefly plays at the announcement volume.
  assert.deepEqual(callOrder, ['playUri', 'setVolume']);
  // Alert metadata must be flagged so the Sonos output omits the DIDL duration and streams
  // the clip open-ended instead of self-truncating the tail (issues #262/#276/#279).
  assert.equal(played.metadata?.isAlert, true);
});

test('startAlert stop timer waits for the playback pre-delay so the tail is not clipped (#293)', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: buildInitialState(zone),
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { setItems: () => {}, currentIndex: () => 0, current: () => null },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    // The engine prepends 3 s of amp wake-up silence to this alert and says so on the
    // session it hands back.
    player: {
      setVolume: () => {},
      playUri: () =>
        ({ playbackSource: { kind: 'file', path: '/tmp/bell.mp3', preDelayMs: 3000 } }) as any,
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'squeezelite',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      waitForFirstAudioMs: async () => null,
    } as any,
    applyPatch: (_zoneId, patch) => {
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: { resolveAlertEventType: () => 0 } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  // Capture the scheduled stop-timer delay without actually firing it.
  const delays: number[] = [];
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (_fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    const handle = realSetTimeout(() => {}, 1_000_000, ...(rest as []));
    handle.unref?.();
    return handle;
  };
  try {
    await coordinator.startAlert(
      zone.id,
      'bell',
      { title: 'bell', url: 'alerts://bell.mp3', relativePath: 'bell.mp3', duration: 4 },
      55,
    );
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }

  // duration 4 s → durationMs = max(4000 + 750, 2500) = 4750; window = preDelay 3000 + 4750 + 150.
  const stopDelay = Math.max(...delays);
  assert.equal(stopDelay, 3000 + 4750 + 150);
});

test('the alert stop window waits for the room, start-up and all (#387)', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: buildInitialState(zone),
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { setItems: () => {}, currentIndex: () => 0, current: () => null },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    // No wake-up silence here: what is on trial is the engine's start-up and the
    // renderer's buffer, neither of which the window used to count.
    player: {
      setVolume: () => {},
      playUri: () => ({ playbackSource: { kind: 'file', path: '/tmp/tts.mp3' } }) as any,
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'sonos',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  let releaseFirstAudio!: () => void;
  const firstAudio = new Promise<void>((resolve) => {
    releaseFirstAudio = resolve;
  });

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      getRoomLagMs: () => 1000,
      // The engine took 600 ms to get its first byte out — the cost of the float DSP
      // bus on a slow box, and the part of the delay no constant can stand in for.
      waitForFirstAudioMs: async () => {
        await firstAudio;
        return 600;
      },
    } as any,
    applyPatch: (_zoneId, patch) => {
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: { resolveAlertEventType: () => 0 } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  const delays: number[] = [];
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (_fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms ?? 0);
    const handle = realSetTimeout(() => {}, 1_000_000, ...(rest as []));
    handle.unref?.();
    return handle;
  };
  try {
    await coordinator.startAlert(
      zone.id,
      'tts',
      {
        title: 'Announcement',
        url: 'alerts://cache/tts.mp3',
        relativePath: 'cache/tts.mp3',
        // The fraction is the point: rounded to 5 s this clip loses 140 ms off its tail
        // before any of the rest is counted.
        duration: 5.14,
      },
      55,
    );

    // Armed on the modelled lead first, so a zone whose engine never produces a byte
    // still gets its music back: room lag 1000 + (5140 + 750) + 150.
    assert.equal(Math.max(...delays), 1000 + 5890 + 150);

    releaseFirstAudio();
    await firstAudio;
    // Re-armed once the first byte exists, now counting the 600 ms it took to appear.
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    assert.equal(Math.max(...delays), 600 + 1000 + 5890 + 150);
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }
});

test('alert restore settles to stop when playback cannot resume (releases power-group relay)', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const patches: Array<Record<string, unknown>> = [];
  const current = {
    audiopath: 'http://radio.example/stream',
    title: 'Radio',
    artist: '',
    album: '',
    coverurl: '',
    duration: 0,
    station: 'Radio',
    unique_id: 'q1',
    audiotype: 1,
  };
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    // Zone was playing (e.g. radio) before the alert, so the snapshot mode is 'play'.
    state: { ...buildInitialState(zone), mode: 'play' },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: {
      setItems: () => {},
      currentIndex: () => 0,
      current: () => current,
    },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: () => {},
      playUri: () => ({}) as any,
      stop: () => {},
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'squeezelite',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      waitForFirstAudioMs: async () => null,
      // Resume fails: no session is returned.
      startQueuePlayback: async () => null,
    } as any,
    applyPatch: (_zoneId, patch) => {
      patches.push(patch as Record<string, unknown>);
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: {
      resolveAlertEventType: () => 0,
      isRadioAudiopath: () => true,
      getStateAudiotype: () => 1,
      resolveSourceName: () => 'Radio',
      getStateFileType: () => 0,
    } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  await coordinator.startAlert(
    zone.id,
    'bell',
    { title: 'bell', url: 'alerts://bell.mp3', relativePath: 'bell.mp3', duration: 4 },
    55,
  );
  await coordinator.stopAlert(zone.id);

  // The failed resume must not leave the zone in a phantom 'play' state.
  assert.equal(ctx.state.mode, 'stop');
  assert.equal(patches[patches.length - 1]?.mode, 'stop');
});

test('the announcement volume waits for the alert to be audible (#359)', async () => {
  // Zone plays music through an output holding a 600 ms buffer, and the engine leads
  // the alert with 400 ms of amp wake-up silence. Raising the room on the spot would
  // blast the second of music the output has yet to play at bell volume.
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const playerVolumes: number[] = [];
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: { ...buildInitialState(zone), mode: 'play', volume: 20 },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { setItems: () => {}, currentIndex: () => 0, current: () => null },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: (level: number) => playerVolumes.push(level),
      playUri: () =>
        ({ playbackSource: { kind: 'file', path: '/tmp/bell.mp3', preDelayMs: 400 } }) as any,
      stop: () => {},
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'sendspin-cast',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      waitForFirstAudioMs: async () => null,
      getRoomLagMs: () => 600,
    } as any,
    applyPatch: (_zoneId, patch) => {
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: { resolveAlertEventType: () => 0 } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  // Capture the scheduled timers instead of waiting them out.
  const scheduled: Array<{ ms: number; fire: () => void }> = [];
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number) => {
    scheduled.push({ ms: ms ?? 0, fire: () => fn() });
    const handle = realSetTimeout(() => {}, 1_000_000);
    handle.unref?.();
    return handle;
  };
  try {
    await coordinator.startAlert(
      zone.id,
      'bell',
      { title: 'bell', url: 'alerts://bell.mp3', relativePath: 'bell.mp3', duration: 4 },
      55,
    );
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }

  // Nothing was sent to the outputs yet: the room is still hearing the outgoing track.
  assert.deepEqual(playerVolumes, []);
  assert.equal(ctx.state.volume, 20);

  // The volume is scheduled for the wake-up silence plus the output's buffer, a
  // quarter second early so the level is at the device before the bell reaches it.
  const volumeTimer = scheduled.find((entry) => entry.ms === 400 + 600 - 250);
  assert.ok(volumeTimer, `expected a 750 ms volume timer, got ${scheduled.map((e) => e.ms).join()}`);
  volumeTimer.fire();
  assert.deepEqual(playerVolumes, [55]);
  assert.equal(ctx.state.volume, 55);
});

test('a stopped alert does not get its volume applied afterwards (#359)', async () => {
  const zone: ZoneConfig = {
    id: 1,
    name: 'Living',
    sourceMac: '00:00:00:00:00:01',
    volumes: {
      default: 20,
      alarm: 20,
      fire: 20,
      bell: 55,
      buzzer: 20,
      tts: 20,
      volstep: 1,
      fading: 0,
      maxVolume: 100,
    },
  };

  const zoneRepo = new ZoneRepository();
  const playerVolumes: number[] = [];
  const ctx = {
    id: zone.id,
    name: zone.name,
    sourceMac: zone.sourceMac,
    config: zone,
    state: { ...buildInitialState(zone), mode: 'play', volume: 20 },
    queue: { items: [], shuffle: false, repeat: 0, currentIndex: 0, authority: 'local' },
    queueController: { setItems: () => {}, currentIndex: () => 0, current: () => null },
    inputAdapter: {},
    spotifyAdapter: {},
    metadata: {},
    outputs: [],
    player: {
      setVolume: (level: number) => playerVolumes.push(level),
      playUri: () => ({ playbackSource: { kind: 'file', path: '/tmp/bell.mp3' } }) as any,
      stop: () => {},
    },
    outputTimingActive: false,
    lastOutputTimingAt: 0,
    lastZoneBroadcastAt: 0,
    lastPositionUpdateAt: 0,
    lastPositionValue: 0,
    lastPlaybackErrorAt: 0,
    activeOutputTypes: new Set<string>(),
    activeOutput: 'sendspin-cast',
    activeInput: null,
    lastMetadataDispatchAt: 0,
    inputMode: 'queue',
  } as unknown as ZoneContext;
  zoneRepo.set(zone.id, ctx);

  const coordinator = new AlertsCoordinator({
    zones: zoneRepo,
    configPort: alertConfigPort,
    playbackCoordinator: {
      setInputMode: (_ctx: ZoneContext, mode: ZoneContext['inputMode']) => {
        _ctx.inputMode = mode;
      },
      alignOutputFormat: () => {},
      applyOutputEndGuard: () => {},
      waitForFirstAudioMs: async () => null,
      getRoomLagMs: () => 800,
    } as any,
    applyPatch: (_zoneId, patch) => {
      ctx.state = { ...ctx.state, ...(patch as Record<string, unknown>) };
    },
    log: { warn: () => {}, debug: () => {} } as any,
    audioHelpers: { resolveAlertEventType: () => 0 } as any,
    zoneAudioPrefs: {
      setTransientGainDb: () => {},
      setAlertPreDelayFloorMs: () => {},
    } as any,
  });

  const scheduled: Array<{ ms: number; fire: () => void }> = [];
  const realSetTimeout = global.setTimeout;
  (global as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number) => {
    scheduled.push({ ms: ms ?? 0, fire: () => fn() });
    const handle = realSetTimeout(() => {}, 1_000_000);
    handle.unref?.();
    return handle;
  };
  try {
    await coordinator.startAlert(
      zone.id,
      'bell',
      { title: 'bell', url: 'alerts://bell.mp3', relativePath: 'bell.mp3', duration: 4 },
      55,
    );
    await coordinator.stopAlert(zone.id);
  } finally {
    (global as any).setTimeout = realSetTimeout;
  }

  // The alert ended before its level was due; firing the stale timer now would
  // leave the room parked at bell volume with the music back on.
  const volumeTimer = scheduled.find((entry) => entry.ms === 800 - 250);
  assert.ok(volumeTimer);
  volumeTimer.fire();
  assert.deepEqual(playerVolumes, [20]);
  assert.equal(ctx.state.volume, 20);
});
