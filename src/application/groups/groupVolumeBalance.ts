/**
 * Remembers how the rooms of a group stand to each other, so the group volume can run into the
 * ends of the scale without flattening that.
 *
 * Moving a group's volume moved every room by the same amount and clamped each at 0 and 100. A room
 * that hit the end stopped there while the others went on, and the distance it had lost was gone:
 * turn a group down to nothing and back up, and the quiet bedroom came back as loud as the living
 * room. Here each room's distance from the leader is noted when the group volume is first moved,
 * and every later move places the room at the leader's new level plus that distance — clamped for
 * as long as it has to be, and back where it belongs as soon as there is room.
 *
 * The note is dropped the moment it stops describing the group: somebody changed one room on its
 * own, or the group gained or lost a member. The next move then starts from what the rooms are.
 */
export class GroupVolumeBalance {
  private readonly groups = new Map<number, { offsets: Map<number, number>; applied: Map<number, number> }>();

  /**
   * The level each member should get for a group volume of `target`.
   *
   * @param volumes Every member's current level, the leader included.
   */
  public plan(leaderId: number, target: number, volumes: ReadonlyMap<number, number>): Map<number, number> {
    const leaderVolume = volumes.get(leaderId) ?? 0;
    let remembered = this.groups.get(leaderId);
    const stillHolds =
      remembered !== undefined &&
      remembered.applied.size === volumes.size &&
      [...volumes].every(([zoneId, volume]) => remembered!.applied.get(zoneId) === volume);
    if (!remembered || !stillHolds) {
      remembered = {
        offsets: new Map([...volumes].map(([zoneId, volume]) => [zoneId, volume - leaderVolume])),
        applied: new Map(),
      };
      this.groups.set(leaderId, remembered);
    }
    const next = new Map<number, number>();
    for (const zoneId of volumes.keys()) {
      const level = target + (remembered.offsets.get(zoneId) ?? 0);
      next.set(zoneId, Math.max(0, Math.min(100, Math.round(level))));
    }
    return next;
  }

  /** Record the levels the members actually ended up at, which is what the next move is checked against. */
  public applied(leaderId: number, volumes: ReadonlyMap<number, number>): void {
    const remembered = this.groups.get(leaderId);
    if (remembered) {
      remembered.applied = new Map(volumes);
    }
  }

  public forget(leaderId: number): void {
    this.groups.delete(leaderId);
  }
}
