/** Public surface of the shared core (platform-agnostic, fully Node-tested). */
export { RealtimeEngine } from './core/engine.ts';
export type {
  EngineOptions, EngineMetrics, ServerSnapshot, EngineSnapshot,
  DuelPhase, DuelTiming, OpponentState, IntegrityState,
} from './core/engine.ts';
export { JsonCodec, MsgpackCodec } from './core/codec.ts';
export type { Codec } from './core/codec.ts';
export { PredictionEngine } from './core/prediction.ts';
export type { PredictionMetrics, ReconcileResult } from './core/prediction.ts';
export { RingBuffer, Batcher } from './core/ringbuffer.ts';
export { select } from './core/store.ts';
export type { ExternalStore } from './core/store.ts';
export { applyAnswer, initialDuelState, BLITZ_POINTS_PER_CORRECT, cloneDuelState, duelStateEqual } from './core/duel.ts';
export type { DuelState, AnswerInput } from './core/duel.ts';
export { MessageType, Channels } from './core/types.ts';
export type { WsFrame, AnswerSubmission, GameSnapshot, PlayerState } from './core/types.ts';
export { MockTransport } from './core/transport.ts';
export type { Transport } from './core/transport.ts';
