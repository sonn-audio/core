import type { ZoneOutput } from '@/ports/OutputsTypes';

/**
 * Whether a zone's speaker plays its group leader's stream rather than anything of its own.
 *
 * That is a member of a group whose protocol has the member's player follow the leader's
 * stream — a squeezelite sync group. Its output says so by offering a member pause, which
 * it does only then (see `ZoneOutput.memberPause`). Such a member has nothing of its own
 * to play: the group's music is the leader's, and so is everything that steers it (#409).
 * A member of a mixed group is fed a session of its own and is not one of these.
 */
export function followsLeaderStream(outputs: readonly ZoneOutput[]): boolean {
  return outputs.some((output) => output.memberPause?.() != null);
}
