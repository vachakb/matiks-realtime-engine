/**
 * Core protocol types for the Matiks real-time engine.
 *
 * Mirrors Matiks' production WebSocket contract: every frame on the wire is
 * `{ type, channel?, data? }`. We keep that shape verbatim so the engine is a
 * drop-in replacement — the server never has to change.
 */

/** Message types on the wire, matching Matiks' production enum (from their bundle). */
export const MessageType = {
  JoinChannel: 'channel_subscribe',
  LeaveChannel: 'channel_unsubscribe',
  PingPong: 'ping-pong',
  SubmitAnswer: 'submitAnswer',
  SubmitAnswerV2: 'submitAnswerV2',
  RegisterTap: 'registerTap',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** A single frame on the WebSocket. `data` is opaque to the transport; the codec (de)serializes it. */
export interface WsFrame<T = unknown> {
  type: MessageType | string;
  channel?: string;
  data?: T;
  /** Client-generated id for reliable delivery / ack correlation. Matiks already uses this today. */
  clientMessageId?: string;
}

/** Channel-name helpers — namespaced exactly like Matiks' `WEBSOCKET_CHANNELS`. */
export const Channels = {
  game: (gameId: string) => `GAME_EVENT_${gameId}_V2`,
  user: (userId: string) => `USER_EVENT_${userId}`,
  pingPong: (userId: string) => `PING_PONG_EVENT_${userId}`,
  onlineUsers: () => 'ONLINE_USERS',
} as const;

/**
 * An answer submission — the hot path of a Blitz/DMAS duel.
 * NOTE: `timeOfSubmission` is engine clock-time (monotonic-derived), never `Date.now()`.
 */
export interface AnswerSubmission {
  gameId: string;
  /** "<gameId>_<questionIndex>" */
  questionId: string;
  submittedValue: number;
  /** Server-aligned, monotonic timestamp (ms). See ClockSync. */
  timeOfSubmission: number;
  userId: string;
  /** Monotonically increasing per-client input sequence number — drives reconciliation. */
  seq: number;
}

/** Authoritative per-player state the server broadcasts on the GAME_EVENT channel. */
export interface PlayerState {
  userId: string;
  score: number;
  questionIndex: number;
  /** The last input seq the server has processed for THIS client (reconciliation anchor). */
  lastProcessedSeq?: number;
}

/** A snapshot of the duel as the server sees it. */
export interface GameSnapshot {
  gameId: string;
  /** server time (ms) this snapshot represents — used for opponent interpolation. */
  t: number;
  players: PlayerState[];
}

/** Ping/pong sample for NTP-style clock sync. t1=client send, t2=server recv, t3=server send, t4=client recv. */
export interface PingSample {
  t1: number;
  t2: number;
  t3: number;
  t4: number;
}
