/**
 * The two base rates, for outputs that fetch a stream over HTTP and decode it themselves.
 *
 * Everything that plays FLAC, WAV or MP3 plays both: 44.1 kHz is CD and nearly all streamed music,
 * 48 kHz is video, most radio and everything that started life as Opus. Naming only the first made
 * every 48 kHz source take a detour through the resampler on its way to a device that did not need
 * it. The higher rates are left out on purpose — which of those a given device takes is a property
 * of that device, and a guess that is wrong plays nothing at all.
 */
export const BASE_PLAYABLE_RATES: number[] = [44100, 48000];
