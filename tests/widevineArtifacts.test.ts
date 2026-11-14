import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './testHarness';
import {
  readWidevineArtifacts,
  WidevineArtifactsError,
  type WidevineCdmDirs,
} from '../src/adapters/content/drm/widevine';

// No real CDM belongs in a repository, so the pair here is made up: a fresh RSA key and the
// smallest client id the widevine library will parse — a ClientIdentification holding nothing but
// a token. It opens no licence anywhere; it only has to get past the same checks a real one does.
const PRIVATE_KEY = Buffer.from(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
);
const CLIENT_ID = Buffer.concat([Buffer.from([0x08, 0x00, 0x12, 0x60]), Buffer.alloc(0x60, 0x41)]);

async function withDirs(run: (dirs: WidevineCdmDirs) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sonn-widevine-'));
  const dirs = { uploaded: join(root, 'data'), bundled: join(root, 'image') };
  await mkdir(dirs.uploaded);
  await mkdir(dirs.bundled);
  try {
    await run(dirs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSet(dir: string): Promise<void> {
  await writeFile(join(dir, 'private_key.pem'), PRIVATE_KEY);
  await writeFile(join(dir, 'client_id.bin'), CLIENT_ID);
}

async function verdict(dirs: WidevineCdmDirs): Promise<WidevineArtifactsError> {
  try {
    await readWidevineArtifacts(dirs);
  } catch (err) {
    assert.ok(err instanceof WidevineArtifactsError, `unexpected failure: ${String(err)}`);
    return err;
  }
  return assert.fail('expected the set to be refused');
}

// What a release image is for: nobody uploaded anything, and the music still plays.
test('with nothing uploaded the CDM the image was built with is used', async () => {
  await withDirs(async (dirs) => {
    await writeSet(dirs.bundled);
    const artifacts = await readWidevineArtifacts(dirs);
    assert.equal(artifacts.source, 'bundled');
    assert.deepEqual(artifacts.clientIdBlob, CLIENT_ID);
  });
});

// The bundled set is one key shared by every install; a user's own has to be able to replace it.
test('an uploaded CDM is used in place of the bundled one', async () => {
  await withDirs(async (dirs) => {
    await writeSet(dirs.bundled);
    await writeSet(dirs.uploaded);
    assert.equal((await readWidevineArtifacts(dirs)).source, 'uploaded');
  });
});

// The screen uploads the two files one after the other and asks for a verdict after each. If the
// bundled set stepped in here, the answer after the first file would be "valid" — about a set the
// user did not upload.
test('half an upload is reported as missing, not covered by the bundled set', async () => {
  await withDirs(async (dirs) => {
    await writeSet(dirs.bundled);
    await writeFile(join(dirs.uploaded, 'private_key.pem'), PRIVATE_KEY);
    const err = await verdict(dirs);
    assert.equal(err.code, 'missing');
    assert.deepEqual(err.details, ['client_id.bin missing']);
  });
});

test('a broken upload is reported as invalid, not covered by the bundled set', async () => {
  await withDirs(async (dirs) => {
    await writeSet(dirs.bundled);
    await writeFile(join(dirs.uploaded, 'private_key.pem'), 'not a key');
    await writeFile(join(dirs.uploaded, 'client_id.bin'), CLIENT_ID);
    const err = await verdict(dirs);
    assert.equal(err.code, 'invalid');
    assert.deepEqual(err.details, ['private_key.pem invalid']);
  });
});

// A build without the secrets — a fork, a local `docker build` — carries no CDM, and says so.
test('with no CDM anywhere both files are named as missing', async () => {
  await withDirs(async (dirs) => {
    const err = await verdict(dirs);
    assert.equal(err.code, 'missing');
    assert.deepEqual(err.details, ['private_key.pem missing', 'client_id.bin missing']);
  });
});
