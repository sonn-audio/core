import type { NotifierPort } from '@/ports/NotifierPort';
import type { InputsPort } from '@/ports/InputsPort';
import type { OutputsPort } from '@/ports/OutputsPort';
import type { ContentPort } from '@/ports/ContentPort';
import type { ConfigPort } from '@/ports/ConfigPort';
import { ZoneManager } from '@/application/zones/zoneManager';
import type { AudioManager } from '@/application/playback/audioManager';
import type { ZoneAudioPreferences } from '@/application/playback/ZoneAudioPreferences';
import type { RecentsManager } from '@/application/zones/recents/recentsManager';
import type { MixedGroupCoordinator } from '@/application/groups/mixedGroupController';

export type ZoneManagerFacade = Pick<
  ZoneManager,
  | 'initialize'
  | 'shutdown'
  | 'replaceAll'
  | 'replaceZones'
  | 'getState'
  | 'getAllZoneStates'
  | 'getZoneState'
  | 'getQueue'
  | 'getRawQueue'
  | 'getMetadata'
  | 'getTechnicalSnapshot'
  | 'getOutputCapabilities'
  | 'getOutputSyncStatus'
  | 'supportsNativeGrouping'
  | 'getGroupMembership'
  | 'getZoneVolumes'
  | 'keepVolumeOnNextStart'
  | 'getOutputHandlers'
  | 'applyPatch'
  | 'applySourceDuration'
  | 'setEqualizerBands'
  | 'handleCommand'
  | 'setPower'
  | 'powerOffImmediately'
  | 'getPowerState'
  | 'inputs'
  | 'queue'
  | 'playContent'
  | 'handoff'
  | 'renameZone'
  | 'setOutputLatency'
  | 'startAlert'
  | 'getAlertStartDelaysMs'
  | 'stopAlert'
  | 'syncGroupMembersToLeader'
  | 'refreshContentProviders'
  | 'setNotifier'
  | 'removeZone'
>;

export type ZoneManagerDeps = {
  notifier: NotifierPort;
  inputs: InputsPort;
  outputs: OutputsPort;
  content: ContentPort;
  config: ConfigPort;
  recents: RecentsManager;
  audioManager: AudioManager;
  zoneAudioPrefs: ZoneAudioPreferences;
  mixedGroup?: MixedGroupCoordinator;
};

export function createZoneManager(deps: ZoneManagerDeps): ZoneManagerFacade {
  return new ZoneManager(
    deps.notifier,
    deps.inputs,
    deps.outputs,
    deps.content,
    deps.config,
    deps.recents,
    deps.audioManager,
    deps.zoneAudioPrefs,
    deps.mixedGroup ?? null,
  );
}
