import type { ZoneConfig } from '@/domain/config/types';

export type ZoneStateControllerId = 'internal' | string;

export function resolveZoneStateControllerId(zone: ZoneConfig): ZoneStateControllerId {
  const raw = typeof zone.state?.controller === 'string' ? zone.state.controller.trim().toLowerCase() : '';
  if (!raw) return 'internal';
  const normalized = raw.replace(/[\s_-]+/g, '');
  if (normalized === 'beolink') return 'beolink';
  if (normalized === 'sonos') return 'sonos';
  if (normalized === 'musicassistant' || normalized === 'ma') return 'musicassistant';
  if (normalized === 'internal') return 'internal';
  return raw;
}

type StateControllerAuthorityPolicy = {
  ownsVolumeState?: boolean;
  commandAuthorityWhenLocalSessionActive?: (command: string) => boolean;
};

const isVolumeCommand = (command: string): boolean => {
  const normalized = command.trim().toLowerCase();
  return normalized === 'volume' || normalized === 'volume_set';
};

// Per-controller authority hints. The state controller itself is the source of
// truth for what the speaker is doing; these flags only govern command routing
// and volume ownership. Patch filtering used to live here too, but that was an
// overcorrection — it silenced legitimate external updates (e.g. AirPlay
// commandeering an MA-fed Sonos) along with the time-jitter it was meant to
// suppress. Time/duration suppression is now a narrow rule in ExternalStateRouter.
const CONTROLLER_AUTHORITY_POLICIES: Record<string, StateControllerAuthorityPolicy> = {
  beolink: {
    ownsVolumeState: true,
    commandAuthorityWhenLocalSessionActive: isVolumeCommand,
  },
  musicassistant: {
    ownsVolumeState: true,
    commandAuthorityWhenLocalSessionActive: () => true,
  },
  sonos: {
    // The speaker owns its own level. Its keys, the Sonos app and the Spotify app all move it,
    // and the state controller reports the level back, so the zone follows the room. Seeding a
    // configured default on top of it at startup is what put three speakers at 0 whenever the
    // container restarted: a Sonos zone has no reason to be told a level it never lost.
    ownsVolumeState: true,
  },
};

export function shouldUseStateControllerForCommand(
  controllerId: string,
  hasActiveLocalSession: boolean,
  command: string,
): boolean {
  if (controllerId === 'internal') return false;
  if (!hasActiveLocalSession) return true;
  const policy = CONTROLLER_AUTHORITY_POLICIES[controllerId];
  return policy?.commandAuthorityWhenLocalSessionActive?.(command) === true;
}

export function isVolumeOwnedByStateController(controllerId: string): boolean {
  if (controllerId === 'internal') return false;
  const policy = CONTROLLER_AUTHORITY_POLICIES[controllerId];
  return policy?.ownsVolumeState === true;
}
