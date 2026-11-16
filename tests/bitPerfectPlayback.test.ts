import assert from 'node:assert/strict';
import { test } from './testHarness';
import { FfmpegArgBuilder } from '../src/engine/ffmpegArgs';
import { runPcmBlend } from '../src/engine/pcmCrossfade';
import type { AudioOutputSettings } from '../src/engine/audioFormat';

const BASE_OUTPUT: AudioOutputSettings = {
  sampleRate: 96000,
  channels: 2,
  pcmBitDepth: 24,
  mp3Bitrate: '160k',
  prebufferBytes: 262144,
  httpProfile: 'default',
  httpFallbackSeconds: 43200,
  fixedGainDb: 0,
  httpIcyEnabled: false,
  httpIcyInterval: 16384,
  httpIcyName: 'sonn-core',
};

const SOURCE = { kind: 'file' as const, path: '/music/track.flac' };
const NATIVE_24_96 = { sampleRate: 96000, channels: 2, bitDepth: 24, lossless: true };

const hasResample = (args: string[]): boolean => args.some((a) => a.includes('aresample'));

test('a lossless source matching the sink streams without a resampler', () => {
  const builder = new FfmpegArgBuilder(SOURCE, 'pcm', BASE_OUTPUT, false, undefined, NATIVE_24_96);
  assert.equal(builder.isBitPerfect(null), true);
  const args = builder.buildOutputArgs(null);
  assert.equal(hasResample(args), false);
  assert.ok(args.includes('pcm_s24le'), 'expected 24-bit PCM codec');
  assert.ok(args.includes('s24le'), 'expected 24-bit output format');
});

test('a rate or depth mismatch keeps the resampler', () => {
  const mismatched = { ...BASE_OUTPUT, sampleRate: 44100, pcmBitDepth: 16 as const };
  const builder = new FfmpegArgBuilder(SOURCE, 'pcm', mismatched, false, undefined, NATIVE_24_96);
  assert.equal(builder.isBitPerfect(null), false);
  assert.equal(hasResample(builder.buildOutputArgs(null)), true);
});

test('a lossless source at a different depth is requantised, so not passthrough', () => {
  // 24-bit source into a 16-bit sink genuinely loses bits on our side.
  const at16 = { ...BASE_OUTPUT, pcmBitDepth: 16 as const };
  const builder = new FfmpegArgBuilder(SOURCE, 'pcm', at16, false, undefined, NATIVE_24_96);
  assert.equal(builder.isBitPerfect(null), false);
  assert.equal(hasResample(builder.buildOutputArgs(null)), true);
});

test('a lossy source at the sink rate is not resampled, and is dithered only where it must be', () => {
  // Bit-perfect here means "we do not touch it". Apple Music is AAC 44.1k: served
  // at 44.1k we hand the provider's decode to the player exactly as delivered.
  // Resampling to 48k would alter every sample and inflate the stream ~2.7x.
  const aacSource = {
    kind: 'url' as const,
    url: 'http://127.0.0.1:7090/applemusic/abc/segment?u=x',
    inputFormat: 'mov',
    decryptionKey: 'deadbeef',
    nativeFormat: { sampleRate: 44100, channels: 2, lossless: false, codecName: 'aac' },
  };
  // A lossy source declares no depth: there is no original width to preserve.
  const native = { sampleRate: 44100, channels: 2, bitDepth: null, lossless: false };
  const atNative = { ...BASE_OUTPUT, sampleRate: 44100, pcmBitDepth: 16 as const };

  // At 16 bits "untouched" was never on offer. The decode is floating point and something has to
  // make integers of it; with no stage of ours in the chain ffmpeg rounds, and the rounding error
  // follows the signal. Measured on a 1 kHz tone at -84 dBFS from a 256 kb/s AAC: odd harmonics
  // at -102 to -116 dBFS, against -140 through the dithered conversion. So that conversion runs —
  // at the source's own rate, which is a change of format and not a resample.
  const matched = new FfmpegArgBuilder(aacSource, 'flac', atNative, false, undefined, native);
  assert.equal(matched.isBitPerfect(null), false);
  const args16 = matched.buildOutputArgs(null);
  const filter16 = args16[args16.indexOf('-af') + 1] ?? '';
  assert.match(filter16, /osr=44100/, 'the rate stays the source\'s own');
  assert.match(filter16, /osf=s16/);
  assert.match(filter16, /dither_method=/);

  // In 24 bits the rounding error is below anything a converter resolves: carrying AAC there
  // loses nothing and needs nothing added, so that stays a passthrough.
  const at24 = { ...BASE_OUTPUT, sampleRate: 44100, pcmBitDepth: 24 as const };
  const wider = new FfmpegArgBuilder(aacSource, 'flac', at24, false, undefined, native);
  assert.equal(wider.isBitPerfect(null), true);
  assert.equal(hasResample(wider.buildOutputArgs(null)), false);

  // A rate mismatch does alter the samples, so it must still resample.
  const mismatched = new FfmpegArgBuilder(aacSource, 'flac', BASE_OUTPUT, false, undefined, native);
  assert.equal(mismatched.isBitPerfect(null), false);
  assert.equal(hasResample(mismatched.buildOutputArgs(null)), true);
});

test('active DSP disables bit-perfect passthrough', () => {
  // EQ, fixed gain and a pre-delay each force ffmpeg into filtered processing,
  // so none of them may report a bit-perfect path.
  const eqBuilder = new FfmpegArgBuilder(SOURCE, 'pcm', BASE_OUTPUT, false, undefined, NATIVE_24_96);
  assert.equal(eqBuilder.isBitPerfect([4, 0, 0, 0, 0, 0, 0, 0, 0, 0]), false);

  const gainBuilder = new FfmpegArgBuilder(
    SOURCE, 'pcm', { ...BASE_OUTPUT, fixedGainDb: -6 }, false, undefined, NATIVE_24_96,
  );
  assert.equal(gainBuilder.isBitPerfect(null), false);

  const delayBuilder = new FfmpegArgBuilder(SOURCE, 'pcm', BASE_OUTPUT, false, 250, NATIVE_24_96);
  assert.equal(delayBuilder.isBitPerfect(null), false);
});

test('without probe data the legacy resampling path is unchanged', () => {
  const builder = new FfmpegArgBuilder(SOURCE, 'pcm', BASE_OUTPUT, false, undefined, undefined);
  assert.equal(builder.isBitPerfect(null), false);
  assert.equal(hasResample(builder.buildOutputArgs(null)), true);
});

test('flac output pins the sample format to the negotiated depth', () => {
  // Without an explicit -sample_fmt, ffmpeg's flac encoder inherits the *source*
  // depth, so a 24-bit file produced 24-bit frames while stream/start advertised
  // 16-bit — the client would then decode noise.
  const at24 = new FfmpegArgBuilder(SOURCE, 'flac', BASE_OUTPUT, false, undefined, NATIVE_24_96)
    .buildOutputArgs(null);
  assert.equal(at24[at24.indexOf('-sample_fmt') + 1], 's32', 'flac carries 24-bit inside s32');

  const at16 = new FfmpegArgBuilder(
    SOURCE, 'flac', { ...BASE_OUTPUT, pcmBitDepth: 16 }, false, undefined, NATIVE_24_96,
  ).buildOutputArgs(null);
  assert.equal(at16[at16.indexOf('-sample_fmt') + 1], 's16');
});

test('the two-stage PCM bus carries the negotiated depth end to end', () => {
  // The decoder used to hardcode s16le while the encoder emitted pcm_s24le, which
  // silently padded 16-bit samples into 24-bit containers.
  const builder = new FfmpegArgBuilder(SOURCE, 'pcm', BASE_OUTPUT, false, undefined, NATIVE_24_96);
  const decoder = builder.buildPcmDecoderArgs();
  assert.ok(decoder.includes('pcm_s24le'), 'decoder must emit 24-bit PCM');
  assert.equal(decoder[decoder.lastIndexOf('-f') + 1], 's24le');

  const encoder = builder.buildPcmEncoderArgs();
  assert.equal(encoder[encoder.indexOf('-f') + 1], 's24le', 'encoder stdin must match decoder output');
});

test('crossfade blends correctly at 16, 24 and 32 bit', async () => {
  for (const bytesPerSample of [2, 3, 4]) {
    const channels = 2;
    const totalFrames = 100;
    const amplitude = bytesPerSample === 2 ? 30000 : bytesPerSample === 3 ? 8_000_000 : 2_000_000_000;

    const fill = (value: number): Buffer => {
      const frames = totalFrames * 3;
      const buf = Buffer.alloc(frames * channels * bytesPerSample);
      for (let f = 0; f < frames; f++) {
        for (let ch = 0; ch < channels; ch++) {
          const off = f * channels * bytesPerSample + ch * bytesPerSample;
          if (bytesPerSample === 4) buf.writeInt32LE(value, off);
          else buf.writeIntLE(value, off, bytesPerSample);
        }
      }
      return buf;
    };

    const emitted: Buffer[] = [];
    await runPcmBlend([fill(amplitude)], [fill(-amplitude)], {
      channels,
      bytesPerSample,
      totalFrames,
      getOldEnded: () => false,
      getNewEnded: () => false,
      onBlendedFrame: (b) => emitted.push(b),
      log: { debug: () => {}, warn: () => {} },
      logContext: {},
    });

    const all = Buffer.concat(emitted);
    const frameBytes = channels * bytesPerSample;
    assert.equal(all.length / frameBytes, totalFrames, `${bytesPerSample}B: frame count`);

    const read = (off: number): number =>
      bytesPerSample === 4 ? all.readInt32LE(off) : all.readIntLE(off, bytesPerSample);

    // A linear ramp must start near +amplitude, cross zero, and end near -amplitude.
    assert.ok(Math.abs(read(0) - amplitude) < amplitude * 0.05, `${bytesPerSample}B: ramp start`);
    assert.ok(
      Math.abs(read(Math.floor(totalFrames / 2) * frameBytes)) < amplitude * 0.1,
      `${bytesPerSample}B: ramp midpoint`,
    );
    assert.ok(
      Math.abs(read((totalFrames - 1) * frameBytes) + amplitude) < amplitude * 0.05,
      `${bytesPerSample}B: ramp end`,
    );
  }
});
