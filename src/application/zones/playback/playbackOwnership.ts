import type { ZoneContext } from '@/application/zones/internal/zoneTypes';

/**
 * Who is allowed to move a zone's playback, and when the answer changed.
 *
 * A zone can be handed to an outside player at any moment - a soundbar that goes to its TV
 * input, somebody starting Spotify in the room from their phone, a group regrouping. When that
 * happens this server gives the speaker up, but its own queue is left holding the last item it
 * was playing, and work that was already under way (a source being resolved, an end-of-track
 * that had not run yet) can land afterwards and take the room back. Measured: a queue advance
 * claimed a Sonos speaker two minutes after the zone had yielded to a Spotify session.
 *
 * Two facts keep that from happening, and both live on the zone context so they survive the call
 * that made them:
 *
 * - `queueSuspended` says automatic advancement is held back. The queue itself is kept: it is the
 *   listener's list, and an explicit play resumes exactly where it left off.
 * - `playbackEpoch` is bumped on every change of hands. Work that captured it can tell that it is
 *   no longer the owner's work and abandon itself instead of completing.
 */

/** The zone's current ownership epoch, captured by work that is about to take a while. */
export function captureOwnershipEpoch(ctx: ZoneContext): number {
  return ctx.playbackEpoch ?? 0;
}

/** Whether the zone has changed hands since that epoch was captured. */
export function ownershipMoved(ctx: ZoneContext, epoch: number): boolean {
  return captureOwnershipEpoch(ctx) !== epoch;
}

/**
 * Mark the zone as following somebody else: hold automatic advancement back and invalidate work
 * that is already in flight. Intentional commands call `resumeLocalOwnership` and undo both.
 */
export function yieldLocalOwnership(ctx: ZoneContext): void {
  ctx.queueSuspended = true;
  ctx.playbackEpoch = captureOwnershipEpoch(ctx) + 1;
}

/**
 * Take ownership back for an explicit local command.
 *
 * Only commands a listener asked for go through here - a play, a queue step, picking a row. The
 * automatic end-of-track path never does, which is the whole distinction: the queue may be
 * resumed deliberately and never by itself.
 */
export function resumeLocalOwnership(ctx: ZoneContext): void {
  ctx.queueSuspended = false;
}

/** Whether automatic local advancement is currently held back. */
export function localAdvanceBlocked(ctx: ZoneContext): boolean {
  return ctx.queueSuspended === true;
}
