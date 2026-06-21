/** Web entry (RN-Web) — Expo resolves `.web.ts`. Socket runs in a Web Worker (off main thread). */
export * from './index.ts';
import { RealtimeEngine } from './core/engine.ts';
import type { Codec } from './core/codec.ts';
import { WorkerTransport } from './web/WorkerTransport.ts';

export interface CreateEngineOptions {
  url: string;
  userId: string;
  /** App-constructed worker (bundler-specific URL resolution lives in the app). */
  worker: Worker;
  codec?: Codec;
}

export function createMatiksEngine(opts: CreateEngineOptions): RealtimeEngine {
  return new RealtimeEngine({
    transport: new WorkerTransport(opts.url, opts.worker),
    userId: opts.userId,
    ...(opts.codec ? { codec: opts.codec } : {}),
  });
}
