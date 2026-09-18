/**
 * AirPlay 1 (RAOP) end-to-end probe, without any hardware.
 *
 * Runs node-airplay's own RAOP receiver on localhost and streams a tone at it
 * through the real output sender, then reports what the receiver decoded. This
 * is what stands in for the gear the AirPlay 1 lane exists for (#386): if the
 * packets, the ALAC framing, the volume verb and the metadata blob are wrong,
 * the receiver says so here rather than a speaker in someone's house.
 *
 * Run: npx ts-node --transpile-only scripts/raop-loopback.ts
 * Exit code 0 means audio came out the other end.
 */
import 'tsconfig-paths/register';
import { PassThrough } from 'node:stream';
import { AirPlayReceiver, type ReceiverEvent } from '@sonn-audio/node-airplay';
import { AirplayLaneSender } from '@/adapters/outputs/airplay/laneSender';

const SECONDS = 3;

async function main(): Promise<void> {
  let pcmBytes = 0;
  const events: string[] = [];
  const receiver = new AirPlayReceiver({ name: 'loopback', port: 0 }, (event: ReceiverEvent) => {
    if (event.type === 'pcm') {
      pcmBytes += event.data.length;
    } else {
      events.push(event.type + (event.type === 'volume' ? `=${event.value}` : ''));
    }
  });
  const advertisement = await receiver.start();
  console.log('receiver on port', advertisement.port);

  // No `features` in the config: exactly what a zone saved before the lane was
  // recorded looks like, so this exercises the AirPlay 2 -> RAOP fallback too.
  const sender = new AirplayLaneSender(
    { host: '127.0.0.1', port: advertisement.port },
    { zoneId: 1, zoneName: 'Loopback' },
  );

  // A 440 Hz tone, s16le stereo 44.1k, written in realtime-sized chunks — a
  // source that runs ahead would exercise the backpressure gate instead.
  const source = new PassThrough();
  let phase = 0;
  const timer = setInterval(() => {
    const frames = 4410; // 100 ms
    const buffer = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const value = Math.round(Math.sin((2 * Math.PI * 440 * phase++) / 44_100) * 8000);
      buffer.writeInt16LE(value, i * 4);
      buffer.writeInt16LE(value, i * 4 + 2);
    }
    source.write(buffer);
  }, 100);

  const started = await sender.start(source, 55);
  console.log('sender started:', started, 'latencyMs', sender.getLatencyMs());
  if (!started) {
    clearInterval(timer);
    receiver.stop();
    process.exit(1);
  }

  sender.updateMetadata({ title: 'Tone', artist: 'Test', album: 'Loopback' });
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  clearInterval(timer);

  console.log('receiver stats', receiver.stats);
  console.log('decoded', Math.round((pcmBytes / (44_100 * 4)) * 1000), 'ms of audio');
  console.log('events:', events.join(','));
  sender.stop();
  receiver.stop();
  process.exit(pcmBytes > 44_100 * 4 ? 0 : 2);
}

void main();
