import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from './testHarness';
import * as loader from '../src/adapters/outputs/googleCast/googlecastLoader';
import { GoogleCastOutput } from '../src/adapters/outputs/googleCast/googleCastOutput';
import type { OutputPorts } from '../src/adapters/outputs/outputPorts';
import type { PlaybackSession } from '../src/ports/types/playback';

/*
 * Issue #431: picking another track on a Cast speaker went silent. Two loads ran at once (the old
 * stream reloaded for new metadata, then the new stream from play()); the receiver cancelled the
 * older one, which was retried and landed after the new load, replacing it. A load overtaken by a
 * newer one must not be retried: the newer media is the last one the receiver is given.
 */

type Loader = { loadGoogleCastModule: typeof loader.loadGoogleCastModule };

function session(url: string): PlaybackSession {
  return {
    zoneId: 2,
    playbackSource: { kind: 'pipe' },
    stream: { url },
    metadata: { title: url },
  } as unknown as PlaybackSession;
}

test('a cast load overtaken by a newer one is not retried over it', async () => {
  const original = (loader as Loader).loadGoogleCastModule;
  const loaded: string[] = [];
  let cancelFirst: (() => void) | null = null;
  const device = new EventEmitter() as EventEmitter & Record<string, unknown>;
  device.getSession = () => ({ appId: 'CC1AD845', transportId: 't' });
  device.media = {
    load: (contentId: string) => {
      loaded.push(contentId);
      if (loaded.length === 1) {
        // The first load hangs until the receiver is handed the next one, then is cancelled.
        return new Promise((_resolve, reject) => {
          cancelFirst = () => reject(new Error('Load cancelled'));
        });
      }
      cancelFirst?.();
      return Promise.resolve({ status: [{ mediaSessionId: loaded.length }] });
    },
    getStatusModel: async () => ({ playerState: 'PLAYING' }),
  };
  device.disconnect = async () => {};
  (loader as Loader).loadGoogleCastModule = (async () => ({
    connect: async () => device,
  })) as unknown as typeof loader.loadGoogleCastModule;
  try {
    const ports = {
      config: { getSystemConfig: () => ({ audioserver: { ip: '10.0.0.2' } }) },
    } as unknown as OutputPorts;
    const output = new GoogleCastOutput(2, 'Probe 2', { host: '10.0.0.9' }, ports);

    const first = output.play(session('/streams/2/old.flac'));
    while (loaded.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = output.play(session('/streams/2/new.flac'));
    await Promise.all([first, second]);

    assert.equal(loaded.length, 2, 'the cancelled load is not sent again');
    assert.match(loaded[loaded.length - 1]!, /new\.flac/, 'the newer stream is the last one loaded');
  } finally {
    (loader as Loader).loadGoogleCastModule = original;
  }
});
