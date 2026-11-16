import type { QueueItem } from '@/ports/types/queueTypes';

/** A zone's queue as it is kept on disk. Two parts, because they change at very different rates. */
export interface StoredQueueItems {
  items: QueueItem[];
}

export interface StoredQueueState {
  currentIndex: number;
  shuffle: boolean;
  repeat: number;
  /** Whether `items` is in shuffled order, so switching shuffle off can still put it back. */
  shuffled: boolean;
  /** Seconds into the current item. */
  positionSec: number;
  savedAt: number;
}

export interface RestoredQueue extends StoredQueueItems, StoredQueueState {}

/** What the persistence needs to see of a zone; a `ZoneContext` fits. */
export interface PersistableZone {
  id: number;
  queue: { items: QueueItem[]; currentIndex: number; shuffle: boolean; repeat: number; authority: string };
  metadata: Record<string, unknown>;
  inputMode: string | null;
  alert?: unknown;
  state: { time?: number };
}

export interface QueueFiles {
  readItems(zoneId: number): Promise<StoredQueueItems | null>;
  readState(zoneId: number): Promise<StoredQueueState | null>;
  writeItems(zoneId: number, data: StoredQueueItems): Promise<void>;
  writeState(zoneId: number, data: StoredQueueState): Promise<void>;
}

/** Browser tabs are zones too, with ids that mean nothing after a restart. */
const EPHEMERAL_ZONE_BASE = 9000;
/** How long changes are gathered before they are written. */
const WRITE_DELAY_MS = 2000;
/** The position is saved to this many seconds; finer would mean a write every second of playback. */
const POSITION_STEP_SEC = 10;

/**
 * Keeps each zone's queue on disk, so a restart does not empty it.
 *
 * The queue lived in memory only: every update of the server, and every change to a zone's
 * configuration, left the room with nothing queued and no memory of where it was in the track.
 *
 * The list and the position are written apart. A queue of a few thousand tracks is a megabyte of
 * JSON and changes when somebody edits it; where playback is in it changes every few seconds.
 *
 * Only a queue the zone itself drives is kept. While a phone is streaming in, or an announcement
 * is playing, the queue holds a stand-in for that source — nothing a restart could play again —
 * and what is on disk is left as it was, which is the queue the room goes back to.
 */
export class QueuePersistence {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly itemsWritten = new Map<number, string>();
  private readonly stateWritten = new Map<number, string>();
  private readonly itemsDirty = new Set<number>();
  /**
   * Zones whose stored queue has been read. Until then a zone's empty queue says nothing about
   * what it should hold, and writing it would erase the queue about to be restored.
   */
  private readonly loaded = new Set<number>();
  private closed = false;

  constructor(
    private readonly files: QueueFiles,
    private readonly getZone: (zoneId: number) => PersistableZone | undefined,
    private readonly onError: (zoneId: number, error: unknown) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly writeDelayMs: number = WRITE_DELAY_MS,
  ) {}

  /** Something about the zone's playback changed. Cheap; safe to call on every state patch. */
  public noteState(zoneId: number): void {
    this.schedule(zoneId);
  }

  /** The list itself changed: tracks added, removed, moved or reordered. */
  public noteItems(zoneId: number): void {
    this.itemsDirty.add(zoneId);
    this.schedule(zoneId);
  }

  private schedule(zoneId: number): void {
    if (this.closed || zoneId >= EPHEMERAL_ZONE_BASE || this.timers.has(zoneId)) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(zoneId);
      void this.write(zoneId);
    }, this.writeDelayMs);
    timer.unref?.();
    this.timers.set(zoneId, timer);
  }

  /**
   * Write everything pending now and take no more changes.
   *
   * For shutdown, called before the players are stopped: stopping them rewinds every zone, and
   * that must not be what is remembered.
   */
  public async close(zoneIds: readonly number[]): Promise<void> {
    this.closed = true;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    await Promise.all(
      zoneIds.filter((zoneId) => zoneId < EPHEMERAL_ZONE_BASE).map((zoneId) => this.write(zoneId, true)),
    );
  }

  private async write(zoneId: number, exactPosition = false): Promise<void> {
    const zone = this.getZone(zoneId);
    if (!zone || !this.loaded.has(zoneId) || !isOwnQueue(zone)) {
      return;
    }
    try {
      const items = zone.queue.items;
      const itemsKey = items.map((item) => item.unique_id).join(',');
      if (this.itemsDirty.delete(zoneId) || this.itemsWritten.get(zoneId) !== itemsKey) {
        await this.files.writeItems(zoneId, { items });
        this.itemsWritten.set(zoneId, itemsKey);
      }
      const rawPosition = Number.isFinite(zone.state.time) ? Math.max(0, Number(zone.state.time)) : 0;
      const positionSec = exactPosition
        ? Math.floor(rawPosition)
        : Math.floor(rawPosition / POSITION_STEP_SEC) * POSITION_STEP_SEC;
      const state: StoredQueueState = {
        currentIndex: zone.queue.currentIndex,
        shuffle: zone.queue.shuffle,
        repeat: zone.queue.repeat,
        shuffled: zone.metadata.queueShuffled === true,
        positionSec,
        savedAt: 0,
      };
      const stateKey = JSON.stringify(state);
      if (this.stateWritten.get(zoneId) !== stateKey) {
        await this.files.writeState(zoneId, { ...state, savedAt: this.now() });
        this.stateWritten.set(zoneId, stateKey);
      }
    } catch (error) {
      this.onError(zoneId, error);
    }
  }

  /** The queue a zone had, or null when it had none worth returning to. */
  public async load(zoneId: number): Promise<RestoredQueue | null> {
    if (zoneId >= EPHEMERAL_ZONE_BASE) {
      return null;
    }
    this.loaded.delete(zoneId);
    try {
      const [stored, state] = await Promise.all([this.files.readItems(zoneId), this.files.readState(zoneId)]);
      const items = Array.isArray(stored?.items) ? stored.items.filter(isQueueItem) : [];
      if (!items.length) {
        return null;
      }
      const index = Number(state?.currentIndex);
      const position = Number(state?.positionSec);
      return {
        items,
        currentIndex: Number.isInteger(index) && index >= 0 && index < items.length ? index : 0,
        shuffle: state?.shuffle === true,
        repeat: Number.isInteger(state?.repeat) ? Number(state?.repeat) : 0,
        shuffled: state?.shuffled === true,
        positionSec: Number.isFinite(position) && position > 0 ? position : 0,
        savedAt: Number(state?.savedAt) || 0,
      };
    } catch (error) {
      this.onError(zoneId, error);
      return null;
    } finally {
      this.loaded.add(zoneId);
    }
  }
}

function isOwnQueue(zone: PersistableZone): boolean {
  if (zone.alert || zone.queue.authority !== 'local') {
    return false;
  }
  return !zone.inputMode || zone.inputMode === 'queue' || zone.inputMode === 'spotify';
}

function isQueueItem(value: unknown): value is QueueItem {
  const item = value as Partial<QueueItem> | null;
  return typeof item?.audiopath === 'string' && item.audiopath.length > 0 && typeof item.unique_id === 'string';
}
