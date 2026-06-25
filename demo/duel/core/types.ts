// Core protocol types — mirrors Matiks' WebSocket contract ({ type, channel?, data? }) verbatim,
// so the engine is a drop-in replacement and the server is unchanged.

// Message types on the wire (from Matiks' bundle).
export const MessageType = {
  JoinChannel: 'channel_subscribe',
  LeaveChannel: 'channel_unsubscribe',
  PingPong: 'ping-pong',
  SubmitAnswer: 'submitAnswer',
  SubmitAnswerV2: 'submitAnswerV2',
  RegisterTap: 'registerTap',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

// A frame on the WebSocket; `data` is opaque to the transport (the codec (de)serializes it).
export interface WsFrame<T = unknown> {
  type: MessageType | string;
  channel?: string;
  data?: T;
  clientMessageId?: string;
}

// Channel names, namespaced like Matiks' WEBSOCKET_CHANNELS.
export const Channels = {
  game: (gameId: string) => `GAME_EVENT_${gameId}_V2`,
  user: (userId: string) => `USER_EVENT_${userId}`,
  pingPong: (userId: string) => `PING_PONG_EVENT_${userId}`,
  onlineUsers: () => 'ONLINE_USERS',
} as const;

export interface AnswerSubmission {
  gameId: string;
  questionId: string; // "<gameId>_<questionIndex>"
  submittedValue: number;
  timeOfSubmission: number;
  userId: string;
  seq: number; // monotonic per-client input seq — drives reconciliation
}

export interface PlayerState {
  userId: string;
  score: number;
  questionIndex: number;
  lastProcessedSeq?: number; // reconciliation anchor
}

export interface GameSnapshot {
  gameId: string;
  t: number;
  players: PlayerState[];
}
