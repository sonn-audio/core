import { createLogger } from '@/shared/logging/logger';
import { resolveSessionCover } from '@/shared/coverArt';
import { buildBaseUrl, resolveAbsoluteUrl, resolveStreamUrl, ensureQueryParam } from '@/shared/streamUrl';
import type { PlaybackSession } from '@/ports/types/playback';
import type {
  HttpPreferences,
  MemberPauseControl,
  OutputConfigDefinition,
  ZoneOutput,
} from '@/ports/OutputsTypes';
import type { OutputPorts } from '@/adapters/outputs/outputPorts';
import type { SlimClient, SlimEvent } from '@sonn-audio/node-slimproto';
import { EventType, PlayerState, TransitionType } from '@sonn-audio/node-slimproto';

export interface SqueezeliteOutputConfig {
  playerId?: string;
  playerName?: string;
  /** Optional fixed output latency (ms) used for sync-group alignment. */
  latencyMs?: number;
}

/**
 * How long to ignore further reconnect events after re-arming a stream.
 *
 * A single reconnect surfaces as several events (PLAYER_CONNECTED plus a name), and a
 * flapping client produces more, so without this each one would start another stream.
 */
const RESUME_DEBOUNCE_MS = 1500;
/** How often the player's own position is passed on for lag measurement. */
const POSITION_REPORT_INTERVAL_MS = 2000;

export const SQUEEZELITE_OUTPUT_DEFINITION: OutputConfigDefinition = {
  id: 'squeezelite',
  label: 'Squeezelite',
  description: 'Streams audio to Squeezelite/Squeezebox players via SlimProto.',
  fields: [
    {
      id: 'playerId',
      label: 'Player ID (MAC)',
      type: 'text',
      placeholder: 'aa:bb:cc:dd:ee:ff',
      description: 'Preferred target MAC address. Use this for a stable binding.',
    },
    {
      id: 'playerName',
      label: 'Player name',
      type: 'text',
      placeholder: 'Living Room',
      advanced: true,
      description: 'Optional player name when no MAC is configured.',
    },
    {
      id: 'latencyMs',
      label: 'Latency (ms)',
      type: 'number',
      placeholder: '0',
      advanced: true,
      description: 'Fixed output delay for sync groups. Higher = this room plays later.',
    },
  ],
};

export class SqueezeliteOutput implements ZoneOutput {
  public readonly type = 'squeezelite';

  /** Grouped zones stay in step here: members follow the leader's stream and unpause on its clock. */
  public supportsNativeGrouping(): boolean {
    return true;
  }

  /**
   * A member pauses alone and sits the group out until it is played again (#409). The
   * zone decides when that is, and whether the leader is playing; this only carries it
   * out. The hold itself lives in the group controller, which leaves a held member out
   * of every coordinated start.
   */
  public memberPause(): MemberPauseControl {
    return {
      isHeld: () => this.ports.squeezeliteGroup.isMemberHeld(this.zoneId),
      hold: () => this.holdOutOfGroup(),
      release: (leaderPlaying) => this.rejoinAfterHold(leaderPlaying),
    };
  }

  private readonly log = createLogger('Output', 'Squeezelite');
  private readonly normalizedPlayerId: string;
  private readonly normalizedPlayerName: string;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeGroups: () => void;
  private lastStatus: 'playing' | 'paused' | 'stopped' | null = null;
  private pendingCrossfadeSec = 0;
  private pendingAutostart = false;
  private autostartTimer?: NodeJS.Timeout;
  private lastPositionReportAt = 0;
  private lastJoinAt = 0;
  private lastResumeAt = 0;
  private lastJoinLeaderId: number | null = null;
  private readonly baseAutostartHeadroomMs = 200;
  private readonly joinAutostartHeadroomMs = 1200;
  private joinAutostartActiveUntilMs = 0;
  private lastGroupLeaderId: number | null = null;
  private lastGrouped = false;
  private stoppingAfterDrop = false;
  private latencyMs: number;

  constructor(
    private readonly zoneId: number,
    private readonly zoneName: string,
    config: SqueezeliteOutputConfig,
    private readonly ports: OutputPorts,
  ) {
    this.normalizedPlayerId = normalizePlayerId(config.playerId);
    this.normalizedPlayerName = normalizeName(config.playerName);
    this.latencyMs = normalizeLatencyMs((config as { latencyMs?: number }).latencyMs);
    this.unsubscribe = this.ports.squeezeliteCore.subscribe((event) => this.handleEvent(event));
    this.syncGroupState();
    this.unsubscribeGroups = this.ports.groupTracker.onGroupChanged(() => {
      void this.handleGroupChanged();
    });
    this.ports.squeezeliteGroup.register({
      zoneId: this.zoneId,
      getPlayer: () => this.resolvePlayer(),
      getLatencyMs: () => this.latencyMs,
    });
  }

  public isReady(): boolean {
    return Boolean(this.resolvePlayer());
  }

  public supportsCrossfade(): boolean {
    // Native (client-side) crossfade only when this zone is part of a sync group.
    // For sync groups the server-side inline blend can't rotate URLs on all members
    // simultaneously, so squeezelite's built-in crossfade is the correct path.
    // For single players the inline (server-side FFmpeg) crossfade is more reliable:
    // the native path calls softStopPlayback before dispatching play(), so the old
    // HTTP stream ends before squeezelite receives the CROSSFADE command — leaving
    // nothing in the buffer to blend with.
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    return Boolean(group && group.members.length >= 2);
  }

  public setCrossfadeHint(durationSec: number): void {
    this.pendingCrossfadeSec = durationSec;
  }

  public async play(session: PlaybackSession): Promise<void> {
    if (!session.playbackSource) {
      this.log.warn('Squeezelite output skipped; no playback source', { zoneId: this.zoneId });
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no source');
      return;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no player');
      return;
    }
    // Consume the crossfade hint set by setCrossfadeHint() before this call.
    const crossfadeSec = this.pendingCrossfadeSec;
    this.pendingCrossfadeSec = 0;

    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(this.zoneId);
    const streamUrl = this.buildStreamUrl(session, groupInfo);
    if (!streamUrl) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite no stream');
      return;
    }
    this.clearPendingAutostart();

    // Only the leader zone receives new sessions on track switches.
    // Orchestrate group playback from the leader to ensure all members connect,
    // otherwise the sync stream will stall on `expect=N`.
    if (groupInfo.grouped && groupInfo.expectedCount > 1) {
      if (this.zoneId !== groupInfo.leaderZoneId) {
        return;
      }
      const meta = this.buildMetadata(session, streamUrl);
      const mime = resolveMimeType(streamUrl);
      if (crossfadeSec > 0) {
        // Native crossfade: enqueue the new URL on all group players so they
        // blend client-side when their current stream buffer drains. Players in a
        // sync group all have identical buffers, so the transition is simultaneous.
        const crossfadeTenths = Math.max(1, Math.round(crossfadeSec * 10));
        const ok = await this.ports.squeezeliteGroup.orchestrateGroupEnqueue(
          groupInfo.leaderZoneId, streamUrl, mime, meta, crossfadeTenths,
        );
        if (!ok) {
          this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite group enqueue failed');
        }
        this.log.debug('squeezelite group native crossfade enqueued', {
          zoneId: this.zoneId,
          crossfadeSec,
          streamUrl,
        });
        return;
      }
      const ok = await this.ports.squeezeliteGroup.orchestrateGroupPlayback(
        groupInfo.leaderZoneId,
        streamUrl,
        mime,
        meta,
      );
      if (!ok) {
        this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite group orchestrate failed');
      }
      return;
    }

    const shouldAutostart = !groupInfo.grouped || groupInfo.expectedCount <= 1;
    const meta = this.buildMetadata(session, streamUrl);
    const mime = resolveMimeType(streamUrl);
    if (crossfadeSec > 0) {
      const crossfadeTenths = Math.max(1, Math.round(crossfadeSec * 10));
      await player.playUrl(
        streamUrl, mime, meta,
        TransitionType.CROSSFADE, crossfadeTenths,
        false, shouldAutostart, false,
      );
      this.log.debug('squeezelite native crossfade enqueued', {
        zoneId: this.zoneId,
        crossfadeSec,
        streamUrl,
      });
    } else {
      await player.playUrl(
        streamUrl,
        mime,
        meta,
        undefined,
        0,
        false,
        // For non-sync playback, allow the player to autostart as soon as it has enough buffer.
        // This avoids relying on clock/jiffies being initialized (which can be missing right after a server restart).
        shouldAutostart,
        true,
      );
    }
  }

  /**
   * Gapless URL handover for inline crossfade. Tells squeezelite to enqueue the
   * (rotated) stream URL as the next track WITHOUT flushing the current one. The
   * audio session keeps emitting the same continuous PCM, so when squeezelite
   * exhausts the OLD URL's buffer (after we close that URL's HTTP response), it
   * transitions to the NEW URL — which is already pre-buffered — with no gap.
   * Returns false when the player isn't ready or grouped playback would prevent
   * a clean handover (caller should fall back to a normal `play()` instead).
   */
  public async enqueueRotation(session: PlaybackSession): Promise<boolean> {
    if (!session.playbackSource) return false;
    const player = await this.ensurePlayer();
    if (!player) return false;
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(this.zoneId);
    // Group playback uses the multi-client sync stream which has its own coordination;
    // skip the URL-rotation gapless trick for grouped zones for now (Phase 1 scope).
    if (groupInfo.grouped && groupInfo.expectedCount > 1) return false;
    const streamUrl = this.buildStreamUrl(session, groupInfo);
    if (!streamUrl) return false;
    const meta = this.buildMetadata(session, streamUrl);
    const mime = resolveMimeType(streamUrl);
    // playUrl signature:
    //   (url, mime, meta, transition=NONE, transitionDuration=0,
    //    enqueue=false, autostart=true, sendFlush=true)
    // CROSSFADE with a short transitionDuration tells squeezelite to client-side
    // overlap the OLD URL's tail with the NEW URL's head. Both URLs serve the same
    // continuous audio from the same encoder; the fade lets squeezelite mask any
    // intrinsic transition latency (decoder underrun → next-track switch) and any
    // small phase offset between the two TCP connections, so the user hears a
    // smooth handover instead of a stutter. Server-side blend already happened in
    // the previous 10 s, so this 1 s client fade is purely cosmetic.
    await player.playUrl(streamUrl, mime, meta, TransitionType.CROSSFADE, 1, true, true, false);
    this.log.debug('squeezelite enqueueRotation', {
      zoneId: this.zoneId,
      streamUrl,
      streamId: session.stream?.id,
      title: meta.title,
    });
    return true;
  }

  public async pause(_session: PlaybackSession | null): Promise<void> {
    this.clearPendingAutostart();
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    // Only a slimproto sync-group is paused as a whole. In a mixed group this zone
    // plays its own stream, so it pauses itself — and when the orchestration finds
    // too few connected players to coordinate, pausing itself is still the job.
    // A member paused on its own does not come through here: the zone hands that to
    // `memberPause` (#409). A pause reaching this output is the group's.
    if (group && this.ports.squeezeliteGroup.isSyncGroup(this.zoneId)) {
      if (await this.ports.squeezeliteGroup.orchestrateGroupPause(group.leader)) {
        return;
      }
    }
    const player = this.resolvePlayer();
    if (!player) return;
    await player.pause();
  }

  public async resume(session: PlaybackSession | null): Promise<void> {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (group && this.ports.squeezeliteGroup.isSyncGroup(this.zoneId)) {
      const ownPlayer = this.resolvePlayer();
      if (ownPlayer?.state === PlayerState.STOPPED) {
        // Player was stopped (e.g. by a local TTS override on this zone). A bare
        // orchestrateGroupResume (unpause-only) silently fails on stopped players.
        // Members rejoin via the leader's current stream; the leader re-orchestrates
        // the whole group from its current session.
        if (this.zoneId !== group.leader) {
          await this.maybeJoinLeader('player_connected');
          return;
        }
        if (session) {
          await this.play(session);
        }
        return;
      }
      if (
        this.zoneId === group.leader &&
        session &&
        this.ports.squeezeliteGroup.hasStoppedMember(group.leader)
      ) {
        // A member is stopped — one that sat the group out had its stale buffer dropped
        // when the group paused (#409). An unpause leaves it silent, so the group starts
        // again on the leader's stream and every player begins from the same byte.
        await this.play(session);
        return;
      }
      if (await this.ports.squeezeliteGroup.orchestrateGroupResume(group.leader)) {
        return;
      }
    }
    const player = this.resolvePlayer();
    if (player) {
      await player.play();
      return;
    }
    if (session) {
      await this.play(session);
    }
  }

  public async stop(_session: PlaybackSession | null): Promise<void> {
    this.clearPendingAutostart();
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (group && this.ports.squeezeliteGroup.isSyncGroup(this.zoneId)) {
      if (this.zoneId === group.leader) {
        // Leader stops the whole group.
        await this.ports.squeezeliteGroup.orchestrateGroupStop(group.leader);
      } else {
        // Member stops only itself. Orchestrating a full group stop would silence
        // all zones, which is wrong for local overrides like TTS on a single zone.
        // A stopped member has nothing left to hold: it rejoins with the next start.
        this.ports.squeezeliteGroup.releaseMember(this.zoneId);
        const player = this.resolvePlayer();
        if (player) await player.stop().catch(() => undefined);
      }
      return;
    }
    const player = this.resolvePlayer();
    if (!player) return;
    await player.stop();
  }

  public async setVolume(level: number): Promise<void> {
    const player = this.resolvePlayer();
    if (!player) return;
    const clamped = Math.min(100, Math.max(0, Math.round(level)));
    await player.volumeSet(clamped);
  }

  public getPreferredOutput(): { profile: 'flac' | 'mp3'; sampleRate: number; channels: number; prebufferBytes: number } {
    // Squeezelite can report sporadic underruns when the HTTP stream stalls briefly (WiFi jitter, GC, CPU spikes).
    // A larger rolling prebuffer reduces audible dropouts at the cost of a bit more startup latency/memory.
    // Prefer FLAC to avoid lossy re-encode and improve group sync stability.
    // SlimProto identifies FLAC as 'flc' in the HELO supportedCodecs list. If the connected player
    // does not advertise 'flc', fall back to MP3 which is universally supported.
    const player = this.resolvePlayer();
    const codecs = player?.supportedCodecs ?? [];
    const supportsFlac = !player || codecs.includes('flc');
    if (!supportsFlac) {
      this.log.info('squeezelite player does not support flac; using mp3', {
        zoneId: this.zoneId,
        supportedCodecs: codecs,
      });
    }
    // prebufferBytes=0: no burst prime sent to the client. VLC/squeezeplay receives data at
    // real-time rate, which keeps its adaptive network-cache estimate small (~2 s startup).
    // A large prime burst (e.g. 256 KB) causes VLC to infer a very high incoming bitrate and
    // inflate its buffer to 60+ seconds, making every song start inaudible for over a minute.
    return { profile: supportsFlac ? 'flac' : 'mp3', sampleRate: 44100, channels: 2, prebufferBytes: 0 };
  }

  public getHttpPreferences(): HttpPreferences {
    return { icyEnabled: false };
  }

  public getLatencyMs(): number | null {
    return this.latencyMs || null;
  }

  /** Hot-update the squeezelite static latency used for sync-group alignment. */
  public setLatencyMs(ms: number): void {
    this.latencyMs = normalizeLatencyMs(ms);
  }

  public dispose(): void {
    this.clearPendingAutostart();
    this.unsubscribe();
    this.unsubscribeGroups();
    this.ports.squeezeliteGroup.unregister(this.zoneId);
  }

  private syncGroupState(): void {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    this.lastGrouped = Boolean(group && group.members.length >= 2);
    this.lastGroupLeaderId = group?.leader ?? null;
  }

  private async handleGroupChanged(): Promise<void> {
    const previousGrouped = this.lastGrouped;
    const previousLeader = this.lastGroupLeaderId;
    const previousWasMember = previousGrouped && previousLeader != null && previousLeader !== this.zoneId;

    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    const groupedNow = Boolean(group && group.members.length >= 2);
    const leaderNow = group?.leader ?? null;

    this.lastGrouped = groupedNow;
    this.lastGroupLeaderId = leaderNow;

    if (previousWasMember && !groupedNow) {
      // A member was dropped from the group: stop playback on that member to avoid it
      // continuing to pull the leader's sync stream.
      await this.stopAfterDrop(previousLeader);
      return;
    }

    if (leaderNow != null && groupedNow) {
      await this.maybeResyncGroup('group_change');
    }
  }

  private async stopAfterDrop(previousLeaderZoneId: number | null): Promise<void> {
    if (this.stoppingAfterDrop) {
      return;
    }
    this.stoppingAfterDrop = true;
    try {
      this.clearPendingAutostart();
      this.ports.groupTracker.clearJoinedLeader(this.zoneId);
      this.ports.squeezeliteGroup.releaseMember(this.zoneId);
      const player = this.resolvePlayer();
      if (!player) return;
      this.log.debug('squeezelite member dropped from group; stopping', {
        zoneId: this.zoneId,
        previousLeaderZoneId,
      });
      await player.stop();
    } finally {
      this.stoppingAfterDrop = false;
    }
  }

  /**
   * Pause only this member and hold it out of the group. Pausing the whole group here
   * silenced the leader too while its session ran on, and without the hold the next
   * coordinated start unpaused this member again at the following track (#409).
   */
  private async holdOutOfGroup(): Promise<void> {
    this.clearPendingAutostart();
    this.ports.squeezeliteGroup.holdMember(this.zoneId);
    if (!this.ports.squeezeliteGroup.isMemberHeld(this.zoneId)) {
      return;
    }
    const player = this.resolvePlayer();
    if (player) await player.pause().catch(() => undefined);
  }

  /**
   * Bring a member that was paused on its own back into its group.
   *
   * Its buffer stopped at the moment it was paused while the leader played on, so simply
   * unpausing it would play stale audio out of step. With the leader playing it rejoins the
   * way a reconnecting member does: the group is restarted on the leader's stream so every
   * player starts from the same byte. Otherwise — or when the leader has no stream to join
   * just now — the stale buffer is dropped and the member comes along with the next start.
   */
  private async rejoinAfterHold(leaderPlaying: boolean): Promise<void> {
    if (!this.ports.squeezeliteGroup.releaseMember(this.zoneId)) {
      return;
    }
    if (leaderPlaying) {
      this.lastJoinAt = 0;
      if (await this.maybeJoinLeader('member_resume')) {
        return;
      }
    }
    const player = this.resolvePlayer();
    if (player) await player.stop().catch(() => undefined);
  }

  private async ensurePlayer(): Promise<SlimClient | null> {
    const existing = this.resolvePlayer();
    if (existing) return existing;
    return await this.ports.squeezeliteCore.waitForPlayer((player) => this.matchesPlayer(player));
  }

  private resolvePlayer(): SlimClient | null {
    const players = this.ports.squeezeliteCore.players;
    if (!players.length) return null;
    const match = players.find((player) => this.matchesPlayer(player));
    if (match) return match;
    if (!this.normalizedPlayerId && !this.normalizedPlayerName && players.length === 1) {
      return players[0] ?? null;
    }
    return null;
  }

  private matchesPlayer(player: SlimClient): boolean {
    if (this.normalizedPlayerId) {
      return normalizePlayerId(player.playerId) === this.normalizedPlayerId;
    }
    if (this.normalizedPlayerName) {
      return normalizeName(player.name) === this.normalizedPlayerName;
    }
    return false;
  }

  private handleEvent(event: SlimEvent): void {
    const player = this.ports.squeezeliteCore.getPlayer(event.playerId);
    if (!player || !this.matchesPlayer(player)) {
      return;
    }
    if (event.type === EventType.PLAYER_CONNECTED || event.type === EventType.PLAYER_NAME_RECEIVED) {
      // If this is a grouped member and the leader is already playing, start pulling the leader stream.
      // Note: this may not be perfectly in sync until the next explicit group change/resync.
      void this.maybeJoinLeader('player_connected');
      void this.maybeResumeAfterReconnect();
    }
    if (event.type === EventType.PLAYER_DISCONNECTED) {
      this.lastStatus = 'stopped';
      this.ports.outputHandlers.onOutputState(this.zoneId, { status: 'stopped' });
      return;
    }
    if (event.type === EventType.PLAYER_UPDATED) {
      this.emitState(player);
    }
    if (event.type === EventType.PLAYER_HEARTBEAT) {
      this.ports.squeezeliteGroup.notifyPlaybackTick(this.zoneId);
      this.reportPlayoutPosition(player);
    }
    if (event.type === EventType.PLAYER_BUFFER_READY) {
      this.triggerAutostart(player, 'buffer_ready');
      this.ports.squeezeliteGroup.notifyBufferReady(this.zoneId);
    }
    if (event.type === EventType.PLAYER_DECODER_ERROR) {
      this.ports.outputHandlers.onOutputError(this.zoneId, 'squeezelite decode');
    }
  }

  /**
   * Say where the player reports itself to be, so the zone can measure its lag.
   *
   * This output cannot state its buffer up front — `getLatencyMs` here is the operator's
   * own offset, not a measurement — but SlimProto's heartbeat carries the client's elapsed
   * time, and the gap to the server's clock is exactly the audio the player is still
   * holding. An alert needs that to know when it will be heard (#359).
   *
   * Position only, deliberately: a report carrying no status is read for the measurement
   * and applies no zone state, so this cannot turn into a second source of truth for what
   * the room is doing.
   */
  private reportPlayoutPosition(player: SlimClient): void {
    if (mapPlayerState(player.state) !== 'playing') {
      return;
    }
    const elapsedMs = player.elapsedMilliseconds;
    if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastPositionReportAt < POSITION_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastPositionReportAt = now;
    this.ports.outputHandlers.onOutputState(this.zoneId, { position: elapsedMs / 1000 });
  }

  private async maybeResyncGroup(source: 'group_change'): Promise<void> {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (!group || !this.ports.squeezeliteGroup.isSyncGroup(this.zoneId)) {
      return;
    }
    // A member paused on its own stays out until it is played again.
    if (this.ports.squeezeliteGroup.isMemberHeld(this.zoneId)) {
      return;
    }
    const leaderZoneId = group.leader;
    const leaderSession = this.ports.audioManager.getSession(leaderZoneId);
    if (!leaderSession || leaderSession.state !== 'playing') {
      return;
    }
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(this.zoneId);
    if (!groupInfo.grouped || groupInfo.expectedCount < 2) {
      return;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      return;
    }
    const streamUrl = this.buildStreamUrl(leaderSession, groupInfo);
    if (!streamUrl) {
      return;
    }
    // Debounce group changes to avoid repeated flush/rebuffer.
    const now = Date.now();
    if (this.lastJoinLeaderId === leaderZoneId && now - this.lastJoinAt < 1500) {
      return;
    }
    this.lastJoinAt = now;
    this.lastJoinLeaderId = leaderZoneId;

    // For a resync we want the group controller to unpause everyone at the same jiffies.
    this.clearPendingAutostart();

    const meta = this.buildMetadata(leaderSession, streamUrl);
    const mime = resolveMimeType(streamUrl);
    this.log.debug('squeezelite group resync to leader stream', {
      zoneId: this.zoneId,
      leaderZoneId,
      expectedCount: groupInfo.expectedCount,
      source,
      url: streamUrl,
    });
    try {
      await player.playUrl(
        streamUrl,
        mime,
        meta,
        undefined,
        0,
        false,
        false,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite group resync failed', {
        zoneId: this.zoneId,
        leaderZoneId,
        expectedCount: groupInfo.expectedCount,
        source,
        message,
      });
    }
  }

  /**
   * Re-arms playback for a player that reconnected while its zone was playing.
   *
   * A squeezelite client that drops and comes back leaves the server streaming into a
   * socket nobody reads: the session stays alive, the zone still reports `play`, and the
   * engine is merely paused for want of a subscriber. Nothing then tells the returning
   * client to open a new stream, because a `strm s` is only ever sent from `playUrl` — HELO
   * itself carries none. So the zone looked like it was playing and was silent until
   * someone pressed stop and play.
   *
   * This is what sendspin already does on its own reconnect (see `onIdentified`): ask the
   * audio manager whether the zone is playing, and if so start the stream again. The
   * grouped case was already handled by `maybeJoinLeader`, which is why only standalone
   * zones and group leaders were affected — and why it looked intermittent.
   *
   * Downstream this deletes the reason the LoxBerry Squeezelite Multi-Room plugin carries a
   * "Save & Resume" subsystem: roughly 400 lines that watch our state and poke
   * off → on → play to get audio back.
   */
  private async maybeResumeAfterReconnect(): Promise<void> {
    // Grouped members are `maybeJoinLeader`'s job: they must rejoin the leader's byte
    // stream rather than start their own, so doing both would fight.
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (
      group &&
      group.leader !== this.zoneId &&
      this.ports.squeezeliteGroup.isSyncGroup(this.zoneId)
    ) {
      return;
    }
    const session = this.ports.audioManager.getSession(this.zoneId);
    if (!session || session.state !== 'playing' || !session.playbackSource) {
      return;
    }
    // A reconnect arrives as several events (PLAYER_CONNECTED plus a name), and a flapping
    // client can produce more. Claim the window *before* the first await: the events arrive
    // in one tick, so a check-then-set around an await lets both through and starts two
    // streams on the same player.
    const now = Date.now();
    if (now - this.lastResumeAt < RESUME_DEBOUNCE_MS) {
      return;
    }
    this.lastResumeAt = now;
    const player = await this.ensurePlayer();
    if (!player) {
      return;
    }
    // Already playing means the client re-opened the stream itself; leave it alone.
    if (player.state === PlayerState.PLAYING) {
      return;
    }
    this.log.info('squeezelite player reconnected while zone was playing; restarting stream', {
      zoneId: this.zoneId,
      playerId: player.playerId,
    });
    // Deliberately `play()` rather than a second stream-building path: it already resolves
    // the player, builds the url and sets metadata, and a copy here would drift from it.
    // Position restarts at zero — the session's byte stream has no seekable anchor for a
    // client that missed part of it.
    await this.play(session);
  }

  /** True when the member plays, or is being started, in step with its leader. */
  private async maybeJoinLeader(
    source: 'group_change' | 'player_connected' | 'member_resume',
  ): Promise<boolean> {
    const group = this.ports.groupTracker.getGroupByZone(this.zoneId);
    if (
      !group ||
      group.leader === this.zoneId ||
      !this.ports.squeezeliteGroup.isSyncGroup(this.zoneId) ||
      // A member paused on its own does not rejoin because its player reconnected.
      this.ports.squeezeliteGroup.isMemberHeld(this.zoneId)
    ) {
      return false;
    }
    const leaderZoneId = group.leader;
    const leaderSession = this.ports.audioManager.getSession(leaderZoneId);
    if (!leaderSession || leaderSession.state !== 'playing') {
      return false;
    }
    const player = await this.ensurePlayer();
    if (!player) {
      return false;
    }
    // Avoid repeated playUrl spam when we get multiple group/connection events in a short window.
    const now = Date.now();
    if (this.lastJoinLeaderId === leaderZoneId && now - this.lastJoinAt < 1500) {
      return false;
    }
    if (player.state === PlayerState.PLAYING) {
      return true;
    }
    const streamUrl = this.buildLeaderFollowUrl(leaderZoneId);
    if (!streamUrl) {
      return false;
    }
    this.lastJoinAt = now;
    this.lastJoinLeaderId = leaderZoneId;
    // For mid-stream joins, prefer SlimProto autostart so the player can decide when it has enough buffer.
    // Forcing unpauseAt too early tends to cause immediate underruns on some clients.
    this.clearPendingAutostart();

    // For 100% sync we cannot allow "late join" mid-stream for codecs with headers (FLAC/MP3).
    // Instead, trigger a full group resync so all players start from the same byte again.
    const groupInfo = this.ports.squeezeliteGroup.preparePlayback(leaderZoneId);
    if (!groupInfo.grouped || groupInfo.expectedCount < 2) {
      return false;
    }
    const url = this.buildStreamUrl(leaderSession, groupInfo);
    if (!url) {
      return false;
    }
    const meta = this.buildMetadata(leaderSession, url);
    const mime = resolveMimeType(url);
    this.log.debug('squeezelite grouped member connected; resyncing full group', {
      zoneId: this.zoneId,
      leaderZoneId,
      expectedCount: groupInfo.expectedCount,
      source,
      url,
    });
    try {
      return await this.ports.squeezeliteGroup.orchestrateGroupPlayback(leaderZoneId, url, mime, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite grouped member resync failed', {
        zoneId: this.zoneId,
        leaderZoneId,
        source,
        message,
      });
      return false;
    }
  }

  private buildLeaderFollowUrl(leaderZoneId: number): string | null {
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    // Keep this as FLAC for non-sync situations; for syncgroups we trigger a full group resync instead.
    return resolveStreamUrl({
      baseUrl,
      zoneId: leaderZoneId,
      streamPath: undefined,
      defaultExt: 'flac',
      // Disable priming when joining mid-stream; otherwise we can dump a backlog and drift far behind the leader.
      prime: '0',
      primeMode: 'ensure',
    });
  }

  private emitState(player: SlimClient): void {
    const status = mapPlayerState(player.state);
    if (!status) return;
    // A resync pause-and-unpause is a brief internal SlimProto operation (~100-300ms).
    // Propagating it as 'paused' causes the zone power manager to fire a forced stop
    // if activeModes=['play'], tearing down the group mid-sync.
    if (status === 'paused' && this.ports.squeezeliteGroup.isZoneResyncing(this.zoneId)) {
      this.log.spam('squeezelite state suppressed during group resync', { zoneId: this.zoneId });
      return;
    }
    if (this.lastStatus === status) return;
    this.lastStatus = status;
    this.ports.outputHandlers.onOutputState(this.zoneId, {
      status,
      uri: player.currentMedia?.metadata?.item_id,
      duration: player.currentMedia?.metadata?.duration,
    });
  }

  private triggerAutostart(player: SlimClient, source: 'buffer_ready' | 'timeout' | 'immediate'): void {
    if (!this.pendingAutostart) {
      return;
    }
    this.pendingAutostart = false;
    if (this.autostartTimer) {
      clearTimeout(this.autostartTimer);
      this.autostartTimer = undefined;
    }
    const headroomMs =
      Date.now() < this.joinAutostartActiveUntilMs ? this.joinAutostartHeadroomMs : this.baseAutostartHeadroomMs;
    // If jiffies aren't initialized yet (common right after restart), schedule an immediate unpause.
    // Some players ignore "unpauseAt" timestamps that don't align with their local clock.
    const targetJiffies = player.jiffies && player.jiffies > 0 ? player.jiffies + headroomMs : 0;
    void player.unpauseAt(targetJiffies).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log.debug('squeezelite autostart failed', {
        zoneId: this.zoneId,
        source,
        message,
      });
    });
  }

  private clearPendingAutostart(): void {
    this.pendingAutostart = false;
    if (this.autostartTimer) {
      clearTimeout(this.autostartTimer);
      this.autostartTimer = undefined;
    }
  }

  private buildStreamUrl(
    session: PlaybackSession,
    groupInfo?: { grouped: boolean; leaderZoneId: number; expectedCount: number },
  ): string | null {
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const leaderZoneId = groupInfo?.grouped ? groupInfo.leaderZoneId : this.zoneId;
    const url = resolveStreamUrl({
      baseUrl,
      zoneId: leaderZoneId,
      streamPath: groupInfo?.grouped ? undefined : session.stream?.url,
      // IMPORTANT: for sync-groups, request the same profile that the leader session already exposes.
      // If we request a profile that is not active (e.g. mp3 while the session runs flac),
      // the stream handler will restart the engine to add that profile, causing the track to restart.
      defaultExt: 'flac',
      // For sync-group playback we do NOT want a primed backlog; it can overflow client buffers
      // and trigger immediate underruns. Let SlimProto buffering thresholds handle startup.
      prime: groupInfo?.grouped ? '0' : '1',
      primeMode: 'ensure',
    });
    let result = url;
    if (groupInfo?.grouped && groupInfo.expectedCount > 1) {
      // IMPORTANT: make the sync stream URL unique per playback session.
      // Otherwise, some players may keep an existing HTTP connection open across track switches,
      // causing `expect=N` to never be satisfied and groups to start via the 10s timeout.
      const syncId = `${groupInfo.leaderZoneId}-${session.stream?.id ?? 'current'}`;
      result = ensureQueryParam(result, 'sync', syncId);
      result = ensureQueryParam(result, 'expect', String(groupInfo.expectedCount));
    }
    // Use `expect=1` for all non-grouped playback so node-slimproto uses a lower client-side input
    // buffer threshold (32KB vs 200KB). This reduces startup silence from ~2-5s to ~0.5s on track
    // changes (e.g. Spotify). The server ignores `expect` values < 2 (parseSyncParams returns null),
    // so this only affects the SlimProto client's buffering threshold, not server sync coordination.
    if (!groupInfo?.grouped) {
      const syncId = `${this.zoneId}-${session.stream?.id ?? 'current'}`;
      result = ensureQueryParam(result, 'sync', syncId);
      result = ensureQueryParam(result, 'expect', '1');
    }
    return result;
  }

  private buildMetadata(session: PlaybackSession, streamUrl: string): Record<string, string | number> {
    const meta = session.metadata;
    const itemId = meta?.audiopath || meta?.trackId || streamUrl;
    const cover = resolveSessionCover(session);
    const sys = this.ports.config.getSystemConfig();
    const baseUrl = buildBaseUrl({
      host: sys.audioserver.ip?.trim(),
      fallbackHost: '127.0.0.1',
    });
    const coverUrl = cover ? resolveAbsoluteUrl(baseUrl, cover) ?? cover : '';
    return {
      item_id: itemId,
      title: meta?.title || this.zoneName,
      artist: meta?.artist || '',
      album: meta?.album || '',
      image_url: coverUrl,
      duration: session.duration || meta?.duration || 0,
    };
  }
}

function normalizePlayerId(value?: string | null): string {
  if (!value) return '';
  return value.replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function normalizeName(value?: string | null): string {
  if (!value) return '';
  return value.trim().toLowerCase();
}

function mapPlayerState(state: PlayerState): 'playing' | 'paused' | 'stopped' | null {
  switch (state) {
    case PlayerState.PLAYING:
      return 'playing';
    case PlayerState.PAUSED:
      return 'paused';
    case PlayerState.STOPPED:
      return 'stopped';
    default:
      return null;
  }
}

function normalizeLatencyMs(value: unknown): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(num)) return 0;
  // Clamp to a sane range; this is a fixed compensation value, not a buffer size.
  return Math.max(-5000, Math.min(5000, Math.round(num)));
}

function resolveMimeType(url: string): string {
  const lower = (url || '').toLowerCase();
  if (lower.includes('.flac')) return 'audio/flac';
  if (lower.includes('.wav')) return 'audio/wav';
  if (lower.includes('.aac')) return 'audio/aac';
  return 'audio/mpeg';
}
