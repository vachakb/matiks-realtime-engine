// RequestBatcher — coalesces GraphQL ops issued in the same microtask into ONE batched request
// (Apollo BatchHttpLink / DataLoader style), collapsing the cold-launch query fan-out. Requires a
// server that accepts an array of operations.

import type { RequestSpec, ResponseRecord } from './types.ts';

/** Sends a batch of requests as one round-trip; returns results positionally. */
export type BatchFetcher = (specs: RequestSpec[]) => Promise<ResponseRecord[]>;

interface Waiter {
  spec: RequestSpec;
  resolve: (r: ResponseRecord) => void;
  reject: (e: unknown) => void;
}

export class RequestBatcher {
  private readonly batchFetcher: BatchFetcher;
  private readonly maxBatch: number;
  private queue: Waiter[] = [];
  private scheduled = false;
  /** Number of batched round-trips actually sent — the metric that matters for launch. */
  roundTrips = 0;

  constructor(batchFetcher: BatchFetcher, maxBatch = 25) {
    this.batchFetcher = batchFetcher;
    this.maxBatch = maxBatch;
  }

  request(spec: RequestSpec): Promise<ResponseRecord> {
    return new Promise<ResponseRecord>((resolve, reject) => {
      this.queue.push({ spec, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => void this.flush());
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    this.scheduled = false;

    // Chunk to maxBatch so one giant tick can't build an unbounded request.
    for (let i = 0; i < batch.length; i += this.maxBatch) {
      const chunk = batch.slice(i, i + this.maxBatch);
      this.roundTrips++;
      try {
        const results = await this.batchFetcher(chunk.map((w) => w.spec));
        chunk.forEach((w, j) => {
          const r = results[j];
          if (r === undefined) {
            w.reject(new Error(`batch fetcher returned ${results.length} results for ${chunk.length} requests`));
          } else {
            w.resolve(r);
          }
        });
      } catch (err) {
        chunk.forEach((w) => w.reject(err));
      }
    }
  }
}
