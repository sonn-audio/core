import type { ZoneConfig } from '@/domain/config/types';

export interface ZoneDescriptor {
  id: number;
  /** Absent when the Miniserver sent the player without a name, which it may do for all (#441). */
  name?: string;
  sourceSerial: string;
  sourceMac: string;
  sourceLabel: string;
  loxoneUuid?: string;
}

/**
 * Extracts AudioServer zone definitions from the parsed Loxone config payload.
 */
export function extractZonesFromLoxoneConfig(
  parsedConfig: unknown,
  macId: string,
): ZoneDescriptor[] {
  if (!Array.isArray(parsedConfig)) {
    return [];
  }

  let server: Record<string, unknown> | undefined;

  for (const item of parsedConfig) {
    if (item && typeof item === 'object') {
      const matchKey = Object.keys(item).find(
        (key) => key.trim().toUpperCase() === macId,
      );
      if (matchKey) {
        server = item[matchKey] as Record<string, unknown>;
        break;
      }
    }
  }

  if (!server) {
    return [];
  }

  const players = Array.isArray(server.players) ? server.players : [];
  if (!players.length) {
    return [];
  }

  const extensions = Array.isArray(server.extensions) ? server.extensions : [];

  const extensionMap = new Map<string, { label: string }>();

  extensions.forEach((ext: Record<string, unknown> | null | undefined, index: number) => {
    if (!ext || typeof ext !== 'object') {
      return;
    }

    const serial = String(ext.serial ?? '').trim().toUpperCase();
    if (!serial) {
      return;
    }

    const label =
      typeof ext.name === 'string' && ext.name.trim()
        ? ext.name.trim()
        : `Stereo Extension ${index + 1}`;

    extensionMap.set(serial, { label });
  });

  const audioSerial = macId;
  const serverName =
    typeof server.name === 'string' && server.name.trim()
      ? server.name.trim()
      : 'AudioServer';

  const resolvePlayerSource = (player: Record<string, unknown>) => {
    const outputs = Array.isArray(player.outputs) ? player.outputs : [];
    let serial = '';

    outputsLoop: for (const output of outputs) {
      const channels = Array.isArray(output?.channels)
        ? output.channels
        : [];

      for (const channel of channels) {
        if (channel && typeof channel.id === 'string') {
          const [rawSerial] = channel.id.split('#');
          if (rawSerial) {
            serial = rawSerial.trim().toUpperCase();
            break outputsLoop;
          }
        }
      }
    }

    let label = serverName;

    if (serial) {
      if (extensionMap.has(serial)) {
        label = extensionMap.get(serial)!.label;
      } else if (audioSerial && serial !== audioSerial) {
        const suffix = serial.slice(-4) || serial;
        label = `Stereo Extension ${suffix}`;
      }
    } else {
      serial = audioSerial;
      label = serverName;
    }

    return { serial, label };
  };

  return players.map((player: Record<string, unknown>) => {
    const id = Number(player.playerid ?? player.id ?? 0);
    const resolved = resolvePlayerSource(player);

    return {
      id,
      name: typeof player.name === 'string' && player.name.trim() ? player.name.trim() : undefined,
      sourceSerial: resolved.serial,
      sourceMac: resolved.serial,
      sourceLabel: resolved.label,
      loxoneUuid:
        typeof player.uuid === 'string' && player.uuid.trim()
          ? player.uuid.trim()
          : undefined,
    };
  });
}

/**
 * Projects the pushed Loxone player list onto our zone config.
 *
 * Ownership is split: the Miniserver decides **which** zones exist and their
 * identity (name, source), we own how each one plays — output, receivers, EQ,
 * power management and volumes. So this merges onto the existing zones by id
 * instead of rebuilding them; a config deploy would otherwise wipe everything
 * the user set up here. Zones the Miniserver no longer lists are dropped.
 */
export function buildZoneConfigs(
  descriptors: ZoneDescriptor[],
  existing: readonly ZoneConfig[] = [],
): ZoneConfig[] {
  const byId = new Map(existing.map((zone) => [zone.id, zone]));
  return descriptors.map((descriptor) => {
    const current = byId.get(descriptor.id);
    if (current) {
      return {
        ...current,
        // Loxone-owned identity, refreshed on every push. A player pushed without a name keeps
        // the one it has: a placeholder made up here overwrote every room's name (#441).
        name: descriptor.name ?? current.name,
        sourceMac: descriptor.sourceMac,
        sourceSerial: descriptor.sourceSerial,
      };
    }
    return {
      id: descriptor.id,
      name: descriptor.name ?? `Zone ${descriptor.id}`,
      sourceMac: descriptor.sourceMac,
      sourceSerial: descriptor.sourceSerial,
      output: null,
      // Receivers are opt-in per player, so a new zone starts with none.
      inputs: {},
      volumes: defaultVolumes(),
    };
  });
}

function defaultVolumes() {
  return {
    default: 30,
    alarm: 40,
    fire: 50,
    bell: 35,
    buzzer: 35,
    tts: 40,
    volstep: 2,
    fading: 5,
    maxVolume: 80,
  };
}
