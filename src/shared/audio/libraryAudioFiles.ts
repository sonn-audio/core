import path from 'node:path';

/**
 * The file extensions the local library indexes, each with the MIME type the file is served as.
 *
 * The one list every part of the library reads: the scanner, the folder view, the upload check and the
 * byte-for-byte streamers. When they kept copies of their own, a new extension landed in one and not
 * the others, and the file showed up in one place and nowhere else.
 *
 * `.mp4` and `.m4b` are the same ISO BMFF container as `.m4a`, so they are served as `audio/mp4`; an
 * `.mp4` may also carry a video stream, which playback drops (`-vn`).
 */
export const LIBRARY_AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/** Whether the library indexes a file of this name, judged by its extension alone. */
export function isLibraryAudioFile(name: string): boolean {
  return Object.hasOwn(LIBRARY_AUDIO_MIME_TYPES, path.extname(name).toLowerCase());
}

/**
 * Whether a file of this name may be a video with no audio at all, so the extension alone does not
 * make it a track. Such a file is only indexed once its tags show an audio stream.
 */
export function mayLackAudioStream(name: string): boolean {
  return path.extname(name).toLowerCase() === '.mp4';
}
