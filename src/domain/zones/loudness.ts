import { EQUALIZER_BAND_COUNT } from '@/domain/zones/equalizer';

/**
 * Loudness compensation: lift the bass and the top end when a zone plays quietly.
 *
 * The ear loses the ends of the spectrum first as the level drops — the equal-loudness contours
 * flatten out towards the top and bunch up at the bottom — so music turned down sounds thin, not
 * just quiet. The classic amplifier switch answers that with a fixed tilt; this one follows the
 * zone's volume, so it does the most where it is needed and fades out as the zone is turned up.
 *
 * The curve is expressed on the same ten ISO bands the equalizer uses, which is what lets it ride
 * the existing DSP stage: a zone's effective curve is its equalizer plus this, and a volume change
 * is a coefficient swap on the running stream.
 */

/** The lift at full strength, in dB, per equalizer band (31 Hz … 16 kHz). */
const FULL_CONTOUR_DB: ReadonlyArray<number> = Object.freeze([6, 5, 3, 1, 0, 0, 0, 0, 1.5, 3]);

/** At and above this volume the compensation has all but faded out. */
const REFERENCE_VOLUME = 80;

/** The contour moves in steps this size, so a volume drag is a handful of changes, not a hundred. */
const STEP_DB = 0.5;

/**
 * What is left at the reference volume and above. Not zero on purpose: a curve that goes exactly
 * flat lets the stream fall back to its untouched path, and coming back from there costs a restart
 * of the decoder — an audible hiccup for turning the volume down. A tenth of a dB at 31 Hz is
 * inaudible and keeps the stage in place for as long as the switch is on.
 */
const RESIDUAL_DB = 0.1;

/** The lift for a zone at `volume` (0–100), one value per equalizer band. */
export function loudnessContour(volume: number): number[] {
  const level = Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 0;
  const strength = Math.max(0, (REFERENCE_VOLUME - level) / REFERENCE_VOLUME);
  const contour = FULL_CONTOUR_DB.map((full) => Math.round((full * strength) / STEP_DB) * STEP_DB);
  contour[0] = Math.max(contour[0] ?? 0, RESIDUAL_DB);
  return contour;
}

/** A zone's equalizer with the loudness lift for `volume` laid over it. */
export function withLoudness(bands: ReadonlyArray<number> | null | undefined, volume: number): number[] {
  const contour = loudnessContour(volume);
  return Array.from({ length: EQUALIZER_BAND_COUNT }, (_unused, index) => {
    const own = Number(bands?.[index] ?? 0);
    return (Number.isFinite(own) ? own : 0) + (contour[index] ?? 0);
  });
}

/** Whether moving a zone between these two volumes changes the lift at all. */
export function loudnessContourChanges(fromVolume: number, toVolume: number): boolean {
  const from = loudnessContour(fromVolume);
  const to = loudnessContour(toVolume);
  return from.some((value, index) => value !== to[index]);
}
