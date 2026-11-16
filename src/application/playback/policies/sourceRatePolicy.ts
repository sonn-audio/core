import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PcmBitDepth } from '@/ports/types/audioFormat';

/**
 * The rate to run a session at, given what the source is and what the output plays as it comes.
 *
 * Every output used to name one rate, and everything was converted to it: a 48 kHz stream to a
 * renderer that plays 48 kHz perfectly well was resampled to 44.1 kHz first, for no reason but
 * that 44.1 was the number written down. A conversion between those two families is the expensive
 * kind — no whole ratio, every sample recomputed — and the one worth not doing.
 *
 * - A rate the output plays is used as it is: no conversion at all.
 * - A higher one comes down to the highest playable rate that divides it (96 → 48, 88.2 → 44.1),
 *   and only without one of those to the highest playable rate below it.
 * - A lower one goes up to the lowest playable multiple (22.05 → 44.1, 24 → 48), else to the
 *   nearest playable rate above it.
 */
export function pickSessionRate(sourceRate: number, playable: readonly number[]): number | null {
  const rates = [...new Set(playable.filter((rate) => Number.isFinite(rate) && rate > 0))].sort((a, b) => a - b);
  if (!rates.length || !Number.isFinite(sourceRate) || sourceRate <= 0) {
    return null;
  }
  if (rates.includes(sourceRate)) {
    return sourceRate;
  }
  const below = rates.filter((rate) => rate < sourceRate);
  if (below.length) {
    const dividing = below.filter((rate) => sourceRate % rate === 0);
    return (dividing.length ? dividing : below).at(-1) ?? null;
  }
  const multiples = rates.filter((rate) => rate % sourceRate === 0);
  return (multiples.length ? multiples : rates)[0] ?? null;
}

/** The sample rate a source states for itself, or null when nobody has said. */
export function declaredSourceRate(source: PlaybackSource | null): number | null {
  if (!source) {
    return null;
  }
  const rate = source.kind === 'pipe' ? source.sampleRate : source.nativeFormat?.sampleRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * The sample depth to carry a lossless source at, given the depths the output plays.
 *
 * A 24-bit master sent to an output that was only ever asked for 16 bits is cut down on the way,
 * with dither, whether or not the device behind it takes 24. Where it does, the source's own depth
 * is used and nothing is cut. A deeper source than the output plays is carried at the deepest the
 * output has.
 */
export function pickSessionDepth(sourceDepth: number, playable: readonly PcmBitDepth[]): PcmBitDepth | null {
  const depths = [...new Set(playable)].sort((a, b) => a - b);
  if (!depths.length || !Number.isFinite(sourceDepth) || sourceDepth <= 0) {
    return null;
  }
  const fitting = depths.filter((depth) => depth >= sourceDepth);
  return (fitting.length ? fitting[0] : depths.at(-1)) ?? null;
}

/** The depth a lossless source states for itself; null for lossy sources, which have none to keep. */
export function declaredSourceDepth(source: PlaybackSource | null): number | null {
  if (!source || source.kind === 'pipe') {
    return null;
  }
  const native = source.nativeFormat;
  return native?.lossless && typeof native.bitDepth === 'number' ? native.bitDepth : null;
}
