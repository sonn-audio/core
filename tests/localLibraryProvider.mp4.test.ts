import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from './testHarness';
import { makeNotifierFake } from './fakes/notifierPort';
import { LocalLibraryProvider } from '../src/adapters/content/providers/localLibraryProvider';
import {
  isLibraryAudioFile,
  LIBRARY_AUDIO_MIME_TYPES,
} from '../src/shared/audio/libraryAudioFiles';
import type { ConfigPort } from '../src/ports/ConfigPort';

const configPort: ConfigPort = {
  load: async () => {
    throw new Error('not configured');
  },
  getConfig: () => {
    throw new Error('not configured');
  },
  getSystemConfig: () => ({ audioserver: { ip: '127.0.0.1' } }) as any,
  getRawAudioConfig: () => {
    throw new Error('not configured');
  },
  ensureInputs: () => {},
  updateConfig: async () => {
    throw new Error('not configured');
  },
};

/*
 * A minimal ISO BMFF file, built by hand so the suite needs no ffmpeg: one `trak` per stream, each
 * with the handler and sample description the tag parser reads to tell audio from video. No media
 * data — the scan never decodes, it only reads these boxes.
 */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function u32(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => out.writeUInt32BE(value, index * 4));
  return out;
}

const UNITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

function trak(kind: 'audio' | 'video', trackId: number): Buffer {
  const tkhd = box('tkhd', u32(0, 0, 0, trackId, 0, 44100), Buffer.alloc(16), UNITY_MATRIX, u32(0, 0));
  const mdhd = box('mdhd', u32(0, 0, 0, 44100, 44100), Buffer.alloc(4));
  const hdlr = box('hdlr', u32(0, 0), Buffer.from(kind === 'audio' ? 'soun' : 'vide', 'latin1'),
    Buffer.alloc(13));
  const sampleEntry =
    kind === 'audio'
      ? box('mp4a', Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(8),
        Buffer.from([0, 2, 0, 16, 0, 0, 0, 0]), u32(44100 * 0x10000))
      : box('avc1', Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(70));
  const stsd = box('stsd', u32(0, 1), sampleEntry);
  const stsz = box('stsz', u32(0, 0, 0));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd, stsz))));
}

function mp4(...tracks: Array<'audio' | 'video'>): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isommp41', 'latin1'));
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, 1000, 0x00010000), Buffer.from([1, 0]), Buffer.alloc(10),
    UNITY_MATRIX, Buffer.alloc(24), u32(tracks.length + 1));
  return Buffer.concat([ftyp, box('moov', mvhd, ...tracks.map((kind, index) => trak(kind, index + 1)))]);
}

async function withLibrary(
  files: Record<string, Buffer>,
  run: (provider: LocalLibraryProvider, albumDir: string) => Promise<void>,
): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sonn-core-library-mp4-'));
  try {
    process.chdir(tempDir);
    const albumDir = path.join(tempDir, 'data', 'music', 'local', 'Band', 'Live');
    await fs.mkdir(albumDir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      await fs.writeFile(path.join(albumDir, name), data);
    }
    await run(new LocalLibraryProvider(makeNotifierFake(), configPort), albumDir);
  } finally {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function albumFolderNames(provider: LocalLibraryProvider): Promise<string[]> {
  const root = await provider.getMediaFolder('library-local-folders', 0, 50);
  const band = await provider.getMediaFolder(root!.items.find((item) => item.name === 'Band')!.id, 0, 50);
  const live = await provider.getMediaFolder(band!.items.find((item) => item.name === 'Live')!.id, 0, 50);
  return (live?.items ?? []).map((item) => item.name).sort();
}

test('library audio files: .mp4 and .m4b are library audio, served as audio/mp4 like .m4a', () => {
  for (const name of ['Concert.mp4', 'Book.M4B', 'Song.m4a']) {
    assert.equal(isLibraryAudioFile(name), true, name);
  }
  assert.equal(isLibraryAudioFile('Clip.mkv'), false);
  assert.equal(isLibraryAudioFile('notes.txt'), false);
  assert.equal(LIBRARY_AUDIO_MIME_TYPES['.mp4'], 'audio/mp4');
  assert.equal(LIBRARY_AUDIO_MIME_TYPES['.m4b'], 'audio/mp4');
});

test('local library: an .mp4 with an audio track and an .m4b are indexed as tracks', async () => {
  await withLibrary(
    { '01 Opening.mp4': mp4('video', 'audio'), '02 Chapter.m4b': mp4('audio') },
    async (provider) => {
      assert.equal(await provider.syncPath('local/Band/Live/01 Opening.mp4'), 'added');
      assert.equal(await provider.syncPath('local/Band/Live/02 Chapter.m4b'), 'added');
      assert.deepEqual(await albumFolderNames(provider), ['01 Opening', '02 Chapter']);
    },
  );
});

test('local library: a video-only .mp4 is not indexed and not listed in its folder', async () => {
  await withLibrary(
    { '01 Opening.mp4': mp4('video', 'audio'), '02 B-roll.mp4': mp4('video') },
    async (provider) => {
      assert.equal(await provider.syncPath('local/Band/Live/02 B-roll.mp4'), 'ignored');
      // Before the scan has seen it, an .mp4 is not offered on its extension alone either.
      assert.deepEqual(await albumFolderNames(provider), []);
      assert.equal(await provider.syncPath('local/Band/Live/01 Opening.mp4'), 'added');
      assert.deepEqual(await albumFolderNames(provider), ['01 Opening']);
    },
  );
});

test('local library: an .mp4 that loses its audio track on re-encode drops out of the index', async () => {
  await withLibrary({ 'Clip.mp4': mp4('video', 'audio') }, async (provider, albumDir) => {
    assert.equal(await provider.syncPath('local/Band/Live/Clip.mp4'), 'added');
    await fs.writeFile(path.join(albumDir, 'Clip.mp4'), mp4('video'));
    assert.equal(await provider.syncPath('local/Band/Live/Clip.mp4'), 'removed');
    assert.deepEqual(await albumFolderNames(provider), []);
  });
});
