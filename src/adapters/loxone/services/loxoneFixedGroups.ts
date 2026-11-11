import type { FixedGroupDefinition } from '@/ports/types/groups';

/**
 * Reads the Loxone fixed groups ("Audio Player Gruppe fixed") for this audioserver out of the
 * Miniserver's audioserver config, the payload of `audio/cfg/setconfig` (the Miniserver's
 * Music.json).
 *
 * The payload is an array with one `{ <MAC>: section }` entry per audioserver, and every
 * section lists the groups. Only our own section counts, and of a group only the players that
 * are ours: those listed in our section's `players`. The leader is the first of them in the
 * group's `players`, which is the player the Loxone app sends the group's commands to. A group
 * with fewer than two of our players is no group here.
 *
 * Accepts the raw payload as parsed JSON or as the JSON string it was stored as.
 */
export function extractFixedGroupsFromLoxoneConfig(raw: unknown, macId: string): FixedGroupDefinition[] {
  const section = findSection(raw, macId);
  if (!section) {
    return [];
  }
  const players = Array.isArray(section.players) ? (section.players as unknown[]) : [];
  const ourZones = new Set<number>();
  for (const player of players) {
    const id = toZoneId((player as Record<string, unknown> | null)?.playerid);
    if (id !== null) ourZones.add(id);
  }

  const groups = Array.isArray(section.groups) ? (section.groups as unknown[]) : [];
  const result: FixedGroupDefinition[] = [];
  for (const entry of groups) {
    if (!entry || typeof entry !== 'object') continue;
    const group = entry as Record<string, unknown>;
    const uuid = typeof group.uuid === 'string' ? group.uuid.trim() : '';
    if (!uuid) continue;
    const listed = Array.isArray(group.players) ? (group.players as unknown[]) : [];
    const members: number[] = [];
    for (const value of listed) {
      const id = toZoneId(value);
      if (id !== null && ourZones.has(id) && !members.includes(id)) {
        members.push(id);
      }
    }
    if (members.length < 2) continue;
    result.push({ externalId: uuid, leader: members[0]!, members });
  }
  return result;
}

function toZoneId(value: unknown): number | null {
  const id = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
}

function findSection(raw: unknown, macId: string): Record<string, unknown> | undefined {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  const needle = macId.trim().toUpperCase();
  if (!Array.isArray(parsed) || !needle) {
    return undefined;
  }
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const key = Object.keys(item).find((candidate) => candidate.trim().toUpperCase() === needle);
    if (key) {
      const section = (item as Record<string, unknown>)[key];
      return section && typeof section === 'object' ? (section as Record<string, unknown>) : undefined;
    }
  }
  return undefined;
}
