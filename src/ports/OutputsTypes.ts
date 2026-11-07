import type { PlaybackSession } from '@/ports/types/playback';
import type { PcmBitDepth, HttpProfile } from '@/ports/types/audioFormat';

export type PreferredOutput = {
  profile: 'pcm' | 'opus' | 'flac' | 'mp3' | 'aac';
  sampleRate?: number;
  channels?: number;
  bitDepth?: PcmBitDepth;
  /** Optional requested prebuffer size (bytes) for the output pipeline. */
  prebufferBytes?: number;
};

/**
 * How this output's audio is timed against the device it plays on.
 *
 * Two different things live here and they are worth keeping apart. `state` and `delayMs` are the
 * *agreement*: the device says whether it locked onto our clock, and `delayMs` is the delay its own
 * chain adds after the audio port, which it compensates for by playing earlier. The rest is the
 * *measurement* of how well we are holding up our end — how far ahead of the playhead frames are
 * handed over, how regularly, and whether our modelled timeline is slipping against the frame
 * clock. All of it was already computed to schedule audio; it just had nowhere to go but the log.
 *
 * Every field except `delayMs` is null while nothing is streaming: they describe a stream in
 * flight, and reporting the last stream's numbers as if they were current would be worse than
 * saying nothing.
 */
export type OutputSyncStatus = {
  /**
   * What the device reports about its own clock lock. 'unknown' when it has not said yet;
   * 'external_source' means it switched to its own input and is not playing ours.
   */
  state: 'synchronized' | 'error' | 'external_source' | 'unknown';
  /**
   * Delay this device's chain adds *after* its audio output, in ms — an amplifier or active speaker.
   *
   * Not an offset that makes the room play later. The client subtracts it from every timestamp
   * (spec: "Clients subtract their static_delay_ms from server timestamps before scheduling
   * playback"), so it plays that much *earlier* and the sound lands on time despite the downstream
   * delay. Raise it for a room that arrives late; a room that arrives early has nothing to declare.
   * Positive only — the protocol has no negative form and states none should ever be needed.
   *
   * This is the value *this server* asked for. `deviceDelayMs` is what the device says it has.
   */
  delayMs: number;
  /**
   * The static delay the device last declared, or null if it never has.
   *
   * Not the same fact as `delayMs`, and not a confirmation of it. A client applies `set_static_delay`
   * immediately — that is the protocol — and simply does not mention the value again until the next
   * state message it sends for some other reason, so this trails a write by design. Watching the two
   * converge tells you nothing except that you just changed something.
   *
   * What it is good for: a client persists this locally and may hold a value nobody here asked for —
   * an installer's offset for the amplifier it is wired to — which is why the send-ahead is sized by
   * the larger of the two. Whether a client accepts the command at all is a separate question, and
   * its advertised `supported_commands` answers that one, not this number.
   */
  deviceDelayMs: number | null;
  /** The bottom of the band frames are scheduled in: the least lead the sender will allow. */
  targetLeadMs: number;
  /**
   * How far above the target the sender is allowed to run before it backpressures.
   *
   * Reported because without it `leadMs` reads as an error. The loop only waits once the lead
   * exceeds target + this, so it *settles at the top of the band* — a healthy sender sits at
   * `targetLeadMs + leadMarginMs`, not at `targetLeadMs`, and comparing against the target alone
   * makes a by-design 100 ms look like 100 ms of trouble.
   */
  leadMarginMs: number;
  /** The lead achieved on the most recent frame. Healthy inside [target, target + margin]. */
  leadMs: number | null;
  /**
   * The lowest lead seen in the last couple of seconds — the floor, and the only health signal here.
   *
   * Two earlier attempts at this measured designed behaviour and read as faults. Send-interval
   * "jitter" measured the loop's deliberate sleep (>100 ms, on a perfectly steady stream). The
   * spread between the highest and lowest lead measured the backpressure sawtooth: the loop bursts
   * frames until the lead reaches the top of its band and then waits, so per-frame leads sweep the
   * whole band and the spread simply *is* the band width (~100 ms, always).
   *
   * The floor is what is left, and it is the thing that matters: while it stays at or above
   * `targetLeadMs` the client always has audio in hand. A floor sinking toward zero is a server
   * losing the race, and that is audible as dropouts.
   */
  leadMinMs: number | null;
  /** Our modelled timeline against the frame clock. A number that keeps growing means slipping. */
  driftMs: number | null;
};

/**
 * A request to play an alert as a native overlay on an output (e.g. Sonos AudioClip).
 * The output ducks the current playback, plays the clip, and restores playback itself —
 * the engine stream is never stopped. Only non-looping alerts are offered this way.
 */
export type NativeAlertRequest = {
  /** Absolute http(s) URL the device can fetch directly (reachable on the LAN). */
  url: string;
  /** Clip playback volume (0..100), already clamped for the zone. */
  volume: number;
  /** Human-friendly label for the clip. */
  title: string;
  /** Alert type ('bell', 'tts', ...). */
  type: string;
};

export type HttpPreferences = {
  httpProfile?: HttpProfile;
  icyEnabled?: boolean;
  icyInterval?: number;
  icyName?: string;
  /**
   * Keep the HTTP response open this many ms after the source ends before closing it.
   * A buffering network renderer (Google Cast holds ~the engine's read-ahead) plays out
   * its buffer after we stop sending; closing immediately makes it glitch/clip the tail.
   * Holding the connection open lets it drain so the close lands at its real end-of-audio.
   */
  drainMsAfterEnd?: number;
};

/** See `ZoneOutput.memberPause`. Each call takes effect at once; the promise covers the player. */
export interface MemberPauseControl {
  /** Whether this member was paused on its own and is sitting the group out. */
  isHeld(): boolean;
  /** Pause only this member and keep it out of the group until it is released. */
  hold(): Promise<void>;
  /**
   * End the hold. With the leader playing the member rejoins it in step; otherwise there
   * is nothing to join, so its stale buffer is dropped and it comes along with the group's
   * next start.
   */
  release(leaderPlaying: boolean): Promise<void>;
}

export interface ZoneOutput {
  readonly type: string;
  play(session: PlaybackSession): Promise<void> | void;
  pause(session: PlaybackSession | null): Promise<void> | void;
  resume(session: PlaybackSession | null): Promise<void> | void;
  stop(session: PlaybackSession | null): Promise<void> | void;
  setVolume?(level: number): Promise<void> | void;
  setPosition?(seconds: number): Promise<void> | void;
  /** Optional hook to push metadata/cover updates without restarting playback. */
  updateMetadata?(session: PlaybackSession | null): Promise<void> | void;
  /**
   * Optional gapless URL-rotation hook for inline crossfade. After the server-side
   * blend completes and the audio session has rotated its stream id, the coordinator
   * calls this so the output can register the NEW URL as a queued next track. The
   * output is expected to accept the new URL/metadata without flushing the current
   * stream; the coordinator will close the OLD URL's HTTP response after a short
   * pre-buffer window so the output transitions naturally. Returns true on success.
   */
  enqueueRotation?(session: PlaybackSession): Promise<boolean> | boolean;
  /**
   * Returns true when this output supports client-side native crossfade (e.g.
   * squeezelite via SlimProto TransitionType.CROSSFADE). When ALL outputs in a zone
   * return true, the coordinator skips the server-side PCM blend and instead issues
   * a native crossfade via the next play() call.
   */
  supportsCrossfade?(): boolean;
  /**
   * Signal that the NEXT play() call should use native crossfade with the given
   * duration (seconds). The output stores this hint and consumes it on the next play.
   */
  setCrossfadeHint?(durationSec: number): void;
  /** Optional preferred output format for this output (used to drive resampling/profile). */
  getPreferredOutput?(): PreferredOutput | null;
  /** Optional estimated output latency/buffer in milliseconds. */
  getLatencyMs?(): number | null;
  /**
   * Optional: wait for the player to say that the stream handed to it by the latest
   * `play()` has begun to play out. Resolves true on that report, false when the output
   * cannot tell (the play never reached a player, it was not a plain start, or nothing
   * was reported within `timeoutMs`). Only outputs whose player reports the moment its
   * new stream starts implement it; the alert volume waits for it (#359).
   */
  waitForPlaybackStart?(timeoutMs: number): Promise<boolean>;
  /** Protocol-specific client capabilities, when the output has negotiated them. */
  getProtocolCapabilities?(): Record<string, unknown> | null;
  /**
   * Optional drain delay (ms) that the alert coordinator should wait after the
   * alert stream ends and before issuing the next play to this output. Used to
   * let the renderer's own buffer empty before its transport URI is swapped —
   * without this, renderers like Sonos clip the tail of short alerts.
   */
  getAlertHandoffDrainMs?(): number | null;
  /** Optional hot-update for output latency (e.g. snapcast/squeezelite/sendspin). */
  setLatencyMs?(ms: number): Promise<void> | void;
  /**
   * Whether this protocol can play a group of zones in step by itself, through a
   * coordinator of its own (Sonos groups, slimproto sync, a shared snapcast stream).
   *
   * An output that says nothing here plays alone: when such a zone joins a group, the
   * mixed group controller has to feed every member the leader's audio instead, because
   * there is no protocol underneath to hold them together.
   */
  supportsNativeGrouping?(): boolean;
  /**
   * How one member of this protocol's group is paused on its own while the rest play on,
   * and brought back by playing it again. Null, or absent, when the protocol cannot, and
   * null whenever this zone is not a member whose player follows the leader's stream.
   *
   * A member of such a group has no session of its own that it plays: it plays the
   * leader's stream (whatever session it had before it joined plays to nobody), so
   * the zone hands its pause and play straight to this control instead of looking for
   * something of its own to pause or restart. The protocol keeps the hold itself, since it
   * is what leaves a held member out of the group's starts; the zone only asks about it.
   */
  memberPause?(): MemberPauseControl | null;
  /**
   * Optional timing relationship with the device, for outputs that have one to report.
   *
   * Only protocols that schedule audio against a shared clock can answer this — Sendspin
   * negotiates one with the client and the client says whether it locked on. An output that
   * just hands bytes to a renderer has nothing to say and should not implement it.
   */
  getSyncStatus?(): OutputSyncStatus | null;
  /** Optional HTTP streaming preferences for outputs that pull via HTTP (e.g. DLNA/Cast). */
  getHttpPreferences?(): HttpPreferences | null;
  /**
   * Optional native (overlay) alert playback. When present, the alert coordinator
   * offers non-looping alerts here instead of the snapshot/replace/resume fallback:
   * the output ducks the current playback, plays the clip, and restores it itself,
   * leaving the engine stream untouched. Returns true when the alert was handled
   * natively; return false (or throw) to make the coordinator fall back to the
   * engine-stream path. Mirrors MA's PlayerFeature.PLAY_ANNOUNCEMENT dispatch.
   */
  playNativeAlert?(request: NativeAlertRequest): Promise<boolean>;
  /**
   * Optional: play the next alert of these zones as one stream, in step in every room,
   * where the protocol keeps players in step only by feeding them one stream (#359).
   * Asked once per alert, of one output, with every zone the alert is for; this zone is
   * among them. Returns the zones it took on — only ever two or more — and every zone it
   * did not plays its alert as before. Their alerts then start as usual, one per zone.
   */
  prepareSyncedAlert?(zoneIds: readonly number[]): number[];
  dispose(): Promise<void> | void;
}

export type ZoneTransport = ZoneOutput;

export interface OutputFieldDefinition {
  id: string;
  label: string;
  /**
   * What the value is, so the admin surface can offer the right control.
   *
   * Everything used to be `text`, which is how a yes/no setting ended up as a box
   * you type the word `true` into. The stored value stays a string either way —
   * every output parses its own config defensively — so a definition can change
   * type without invalidating what is already in config.json.
   */
  type: 'text' | 'boolean' | 'number';
  placeholder?: string;
  description?: string;
  required?: boolean;
  /**
   * Plumbing: correct to expose, wrong to put in front of someone setting up a
   * room. The admin surface keeps these folded away until asked for. Music
   * Assistant marks the same class of setting `advanced`.
   */
  advanced?: boolean;
}

export type TransportFieldDefinition = OutputFieldDefinition;

export interface OutputConfigDefinition {
  id: string;
  label: string;
  description?: string;
  fields: OutputFieldDefinition[];
}

/**
 * Admin-facing shape of an output definition: the definition itself plus whether
 * an operator currently offers it when configuring a zone (see
 * `AudioServerConfig.outputs`). Absent means available.
 */
export type TransportConfigDefinition = OutputConfigDefinition;
