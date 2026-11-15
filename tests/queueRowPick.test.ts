import assert from 'node:assert/strict';
import { test } from './testHarness';
import { ZoneRepository } from '../src/application/zones/ZoneRepository';
import { QueueController } from '../src/application/zones/QueueController';
import { PlaybackQueueNavigator } from '../src/application/playback/PlaybackQueueNavigator';
import { buildBridgeRegistry } from '../src/domain/zones/bridgeIdentity';
import { createZoneHandlers } from '../src/adapters/loxone/commands/handlers/zoneHandlers';
import type { QueueState, ZoneContext } from '../src/application/zones/internal/zoneTypes';

// Tapping a row in the Loxone app's queue. The app does not say "play queue item N": it plays
// the row's audiopath like any other track, and the audiopath it holds is the one the queue
// was shown in — `spotify:track:<id>`, with neither the service nor the account. That has to
// be found again in the queue it came from. When it was not, the tap counted as new music:
// the whole queue was replaced by that one track, under a path no provider recognises, and
// the app then failed to draw the queue at all.

const BRIDGES = [
  { id: 'bridge-tidal-9zk2', label: 'Tidal', provider: 'tidal' },
  { id: 'bridge-applemusic-k1w50n', label: 'Apple Music', provider: 'applemusic' },
];

function zoneWithQueue(audiopaths: string[]) {
  const zones = new ZoneRepository();
  const qc = new QueueController(zones, {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, spam: () => {} } as never,
    contentPort: { getBridgeRegistry: () => buildBridgeRegistry(BRIDGES) } as never,
    applyPatch: () => {},
    isRadioAudiopath: () => false,
    isSpotifyAudiopath: () => false,
    isMusicAssistantAudiopath: () => false,
    providerForAudiopath: () => 'tidal',
    resolveBridgeProvider: () => null,
    getMusicAssistantUserId: () => 'musicassistant',
    getStateAudiotype: () => null,
    getStateFileType: () => 0,
    resolveSourceName: () => undefined,
    notifier: { notifyQueueUpdated: () => {}, notifyZoneStateChanged: () => {} } as never,
  } as never);
  const queue: QueueState = {
    items: audiopaths.map((audiopath, index) => ({
      audiopath,
      audiotype: 5,
      title: `Track ${index}`,
      artist: '',
      album: '',
      coverurl: 'http://cover',
      duration: 200,
      station: '',
      unique_id: `uid-${index}`,
      qindex: index,
      user: 'tidal',
    })) as never,
    shuffle: false,
    repeat: 0,
    currentIndex: 0,
    authority: 'local',
  };
  const navigator = new PlaybackQueueNavigator(queue);
  zones.set(14, {
    id: 14,
    name: 'Woonkamer',
    queue,
    queueController: navigator,
    metadata: {} as Record<string, unknown>,
    state: { audiopath: '', audiotype: 0 },
  } as unknown as ZoneContext);
  return { qc, navigator };
}

const QUEUE = [
  'tidal:9zk2:track:11111111',
  'tidal:9zk2:track:34852094',
  'applemusic:k1w50n:track:b64_MTQ0MDgyMjIzMg==',
];

test('a queue row is found again by the audiopath the queue showed for it', () => {
  const { qc, navigator } = zoneWithQueue(QUEUE);
  const shown = qc.getQueue(14, 0, 50).items.map((item) => item.audiopath);
  // What the app holds for each row — no service, no account.
  assert.deepEqual(shown, ['spotify:track:11111111', 'spotify:track:34852094', 'spotify:track:b64_MTQ0MDgyMjIzMg==']);
  for (const [index, audiopath] of shown.entries()) {
    assert.equal(qc.seekInQueue(14, audiopath), true, `row ${index} (${audiopath})`);
    assert.equal(navigator.currentIndex(), index);
  }
});

test('a queue row is still found by its unique id and by its own audiopath', () => {
  const { qc, navigator } = zoneWithQueue(QUEUE);
  assert.equal(qc.seekInQueue(14, 'uid-2'), true);
  assert.equal(navigator.currentIndex(), 2);
  assert.equal(qc.seekInQueue(14, 'tidal:9zk2:track:34852094'), true);
  assert.equal(navigator.currentIndex(), 1);
  // The Loxone disguise of the same track.
  assert.equal(qc.seekInQueue(14, 'spotify@bridge-tidal-9zk2:track:11111111'), true);
  assert.equal(navigator.currentIndex(), 0);
});

test('a track that is not in the queue is not found in it', () => {
  const { qc, navigator } = zoneWithQueue(QUEUE);
  assert.equal(qc.seekInQueue(14, 'spotify:track:99999999'), false);
  assert.equal(qc.seekInQueue(14, 'spotify:album:34852094'), false, 'an album with the id of a queued track');
  assert.equal(navigator.currentIndex(), 0, 'and the queue stays where it was');
});

// --- what the play command does with it ----------------------------------------------

function handlers(inQueue: (target: string) => boolean) {
  const calls: unknown[][] = [];
  const zoneHandlers = createZoneHandlers(
    {
      getState: () => ({ plshuffle: 0 }),
      getMetadata: () => ({}),
      handleCommand: (...args: unknown[]) => calls.push(['handleCommand', ...args]),
      playContent: async (...args: unknown[]) => {
        calls.push(['playContent', args[0], args[1]]);
      },
      queue: {
        setPendingShuffle: () => {},
        seekInQueue: (_zoneId: number, target: string) => inQueue(target),
      },
    } as any,
    {} as any,
    {} as any,
    { resolveMetadata: async () => null } as any,
  );
  return { zoneHandlers, calls };
}

test('a tap on a queue row plays that row from the queue, and leaves the queue alone', async () => {
  // What the app sends: the row's audiopath, with the zone as its "parent folder".
  const { zoneHandlers, calls } = handlers((target) => target === 'spotify:track:34852094');
  const result = await zoneHandlers.audioPlayUrl('audio/14/playurl/spotify:track:34852094/parentid/14/1/noshuffle');
  assert.deepEqual(calls, [['handleCommand', 14, 'queueplaycurrent']], 'no new play request, so no new queue');
  assert.equal(result.name, 'playurl');
  assert.deepEqual(result.payload, { uri: 'spotify:track:34852094' });
});

test('the same tap sent as a service play is recognised too', async () => {
  // The form the app uses when it can place the row's account.
  const { zoneHandlers, calls } = handlers((target) => target === 'spotify@bridge-tidal-9zk2:track:34852094');
  await zoneHandlers.audioServicePlay(
    'audio/14/serviceplay/spotify/bridge-tidal-9zk2/spotify:track:34852094/parentid/14/1/noshuffle',
  );
  assert.deepEqual(calls, [['handleCommand', 14, 'queueplaycurrent']]);
});

test('a track that is not in the queue is new music, as before', async () => {
  const { zoneHandlers, calls } = handlers(() => false);
  await zoneHandlers.audioPlayUrl('audio/14/playurl/spotify@bridge-tidal-9zk2:track:55555555/noshuffle');
  assert.deepEqual(calls, [['playContent', 14, 'spotify@bridge-tidal-9zk2:track:55555555']]);
});

test('a track picked out of an album is never taken for a queue row', async () => {
  // It names its album, so it starts that album — even if the track is in the queue already.
  const { zoneHandlers, calls } = handlers(() => true);
  await zoneHandlers.audioServicePlay(
    'audio/14/serviceplay/spotify/bridge-tidal-9zk2/spotify@bridge-tidal-9zk2:track:34852094/parentpath/spotify@bridge-tidal-9zk2:album:777/3/noshuffle',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'playContent');
  assert.match(String(calls[0]![2]), /\/parentpath\//);
});

test('a parent id that names no folder does not ride along as part of the path', async () => {
  const { zoneHandlers, calls } = handlers(() => false);
  await zoneHandlers.audioServicePlay(
    'audio/14/serviceplay/spotify/bridge-tidal-9zk2/spotify@bridge-tidal-9zk2:track:55555555/parentid/14/0/noshuffle',
  );
  assert.deepEqual(calls, [['playContent', 14, 'spotify@bridge-tidal-9zk2:track:55555555']]);
});
