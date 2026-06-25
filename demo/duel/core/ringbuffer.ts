// Backpressure primitives: RingBuffer (fixed-memory O(1) queue, drop-oldest) and Batcher
// (coalesce rapid inbound frames into one dispatch instead of flooding the JS thread).

export class RingBuffer<T> {
  #buf: Array<T | undefined>;
  #head = 0;
  #count = 0;
  readonly #cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
    this.#cap = capacity;
    this.#buf = new Array<T | undefined>(capacity);
  }

  get size(): number { return this.#count; }
  get capacity(): number { return this.#cap; }
  get isFull(): boolean { return this.#count === this.#cap; }
  get isEmpty(): boolean { return this.#count === 0; }

  /** Enqueue. If full, the oldest item is evicted and returned; otherwise returns undefined. */
  push(item: T): T | undefined {
    let dropped: T | undefined;
    if (this.#count === this.#cap) {
      dropped = this.#buf[this.#head];
      this.#head = (this.#head + 1) % this.#cap;
      this.#count--;
    }
    const tail = (this.#head + this.#count) % this.#cap;
    this.#buf[tail] = item;
    this.#count++;
    return dropped;
  }

  shift(): T | undefined {
    if (this.#count === 0) return undefined;
    const v = this.#buf[this.#head];
    this.#buf[this.#head] = undefined;
    this.#head = (this.#head + 1) % this.#cap;
    this.#count--;
    return v;
  }

  peek(): T | undefined { return this.#count === 0 ? undefined : this.#buf[this.#head]; }

  /** Oldest-first snapshot (does not mutate). */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.#count; i++) out.push(this.#buf[(this.#head + i) % this.#cap] as T);
    return out;
  }
}

/** Coalesces items and flushes them as one batch at a size threshold or on demand. */
export class Batcher<T> {
  #items: T[] = [];
  readonly #threshold: number;
  readonly #onFlush: (batch: T[]) => void;

  constructor(threshold: number, onFlush: (batch: T[]) => void) {
    if (threshold < 1) throw new RangeError('threshold must be >= 1');
    this.#threshold = threshold;
    this.#onFlush = onFlush;
  }

  add(item: T): void {
    this.#items.push(item);
    if (this.#items.length >= this.#threshold) this.flush();
  }

  /** Emit whatever is buffered (no-op when empty). Order is preserved. */
  flush(): void {
    if (this.#items.length === 0) return;
    const batch = this.#items;
    this.#items = [];
    this.#onFlush(batch);
  }

  get pending(): number { return this.#items.length; }
}
