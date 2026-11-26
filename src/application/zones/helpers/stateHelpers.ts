import type { ZoneConfig } from '@/domain/config/types';
import type { QueueState } from '@/application/zones/zoneManager';
import type { ZoneState } from '@/domain/zones/zoneState';
import { AudioType } from '@/domain/zones/enums';
import { parseServiceNativeAudiopath } from '@/domain/zones/audiopath';
import { getZoneEqualizerBands } from '@/domain/zones/equalizer';
import { normalizePowerManagerConfig } from '@/application/zones/services/powerManager';

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampVolumeForZone(zone: ZoneConfig, value: number): number {
  const raw = Number.isFinite(value) ? Number(value) : 0;
  const maxVol =
    typeof zone.volumes?.maxVolume === 'number' && zone.volumes.maxVolume > 0
      ? zone.volumes.maxVolume
      : 100;
  const step = typeof zone.volumes?.volstep === 'number' && zone.volumes.volstep > 0
    ? zone.volumes.volstep
    : null;
  const stepped = step ? Math.round(raw / step) * step : raw;
  return clamp(Math.round(stepped), 0, maxVol);
}

/**
 * The zone's configured default volume, falling back to a sensible level when none is set.
 * The fallback must not be 0: this value seeds the zone state, the fresh-start dispatch and
 * the unmute restore, and 0 in all of those means a zone that starts muted (issue #358, an
 * unconfigured zone began every play in silence). An explicit 0 stays the user's choice.
 *
 * A negative default means "not set". The Audioserver configuration writes -1 for it and the
 * public API reports that -1 unchanged, so the value is not a level and must not be clamped as
 * one: read as a number, it became 0, and every zone without a default started muted. An
 * installation that leaves the sentinel in place lost its speaker volumes on every restart.
 */
export function getZoneDefaultVolume(zone: ZoneConfig): number {
  const configured = zone.volumes?.default;
  const resolved =
    typeof configured === 'number' && configured >= 0 ? configured : FALLBACK_DEFAULT_VOLUME;
  return clampVolumeForZone(zone, resolved);
}

const FALLBACK_DEFAULT_VOLUME = 25;

export function cloneQueueState(queue: QueueState): QueueState {
  return {
    items: queue.items.map((item, idx) => ({ ...item, qindex: idx })),
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    currentIndex: queue.currentIndex,
    authority: queue.authority,
  };
}

export function fallbackTitle(current: string | undefined, zoneName: string): string {
  if (current && !isUriLike(current)) {
    return current;
  }
  return zoneName;
}

export function sanitizeTitle(title: string | undefined, fallback: string): string {
  if (!title) return fallback;
  const lower = title.toLowerCase();
  if (lower.startsWith('spotify:') || lower.startsWith('spotify@')) {
    return fallback;
  }
  // Service-native audiopath (applemusic:playlist:..., tidal:track:..., etc.)
  // must never leak into the displayed title.
  if (parseServiceNativeAudiopath(title)) {
    return fallback;
  }
  if (/^[A-Za-z0-9]{16,}$/i.test(title.trim())) {
    return fallback;
  }
  return title;
}

export function isUriLike(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return (
    lower.startsWith('spotify:') ||
    lower.startsWith('spotify@') ||
    parseServiceNativeAudiopath(value) !== null ||
    /^[A-Za-z0-9]{16,}$/.test(value.trim())
  );
}

export function resolveDisplayAudiotype(
  audiotype: number | null | undefined,
  queueAuthority?: string | null,
): number | undefined {
  if (audiotype == null) {
    return undefined;
  }
  if (audiotype === AudioType.Spotify && queueAuthority !== 'spotify') {
    return AudioType.Playlist;
  }
  return audiotype;
}

export function buildInitialState(zone: ZoneConfig): ZoneState {
  const defaultVol = getZoneDefaultVolume(zone);
  const powerManaged = normalizePowerManagerConfig(zone.powerManager ?? null).actions.length > 0;
  return {
    id: zone.id,
    name: zone.name,
    title: '',
    artist: '',
    album: '',
    coverurl: '',
    audiopath: '',
    duration: 0,
    eq: getZoneEqualizerBands(zone),
    time: 0,
    qindex: 0,
    queueAuthority: 'local',
    plshuffle: 0,
    plrepeat: 0,
    volume: defaultVol,
    muted: false,
    mode: 'stop',
    audiotype: 0,
    sourceName: zone.sourceMac,
    station: '',
    type: 3,
    clientState: 'on',
    // A configured power manager has no persisted hardware state after a restart. Its
    // initial stopped state is therefore the safe/expected OFF state; the manager updates
    // this field again after a confirmed physical switch.
    power: powerManaged ? 'off' : 'on',
  };
}
