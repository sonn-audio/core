import assert from 'node:assert/strict';
import { test } from './testHarness';
import { SonosStateController } from '../src/application/zones/state/SonosStateController';
import type { ZoneConfig } from '../src/domain/config/types';
import type { ZoneState } from '../src/domain/zones/zoneState';

// A Spotify favourite played on a Sonos zone: the speaker played our stream audibly, but the
// zone said 'stop' the whole time, kept the first track's title, and Loxone said the favourite
// could not be played (#464).

const OWN = 'x-rincon-mp3radio://192.168.1.10:7090/streams/16/current.mp3';

function speaker(playbackState: string) {
  const patches: Array<Partial<ZoneState>> = [];
  const controller = new SonosStateController({
    zone: { id: 16, name: 'WC', output: { host: '192.168.20.34' } } as unknown as ZoneConfig,
    configPort: { getSystemConfig: () => ({ audioserver: { ip: '192.168.1.10' } }) } as any,
    onStatePatch: (_zoneId: number, patch: Partial<ZoneState>) => patches.push(patch),
  }) as any;
  controller.host = '192.168.20.34';
  controller.client = {
    player: {
      group: {
        playbackState,
        positionSeconds: 12,
        name: 'WC',
        playbackMetadataStatus: { currentItem: { track: { name: 'First track', mediaUrl: OWN } } },
      },
    },
  };
  return { controller, patches };
}

test('the speaker does not name what plays on a stream of ours (#464)', () => {
  const { controller, patches } = speaker('PLAYBACK_STATE_PLAYING');
  controller.emitSnapshotPatch();
  const patch = patches[patches.length - 1]!;
  assert.equal(patch.mode, 'play');
  for (const key of ['title', 'artist', 'album', 'coverurl', 'audiopath', 'sourceName']) {
    assert.equal(key in patch, false, `${key} is sonn's to say`);
  }
});
