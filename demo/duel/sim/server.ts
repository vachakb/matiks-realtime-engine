// MockMatiksServer — the authoritative side of the duel, for the demo + tests. It holds the
// answer key, scores the duel from its own copy, runs an opponent, and demonstrates the one
// integrity layer a correctness check can't provide:
//
//   • Bot / cadence detection — because the question bank is decrypted on the client, a bot
//     knows every answer and can submit genuinely-correct answers at inhuman speed. Correct-
//     and-fast passes any correctness check, so the only tell is cadence: N consecutive
//     sub-human-latency answers => flagged => run voided; the client learns it via the snapshot.
//     (Robust detection times answers server-side; this demo uses the client-sent timestamp.)

import { MsgpackCodec, type Codec } from '../core/codec';
import { applyAnswer, initialDuelState, type DuelState, type AnswerInput } from '../core/duel';
import { MessageType, Channels, type WsFrame } from '../core/types';
import { makeQuestions } from './questions';
import type { Loopback } from './loopback';

export interface ServerOptions {
  link: Loopback;
  gameId: string;
  userId: string;
  questionCount: number;
  now: () => number; // server clock (ms)
  codec?: Codec;
  opponentId?: string;
  opponentIntervalMs?: number; // opponent answers one question this often
  minHumanMs?: number; // answers faster than this gap are "superhuman"
  anomalyStreak?: number; // this many consecutive superhuman answers ⇒ flagged
  durationMs?: number; // match length; surfaced as an absolute deadline so the UI animates natively
}

export interface Integrity {
  flagged: boolean;
  reason?: string;
}

interface ClientSubmit {
  gameId: string;
  questionId: string;
  submittedValue: number;
  timeOfSubmission: number;
  userId: string;
  seq: number;
}

export class MockMatiksServer {
  private readonly link: Loopback;
  private readonly codec: Codec;
  private readonly now: () => number;
  private readonly gameId: string;
  private readonly userId: string;
  private readonly opponentId: string;
  private readonly answerKey: Map<string, number>;
  private readonly questionCount: number;
  private readonly opponentIntervalMs: number;
  private readonly minHumanMs: number;
  private readonly anomalyStreak: number;
  private readonly durationMs: number;

  private self: DuelState = initialDuelState;
  private lastProcessedSeq = -1;
  private oppScore = 0;
  private oppIndex = 0;
  private oppLastAnswerAt = 0;
  private lastSubmitAt = -Infinity;
  private fastStreak = 0;
  private integrity: Integrity = { flagged: false };
  private started = 0;

  constructor(opts: ServerOptions) {
    this.link = opts.link;
    this.codec = opts.codec ?? MsgpackCodec;
    this.now = opts.now;
    this.gameId = opts.gameId;
    this.userId = opts.userId;
    this.opponentId = opts.opponentId ?? 'opponent';
    this.questionCount = opts.questionCount;
    this.opponentIntervalMs = opts.opponentIntervalMs ?? 2200;
    this.minHumanMs = opts.minHumanMs ?? 350;
    this.anomalyStreak = opts.anomalyStreak ?? 3;
    this.durationMs = opts.durationMs ?? 60_000;
    const qs = makeQuestions(opts.gameId, opts.questionCount);
    this.answerKey = new Map(qs.map((q) => [q.questionId, q.answer]));
  }

  /** Begin serving: route client frames. Call tick() periodically to advance the opponent. */
  start(): void {
    this.started = this.now();
    this.oppLastAnswerAt = this.started;
    this.link.onClientFrame((bytes) => this.onFrame(bytes));
  }

  // --- inspection (tests) ---
  get selfState(): DuelState { return this.self; }
  get opponentScore(): number { return this.oppScore; }
  get isFlagged(): boolean { return this.integrity.flagged; }

  private onFrame(bytes: Uint8Array): void {
    let frame: WsFrame;
    try { frame = this.codec.decode(bytes) as WsFrame; } catch { return; }
    if (frame.type === MessageType.JoinChannel) {
      this.broadcast(); // initial snapshot
      return;
    }
    if (frame.type === MessageType.SubmitAnswerV2 && frame.data) {
      this.handleSubmit(frame.data as ClientSubmit);
    }
  }

  /** The match window is closed (time up or flagged) — authoritative, no scoring after this. */
  private isOver(): boolean {
    return this.integrity.flagged || this.now() >= this.started + this.durationMs;
  }

  private handleSubmit(s: ClientSubmit): void {
    // No answers after time's up (Matiks' rule): ack the seq but never score.
    if (this.isOver()) { this.lastProcessedSeq = Math.max(this.lastProcessedSeq, s.seq); this.broadcast(); return; }
    // Idempotent: ignore a question already scored, but still ack the seq.
    if (!Object.prototype.hasOwnProperty.call(this.self.answered, s.questionId)) {
      // Bot/timing anomaly: superhuman cadence between answers.
      const gap = s.timeOfSubmission - this.lastSubmitAt;
      if (this.lastSubmitAt !== -Infinity && gap < this.minHumanMs) {
        this.fastStreak++;
        if (this.fastStreak >= this.anomalyStreak && !this.integrity.flagged) {
          this.integrity = { flagged: true, reason: `superhuman answer cadence (${Math.round(gap)}ms gaps) — flagged as bot` };
        }
      } else {
        this.fastStreak = 0;
      }
      this.lastSubmitAt = s.timeOfSubmission;

      // Score from the server's own answer key.
      const correctValue = this.answerKey.get(s.questionId);
      if (correctValue !== undefined) {
        const input: AnswerInput = {
          seq: s.seq,
          questionId: s.questionId,
          submittedValue: s.submittedValue,
          correctValue,
          timeOfSubmission: s.timeOfSubmission,
        };
        this.self = applyAnswer(this.self, input);
      }
    }
    this.lastProcessedSeq = Math.max(this.lastProcessedSeq, s.seq);
    this.broadcast();
  }

  /** Advance the opponent and broadcast a snapshot. Call on an interval (or per test tick). */
  tick(): void {
    const t = this.now();
    // Opponent stops the instant the clock runs out — no more answers after time's up.
    if (!this.isOver() && this.oppIndex < this.questionCount && t - this.oppLastAnswerAt >= this.opponentIntervalMs) {
      // Opponent answers correctly, deterministically (wrong on every 7th for realism).
      const correct = this.oppIndex % 7 !== 6;
      if (correct) this.oppScore += 4;
      this.oppIndex++;
      this.oppLastAnswerAt = t;
    }
    this.broadcast();
  }

  private broadcast(): void {
    // When flagged, the authoritative score is voided — the client will reconcile its optimistic
    // score down to 0, making the rollback (and the catch) visible.
    const self = this.integrity.flagged ? { ...this.self, score: 0 } : this.self;
    const endsAt = this.started + this.durationMs;
    // Authoritative match end: flagged, time up, OR both players have answered every question.
    // (Fixes the premature "you won" that flipped to "you lost" while the opponent kept playing.)
    const bothDone = this.self.questionIndex >= this.questionCount && this.oppIndex >= this.questionCount;
    const finished = this.integrity.flagged || this.now() >= endsAt || bothDone;
    const frame: WsFrame = {
      type: MessageType.SubmitAnswerV2, // any non-ping type; routed by channel on the client
      channel: Channels.game(this.gameId),
      data: {
        gameId: this.gameId,
        t: this.now(),
        self,
        lastProcessedSeq: this.lastProcessedSeq,
        opponent: { userId: this.opponentId, score: this.oppScore, questionIndex: this.oppIndex },
        integrity: this.integrity,
        // Absolute match window → the client animates the countdown on the UI thread (native
        // driver / Reanimated) instead of ticking React every frame.
        timing: { startedAt: this.started, endsAt },
        finished,
      },
    };
    this.link.sendToClient(this.codec.encode(frame));
  }

}
