import path from 'node:path';

/** Where a track sits on its album. Zero means "not stated anywhere", never "first". */
export interface TrackPosition {
  disc: number;
  track: number;
}

function positive(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * A track's disc and track number: from its tags when they say, from its path when they do not.
 *
 * Plenty of collections carry the order only in the names — `03 - Title.flac` under `CD 2/` — and
 * an album is an ordered thing whichever way its owner wrote that order down.
 *
 * From the file name, a leading number is the track: `03 Title`, `03. Title`, `3-Title`. A single
 * digit, a dash or dot and two more — `2-07 Title` — is disc and track. Four digits are left alone:
 * that is a year far more often than a track.
 *
 * From the folder, `Disc 2`, `CD2`, `Disk 02` name the disc.
 */
export function resolveTrackPosition(
  tags: { disc?: number | null; track?: number | null },
  relPath: string,
): TrackPosition {
  let disc = positive(tags.disc);
  let track = positive(tags.track);
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  const file = segments.pop() ?? '';
  const base = file.slice(0, file.length - path.extname(file).length);

  if (!track) {
    const discAndTrack = /^(\d)[-.](\d{2})(?!\d)/.exec(base);
    const trackOnly = /^(\d{1,3})(?!\d)/.exec(base);
    if (discAndTrack) {
      track = Number(discAndTrack[2]);
      disc = disc || Number(discAndTrack[1]);
    } else if (trackOnly) {
      track = Number(trackOnly[1]);
    }
  }
  if (!disc) {
    const folder = segments[segments.length - 1] ?? '';
    const named = /^(?:disc|disk|cd)\s*[-_.#]?\s*(\d{1,2})(?!\d)/i.exec(folder.trim());
    if (named) {
      disc = Number(named[1]);
    }
  }
  return { disc, track };
}
