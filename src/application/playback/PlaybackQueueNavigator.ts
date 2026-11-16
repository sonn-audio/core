import type { QueueItem } from '@/application/zones/zoneManager';

interface QueueState {
  items: QueueItem[];
  shuffle: boolean;
  repeat: number;
  currentIndex: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class PlaybackQueueNavigator {
  constructor(private readonly queue: QueueState) {}

  public setItems(items: QueueItem[], startIndex = 0): void {
    this.queue.items = items.map((item, idx) => ({
      ...item,
      originalIndex: item.originalIndex ?? idx,
      qindex: idx,
    }));
    this.queue.currentIndex = clamp(startIndex, 0, Math.max(0, this.queue.items.length - 1));
  }

  public current(): QueueItem | null {
    return this.queue.items[this.queue.currentIndex] ?? null;
  }

  public currentIndex(): number {
    return this.queue.currentIndex;
  }

  public setCurrentIndex(index: number): QueueItem | null {
    if (!this.queue.items.length) {
      this.queue.currentIndex = 0;
      return null;
    }
    this.queue.currentIndex = clamp(index, 0, this.queue.items.length - 1);
    return this.current();
  }

  public nextIndex(): number {
    const size = this.queue.items.length;
    if (size === 0) return -1;
    const repeat = this.queue.repeat ?? 0;
    const currentIndex = this.queue.currentIndex;

    if (repeat === 3) {
      return currentIndex;
    }
    // Shuffle is not a reason to pick at random here. Switching it on reorders the items
    // themselves, so the list already is the shuffled order — the one the client shows, the one
    // the next track is prefetched from and the one a manual skip walks. Walking it in order is
    // what makes every track play once and the queue end when it has.
    const incremented = currentIndex + 1;
    if (incremented < size) {
      return incremented;
    }
    if (repeat === 1 || repeat === 2) {
      return 0;
    }
    return -1;
  }

  public step(delta: number): number {
    if (!this.queue.items.length) return -1;
    const next = this.queue.currentIndex + delta;
    if (next < 0 || next >= this.queue.items.length) {
      return -1;
    }
    this.queue.currentIndex = next;
    return next;
  }

  public updateFromOutput(items: QueueItem[], currentIndex: number): QueueItem | null {
    if (!Array.isArray(items) || !items.length) {
      return null;
    }
    this.queue.items = items.map((item, idx) => ({
      ...item,
      originalIndex: item.originalIndex ?? idx,
      qindex: idx,
    }));
    this.queue.currentIndex = clamp(currentIndex, 0, items.length - 1);
    return this.current();
  }

  public getState(): QueueState {
    return this.queue;
  }
}
