import { createLogger } from '@/shared/logging/logger';
import { getGroupByZone } from '@/application/groups/groupTracker';
import type { SlimClient } from '@sonn-audio/node-slimproto';
import { PlayerState, TransitionType } from '@sonn-audio/node-slimproto';

export type SqueezeliteGroupParticipant = {
  zoneId: number;
  getPlayer: () => SlimClient | null;
  getLatencyMs: () => number;
};

/**
 * One zone's part in an alert played to several standalone players as one stream (#359).
 * Handed over by the zone's output when the alert reaches it.
 */
export type SqueezeliteAlertArrival = {
  zoneId: number;
  /** What this player shows while it plays the alert (its own alert, not the source's). */
  metadata: Record<string, string | number>;
  /**
   * The sync stream of this zone's alert, for `expected` players to share. Asked of the
   * zone the players end up following; null when it has no stream to offer.
   */
  stream: (syncId: string, expected: number) => { url: string; mimeType: string } | null;
  /**
   * The zone whose stream this player follows left before this one did. `heard` says
   * whether the players had started: before that the room has heard nothing of the alert.
   */
  onSourceLost: (heard: boolean) => void;
};

/**
 * What became of an alert that arrived for an alert sync: it plays in step with the others
 * (`synced`), the output plays it by itself as before (`alone`), or the zone left before
 * the players were handed anything (`cancelled`).
 */
export type SqueezeliteAlertJoin = 'synced' | 'alone' | 'cancelled';

export type SqueezeliteGroupCoordinator = {
  register: (participant: SqueezeliteGroupParticipant) => void;
  unregister: (zoneId: number) => void;
  /**
   * Whether this zone's group is one slimproto can actually synchronise. Everything
   * below is leader-centric: members follow the leader's stream URL and are unpaused
   * against its clock, which only works when the leader runs squeezelite itself.
   */
  isSyncGroup: (zoneId: number) => boolean;
  preparePlayback: (zoneId: number) => {
    grouped: boolean;
    leaderZoneId: number;
    expectedCount: number;
  };
  /**
   * Start/replace playback for a sync-group by issuing playUrl to all active members.
   * This is required because only the leader zone gets a new session on track switches.
   *
   * `flush` empties every player's buffer first. A track change leaves it out: the
   * players hold the same audio and play the old track's tail out together. A restart
   * of the group on the stream it is already playing needs it, because a buffer is only
   * replaced by a flush — a new stream is queued behind whatever a player still holds.
   */
  orchestrateGroupPlayback: (
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
    options?: { flush?: boolean },
  ) => Promise<boolean>;
  /**
   * Enqueue a new URL on all active group players using a native crossfade transition.
   * Unlike orchestrateGroupPlayback, this does NOT wait for BUFFER_READY — the players
   * are assumed to be already playing. They will crossfade client-side when their current
   * stream buffer drains.
   */
  orchestrateGroupEnqueue: (
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
    crossfadeTenths: number,
  ) => Promise<boolean>;
  orchestrateGroupPause: (zoneId: number) => Promise<boolean>;
  orchestrateGroupResume: (zoneId: number) => Promise<boolean>;
  orchestrateGroupStop: (zoneId: number) => Promise<boolean>;
  notifyBufferReady: (zoneId: number) => void;
  notifyPlaybackTick: (zoneId: number) => void;
  /** True while a resync pause-and-unpause is in flight for the given zone. */
  isZoneResyncing: (zoneId: number) => boolean;
  /**
   * Keep a member that was paused on its own out of the group's orchestration, so the
   * next coordinated start (a track change, a resync) does not unpause it. The rest of
   * the group plays on. Only a member can be held; the leader pauses the whole group.
   */
  holdMember: (zoneId: number) => void;
  /** Let a held member take part again. True when it was held. */
  releaseMember: (zoneId: number) => boolean;
  /** Whether this member was paused on its own and is sitting the group out. */
  isMemberHeld: (zoneId: number) => boolean;
  /**
   * Whether a member of this zone's group is stopped while the group is paused, so an
   * unpause cannot bring it back in step and the group has to start again together.
   */
  hasStoppedMember: (zoneId: number) => boolean;
  /**
   * Have the next alert of these zones play on their players as one stream, the way a sync
   * group plays music (#359). Only zones whose player plays on its own — none that is part
   * of a slimproto sync group, whose alert the group already carries — and only when at
   * least two of them can. Returns the zones that will, or an empty list.
   */
  prepareAlertSync: (zoneIds: readonly number[]) => number[];
  /**
   * The alert of a zone prepared above reached its output. Null when the zone was not
   * prepared for one, so the output plays the alert as it always has; otherwise resolves
   * once this player was handed the shared stream, or with how the output has to go on.
   */
  joinAlertSync: (arrival: SqueezeliteAlertArrival) => Promise<SqueezeliteAlertJoin> | null;
  /** The zone's alert ended, or something else plays there now: its player leaves the alert sync. */
  leaveAlertSync: (zoneId: number) => void;
};

type PendingGroup = {
  expectedZones: Set<number>;
  startedAt: number;
  timeoutId: NodeJS.Timeout;
  pollId?: NodeJS.Timeout;
};

type SyncPlaypoint = { ts: number; diffMs: number };

type AlertSyncMember = {
  arrival: SqueezeliteAlertArrival;
  resolve: (outcome: SqueezeliteAlertJoin) => void;
  player?: SlimClient;
  /** Unpaused, alone or with the others. */
  started: boolean;
};

type AlertSync = {
  id: string;
  /** The zones still expected or taking part, in the order the alert named them. */
  zones: number[];
  members: Map<number, AlertSyncMember>;
  /** Players were handed the stream; nobody joins any more. */
  dispatched: boolean;
  /** The zone whose alert stream the players follow. */
  sourceZoneId: number | null;
  heard: boolean;
  arrivalTimer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  readyDeadline: number;
  ended: boolean;
};

/**
 * How long an alert sync waits for every zone's alert to reach its output, counted from
 * the moment it was prepared. Each zone's alert first ends the one before it and waits for
 * its output to be ready, which can take a couple of seconds; a zone later than this plays
 * its alert by itself rather than hold the others back.
 */
const ALERT_SYNC_ARRIVAL_WAIT_MS = 3000;
/**
 * How long the players get to fill their buffers before the ones that did start together.
 * One that is still not ready then starts on its own as soon as it is.
 */
const ALERT_SYNC_READY_WAIT_MS = 4000;
/** How long a player that missed the shared start may take before it is given up on. */
const ALERT_SYNC_STRAGGLER_WAIT_MS = 10_000;

class SqueezeliteGroupController {
  private readonly log = createLogger('Output', 'SqueezeliteGroups');
  private readonly participants = new Map<number, SqueezeliteGroupParticipant>();
  private readonly pendingGroups = new Map<number, PendingGroup>();
  // Match Music Assistant multi-client stream + buffer ready polling (5s-ish).
  private readonly readyTimeoutMs = 5000;
  private readonly readyPollIntervalMs = 200;
  // Base headroom before scheduled unpause. We will increase this dynamically based on clock RTT.
  private readonly unpauseHeadroomMs = 200;
  private readonly syncPlaypoints = new Map<string, SyncPlaypoint[]>();
  private readonly doNotResyncBefore = new Map<string, number>();
  private readonly lastTickAt = new Map<string, number>();
  private readonly resyncingZones = new Set<number>();
  // Members paused on their own, keyed to the leader they were paused under. They stay
  // out of every coordinated start until they are played again or leave that group.
  private readonly heldMembers = new Map<number, number>();
  // Per-pair elapsed baseline: when a member joins with a different elapsed counter
  // (e.g. 0ms while the leader is at 133 000ms due to CROSSFADE carry-over), we
  // record the initial offset so corrections are applied relative to that baseline
  // rather than against the raw — and artificially huge — counter difference.
  private readonly elapsedBaselines = new Map<string, number>();
  private readonly minReqPlaypoints = 8;
  // Raised from 8 → 20 ms: constant hardware-buffer offsets of ~6–16 ms were
  // triggering corrections every ~13 s (5 s cooldown + 8 s to refill playpoints)
  // without ever settling, causing continuous pause-and-unpause churn on zones
  // that are already perceptually in sync.  20 ms matches the threshold used by
  // Music Assistant's own squeezelite provider.
  private readonly minDeviationAdjustMs = 20;
  private readonly deviationJumpIgnoreMs = 500;
  private readonly maxSkipAheadMs = 800;
  // If the measured average drift exceeds this value, skip/pause corrections
  // are not attempted — the offset is too large to recover via timing nudges
  // and a large pauseAndUnpause on the leader would stall the whole group.
  // A member this far out of sync (e.g. due to a broken elapsedMs report)
  // must be left to resync naturally on the next track change.
  private readonly maxResyncDeltaMs = 2000;
  // Alerts played to several standalone players as one stream (#359). A zone is `prepared`
  // from the moment the alert is planned until its alert reaches its output, and `joined`
  // from then until it leaves; the two are apart because a zone ends its previous alert
  // in between, and that must not take it out of the next one.
  private readonly preparedAlerts = new Map<number, AlertSync>();
  private readonly joinedAlerts = new Map<number, AlertSync>();
  private alertSyncCount = 0;

  constructor() {}

  public register(participant: SqueezeliteGroupParticipant): void {
    this.participants.set(participant.zoneId, participant);
  }

  public unregister(zoneId: number): void {
    this.leaveAlertSync(zoneId);
    this.dropPreparedAlert(zoneId);
    this.participants.delete(zoneId);
    this.heldMembers.delete(zoneId);
  }

  public holdMember(zoneId: number): void {
    const group = getGroupByZone(zoneId);
    if (!group || group.leader === zoneId) {
      return;
    }
    this.heldMembers.set(zoneId, group.leader);
    this.log.debug('squeezelite member paused on its own; holding it out of the group', {
      zoneId,
      leaderZoneId: group.leader,
    });
  }

  public releaseMember(zoneId: number): boolean {
    const held = this.isMemberHeld(zoneId);
    this.heldMembers.delete(zoneId);
    return held;
  }

  public isMemberHeld(zoneId: number): boolean {
    const leaderZoneId = this.heldMembers.get(zoneId);
    if (leaderZoneId === undefined) {
      return false;
    }
    // A hold belongs to the group it was made in. Once the zone left that group, or
    // the group got another leader, it means nothing any more.
    const group = getGroupByZone(zoneId);
    if (!group || group.leader !== leaderZoneId || group.leader === zoneId) {
      this.heldMembers.delete(zoneId);
      return false;
    }
    return true;
  }

  /**
   * A group only syncs over slimproto when the leader runs squeezelite and at least
   * one other member does too. A group led by another protocol — a mixed group — is
   * fed per zone by the mixed group controller, so none of the leader-centric
   * orchestration here applies to it and its members must play on their own.
   */
  public isSyncGroup(zoneId: number): boolean {
    const group = getGroupByZone(zoneId);
    if (!group || !this.participants.has(group.leader)) {
      return false;
    }
    let count = 0;
    for (const memberId of new Set<number>([group.leader, ...group.members])) {
      if (!this.participants.has(memberId)) continue;
      count += 1;
      if (count >= 2) return true;
    }
    return false;
  }

  public preparePlayback(
    zoneId: number,
  ): { grouped: boolean; leaderZoneId: number; expectedCount: number } {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length === 0 || !this.isSyncGroup(zoneId)) {
      return { grouped: false, leaderZoneId: zoneId, expectedCount: 1 };
    }
    const leaderZoneId = group.leader;
    const expectedZones = new Set<number>([leaderZoneId, ...group.members]);
    const activeZones = new Set<number>();
    for (const memberId of expectedZones) {
      if (this.isMemberHeld(memberId)) continue;
      const participant = this.participants.get(memberId);
      const player = participant?.getPlayer();
      if (player) {
        activeZones.add(memberId);
      }
    }
    if (activeZones.size < 2) {
      return { grouped: false, leaderZoneId: zoneId, expectedCount: 1 };
    }

    const existing = this.pendingGroups.get(leaderZoneId);
    if (existing) {
      existing.expectedZones = activeZones;
      // Refresh startedAt so checkPendingGroupReady doesn't skip this round
      // with "timeout handler will start the group" when called for a new play.
      existing.startedAt = Date.now();
    } else {
      this.pendingGroups.set(leaderZoneId, {
        expectedZones: activeZones,
        startedAt: Date.now(),
        timeoutId: setTimeout(() => {
          const pending = this.pendingGroups.get(leaderZoneId);
          if (!pending) return;
          void (async () => {
            const started = await this.startGroup(leaderZoneId, pending.expectedZones);
            if (started) {
              this.pendingGroups.delete(leaderZoneId);
              return;
            }
            // Nothing was ready yet; extend the window and keep polling.
            pending.startedAt = Date.now();
            pending.timeoutId = setTimeout(() => {
              const again = this.pendingGroups.get(leaderZoneId);
              if (!again) return;
              void this.startGroup(leaderZoneId, again.expectedZones).then((ok) => {
                if (ok) this.pendingGroups.delete(leaderZoneId);
              });
            }, this.readyTimeoutMs);
            pending.timeoutId.unref?.();
            this.schedulePendingCheck(leaderZoneId);
          })();
        }, this.readyTimeoutMs),
      });
      // Start polling immediately so we don't depend on events.
      this.schedulePendingCheck(leaderZoneId);
    }
    return {
      grouped: true,
      leaderZoneId,
      expectedCount: activeZones.size,
    };
  }

  public notifyBufferReady(zoneId: number): void {
    const alertSync = this.joinedAlerts.get(zoneId);
    if (alertSync?.dispatched) {
      this.scheduleAlertReadyCheck(alertSync, 0);
    }
    const group = getGroupByZone(zoneId);
    if (!group) return;
    const leaderZoneId = group.leader;
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    this.schedulePendingCheck(leaderZoneId);
  }

  private schedulePendingCheck(leaderZoneId: number): void {
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    if (pending.pollId) return;
    pending.pollId = setTimeout(() => {
      pending.pollId = undefined;
      void this.checkPendingGroupReady(leaderZoneId);
    }, 0);
    pending.pollId.unref?.();
  }

  private async checkPendingGroupReady(leaderZoneId: number): Promise<void> {
    const pending = this.pendingGroups.get(leaderZoneId);
    if (!pending) return;
    const now = Date.now();
    if (now - pending.startedAt > this.readyTimeoutMs) {
      // Timeout handler will start the group; just stop polling.
      return;
    }

    let total = 0;
    let ready = 0;
    for (const zoneId of pending.expectedZones) {
      const player = this.participants.get(zoneId)?.getPlayer();
      if (!player) continue;
      total += 1;
      if (player.state === PlayerState.BUFFER_READY) {
        ready += 1;
      }
    }
    if (total >= 2 && ready >= total) {
      clearTimeout(pending.timeoutId);
      if (pending.pollId) {
        clearTimeout(pending.pollId);
        pending.pollId = undefined;
      }
      this.pendingGroups.delete(leaderZoneId);
      await this.startGroup(leaderZoneId, pending.expectedZones);
      return;
    }

    pending.pollId = setTimeout(() => {
      pending.pollId = undefined;
      void this.checkPendingGroupReady(leaderZoneId);
    }, this.readyPollIntervalMs);
    pending.pollId.unref?.();
  }

  private getActiveGroupPlayersFor(zoneId: number): Array<{ zoneId: number; player: SlimClient }> {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length < 2 || !this.isSyncGroup(zoneId)) {
      return [];
    }
    const expectedZones = new Set<number>([group.leader, ...group.members]);
    const entries: Array<{ zoneId: number; player: SlimClient }> = [];
    for (const memberId of expectedZones) {
      if (this.isMemberHeld(memberId)) continue;
      const participant = this.participants.get(memberId);
      const player = participant?.getPlayer();
      if (player) {
        entries.push({ zoneId: memberId, player });
      }
    }
    return entries;
  }

  public async orchestrateGroupPlayback(
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
    options: { flush?: boolean } = {},
  ): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(leaderZoneId);
    if (entries.length < 2) {
      return false;
    }
    const flush = options.flush === true;

    // Ensure pending group tracking exists before BUFFER_READY events arrive.
    this.preparePlayback(leaderZoneId);

    // Equivalent to MA/aioslimproto behavior: issue play_url to all clients (autostart=0),
    // let them buffer until BUFFER_READY; unpause is coordinated by the controller.
    // sendFlush=false: a direct strm-s (enqueue=false) already implies stop+clear,
    // so we avoid the separate strm-f that would trigger STMf → stale _nextMedia
    // dispatch on paused players that had a prior orchestrateGroupEnqueue pending.
    // A strm-s does not empty the player's buffer, though: the new stream is decoded in
    // behind it. A restart asks for the flush, or a member paused minutes ago plays out
    // the track it was paused on before it reaches this stream (#409).
    await Promise.all(
      entries.map(async ({ player }) => {
        try {
          await player.playUrl(url, mimeType, metadata, undefined, 0, false, false, flush);
        } catch {
          // ignore per-client failures; group will degrade to fewer members
        }
      }),
    );
    // Kick a poll in case BUFFER_READY events are missed/racy.
    this.schedulePendingCheck(leaderZoneId);
    return true;
  }

  public async orchestrateGroupEnqueue(
    leaderZoneId: number,
    url: string,
    mimeType: string,
    metadata: Record<string, string | number>,
    crossfadeTenths: number,
  ): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(leaderZoneId);
    if (entries.length < 2) return false;

    // Register pending group tracking before sending playUrl so BUFFER_READY
    // events don't race with the entry creation.
    this.preparePlayback(leaderZoneId);

    await Promise.all(
      entries.map(async ({ player }) => {
        try {
          // enqueue=false (immediate switch), autostart=false (group coordinator
          // synchronizes start via unpauseAt), sendFlush=false.
          // Using enqueue=false avoids the STMd/_nextMedia race: squeezelite
          // switches to the new URL the moment it receives this command — it does
          // not need to wait for the old HTTP stream to close first.
          // TransitionType.CROSSFADE tells squeezelite to blend old buffer audio
          // with the incoming new-URL audio at transition time.
          await player.playUrl(url, mimeType, metadata, TransitionType.CROSSFADE,
            crossfadeTenths, false, false, false);
        } catch {
          // ignore per-client failures
        }
      }),
    );
    // Kick a poll in case BUFFER_READY events are missed/racy.
    this.schedulePendingCheck(leaderZoneId);
    return true;
  }

  public async orchestrateGroupPause(zoneId: number): Promise<boolean> {
    const dropped = await this.dropHeldMembers(zoneId);
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;
    await Promise.all(
      entries
        .filter((entry) => !dropped.includes(entry.zoneId))
        .map(async ({ player }) => player.pause().catch(() => undefined)),
    );
    return true;
  }

  public async orchestrateGroupStop(zoneId: number): Promise<boolean> {
    const group = getGroupByZone(zoneId);
    const leaderZoneId = group?.leader ?? zoneId;
    await this.dropHeldMembers(zoneId);
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;
    const pending = this.pendingGroups.get(leaderZoneId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      if (pending.pollId) {
        clearTimeout(pending.pollId);
      }
      this.pendingGroups.delete(leaderZoneId);
    }
    await Promise.all(entries.map(async ({ player }) => player.stop().catch(() => undefined)));
    return true;
  }

  /**
   * The whole group pauses or stops: a member that sat it out is part of the group again,
   * so the next group play brings it back with the rest (#409). Its buffer stopped where
   * it was paused, well behind the others, so it is dropped rather than paused along:
   * unpausing it with the group would play it out of step.
   */
  private async dropHeldMembers(zoneId: number): Promise<number[]> {
    const group = getGroupByZone(zoneId);
    if (!group) return [];
    const released: number[] = [];
    for (const [memberId, leaderZoneId] of this.heldMembers) {
      if (leaderZoneId !== group.leader) continue;
      this.heldMembers.delete(memberId);
      released.push(memberId);
    }
    if (released.length) {
      this.log.debug('squeezelite group paused or stopped as a whole; releasing held members', {
        leaderZoneId: group.leader,
        released,
      });
    }
    await Promise.all(
      released.map(async (memberId) => {
        const player = this.participants.get(memberId)?.getPlayer();
        await player?.stop().catch(() => undefined);
      }),
    );
    return released;
  }

  public hasStoppedMember(zoneId: number): boolean {
    const group = getGroupByZone(zoneId);
    if (!group) return false;
    return this.getActiveGroupPlayersFor(zoneId).some(
      ({ zoneId: memberId, player }) =>
        memberId !== group.leader && player.state === PlayerState.STOPPED,
    );
  }

  public async orchestrateGroupResume(zoneId: number): Promise<boolean> {
    const entries = this.getActiveGroupPlayersFor(zoneId);
    if (entries.length < 2) return false;

    // Sync clocks first so we can resume in lock-step using a shared server timestamp.
    await Promise.all(entries.map((entry) => entry.player.requestClockSync().catch(() => false)));

    const enriched = entries.map((entry) => ({
      ...entry,
      latencyMs: this.participants.get(entry.zoneId)?.getLatencyMs?.() ?? 0,
    }));
    const maxLatencyMs = enriched.reduce((max, entry) => Math.max(max, entry.latencyMs), 0);
    const maxRttMs = enriched.reduce((max, entry) => Math.max(max, entry.player.clockSync?.rttMs ?? 0), 0);
    const headroom = Math.max(this.unpauseHeadroomMs, Math.min(1500, 300 + Math.round(maxRttMs)));
    const audibleAtMs = Date.now() + headroom + Math.max(0, maxLatencyMs);
    for (const entry of enriched) {
      const startAtMs = audibleAtMs - entry.latencyMs;
      const target = entry.player.estimateJiffiesAt(startAtMs);
      void entry.player.unpauseAt(target);
    }
    return true;
  }

  public notifyPlaybackTick(zoneId: number): void {
    const group = getGroupByZone(zoneId);
    if (!group || group.members.length < 2) {
      return;
    }
    const leaderZoneId = group.leader;
    const leader = this.participants.get(leaderZoneId)?.getPlayer();
    const leaderLatency = this.participants.get(leaderZoneId)?.getLatencyMs?.() ?? 0;
    if (!leader || leader.state !== PlayerState.PLAYING) {
      return;
    }

    const memberIds = new Set<number>([leaderZoneId, ...group.members]);
    for (const memberId of memberIds) {
      if (memberId === leaderZoneId) continue;
      if (this.isMemberHeld(memberId)) continue;
      const member = this.participants.get(memberId)?.getPlayer();
      const memberLatency = this.participants.get(memberId)?.getLatencyMs?.() ?? 0;
      if (!member || member.state !== PlayerState.PLAYING) continue;

      const key = `${leaderZoneId}:${memberId}`;
      const now = Date.now();
      const lastTick = this.lastTickAt.get(key) ?? 0;
      if (now - lastTick < 500) {
        continue;
      }
      this.lastTickAt.set(key, now);

      const leaderElapsed = (leader.elapsedMilliseconds ?? 0) - leaderLatency;
      const memberElapsed = (member.elapsedMilliseconds ?? 0) - memberLatency;
      if (!Number.isFinite(leaderElapsed) || !Number.isFinite(memberElapsed)) {
        continue;
      }
      const rawDiff = Math.round(leaderElapsed - memberElapsed);

      // When a member joins or restarts while the leader carries over a large
      // elapsed counter (e.g. after a CROSSFADE transition the leader reports
      // ~133 000 ms while the fresh member reports 0 ms), record the initial
      // offset as a baseline and correct relative to it instead of the raw diff.
      const pairKey = `${leaderZoneId}:${memberId}`;
      if (
        Math.abs(rawDiff) > this.maxResyncDeltaMs &&
        memberElapsed < this.maxResyncDeltaMs * 2
      ) {
        if (!this.elapsedBaselines.has(pairKey)) {
          this.elapsedBaselines.set(pairKey, rawDiff);
          this.log.debug('squeezelite elapsed baseline set', {
            leaderZoneId, memberId, baselineMs: rawDiff,
          });
        }
      } else if (this.elapsedBaselines.has(pairKey) && Math.abs(rawDiff) < this.maxResyncDeltaMs) {
        // Member has caught up; the baseline is no longer needed.
        this.elapsedBaselines.delete(pairKey);
      }

      const baseline = this.elapsedBaselines.get(pairKey) ?? 0;
      const diff = baseline !== 0 ? Math.round(rawDiff - baseline) : rawDiff;
      this.log.spam('squeezelite group sync tick', {
        leaderZoneId,
        memberId,
        leaderElapsedMs: Math.round(leaderElapsed),
        memberElapsedMs: Math.round(memberElapsed),
        diffMs: diff,
      });

      const points = this.syncPlaypoints.get(key) ?? [];
      if (points.length > 0 && now - points[points.length - 1]!.ts > 10_000) {
        points.length = 0;
      }
      points.push({ ts: now, diffMs: diff });
      if (points.length > this.minReqPlaypoints) {
        points.splice(0, points.length - this.minReqPlaypoints);
      }
      this.syncPlaypoints.set(key, points);

      const blockUntil = this.doNotResyncBefore.get(key) ?? 0;
      if (now < blockUntil) {
        continue;
      }

      const req = leader.elapsedMilliseconds < 2000 ? 2 : this.minReqPlaypoints;
      if (points.length < req) {
        continue;
      }

      const diffsAbs = points.map((p) => Math.abs(p.diffMs));
      const avgAbs = diffsAbs.reduce((a, b) => a + b, 0) / diffsAbs.length;
      if (Math.abs(avgAbs - Math.abs(diff)) > this.deviationJumpIgnoreMs) {
        continue;
      }
      const avg = points.map((p) => p.diffMs).reduce((a, b) => a + b, 0) / points.length;
      const delta = Math.round(Math.abs(avg));
      if (delta < this.minDeviationAdjustMs) {
        continue;
      }
      // Skip corrections when the drift is too large to recover via timing nudges.
      // A pauseAndUnpause with a multi-second delta would stall the entire group
      // (leader) or jump the member forward by an unusable amount.  Members this
      // far out of sync are left to resync naturally on the next track change.
      if (delta > this.maxResyncDeltaMs) {
        continue;
      }

      // Apply correction and debounce. Similar strategy as Music Assistant's squeezelite provider.
      // Cooldown raised from 5 s → 15 s: need enough time to observe whether the
      // correction settled before allowing another one.  At 1 tick/s and 8 required
      // playpoints the minimum re-fire interval was 5+8 = 13 s; raising to 15 s
      // gives a full second-per-tick observation window after the cooldown lifts.
      this.syncPlaypoints.set(key, []);
      this.doNotResyncBefore.set(key, now + 15_000);

      if (avg > this.maxSkipAheadMs) {
        // member lags badly; slow down the leader a bit.
        void this.pauseAndUnpause(leaderZoneId, leader, delta);
        this.log.debug('squeezelite group resync (pause leader)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      } else if (avg > 0) {
        // member is behind; skip ahead a little.
        void member.skipOver(delta);
        this.log.debug('squeezelite group resync (skip member)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      } else {
        // member is ahead; pause briefly.
        void this.pauseAndUnpause(memberId, member, delta);
        this.log.debug('squeezelite group resync (pause member)', {
          leaderZoneId,
          memberId,
          deltaMs: delta,
        });
      }
    }
  }

  private async pauseAndUnpause(zoneId: number, player: SlimClient, pauseDurationMs: number): Promise<void> {
    this.resyncingZones.add(zoneId);
    try {
      try {
        await player.pause();
      } catch {
        // ignore
      }
      const ts = (player.jiffies || 0) + Math.max(0, Math.round(pauseDurationMs));
      await player.unpauseAt(ts);
    } finally {
      // Keep the resyncing flag active until the player has had time to actually resume.
      // unpauseAt() returns as soon as the command is sent, but the player may still be
      // paused (waiting for its jiffies target). Any 'paused' STAT arriving before the
      // player resumes must be suppressed, otherwise the zone power manager sees a
      // pause→stop transition and kills the group member.
      const clearDelay = Math.max(200, Math.round(pauseDurationMs) + 150);
      setTimeout(() => this.resyncingZones.delete(zoneId), clearDelay).unref?.();
    }
  }

  public isZoneResyncing(zoneId: number): boolean {
    return this.resyncingZones.has(zoneId);
  }

  private async startGroup(
    leaderZoneId: number,
    zones: Set<number>,
  ): Promise<boolean> {
    const entries: Array<{ zoneId: number; player: SlimClient; latencyMs: number }> = [];
    for (const zoneId of zones) {
      // A member paused on its own since this start was prepared stays paused.
      if (this.isMemberHeld(zoneId)) continue;
      const participant = this.participants.get(zoneId);
      const player = participant?.getPlayer();
      if (player) {
        // Always require BUFFER_READY for a coordinated start.
        // On timeout fallback we simply start a smaller subset if needed.
        if (player.state !== PlayerState.BUFFER_READY) continue;
        const latencyMs = participant?.getLatencyMs?.() ?? 0;
        entries.push({
          zoneId,
          player,
          latencyMs: Number.isFinite(latencyMs) ? Math.round(latencyMs) : 0,
        });
      }
    }
    if (entries.length < 2) return false;

    const { headroomMs: headroom, audibleAtMs } = await this.unpauseTogether(entries);
    this.log.debug('squeezelite group start', {
      leaderZoneId,
      headroomMs: headroom,
      audibleAtMs,
      members: entries.map((entry) => entry.zoneId),
      latencyMs: Object.fromEntries(entries.map((entry) => [entry.zoneId, entry.latencyMs])),
    });
    // After a synchronized group start all members resume from the same point,
    // so any previously recorded elapsed baselines are stale.
    for (const key of [...this.elapsedBaselines.keys()]) {
      if (key.startsWith(`${leaderZoneId}:`)) {
        this.elapsedBaselines.delete(key);
      }
    }
    return true;
  }

  /**
   * Unpause these players so the first sample comes out of every one at the same moment:
   * their clocks are synced first, and each is aimed at a shared server time less its own
   * fixed latency, with headroom for the slowest round trip.
   */
  private async unpauseTogether(
    entries: Array<{ zoneId: number; player: SlimClient; latencyMs: number }>,
  ): Promise<{ headroomMs: number; audibleAtMs: number }> {
    // Sync clocks first so we can schedule everyone against a shared server time.
    await Promise.all(entries.map((entry) => entry.player.requestClockSync().catch(() => false)));

    const maxRttMs = entries.reduce((max, entry) => Math.max(max, entry.player.clockSync?.rttMs ?? 0), 0);
    const headroom = Math.max(this.unpauseHeadroomMs, Math.min(1500, 300 + Math.round(maxRttMs)));
    const maxLatencyMs = entries.reduce((max, entry) => Math.max(max, entry.latencyMs), 0);
    const audibleAtMs = Date.now() + headroom + Math.max(0, maxLatencyMs);
    for (const entry of entries) {
      const startAtMs = audibleAtMs - entry.latencyMs;
      const target = entry.player.estimateJiffiesAt(startAtMs);
      const cs = entry.player.clockSync;
      this.log.debug('squeezelite group start unpauseAt', {
        zoneId: entry.zoneId,
        target,
        startAtMs,
        clockBaseJiffies: cs?.jiffies ?? null,
        clockBaseServerTimeMs: cs?.serverTimeMs ?? null,
        clockBaseRttMs: cs?.rttMs ?? null,
        clockBaseAgeMs: cs ? Math.round(Date.now() - cs.serverTimeMs) : null,
        playerJiffies: entry.player.jiffies ?? null,
      });
      void entry.player.unpauseAt(target);
    }
    return { headroomMs: headroom, audibleAtMs };
  }

  public prepareAlertSync(zoneIds: readonly number[]): number[] {
    const zones: number[] = [];
    for (const zoneId of new Set(zoneIds)) {
      if (!this.participants.get(zoneId)?.getPlayer()) continue;
      // A zone of a slimproto sync group has its alert carried by that group. The group is
      // the user's, and an alert must not take its players away from it.
      if (this.isSyncGroup(zoneId)) continue;
      zones.push(zoneId);
    }
    if (zones.length < 2) {
      return [];
    }
    this.alertSyncCount += 1;
    const sync: AlertSync = {
      id: `alert-${Date.now().toString(36)}-${this.alertSyncCount}`,
      zones,
      members: new Map(),
      dispatched: false,
      sourceZoneId: null,
      heard: false,
      readyDeadline: 0,
      ended: false,
    };
    for (const zoneId of zones) {
      this.dropPreparedAlert(zoneId);
      this.preparedAlerts.set(zoneId, sync);
    }
    sync.arrivalTimer = setTimeout(() => {
      sync.arrivalTimer = undefined;
      void this.dispatchAlertSync(sync);
    }, ALERT_SYNC_ARRIVAL_WAIT_MS);
    sync.arrivalTimer.unref?.();
    this.log.debug('squeezelite alert prepared as one stream', { syncId: sync.id, zones });
    return [...zones];
  }

  public joinAlertSync(arrival: SqueezeliteAlertArrival): Promise<SqueezeliteAlertJoin> | null {
    const zoneId = arrival.zoneId;
    const sync = this.preparedAlerts.get(zoneId);
    if (!sync) {
      return null;
    }
    this.preparedAlerts.delete(zoneId);
    // Whatever alert stream this player still followed, this alert replaces it.
    this.leaveAlertSync(zoneId);
    if (sync.dispatched || sync.ended) {
      return Promise.resolve('alone');
    }
    return new Promise<SqueezeliteAlertJoin>((resolve) => {
      sync.members.set(zoneId, { arrival, resolve, started: false });
      this.joinedAlerts.set(zoneId, sync);
      this.maybeDispatchAlertSync(sync);
    });
  }

  /**
   * A zone leaving matters in three ways. Before the players were handed the stream it is
   * simply not waited for. A player following the stream just stops following it. The zone
   * the stream comes from takes it along, though — its alert session is the stream — so the
   * others are told and go on by themselves (see `SqueezeliteAlertArrival.onSourceLost`).
   */
  public leaveAlertSync(zoneId: number): void {
    const sync = this.joinedAlerts.get(zoneId);
    if (!sync) {
      return;
    }
    this.joinedAlerts.delete(zoneId);
    const member = sync.members.get(zoneId);
    sync.members.delete(zoneId);
    sync.zones = sync.zones.filter((id) => id !== zoneId);
    if (!sync.dispatched) {
      member?.resolve('cancelled');
      this.maybeDispatchAlertSync(sync);
      return;
    }
    if (zoneId !== sync.sourceZoneId) {
      if (sync.members.size === 0) {
        this.endAlertSync(sync);
      }
      return;
    }
    const heard = sync.heard;
    const rest = [...sync.members.values()];
    this.log.debug('squeezelite alert stream source left; the others go on by themselves', {
      syncId: sync.id,
      sourceZoneId: zoneId,
      heard,
      remaining: [...sync.members.keys()],
    });
    this.endAlertSync(sync);
    for (const other of rest) {
      try {
        other.arrival.onSourceLost(heard);
      } catch {
        // Best-effort; the zone's own alert window still ends it.
      }
    }
  }

  /** A prepared zone takes part in another alert now, or none: the old one stops waiting for it. */
  private dropPreparedAlert(zoneId: number): void {
    const sync = this.preparedAlerts.get(zoneId);
    if (!sync) {
      return;
    }
    this.preparedAlerts.delete(zoneId);
    sync.zones = sync.zones.filter((id) => id !== zoneId);
    this.maybeDispatchAlertSync(sync);
  }

  private maybeDispatchAlertSync(sync: AlertSync): void {
    if (sync.dispatched || sync.ended) {
      return;
    }
    if (sync.zones.every((zoneId) => sync.members.has(zoneId))) {
      void this.dispatchAlertSync(sync);
    }
  }

  /**
   * Hand every player that arrived the same stream — the alert of the first of them, in the
   * order the alert named the zones — paused, as a sync group's track change does. They all
   * fetch it from its first byte, and are unpaused together once their buffers are full.
   * Fewer than two players is no sync: each plays its alert by itself, as before.
   */
  private async dispatchAlertSync(sync: AlertSync): Promise<void> {
    if (sync.dispatched || sync.ended) {
      return;
    }
    sync.dispatched = true;
    if (sync.arrivalTimer) {
      clearTimeout(sync.arrivalTimer);
      sync.arrivalTimer = undefined;
    }
    for (const [zoneId, prepared] of [...this.preparedAlerts]) {
      if (prepared === sync) {
        // Too late for this one; when its alert arrives it plays by itself.
        this.preparedAlerts.delete(zoneId);
      }
    }
    const entries: Array<{ zoneId: number; member: AlertSyncMember; player: SlimClient }> = [];
    for (const [zoneId, member] of sync.members) {
      const player = this.participants.get(zoneId)?.getPlayer();
      if (player) {
        entries.push({ zoneId, member, player });
      }
    }
    entries.sort((a, b) => sync.zones.indexOf(a.zoneId) - sync.zones.indexOf(b.zoneId));
    const source = entries[0];
    const stream = entries.length >= 2 && source ? source.member.arrival.stream(sync.id, entries.length) : null;
    if (!source || !stream) {
      this.endAlertSync(sync);
      return;
    }
    for (const [zoneId, member] of [...sync.members]) {
      if (!entries.some((entry) => entry.zoneId === zoneId)) {
        sync.members.delete(zoneId);
        this.joinedAlerts.delete(zoneId);
        member.resolve('alone');
      }
    }
    sync.sourceZoneId = source.zoneId;
    this.log.debug('squeezelite alert plays as one stream', {
      syncId: sync.id,
      sourceZoneId: source.zoneId,
      zones: entries.map((entry) => entry.zoneId),
      url: stream.url,
    });
    await Promise.all(
      entries.map(async ({ zoneId, member, player }) => {
        try {
          // autostart off, flush on: the player drops whatever it was playing and waits,
          // buffered, for the shared start.
          await player.playUrl(stream.url, stream.mimeType, member.arrival.metadata, undefined, 0, false, false, true);
        } catch {
          if (sync.members.get(zoneId) === member) {
            sync.members.delete(zoneId);
            this.joinedAlerts.delete(zoneId);
          }
          member.resolve('alone');
          return;
        }
        if (sync.members.get(zoneId) !== member) {
          // Left while the stream was being handed over; its stop may have gone out first.
          await player.stop().catch(() => undefined);
          return;
        }
        member.player = player;
        member.resolve('synced');
      }),
    );
    if (sync.ended) {
      return;
    }
    sync.readyDeadline = Date.now() + ALERT_SYNC_READY_WAIT_MS;
    this.scheduleAlertReadyCheck(sync, 0);
  }

  /** A check due now replaces one waiting for the next poll: a player just said it is ready. */
  private scheduleAlertReadyCheck(sync: AlertSync, delayMs: number): void {
    if (sync.ended) {
      return;
    }
    if (sync.pollTimer) {
      if (delayMs > 0) {
        return;
      }
      clearTimeout(sync.pollTimer);
    }
    sync.pollTimer = setTimeout(() => {
      sync.pollTimer = undefined;
      void this.checkAlertSyncReady(sync);
    }, delayMs);
    sync.pollTimer.unref?.();
  }

  /**
   * Unpause the players together once every one has its buffer full, or — when one takes
   * too long — the ones that have, and each latecomer as soon as it is ready: a room that
   * comes in late is still better than a room that misses the alert.
   */
  private async checkAlertSyncReady(sync: AlertSync): Promise<void> {
    if (sync.ended) {
      return;
    }
    const waiting = [...sync.members].filter(([, member]) => member.player && !member.started);
    if (waiting.length === 0) {
      return;
    }
    const ready = waiting.filter(([, member]) => member.player!.state === PlayerState.BUFFER_READY);
    const now = Date.now();
    if (!sync.heard) {
      if (ready.length > 0 && (ready.length === waiting.length || now >= sync.readyDeadline)) {
        sync.heard = true;
        for (const [, member] of ready) {
          member.started = true;
        }
        const { headroomMs, audibleAtMs } = await this.unpauseTogether(
          ready.map(([zoneId, member]) => ({
            zoneId,
            player: member.player!,
            latencyMs: this.resolveLatencyMs(zoneId),
          })),
        );
        this.log.debug('squeezelite alert start', {
          syncId: sync.id,
          headroomMs,
          audibleAtMs,
          members: ready.map(([zoneId]) => zoneId),
          waiting: waiting.filter((entry) => !ready.includes(entry)).map(([zoneId]) => zoneId),
        });
      }
    } else {
      for (const [zoneId, member] of ready) {
        member.started = true;
        const player = member.player!;
        const target = player.jiffies && player.jiffies > 0 ? player.jiffies + this.unpauseHeadroomMs : 0;
        this.log.debug('squeezelite alert start; late player on its own', { syncId: sync.id, zoneId });
        void player.unpauseAt(target).catch(() => undefined);
      }
    }
    if (sync.ended) {
      return;
    }
    const stillWaiting = [...sync.members.values()].some((member) => member.player && !member.started);
    if (stillWaiting && now < sync.readyDeadline + ALERT_SYNC_STRAGGLER_WAIT_MS) {
      this.scheduleAlertReadyCheck(sync, this.readyPollIntervalMs);
    }
  }

  private resolveLatencyMs(zoneId: number): number {
    const value = this.participants.get(zoneId)?.getLatencyMs?.() ?? 0;
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  private endAlertSync(sync: AlertSync): void {
    sync.ended = true;
    for (const timer of [sync.arrivalTimer, sync.pollTimer]) {
      if (timer) clearTimeout(timer);
    }
    sync.arrivalTimer = undefined;
    sync.pollTimer = undefined;
    for (const [zoneId, member] of sync.members) {
      if (this.joinedAlerts.get(zoneId) === sync) {
        this.joinedAlerts.delete(zoneId);
      }
      // Anyone still waiting for the stream plays by itself.
      member.resolve('alone');
    }
    sync.members.clear();
    for (const [zoneId, prepared] of [...this.preparedAlerts]) {
      if (prepared === sync) {
        this.preparedAlerts.delete(zoneId);
      }
    }
  }
}

export function createSqueezeliteGroupController(): SqueezeliteGroupCoordinator {
  return new SqueezeliteGroupController();
}
