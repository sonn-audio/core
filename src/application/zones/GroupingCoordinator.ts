import type { ZoneState } from '@/domain/zones/zoneState';
import { getGroupByLeader } from '@/application/groups/groupTracker';

type GroupingCoordinatorDeps = {
  getState: (zoneId: number) => ZoneState | undefined;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
};

export class GroupingCoordinator {
  // Members paused on their own, keyed to the leader they were paused under. The leader's
  // `play` is not mirrored onto them: they stay paused until they are played themselves.
  private readonly heldMembers = new Map<number, number>();

  constructor(private readonly deps: GroupingCoordinatorDeps) {}

  public holdMember(memberId: number, leaderId: number): void {
    this.heldMembers.set(memberId, leaderId);
  }

  /** Let a member follow its leader's state again. True when it was held. */
  public releaseMember(memberId: number): boolean {
    return this.heldMembers.delete(memberId);
  }

  public isMemberHeld(memberId: number, leaderId: number): boolean {
    return this.heldMembers.get(memberId) === leaderId;
  }

  public syncGroupMembersToLeader(leaderId: number): void {
    const group = getGroupByLeader(leaderId);
    // A group changed: a member that left it no longer sits anything out.
    for (const [memberId, heldLeader] of this.heldMembers) {
      if (heldLeader === leaderId && !group?.members.includes(memberId)) {
        this.heldMembers.delete(memberId);
      }
    }
    const leaderState = this.deps.getState(leaderId);
    if (!leaderState) {
      return;
    }
    const patch = this.stripGroupStateFields(leaderState);
    this.applyGroupPatchToMembers(leaderId, patch, true);
  }

  public syncGroupMembersPatch(
    leaderId: number,
    patch: Partial<ZoneState>,
    force: boolean,
  ): void {
    const filtered = this.stripGroupStateFields(patch);
    if (!Object.keys(filtered).length) {
      return;
    }
    this.applyGroupPatchToMembers(leaderId, filtered, force);
  }

  private applyGroupPatchToMembers(
    leaderId: number,
    patch: Partial<ZoneState>,
    force: boolean,
  ): void {
    const group = getGroupByLeader(leaderId);
    if (!group) {
      return;
    }
    for (const memberId of group.members) {
      if (memberId === leaderId) {
        continue;
      }
      if (patch.mode === 'play' && this.isMemberHeld(memberId, leaderId)) {
        const { mode: _mode, ...rest } = patch;
        this.deps.applyPatch(memberId, rest, force);
        continue;
      }
      this.deps.applyPatch(memberId, patch, force);
    }
  }

  private stripGroupStateFields(
    patch: Partial<ZoneState>,
  ): Partial<ZoneState> {
    const {
      id: _id,
      name: _name,
      volume: _volume,
      eq: _eq,
      ...rest
    } = patch;
    return rest;
  }
}
