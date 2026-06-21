/** Public surface of the shared core (platform-agnostic, fully Node-tested). */
export { RealtimeEngine } from './core/engine.ts';
export type { EngineOptions, EngineMetrics, ServerSnapshot } from './core/engine.ts';
export { JsonCodec, MsgpackCodec } from './core/codec.ts';
export type { Codec } from './core/codec.ts';
export { ClockSync } from './core/clock.ts';
export { PredictionEngine } from './core/prediction.ts';
export type { PredictionMetrics, ReconcileResult } from './core/prediction.ts';
export { RingBuffer, Batcher } from './core/ringbuffer.ts';
export { applyAnswer, initialDuelState, BLITZ_POINTS_PER_CORRECT } from './core/duel.ts';
export type { DuelState, AnswerInput } from './core/duel.ts';
export { MessageType, Channels } from './core/types.ts';
export type { WsFrame, PingSample, AnswerSubmission, GameSnapshot, PlayerState } from './core/types.ts';
export { MockTransport } from './core/transport.ts';
export type { Transport } from './core/transport.ts';
