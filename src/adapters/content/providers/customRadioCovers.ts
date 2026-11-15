import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, resolveDataDir } from '@/shared/utils/file';

/**
 * Pictures uploaded for custom radio stations.
 *
 * They live under `data/music/customradio/`, because that is the tree the `/music` route on
 * :7090 already serves — the same route library covers reach the clients through. Nothing
 * else needs to know about them: a station's `coverurl` simply points there. The library
 * scanner reads `local` and the mounted storages, never this folder, and there is no audio in
 * it to find anyway.
 */

/** The folder name under `data/music`, and so the first path segment after `/music/`. */
export const CUSTOM_RADIO_COVER_DIR = 'customradio';

/** Large enough for any phone photo the app sends, small enough not to be a way to fill the disk. */
export const CUSTOM_RADIO_COVER_MAX_BYTES = 8 * 1024 * 1024;

const EXTENSIONS = ['jpg', 'png', 'gif', 'webp'] as const;
type CoverExtension = (typeof EXTENSIONS)[number];

/**
 * What kind of image these bytes are, read off their first bytes.
 *
 * The upload arrives as a bare body: the handler never sees the request's Content-Type, and
 * would not trust it if it did. Anything that is not one of these four is refused, which is
 * also what keeps this from being a way to write arbitrary files into a served folder.
 */
export function sniffImageExtension(data: Buffer): CoverExtension | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'jpg';
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1'))) {
    return 'gif';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** A station id as a file name: ids are uuids, but nothing here should depend on that. */
function fileStem(stationId: string): string {
  return stationId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function coverDir(): string {
  return resolveDataDir('music', CUSTOM_RADIO_COVER_DIR);
}

/**
 * Stores a station's picture and returns its file name, or null when the bytes are not an
 * image we accept. A picture in another format left over from before is removed, so a station
 * never has two.
 */
export async function saveCustomRadioCover(stationId: string, data: Buffer): Promise<string | null> {
  if (!stationId || data.length === 0 || data.length > CUSTOM_RADIO_COVER_MAX_BYTES) {
    return null;
  }
  const extension = sniffImageExtension(data);
  if (!extension) {
    return null;
  }
  await ensureDir(coverDir());
  await removeCustomRadioCover(stationId);
  const fileName = `${fileStem(stationId)}.${extension}`;
  await fsp.writeFile(path.join(coverDir(), fileName), data);
  return fileName;
}

/** Removes whatever picture a station has. Missing files are not an error. */
export async function removeCustomRadioCover(stationId: string): Promise<void> {
  const stem = fileStem(stationId);
  await Promise.all(
    EXTENSIONS.map((extension) => fsp.rm(path.join(coverDir(), `${stem}.${extension}`), { force: true })),
  );
}
