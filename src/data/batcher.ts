// RequestBatcher — coalesces GraphQL operations issued in the same tick into ONE batched
// HTTP request, the way Apollo BatchHttpLink / DataLoader do. This is the fix for the
// cold-launch fan-out: 26–33 *distinct* queries fired as the dashboard mounts become a
// handful of round-trips instead of 26–33. (Dedup/cache can't help distinct queries — only
// batching can.) Requires the GraphQL server to accept an array of operations; Apollo Server
// allows this by default.
//
// We batch per microtask (everything queued before the event loop turns), so it needs no
// timers and is deterministic to test — queries fired together in one React render batch
// together. Falls back to one-op batches transparently.

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
        chunk.forEach((w, j) => w.resolve(results[j]));
      } catch (err) {
        chunk.forEach((w) => w.reject(err));
      }
    }
  }
}
