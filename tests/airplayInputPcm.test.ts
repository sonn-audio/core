import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from './testHarness';
import { AirplayInstance } from '../src/adapters/inputs/airplay/airplayInstance';
import type { AirplayInstanceController } from '../src/adapters/inputs/airplay/airplayInstance';
import { collapseRepeats } from '../src/shared/logging/collapseRepeats';
import { logManager } from '../src/shared/logging/logger';
import type { MdnsPort } from '../src/ports/MdnsPort';
import type { PlayerRegistryPort } from '../src/ports/PlayerRegistryPort';

const noop = (): void => {};

/** 8 ms of 44.1 kHz stereo, the size an AirPlay sender delivers a packet in. */
const PACKET_BYTES = 1408;
const PACKETS_PER_SECOND = (44100 * 4) / PACKET_BYTES;

function tone(amplitude: number): Buffer {
  const pcm = Buffer.alloc(PACKET_BYTES);
  for (let offset = 0; offset < PACKET_BYTES; offset += 2) {
    pcm.writeInt16LE(Math.round(Math.sin(offset / 20) * amplitude), offset);
  }
  return pcm;
}

const music = (): Buffer => tone(8000);

function makeZone() {
  const calls: string[] = [];
  const controller: AirplayInstanceController = {
    startPlayback: () => calls.push('start'),
    updateMetadata: noop,
    updateCover: () => undefined,
    updateVolume: noop,
    updateTiming: noop,
    pausePlayback: () => calls.push('pause'),
    resumePlayback: () => calls.push('resume'),
    stopPlayback: () => calls.push('stop'),
  };
  const playerRegistry = { getPlayer: () => null } as unknown as PlayerRegistryPort;
  const mdns = {} as MdnsPort;
  const zone = new AirplayInstance(7, 'Kitchen', '88AEDD681068', { enabled: true }, controller, playerRegistry, mdns);
  const internals = zone as unknown as {
    handlePcmFrame(payload: Buffer, sampleRate?: number, channels?: number): void;
  };
  const feed = (packet: () => Buffer, seconds: number): void => {
    for (let i = 0; i < Math.ceil(seconds * PACKETS_PER_SECOND); i += 1) {
      internals.handlePcmFrame(packet(), 44100, 2);
    }
  };
  return { zone, calls, feed };
}

// #412. A line per PCM packet at spam level was enough load to make the AirPlay audio stutter.
test('received AirPlay audio is not logged per packet, even at spam level', async () => {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  logManager.configure({ level: 'spam', stdout: sink, stderr: sink });
  const { zone, feed } = makeZone();
  try {
    feed(music, 2);
  } finally {
    logManager.configure({ level: 'info', stdout: process.stdout, stderr: process.stderr });
    await zone.stop();
  }
  assert.ok(lines.length < 10, `expected a handful of lines for 2 s of audio, got ${lines.length}`);
});

test('a log line repeated per packet is written at most once a second', () => {
  let clock = 0;
  const written: Array<[string, number]> = [];
  const log = collapseRepeats((message, repeats) => written.push([message, repeats]), 1000, () => clock);
  // 86 packets a second, each one failing.
  for (let i = 0; i < 86; i += 1) {
    log('RTP send failed: EHOSTUNREACH');
    clock += 12;
  }
  assert.deepEqual(written, [
    ['RTP send failed: EHOSTUNREACH', 0],
    ['RTP send failed: EHOSTUNREACH', 83],
  ]);
  log('RAOP sync send failed: EHOSTUNREACH');
  assert.equal(written.at(-1)?.[0], 'RAOP sync send failed: EHOSTUNREACH', 'a different message is not held back');
});
