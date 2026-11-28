import type { ZoneContext } from '@/application/zones/internal/zoneTypes';
import type { CommandIntent } from '@/application/zones/playback/types';

export function mapZoneCommandToIntent(input: {
  command: string;
  payload?: string;
  mode: ZoneContext['inputMode'] | null;
  stateVolume?: number;
  config?: { maxVolume?: number; volstep?: number };
  queueShuffle?: boolean;
  queueRepeat?: number;
}): CommandIntent | null {
  const { command, payload } = input;
  switch (command) {
    case 'play':
    case 'resume':
      return { kind: 'PlayResume' };
    case 'pause':
      return { kind: 'Pause' };
    case 'stop':
    case 'off':
      return { kind: 'StopOff' };
    case 'position': {
      // Without a value it is a read, answered by the Loxone handler; Number('') is 0, which
      // made every read a seek to the start (#462).
      if (typeof payload !== 'string' || payload.trim() === '') {
        return null;
      }
      const posSeconds = Number(payload);
      if (!Number.isFinite(posSeconds) || posSeconds < 0) {
        return null;
      }
      return { kind: 'Position', posSeconds };
    }
    case 'volume':
    case 'volume_set': {
      const parsed = Number(payload);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      const isRelative = typeof payload === 'string' && /^[+-]/.test(payload);
      return {
        kind: 'Volume',
        volume: {
          command,
          rawPayload: payload,
          parsed,
          isRelative,
        },
      };
    }
    case 'mute': {
      // No payload is a toggle, which is what a remote's mute key sends.
      const normalized = typeof payload === 'string' ? payload.trim().toLowerCase() : '';
      if (!normalized || normalized === 'toggle') {
        return { kind: 'Mute', muted: null };
      }
      if (['1', 'on', 'true', 'enable', 'yes'].includes(normalized)) {
        return { kind: 'Mute', muted: true };
      }
      if (['0', 'off', 'false', 'disable', 'no'].includes(normalized)) {
        return { kind: 'Mute', muted: false };
      }
      return null;
    }
    case 'queueplus':
    case 'next':
      return { kind: 'QueueStep', delta: 1 };
    case 'queueminus':
    case 'previous':
      return { kind: 'QueueStep', delta: -1 };
    case 'queueplaycurrent':
      // Internal command: start playback of the current queue item (used by
      // queue/play jump-to-item and queueandplay insert-and-play).
      return { kind: 'QueuePlayCurrent' };
    case 'shuffle': {
      const normalized = typeof payload === 'string' ? payload.trim().toLowerCase() : '';
      let enabled: boolean | null = null;
      if (['enable', 'on', '1', 'true'].includes(normalized)) {
        enabled = true;
      } else if (['disable', 'off', '0', 'false'].includes(normalized)) {
        enabled = false;
      }
      return { kind: 'Shuffle', enabled };
    }
    case 'repeat': {
      const normalized = typeof payload === 'string' ? payload.trim().toLowerCase() : '';
      let value: number | null = null;
      if (normalized) {
        if (['off', 'none', '0'].includes(normalized)) {
          value = 0;
        } else if (['all', 'queue', '1'].includes(normalized)) {
          value = 1;
        } else if (['one', 'track', '3'].includes(normalized)) {
          value = 3;
        }
      }
      return { kind: 'Repeat', value };
    }
    default:
      return null;
  }
}
