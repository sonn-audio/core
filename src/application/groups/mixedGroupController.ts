import { PassThrough } from 'node:stream';
import { createLogger } from '@/shared/logging/logger';
import { getGroupByLeader, onGroupChanged } from '@/application/groups/groupTracker';
import type { GroupRecord } from '@/application/groups/types/groupRecord';
import type { ZoneState } from '@/domain/zones/zoneState';
import type { ConfigPort } from '@/ports/ConfigPort';
import type { ZoneManagerFacade } from '@/application/zones/createZoneManager';
import type { AudioManager } from '@/application/playback/audioManager';
import type { PlaybackSource } from '@/ports/EngineTypes';
import type { PlaybackMetadata } from '@/ports/types/playback';
import { isLineInAudiopath } from '@/application/zones/internal/zoneAudioHelpers';
import { isSameAudiopath } from '@/application/zones/playback/targetResolution';
import { audioOutputSettings } from '@/ports/types/audioFormat';

export type MixedGroupCoordinator = {
  handleStatePatch: (
    zoneId: number,
    patch: Partial<ZoneState>,
    nextState: ZoneState,
  ) => void;
};

type GroupChangeEvent = 'new' | 'update' | 'remove';

type LocalPcmTap = {
  sourceKey: string;
  tap: { stream: NodeJS.ReadableStream; stop: () => void };
  format: 's16le' | 's24le' | 's32le';
  sampleRate: number;
  channels: number;
};

class MixedGroupController implements MixedGroupCoordinator {
  private readonly log = createLogger('Groups', 'Mixed');
  private zoneManager: ZoneManagerFacade | null = null;
  private readonly lastSignature = new Map<number, string>();
  private readonly lastSyncAt = new Map<number, number>();
  private readonly lastLeaderStreamId = new Map<number, string>();
  private readonly pipeFanouts = new Map<number, PipeFanout>();
  private readonly localPcmTaps = new Map<number, LocalPcmTap>();

  constructor(
    private readonly configPort: ConfigPort,
    private readonly audioManager: AudioManager,
  ) {
    onGroupChanged((event: GroupChangeEvent, leader: number, record?: GroupRecord): void => {
      this.handleGroupChange(event, leader, record);
    });
  }

  public initOnce(deps: { zoneManager: ZoneManagerFacade }): void {
    if (this.zoneManager) {
      throw new Error('mixed group controller already initialized');
    }
    if (!deps.zoneManager) {
      throw new Error('mixed group controller missing zone manager');
    }
    this.zoneManager = deps.zoneManager;
  }

  public handleStatePatch(
    zoneId: number,
    patch: Partial<ZoneState>,
    nextState: ZoneState,
  ): void {
    if (!this.zoneManager) {
      return;
    }
    const hasMetadataPatch =
      'title' in patch ||
      'artist' in patch ||
      'album' in patch ||
      'coverurl' in patch ||
      'duration' in patch;
    if (!patch.mode && !patch.audiopath && !hasMetadataPatch) {
      return;
    }
    const group = getGroupByLeader(zoneId);
    if (!group || group.leader !== zoneId) {
      return;
    }
    if (!this.isMixedGroup(group)) {
      return;
    }
    if (hasMetadataPatch) {
      this.syncMemberMetadata(group, patch);
    }
    if (patch.mode || patch.audiopath) {
      this.syncMembersToLeader(group, nextState);
    } else if (hasMetadataPatch) {
      const leaderSession = this.audioManager.getSession(group.leader);
      const streamId = leaderSession?.stream?.id ?? '';
      const lastStreamId = this.lastLeaderStreamId.get(group.leader) ?? '';
      if (streamId && streamId !== lastStreamId) {
        this.syncMembersToLeader(group, nextState, { force: true });
      }
    }
  }

  private handleGroupChange(
    event: GroupChangeEvent,
    leader: number,
    record?: GroupRecord,
  ): void {
    if (!this.zoneManager || !record) {
      return;
    }
    if (event === 'remove') {
      this.lastSignature.delete(leader);
      this.lastSyncAt.delete(leader);
      this.lastLeaderStreamId.delete(leader);
      this.teardownFanout(leader);
      return;
    }
    if (!this.isMixedGroup(record)) {
      this.lastLeaderStreamId.delete(leader);
      this.teardownFanout(leader);
      return;
    }
    const leaderState = this.zones.getState(record.leader);
    if (!leaderState) {
      return;
    }
    this.syncMembersToLeader(record, leaderState, { force: true });
  }

  private get zones(): ZoneManagerFacade {
    if (!this.zoneManager) {
      throw new Error('zone manager not configured');
    }
    return this.zoneManager;
  }

  private isEnabled(): boolean {
    return this.configPort.getConfig()?.groups?.mixedGroupEnabled === true;
  }

  private resolveOutputProtocol(zoneId: number): string {
    const snapshot = this.zones.getTechnicalSnapshot(zoneId);
    if (!snapshot) {
      return 'unknown';
    }
    const fallback = snapshot.transports[0] ?? null;
    return snapshot.activeOutput ?? fallback ?? 'unknown';
  }

  /**
   * Whether this member has to be fed the leader's audio from here.
   *
   * Two reasons it might. The member runs another protocol than the leader, so no
   * coordinator spans them — that is the mixed group the setup toggle is about, and it
   * stays opt-in. Or leader and member share a protocol that cannot group at all (DLNA,
   * Cast, Music Assistant): there is no coordinator to defer to, so without this the
   * member would simply stay silent. That second case is not a choice, so it is not
   * behind the toggle.
   */
  private memberNeedsFanout(leaderId: number, memberId: number): boolean {
    const leaderProtocol = this.resolveOutputProtocol(leaderId);
    const memberProtocol = this.resolveOutputProtocol(memberId);
    if (leaderProtocol === 'unknown' || memberProtocol === 'unknown') {
      return false;
    }
    if (leaderProtocol !== memberProtocol) {
      return this.isEnabled();
    }
    return !this.zones.supportsNativeGrouping(leaderId);
  }

  /** The members of this group that nothing else will feed. */
  private fanoutMembers(group: GroupRecord): Set<number> {
    const members = new Set<number>();
    for (const memberId of group.members) {
      if (memberId === group.leader) {
        continue;
      }
      if (this.memberNeedsFanout(group.leader, memberId)) {
        members.add(memberId);
      }
    }
    return members;
  }

  private isMixedGroup(group: GroupRecord): boolean {
    return this.fanoutMembers(group).size > 0;
  }

  private isUnsupportedAudiopath(audiopath: string): boolean {
    const lower = audiopath.trim().toLowerCase();
    return lower.startsWith('airplay://') || lower.startsWith('linein:') || lower.startsWith('linein://');
  }

  private buildMetadata(state: ZoneState): PlaybackMetadata {
    return {
      title: state.title || '',
      artist: state.artist || '',
      album: state.album || '',
      coverurl: state.coverurl || undefined,
      duration: typeof state.duration === 'number' ? state.duration : undefined,
      audiopath: state.audiopath || '',
      station: state.station || '',
    };
  }

  private serializeHeaders(headers?: Record<string, string>): string {
    if (!headers) {
      return '';
    }
    const entries = Object.entries(headers).filter(([, value]) => typeof value === 'string' && value.length > 0);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, value]) => `${key}:${value}`).join('|');
  }

  private buildSourceKey(
    source: PlaybackSource,
    outputSettings: { sampleRate: number; channels: number; pcmBitDepth: number },
    contentKey?: string,
  ): string {
    const outputKey = `${outputSettings.sampleRate}|${outputSettings.channels}|${outputSettings.pcmBitDepth}`;
    const content = contentKey ? `|${contentKey}` : '';
    if (source.kind === 'file') {
      const pace = source.realTime !== false ? '1' : '0';
      return `file|${source.path}|${pace}|${outputKey}${content}`;
    }
    if (source.kind === 'url') {
      return [
        'url',
        source.url,
        source.inputFormat ?? '',
        source.decryptionKey ?? '',
        source.tlsVerifyHost ?? '',
        source.realTime !== false ? '1' : '0',
        this.serializeHeaders(source.headers),
        outputKey + content,
      ].join('|');
    }
    return `other|${outputKey}${content}`;
  }

  private resolvePcmFormat(bitDepth?: number): 's16le' | 's24le' | 's32le' {
    if (bitDepth === 24) {
      return 's24le';
    }
    if (bitDepth === 32) {
      return 's32le';
    }
    return 's16le';
  }

  private resolveLeaderPcmStream(
    leaderId: number,
    leaderSession: NonNullable<ReturnType<AudioManager['getSession']>>,
    leaderState: ZoneState,
  ): {
    stream: NodeJS.ReadableStream;
    format: 's16le' | 's24le' | 's32le';
    sampleRate: number;
    channels: number;
  } | null {
    if (!leaderSession.playbackSource) {
      this.stopLocalPcmTap(leaderId);
      return null;
    }
    const outputSettings =
      this.audioManager.getOutputSettings(leaderId) ?? {
        sampleRate: audioOutputSettings.sampleRate,
        channels: audioOutputSettings.channels,
        pcmBitDepth: audioOutputSettings.pcmBitDepth,
      };
    if (leaderSession.profiles?.includes('pcm')) {
      this.stopLocalPcmTap(leaderId);
      const stream = this.audioManager.createStream(leaderId, 'pcm', {
        label: `mixed-${leaderId}`,
        primeWithBuffer: false,
      });
      if (!stream) {
        return null;
      }
      return {
        stream,
        format: this.resolvePcmFormat(outputSettings.pcmBitDepth),
        sampleRate: outputSettings.sampleRate,
        channels: outputSettings.channels,
      };
    }
    const source = leaderSession.playbackSource;
    if (source.kind !== 'file' && source.kind !== 'url') {
      this.stopLocalPcmTap(leaderId);
      return null;
    }
    const sessionPath = (leaderSession.metadata?.audiopath || '').trim();
    const statePath = (leaderState.audiopath || '').trim();
    let contentKey = sessionPath || statePath;
    if (sessionPath && statePath && !isSameAudiopath(sessionPath, statePath)) {
      contentKey = `${sessionPath}|${statePath}`;
    }
    const key = this.buildSourceKey(source, outputSettings, contentKey || undefined);
    const existing = this.localPcmTaps.get(leaderId);
    if (existing && existing.sourceKey === key) {
      return {
        stream: existing.tap.stream,
        format: existing.format,
        sampleRate: existing.sampleRate,
        channels: existing.channels,
      };
    }
    if (existing) {
      existing.tap.stop();
      this.localPcmTaps.delete(leaderId);
    }
    const elapsed = this.resolveLeaderElapsedSec(leaderState, leaderSession);
    const duration = this.resolveLeaderDurationSec(leaderState, leaderSession);
    const shouldSeek = !leaderSession.metadata?.isRadio && Number.isFinite(elapsed) && elapsed > 1;
    const candidate = shouldSeek ? Math.round(elapsed) : 0;
    const clamped =
      shouldSeek && Number.isFinite(duration) && duration > 1
        ? Math.min(candidate, Math.max(0, Math.round(duration) - 1))
        : candidate;
    const tap = this.audioManager.createLocalPcmTap(leaderId, source, {
      outputSettings,
      startAtSec: clamped > 0 ? clamped : undefined,
      label: `mixed-local-${leaderId}`,
    });
    if (!tap) {
      return null;
    }
    const entry: LocalPcmTap = {
      sourceKey: key,
      tap,
      format: this.resolvePcmFormat(outputSettings.pcmBitDepth),
      sampleRate: outputSettings.sampleRate,
      channels: outputSettings.channels,
    };
    this.localPcmTaps.set(leaderId, entry);
    return {
      stream: tap.stream,
      format: entry.format,
      sampleRate: entry.sampleRate,
      channels: entry.channels,
    };
  }

  private resolveLeaderElapsedSec(
    leaderState: ZoneState,
    leaderSession: ReturnType<AudioManager['getSession']>,
  ): number {
    if (!leaderSession) {
      return 0;
    }
    const elapsedFromClock = leaderSession.startedAt
      ? Math.round(Math.max(0, Date.now() - leaderSession.startedAt) / 1000)
      : 0;
    const sessionElapsed = Math.max(leaderSession.elapsed ?? 0, elapsedFromClock);
    const stateTime = typeof leaderState.time === 'number' ? leaderState.time : 0;
    const statePath = (leaderState.audiopath ?? '').trim();
    const sessionPath = (leaderSession.metadata?.audiopath ?? '').trim();
    const hasMismatch = statePath && sessionPath && !isSameAudiopath(statePath, sessionPath);
    if (hasMismatch) {
      return sessionElapsed;
    }
    if (leaderSession.startedAt && Date.now() - leaderSession.startedAt < 3000) {
      return sessionElapsed;
    }
    if (stateTime > 0) {
      if (sessionElapsed > 0 && Math.abs(stateTime - sessionElapsed) > 5) {
        return sessionElapsed;
      }
      return stateTime;
    }
    return sessionElapsed;
  }

  private resolveLeaderDurationSec(
    leaderState: ZoneState,
    leaderSession: ReturnType<AudioManager['getSession']>,
  ): number {
    if (typeof leaderState.duration === 'number' && leaderState.duration > 0) {
      return leaderState.duration;
    }
    if (!leaderSession) {
      return 0;
    }
    const duration = leaderSession.duration ?? leaderSession.metadata?.duration ?? 0;
    return typeof duration === 'number' && duration > 0 ? duration : 0;
  }

  private resolveStartAtSec(
    leaderState: ZoneState,
    leaderSession: ReturnType<AudioManager['getSession']>,
  ): number | null {
    if (!leaderSession?.playbackSource) {
      return null;
    }
    const source = leaderSession.playbackSource;
    if (source.kind !== 'file' && source.kind !== 'url') {
      return null;
    }
    if (leaderSession.metadata?.isRadio) {
      return null;
    }
    if (source.kind === 'url' && source.realTime) {
      return null;
    }
    const elapsed = this.resolveLeaderElapsedSec(leaderState, leaderSession);
    if (!Number.isFinite(elapsed) || elapsed <= 1) {
      return null;
    }
    const duration = this.resolveLeaderDurationSec(leaderState, leaderSession);
    if (!Number.isFinite(duration) || duration <= 1) {
      return null;
    }
    const clamped = Math.min(Math.max(0, Math.round(elapsed)), Math.max(0, Math.round(duration) - 1));
    return clamped > 0 ? clamped : null;
  }

  private syncMembersToLeader(
    group: GroupRecord,
    leaderState: ZoneState,
    opts: { force?: boolean } = {},
  ): void {
    const leaderMode = leaderState.mode;
    const leaderAudiopath = (leaderState.audiopath ?? '').trim();
    const signature = `${leaderMode}|${leaderAudiopath}`;
    const prevSignature = this.lastSignature.get(group.leader);
    const now = Date.now();
    const lastSync = this.lastSyncAt.get(group.leader) ?? 0;
    if (!opts.force && signature === prevSignature && now - lastSync < 500) {
      return;
    }
    this.lastSignature.set(group.leader, signature);
    this.lastSyncAt.set(group.leader, now);

    const members = this.fanoutMembers(group);
    if (!members.size) {
      return;
    }

    const leaderSession = this.audioManager.getSession(group.leader);
    this.lastLeaderStreamId.set(group.leader, leaderSession?.stream?.id ?? '');
    const metadata = leaderSession?.metadata ?? this.buildMetadata(leaderState);
    if (leaderSession?.playbackSource?.kind === 'pipe' && leaderSession.playbackSource.stream) {
      this.stopLocalPcmTap(group.leader);
      if (leaderMode === 'stop') {
        for (const memberId of members) {
          this.zones.handleCommand(memberId, 'stop');
        }
        this.teardownFanout(group.leader);
      } else if (leaderMode === 'pause') {
        for (const memberId of members) {
          this.zones.handleCommand(memberId, 'pause');
        }
      } else if (leaderMode === 'play') {
        this.syncMembersToPipe(group, leaderSession, metadata);
      }
      return;
    }
    if (leaderMode === 'stop') {
      for (const memberId of members) {
        this.zones.handleCommand(memberId, 'stop');
      }
      this.teardownFanout(group.leader);
      return;
    }
    if (leaderMode === 'pause') {
      for (const memberId of members) {
        this.zones.handleCommand(memberId, 'pause');
      }
      this.teardownFanout(group.leader);
      return;
    }
    const leaderPcm = leaderSession ? this.resolveLeaderPcmStream(group.leader, leaderSession, leaderState) : null;
    if (leaderMode === 'play' && leaderPcm) {
      this.syncMembersToPcmStream(group, leaderPcm, metadata);
      return;
    }
    this.teardownFanout(group.leader);

    const startAtSec = leaderMode === 'play' ? this.resolveStartAtSec(leaderState, leaderSession) : null;

    if (!leaderAudiopath) {
      this.log.debug('mixed group follow skipped; leader audiopath missing', {
        leader: group.leader,
      });
      return;
    }
    if (this.isUnsupportedAudiopath(leaderAudiopath)) {
      this.log.debug('mixed group follow skipped; unsupported source', {
        leader: group.leader,
        audiopath: leaderAudiopath,
      });
      return;
    }

    for (const memberId of members) {
      const memberSession = this.audioManager.getSession(memberId);
      if (!memberSession) {
        void this.zones.playContent(
          memberId,
          leaderAudiopath,
          isLineInAudiopath(leaderAudiopath) ? 'linein' : 'serviceplay',
          metadata,
          startAtSec ? { startAtSec } : undefined,
        );
        continue;
      }
      const memberPath = memberSession.metadata?.audiopath ?? '';
      const same = isSameAudiopath(memberPath, leaderAudiopath);
      if (same && memberSession.state === 'paused') {
        this.zones.handleCommand(memberId, 'resume');
        continue;
      }
      if (same && memberSession.state === 'playing') {
        continue;
      }
      void this.zones.playContent(
        memberId,
        leaderAudiopath,
        isLineInAudiopath(leaderAudiopath) ? 'linein' : 'serviceplay',
        metadata,
        startAtSec ? { startAtSec } : undefined,
      );
    }
  }

  private syncMembersToPcmStream(
    group: GroupRecord,
    leaderPcm: {
      stream: NodeJS.ReadableStream;
      format: 's16le' | 's24le' | 's32le';
      sampleRate: number;
      channels: number;
    },
    metadata: PlaybackMetadata,
  ): void {
    const fanout = this.ensureFanout(group.leader, leaderPcm.stream);
    const members = this.fanoutMembers(group);
    fanout.pruneToMembers(members);

    for (const memberId of members) {
      const memberStream = fanout.ensureMember(memberId);
      const memberSession = this.audioManager.getSession(memberId);
      if (
        memberSession?.playbackSource?.kind === 'pipe' &&
        memberSession.playbackSource.stream === memberStream
      ) {
        if (memberSession.state === 'paused') {
          this.zones.handleCommand(memberId, 'resume');
        }
        continue;
      }
      this.zones.inputs.playInputSource(
        memberId,
        'mixedgroup',
        {
          kind: 'pipe',
          path: `mixed-${group.leader}-${memberId}`,
          format: leaderPcm.format,
          sampleRate: leaderPcm.sampleRate,
          channels: leaderPcm.channels,
          realTime: true,
          stream: memberStream,
        },
        metadata,
      );
    }
  }

  private syncMembersToPipe(
    group: GroupRecord,
    leaderSession: NonNullable<ReturnType<AudioManager['getSession']>>,
    metadata: PlaybackMetadata,
  ): void {
    const playbackSource = leaderSession.playbackSource;
    if (!playbackSource || playbackSource.kind !== 'pipe' || !playbackSource.stream) {
      return;
    }
    const label = leaderSession.source;
    if (label !== 'airplay' && label !== 'linein') {
      this.log.debug('mixed group pipe follow skipped; unsupported label', {
        leader: group.leader,
        label,
      });
      return;
    }
    const fanout = this.ensureFanout(group.leader, playbackSource.stream);
    const members = this.fanoutMembers(group);
    fanout.pruneToMembers(members);

    for (const memberId of members) {
      const memberStream = fanout.ensureMember(memberId);
      const memberSession = this.audioManager.getSession(memberId);
      if (
        memberSession?.playbackSource?.kind === 'pipe' &&
        memberSession.playbackSource.stream === memberStream
      ) {
        if (memberSession.state === 'paused') {
          this.zones.handleCommand(memberId, 'resume');
        }
        continue;
      }
      this.zones.inputs.playInputSource(
        memberId,
        label,
        {
          kind: 'pipe',
          path: `mixed-${group.leader}-${memberId}`,
          format: playbackSource.format,
          sampleRate: playbackSource.sampleRate,
          channels: playbackSource.channels,
          realTime: playbackSource.realTime,
          stream: memberStream,
        },
        metadata,
      );
    }
  }

  private syncMemberMetadata(group: GroupRecord, patch: Partial<ZoneState>): void {
    if (!this.pipeFanouts.has(group.leader)) {
      return;
    }
    const members = this.fanoutMembers(group);
    if (!members.size) {
      return;
    }
    const metadata: Partial<PlaybackMetadata> = {};
    if (typeof patch.title === 'string') {
      metadata.title = patch.title;
    }
    if (typeof patch.artist === 'string') {
      metadata.artist = patch.artist;
    }
    if (typeof patch.album === 'string') {
      metadata.album = patch.album;
    }
    if (typeof patch.coverurl === 'string') {
      metadata.coverurl = patch.coverurl;
    }
    if (typeof patch.duration === 'number') {
      metadata.duration = patch.duration;
    }
    if (!Object.keys(metadata).length) {
      return;
    }
    for (const memberId of members) {
      this.zones.inputs.updateInputMetadata(memberId, metadata);
    }
  }

  private ensureFanout(leaderId: number, source: NodeJS.ReadableStream): PipeFanout {
    const existing = this.pipeFanouts.get(leaderId);
    if (existing && existing.source === source) {
      return existing;
    }
    if (existing) {
      existing.stop();
    }
    const fanout = new PipeFanout(source, leaderId, this.log);
    this.pipeFanouts.set(leaderId, fanout);
    return fanout;
  }

  private stopLocalPcmTap(leaderId: number): void {
    const tap = this.localPcmTaps.get(leaderId);
    if (!tap) {
      return;
    }
    tap.tap.stop();
    this.localPcmTaps.delete(leaderId);
  }

  private teardownFanout(leaderId: number): void {
    const fanout = this.pipeFanouts.get(leaderId);
    if (!fanout) {
      this.stopLocalPcmTap(leaderId);
      return;
    }
    fanout.stop();
    this.pipeFanouts.delete(leaderId);
    this.stopLocalPcmTap(leaderId);
  }
}

const MAX_FANOUT_BUFFER_BYTES = 512 * 1024;

class PipeFanout {
  public readonly source: NodeJS.ReadableStream;
  private readonly members = new Map<number, PassThrough>();
  private readonly log: ReturnType<typeof createLogger>;
  private closed = false;
  private lastDropAt = new Map<number, number>();
  private readonly onDataHandler: (chunk: Buffer) => void;
  private readonly onEndHandler: () => void;
  private readonly onErrorHandler: (error: unknown) => void;

  constructor(source: NodeJS.ReadableStream, private readonly leaderId: number, logger: ReturnType<typeof createLogger>) {
    this.source = source;
    this.log = logger;
    this.onDataHandler = (chunk: Buffer) => this.onData(chunk);
    this.onEndHandler = () => this.stop();
    this.onErrorHandler = (error: unknown) => {
      this.log.debug('mixed group pipe source error', {
        leader: this.leaderId,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stop();
    };
    source.on('data', this.onDataHandler);
    source.once('end', this.onEndHandler);
    source.once('close', this.onEndHandler);
    source.once('error', this.onErrorHandler);
  }

  public ensureMember(memberId: number): PassThrough {
    let stream = this.members.get(memberId);
    if (!stream || stream.destroyed) {
      stream = new PassThrough({ highWaterMark: MAX_FANOUT_BUFFER_BYTES });
      this.members.set(memberId, stream);
    }
    return stream;
  }

  public pruneToMembers(members: Set<number>): void {
    for (const memberId of this.members.keys()) {
      if (!members.has(memberId)) {
        this.removeMember(memberId);
      }
    }
  }

  public removeMember(memberId: number): void {
    const stream = this.members.get(memberId);
    if (!stream) {
      return;
    }
    this.members.delete(memberId);
    this.lastDropAt.delete(memberId);
    stream.end();
    stream.destroy();
  }

  public stop(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.source.off('data', this.onDataHandler);
    this.source.off('end', this.onEndHandler);
    this.source.off('close', this.onEndHandler);
    this.source.off('error', this.onErrorHandler);
    for (const memberId of Array.from(this.members.keys())) {
      this.removeMember(memberId);
    }
  }

  /** Piping and a paused session both keep a 'data' listener on the stream; only a dropped reader leaves none. */
  private static hasReader(stream: PassThrough): boolean {
    return stream.listenerCount('data') > 0 || stream.listenerCount('readable') > 0;
  }

  private onData(chunk: Buffer): void {
    if (this.closed || this.members.size === 0) {
      return;
    }
    for (const [memberId, stream] of this.members.entries()) {
      if (stream.destroyed) {
        this.members.delete(memberId);
        continue;
      }
      if (stream.writableLength > MAX_FANOUT_BUFFER_BYTES) {
        // A full pipe nobody reads is not a slow member but a gone one: its session ended (an
        // output that failed to play, a stop on the member) and the engine unpiped it without
        // telling us. Kept, it stayed in the fanout for as long as the leader played, invisibly
        // grouped and logging drops (#424). Let go of it; the next leader sync feeds it afresh.
        if (!PipeFanout.hasReader(stream)) {
          this.log.info('mixed group member dropped; nothing reads its pipe', {
            leader: this.leaderId,
            member: memberId,
          });
          this.removeMember(memberId);
          continue;
        }
        const now = Date.now();
        const last = this.lastDropAt.get(memberId) ?? 0;
        if (now - last > 2000) {
          this.lastDropAt.set(memberId, now);
          this.log.debug('mixed group pipe drop (slow member)', {
            leader: this.leaderId,
            member: memberId,
            bufferedBytes: stream.writableLength,
          });
        }
        continue;
      }
      stream.write(chunk);
    }
  }
}

export function createMixedGroupController(
  configPort: ConfigPort,
  audioManager: AudioManager,
): MixedGroupController {
  return new MixedGroupController(configPort, audioManager);
}
