/** Native entry (iOS/Android) — Expo resolves `.native.ts`. Socket runs on a native thread. */
export * from './index.ts';
import { RealtimeEngine } from './core/engine.ts';
import type { Codec } from './core/codec.ts';
import { NativeTransport } from './native/NativeTransport.ts';

export interface CreateEngineOptions {
  url: string;
  userId: string;
  codec?: Codec;
}

export function createMatiksEngine(opts: CreateEngineOptions): RealtimeEngine {
  return new RealtimeEngine({
    transport: new NativeTransport(opts.url),
    userId: opts.userId,
    ...(opts.codec ? { codec: opts.codec } : {}),
  });
}
