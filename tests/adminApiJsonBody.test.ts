import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from './testHarness';
import { makeOutputDiscoveryFake } from './fakes/outputDiscovery';
import { makeYtMusicAdminFake } from './fakes/ytMusicAdmin';
import { makeSoloistAdminFake } from './fakes/soloistAdmin';
import { makeRadioAdminFake } from './fakes/radioAdmin';
import {
  AdminApiHandler,
  buildSqueezeliteAdminPlayerSnapshot,
} from '../src/adapters/http/adminApi/adminApiHandler';
import { readJsonBody } from "../src/adapters/http/adminApi/helpers/httpUtils";
import { readMiniserverBaseUrlFromConfig } from '../src/adapters/http/adminApi/auth/miniserverAuthClient';
import type { ZoneManagerFacade } from '../src/application/zones/createZoneManager';
import type { ConfigPort } from '../src/ports/ConfigPort';
import type { ContentPort } from '../src/ports/ContentPort';
import { makeNotifierFake } from './fakes/notifierPort';
import { AudioManager } from '../src/application/playback/audioManager';
import { ZoneAudioPreferences } from '../src/application/playback/ZoneAudioPreferences';
import { makePlaybackServiceFake } from './fakes/playbackService';
import { createRecentsManager } from '../src/application/zones/recents/recentsManager';
import { createFavoritesManager } from '../src/application/zones/favorites/favoritesManager';
import { createContentManager } from '../src/adapters/content/contentManager';
import { LineInIngestRegistry } from '../src/adapters/inputs/linein/lineInIngestRegistry';
import { SendspinLineInService } from '../src/adapters/inputs/linein/sendspinLineInService';
import { MusicAssistantStreamService } from '../src/adapters/inputs/musicassistant/musicAssistantStreamService';
import { SpotifyInputService } from '../src/adapters/inputs/spotify/spotifyInputService';
import { SendspinHookRegistry } from '../src/adapters/outputs/sendspin/sendspinHookRegistry';
import { SnapcastCore } from '../src/adapters/outputs/snapcast/snapcastCore';
import { SqueezeliteCore } from '../src/adapters/outputs/squeezelite/squeezeliteCore';
import { ConnectionRegistry } from '../src/adapters/loxone/ws/connectionRegistry';
import { LoxoneWsNotifier } from '../src/adapters/loxone/ws/notifier';
import { CustomRadioStore } from '../src/adapters/content/providers/customRadioStore';
import { SpotifyServiceManagerProvider } from '../src/adapters/content/providers/spotifyServiceManager';
import type { MdnsPort } from '../src/ports/MdnsPort';
import { SonnCorePeerRegistry } from '../src/adapters/discovery/sonnCorePeerRegistry';
import { SonnClientApiHandler } from '../src/adapters/http/sonnClientApi/sonnClientApiHandler';
import type { BeoremoteApiHandler } from '../src/adapters/http/beoremote/beoremoteApiHandler';
import { noopGroupTracker } from './fakes/outputPorts';

const HTTP_PORT = 7090;

const MAX_JSON_BODY_BYTES = 1024 * 1024;
const noopConfigPort: ConfigPort = {
  load: async () => {
    throw new Error('config not configured');
  },
  getConfig: () => {
    throw new Error('config not configured');
  },
  getSystemConfig: () => {
    throw new Error('config not configured');
  },
  getRawAudioConfig: () => {
    throw new Error('config not configured');
  },
  ensureInputs: () => {
    throw new Error('config not configured');
  },
  updateConfig: async () => {
    throw new Error('config not configured');
  },
};
const noopContentPort: ContentPort = {
  getDefaultSpotifyAccountId: () => null,
  listBrowsableServices: () => [],
  getBridgeRegistry: () => ({
    byServiceSlug: new Map(),
    byBridgeId: new Map(),
    accountCountByService: new Map(),
  }),
  resolveFolder: async () => null,
  resolveMetadata: async () => null,
  resolvePlaybackSource: async () => ({ playbackSource: null, provider: 'library' }),
  configureProviders: () => {},
  providerForAudiopath: () => null,
  getMediaFolder: async () => null,
  getServiceTrack: async () => null,
  getServiceFolder: async () => null,
  buildQueueForUri: async () => [],
};

const noopMdnsPort: MdnsPort = {
  publish: () => ({ stop: () => {} }),
  browse: () => ({ stop: () => {} }),
  shutdown: () => {},
};

class FakeResponse extends EventEmitter {
  public statusCode: number | null = null;
  public headers: Record<string, string> | null = null;
  public body = '';
  public writableEnded = false;

  public writeHead(status: number, headers: Record<string, string>): void {
    this.statusCode = status;
    this.headers = headers;
  }

  public end(data?: string | Buffer): void {
    if (data !== undefined) {
      this.body += data.toString();
    }
    this.writableEnded = true;
    this.emit('finish');
  }
}

function createHandler(): AdminApiHandler {
  const lineInRegistry = new LineInIngestRegistry();
  const sendspinHookRegistry = new SendspinHookRegistry();
  const sendspinLineInService = new SendspinLineInService(
    lineInRegistry,
    sendspinHookRegistry,
    noopConfigPort,
  );
  const zoneAudioPrefs = new ZoneAudioPreferences();
  const audioManager = new AudioManager(makePlaybackServiceFake(), {
    notifyOutputError: () => {
      /* noop */
    },
    notifyOutputState: () => {
      /* noop */
    },
    notifySourceDuration: () => {
      /* noop */
    },
  }, zoneAudioPrefs);
  const outputHandlers = {
    onQueueUpdate: () => {
      /* noop */
    },
    onOutputError: () => {
      /* noop */
    },
  };
  const spotifyManagerProvider = new SpotifyServiceManagerProvider(noopConfigPort);
  const musicAssistantStreamService = new MusicAssistantStreamService(outputHandlers, noopConfigPort);
  const spotifyInputService = new SpotifyInputService(noopConfigPort);
  const snapcastCore = new SnapcastCore(audioManager);
  const zoneManager = {} as ZoneManagerFacade;
  snapcastCore.initOnce({ zoneManager });
  const squeezeliteCore = new SqueezeliteCore(noopConfigPort);
  const loxoneNotifier = new LoxoneWsNotifier(new ConnectionRegistry(), noopGroupTracker);
  const customRadioStore = new CustomRadioStore();
  const favoritesManager = createFavoritesManager({
    notifier: makeNotifierFake(),
    contentPort: noopContentPort,
  });
  favoritesManager.initOnce({ zoneManager });
  return new AdminApiHandler({
    outputDiscovery: makeOutputDiscoveryFake(),
    ytMusicAdmin: makeYtMusicAdminFake(),
    soloistAdmin: makeSoloistAdminFake(),
    appleMusicAdmin: {
      configuredDeveloperToken: () => null,
      scrapedDeveloperToken: async () => null,
      verifyWidevineArtifacts: async () => ({ ok: false, code: 'missing', details: [] }),
    },
    amazonMusicAdmin: {
      storefronts: () => [],
      startLogin: () => ({ loginId: '', url: '' }),
      finishLogin: async () => ({ ok: false, error: 'expired', message: '' }),
      takeCredentials: () => null,
    },
    validateTuneInUsername: async () => ({ found: false }),
    radioAdmin: makeRadioAdminFake(),
    zoneManager,
    configPort: noopConfigPort,
    notifier: makeNotifierFake(),
    loxoneNotifier,
    spotifyManagerProvider,
    customRadioStore,
    spotifyInputService,
    sendspinLineInService,
    musicAssistantStreamService,
    snapcastCore,
    squeezeliteCore,
    recentsManager: createRecentsManager({ notifier: makeNotifierFake(), contentPort: noopContentPort }),
    favoritesManager,
    groupManager: { getAllGroups: () => [] },
    contentManager: createContentManager({
      notifier: makeNotifierFake(),
      configPort: noopConfigPort,
      spotifyManagerProvider,
      customRadioStore,
    }),
    audioManager,
    zoneAudioPrefs,
    mdnsPort: noopMdnsPort,
    sonnCorePeers: new SonnCorePeerRegistry(noopMdnsPort),
    alertFiles: {
      list: async () => [],
      update: async () => {
        /* noop */
      },
      revert: async () => {
        /* noop */
      },
    },
    sonnClientApi: new SonnClientApiHandler(noopConfigPort, HTTP_PORT),
    // The JSON-body tests never route to the Beoremote surface; standing up its
    // menu-source graph here would add setup, not assurance.
    beoremoteApi: {} as BeoremoteApiHandler,
    httpPort: HTTP_PORT,
  });
}

test('readJsonBody parses valid json under limit', async () => {
  createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = readJsonBody(req, res as unknown as ServerResponse);
  stream.end('{"ok":true}');

  const body = await promise;
  assert.deepEqual(body, { ok: true });
  assert.equal(res.writableEnded, false);
  assert.equal(res.statusCode, null);
});

test('buildSqueezeliteAdminPlayerSnapshot matches configured player MAC', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite', playerId: '02:8c:54:a9:dc:ac' },
    [{ playerId: '028c54a9dcac', name: 'Test1' }],
  );

  assert.deepEqual(snapshot, {
    mac: '02:8C:54:A9:DC:AC',
    name: 'Test1',
    connected: true,
  });
});

test('buildSqueezeliteAdminPlayerSnapshot uses single connected player without configured target', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite' },
    [{ playerId: 'aa:bb:cc:dd:ee:ff', name: 'Living Room' }],
  );

  assert.deepEqual(snapshot, {
    mac: 'AA:BB:CC:DD:EE:FF',
    name: 'Living Room',
    connected: true,
  });
});

test('buildSqueezeliteAdminPlayerSnapshot exposes disconnected configured target', () => {
  const snapshot = buildSqueezeliteAdminPlayerSnapshot(
    { id: 'squeezelite', playerId: '02:8c:54:a9:dc:ac', playerName: 'Test1' },
    [],
  );

  assert.deepEqual(snapshot, {
    mac: '02:8C:54:A9:DC:AC',
    name: 'Test1',
    connected: false,
  });
});

test('readJsonBody rejects invalid json with 400', async () => {
  createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = readJsonBody(req, res as unknown as ServerResponse);
  stream.end('{"bad":');

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'invalid-json');
});

test('readJsonBody rejects oversized payloads with 413', async () => {
  createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = readJsonBody(req, res as unknown as ServerResponse);
  stream.write(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 'a'));
  stream.end();

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 413);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'payload-too-large');
});

test('readJsonBody supports route-specific max size override', async () => {
  createHandler();
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  const res = new FakeResponse();
  const promise = readJsonBody(req, res as unknown as ServerResponse, MAX_JSON_BODY_BYTES + 64);
  stream.write(Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 'a'));
  stream.end();

  const body = await promise;
  assert.equal(body, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.writableEnded, true);
  assert.equal(JSON.parse(res.body).error, 'invalid-json');
});

test('readMiniserverBaseUrlFromConfig returns http url with non-default port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 8081, protocol: 'http' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'http://192.168.1.200:8081');
});

test('readMiniserverBaseUrlFromConfig omits default http port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 80, protocol: 'http' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'http://192.168.1.200');
});

test('readMiniserverBaseUrlFromConfig omits default https port 443', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 443, protocol: 'https' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'https://192.168.1.200');
});

test('readMiniserverBaseUrlFromConfig keeps https with custom port', async () => {
  const handler = createHandler();
  const cfg = {
    system: {
      miniserver: { ip: '192.168.1.200', port: 8443, protocol: 'https' },
    },
  };
  void handler;
  const baseUrl = readMiniserverBaseUrlFromConfig(cfg as any);
  assert.equal(baseUrl, 'https://192.168.1.200:8443');
});
