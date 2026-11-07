import type { ZoneState } from '@/domain/zones/zoneState';
import { getGroupByLeader } from '@/application/groups/groupTracker';

type GroupingCoordinatorDeps = {
  getState: (zoneId: number) => ZoneState | undefined;
  applyPatch: (zoneId: number, patch: Partial<ZoneState>, force?: boolean) => void;
  /**
   * Whether a member was paused on its own and sits its group out (#409). Its leader's
   * `play` is not mirrored onto it until it is played itself. The protocol that holds it
   * out of the group keeps the hold, so this only asks.
   */
  isMemberHeld: (memberId: number) => boolean;
};

export class GroupingCoordinator {
  constructor(private readonly deps: GroupingCoordinatorDeps) {}

  public syncGroupMembersToLeader(leaderId: number): void {
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
      if (patch.mode === 'play' && this.deps.isMemberHeld(memberId)) {
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
