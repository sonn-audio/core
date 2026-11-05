import { createLogger } from '@/shared/logging/logger';
import {
  PlaybackStateType,
  sendspinCore,
  type PlayerFormat,
} from '@sonn-audio/node-sendspin';
import type { SendspinSession } from '@sonn-audio/node-sendspin';
import { getGroupByZone, onGroupChanged } from '@/application/groups/groupTracker';
import type { GroupRecord } from '@/application/groups/types/groupRecord';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';

/**
 * One entry of a client's `supported_formats` list from client/hello.
 *
 * Declared structurally rather than taken from the module's types because older published
 * node-sendspin builds do not expose the getter that returns these; see
 * `SendspinOutput.getDeclaredFormats`.
 */
export type SendspinDeclaredFormat = {
  codec?: string;
  sample_rate?: number;
  bit_depth?: number;
  channels?: number;
};

export type SendspinGroupParticipant = {
  getClientId(): string;
  isClientConnected(): boolean;
  getBufferedFrames?(): Array<{ data: Buffer; timestampUs: number }>;
  getFutureFrames?(minFutureMs?: number): Array<{ data: Buffer; timestampUs: number }>;
  ensureClientReady?(): Promise<void> | void;
  /** What this client said it can play, so a leader can pick a format the whole group takes. */
  getDeclaredFormats?(): SendspinDeclaredFormat[];
  /** Leader hook: rebuild the shared stream for the group it now drives, so every
   *  member can decode it. No-op if the live format already suits them all. */
  ensureGroupFormat?(): Promise<void> | void;
};

type PlayerStreamFormat = PlayerFormat;
const STREAM_PLAYER_ROLE = 'player';

type MetadataPayload = Parameters<SendspinSession['sendMetadata']>[0];
type ControllerPayload = Parameters<SendspinSession['sendControllerState']>[0];

export type SendspinGroupCoordinator = {
  register: (zoneId: number, participant: SendspinGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  getMemberDeclaredFormats: (leaderZoneId: number) => SendspinDeclaredFormat[][];
  notifyStreamStart: (leaderZoneId: number, format: PlayerStreamFormat) => void;
  notifyStreamEnd: (leaderZoneId: number) => void;
  /** The leader paused: end the members' playback streams, keeping their artwork. */
  notifyStreamPause: (leaderZoneId: number) => void;
  broadcastFrame: (leaderZoneId: number, frame: { data: Buffer; timestampUs: number; durationUs?: number }) => void;
  broadcastMetadata: (leaderZoneId: number, payload: MetadataPayload) => void;
  broadcastControllerState: (leaderZoneId: number, payload: ControllerPayload) => void;
  broadcastPlaybackState: (
    leaderZoneId: number,
    state: PlaybackStateType,
    groupId: string,
    groupName: string,
  ) => void;
};

/**
 * Simple orchestrator that reuses the leader's Sendspin stream for all grouped members.
 * The leader keeps producing PCM frames; we mirror stream control, metadata and audio
 * frames to Sendspin clients of the grouped member zones.
 */
class SendspinGroupController {
  private readonly log = createLogger('Output', 'SendspinGroups');
  private readonly participants = new Map<number, SendspinGroupParticipant>();
  private readonly lastStreamFormat = new Map<number, PlayerStreamFormat>();
  private readonly lastMetadata = new Map<number, MetadataPayload>();
  private readonly lastController = new Map<number, ControllerPayload>();
  private readonly lastPlaybackState = new Map<number, PlaybackStateType>();
  private zoneManager: ZoneManagerFacade | null = null;

  constructor() {
    onGroupChanged((event, _leader, record) => {
      if (event === 'remove' && record) {
        this.handleGroupRemoved(record);
        return;
      }
      if ((event === 'update' || event === 'new') && record) {
        this.syncNewMembers(record);
      }
    });
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('sendspin group controller already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('sendspin group controller missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  public register(zoneId: number, participant: SendspinGroupParticipant): void {
    this.participants.set(zoneId, participant);
  }

  /**
   * What each connected member of this group declared it can play, one list per member.
   *
   * Members never negotiate for themselves — `notifyStreamStart` hands them the leader's
   * format verbatim — so this is the only place their capabilities can enter the choice.
   * An empty outer array means the zone leads nobody and is free to please itself.
   */
  public getMemberDeclaredFormats(leaderZoneId: number): SendspinDeclaredFormat[][] {
    const group = getGroupByZone(leaderZoneId);
    if (!group || group.leader !== leaderZoneId) {
      return [];
    }
    const members = new Set<number>([group.leader, ...group.members]);
    members.delete(leaderZoneId);
    const declared: SendspinDeclaredFormat[][] = [];
    for (const memberId of members) {
      const participant = this.participants.get(memberId);
      if (!participant?.isClientConnected()) {
        continue;
      }
      declared.push(participant.getDeclaredFormats?.() ?? []);
    }
    return declared;
  }

  public unregister(zoneId: number): void {
    this.participants.delete(zoneId);
    this.lastStreamFormat.delete(zoneId);
    this.lastMetadata.delete(zoneId);
    this.lastController.delete(zoneId);
    this.lastPlaybackState.delete(zoneId);
  }

  public notifyStreamStart(leaderZoneId: number, format: PlayerStreamFormat): void {
    const prev = this.lastStreamFormat.get(leaderZoneId);
    const merged = { ...prev, ...format };
    this.lastStreamFormat.set(leaderZoneId, merged);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.sendStreamStart(output.getClientId(), merged);
    });
  }

  public notifyStreamEnd(leaderZoneId: number): void {
    this.lastStreamFormat.delete(leaderZoneId);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      const clientId = output.getClientId();
      sendspinCore.sendStreamEnd(clientId);
      sendspinCore.sendStreamClear(clientId, [STREAM_PLAYER_ROLE]);
    });
  }

  /**
   * The leader paused, so its members pause with it.
   *
   * A paused group's members must have their player and visualizer streams ended, not merely
   * starved (spec main #346): a member left with an open stream and no audio is a device holding
   * its output open on nothing. The artwork stream stays, so a display keeps the cover. The
   * leader's resume re-announces the stream through `notifyStreamStart`.
   */
  public notifyStreamPause(leaderZoneId: number): void {
    this.forEachMemberOutput(leaderZoneId, (output) => {
      const clientId = output.getClientId();
      sendspinCore.endPlaybackStreams(clientId);
      sendspinCore.sendStreamClear(clientId, [STREAM_PLAYER_ROLE]);
    });
  }

  public broadcastFrame(
    leaderZoneId: number,
    frame: { data: Buffer; timestampUs: number; durationUs?: number },
  ): void {
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.sendPcmFrameToClient(output.getClientId(), frame);
    });
  }

  public broadcastMetadata(leaderZoneId: number, payload: MetadataPayload): void {
    this.lastMetadata.set(leaderZoneId, payload);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientMetadata(output.getClientId(), payload);
    });
  }

  public broadcastControllerState(leaderZoneId: number, payload: ControllerPayload): void {
    this.lastController.set(leaderZoneId, payload);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientControllerState(output.getClientId(), payload);
    });
  }

  public broadcastPlaybackState(
    leaderZoneId: number,
    state: PlaybackStateType,
    groupId: string,
    groupName: string,
  ): void {
    this.lastPlaybackState.set(leaderZoneId, state);
    this.forEachMemberOutput(leaderZoneId, (output) => {
      sendspinCore.setClientPlaybackState(output.getClientId(), state, groupId, groupName);
      if (state === PlaybackStateType.STOPPED) {
        // A stopped group no longer claims its members for playback (see the leader's own
        // `dropPlaybackActivity`); the next stream start raises it again.
        sendspinCore.setPlaybackActive(output.getClientId(), false);
      }
    });
  }

  private forEachMemberOutput(
    leaderZoneId: number,
    fn: (participant: SendspinGroupParticipant, group: GroupRecord) => void,
  ): void {
    const group = getGroupByZone(leaderZoneId);
    if (!group || group.leader !== leaderZoneId) {
      return;
    }
    const members = new Set<number>([group.leader, ...group.members]);
    members.delete(leaderZoneId);
    for (const memberId of members) {
      const participant = this.participants.get(memberId);
      if (!participant || !participant.isClientConnected()) {
        // Try to wake up latent participants (e.g. Google Cast) so they can join soon.
        try {
          void participant?.ensureClientReady?.();
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        fn(participant, group);
      } catch (err) {
        this.log.debug('sendspin group broadcast failed', {
          leaderZoneId,
          memberId,
          message: (err as Error).message,
        });
      }
    }
  }

  private handleGroupRemoved(record: GroupRecord): void {
    const { leader } = record;
    const members = new Set<number>([leader, ...record.members]);
    members.delete(leader);
    for (const memberId of members) {
      const participant = this.participants.get(memberId);
      if (!participant) continue;
      const clientId = participant.getClientId();
      sendspinCore.sendStreamEnd(clientId);
      sendspinCore.sendStreamClear(clientId, [STREAM_PLAYER_ROLE]);
      const name = this.zones.getZoneState(memberId)?.name ?? `Zone ${memberId}`;
      const groupId = record.externalId ?? `group-${leader}`;
      sendspinCore.setClientPlaybackState(clientId, PlaybackStateType.STOPPED, groupId, name);
      // Left alone in a stopped group, the member no longer plays for us.
      sendspinCore.setPlaybackActive(clientId, false);
    }
  }

  /**
   * When a group is created/updated while the leader is already playing,
   * push the current snapshot to newly added members.
   */
  private async syncNewMembers(record: GroupRecord): Promise<void> {
    const leader = record.leader;
    const members = new Set<number>([leader, ...record.members]);
    members.delete(leader);

    const leaderParticipant = this.participants.get(leader);
    if (!leaderParticipant || !leaderParticipant.isClientConnected()) {
      return;
    }

    // Rebuild the leader's stream for the group before feeding members: it was negotiated
    // for one client and may be a codec, or a rate, the new member cannot play. No-op when
    // the live format already suits everyone.
    await leaderParticipant.ensureGroupFormat?.();

    const snapshotTargets: SendspinGroupParticipant[] = [];
    for (const memberId of members) {
      const memberTransport = this.participants.get(memberId);
      if (memberTransport && memberTransport.isClientConnected()) {
        snapshotTargets.push(memberTransport);
      }
    }
    if (!snapshotTargets.length) return;

    const fmt = this.lastStreamFormat.get(leader);
    const metadata = this.lastMetadata.get(leader);
    const controller = this.lastController.get(leader);
    const playbackState = this.lastPlaybackState.get(leader);
    const groupId = record.externalId ?? `group-${leader}`;
    const groupName = this.zones.getZoneState(leader)?.name ?? `Zone ${leader}`;

    for (const member of snapshotTargets) {
      const clientId = member.getClientId();
      if (fmt) {
        sendspinCore.sendStreamStart(clientId, fmt);
      }
      if (metadata) {
        sendspinCore.setClientMetadata(clientId, metadata);
      }
      if (controller) {
        sendspinCore.setClientControllerState(clientId, controller);
      }
      // Push buffered frames as-is; timestamps are already in server time.
      const buffered = leaderParticipant.getFutureFrames?.(150) ?? [];
      if (buffered.length) {
        for (const frame of buffered) {
          sendspinCore.sendPcmFrameToClient(clientId, frame);
        }
      }
      if (playbackState) {
        sendspinCore.setClientPlaybackState(clientId, playbackState, groupId, groupName);
      }
    }
  }
}

export const sendspinGroupController = new SendspinGroupController();
