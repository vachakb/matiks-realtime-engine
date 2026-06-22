// MockMatiksServer — the AUTHORITATIVE side of the duel. This is what makes the runtime
// trustworthy: it holds the answer key, recomputes correctness itself (never trusts the
// client's claim), scores authoritatively, runs an opponent, and detects bot-like cadence.
//
// Integrity model (the "leagues you can trust" pillar):
//   • Server-authoritative scoring — the client's score is whatever THE SERVER computes from
//     submittedValue vs its own key. A client can only "win" by sending the right number.
//   • Bot/timing-anomaly detection — a bot that knows every answer (because the bank is on the
//     client) gives itself away through superhuman cadence. N consecutive sub-human-latency
//     answers ⇒ flagged ⇒ score voided. The client learns it's flagged via the snapshot, so
//     its optimistic score visibly rolls back — reconciliation + integrity in one moment.

import { MsgpackCodec, type Codec } from '../core/codec.ts';
import { applyAnswer, initialDuelState, type DuelState, type AnswerInput } from '../core/duel.ts';
import { MessageType, Channels, type WsFrame, type PingSample } from '../core/types.ts';
import { makeQuestions } from './questions.ts';
import type { Loopback } from './loopback.ts';

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

  private handleSubmit(s: ClientSubmit): void {
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

      // AUTHORITATIVE correctness: server's own key, not the client's word.
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

  /** Advance the opponent + emit a clock-sync sample. Call on an interval (or per test tick). */
  tick(): void {
    const t = this.now();
    if (this.oppIndex < this.questionCount && t - this.oppLastAnswerAt >= this.opponentIntervalMs) {
      // Opponent answers correctly, deterministically (wrong on every 7th for realism).
      const correct = this.oppIndex % 7 !== 6;
      if (correct) this.oppScore += 4;
      this.oppIndex++;
      this.oppLastAnswerAt = t;
    }
    this.emitPing();
    this.broadcast();
  }

  private broadcast(): void {
    // When flagged, the authoritative score is voided — the client will reconcile its optimistic
    // score down to 0, making the rollback (and the catch) visible.
    const self = this.integrity.flagged ? { ...this.self, score: 0 } : this.self;
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
      },
    };
    this.link.sendToClient(this.codec.encode(frame));
  }

  private emitPing(): void {
    // Fabricate a well-formed NTP sample (offset≈0, rtt≈0 over loopback) so ClockSync has data.
    const t = this.now();
    const sample: PingSample = { t1: t, t2: t, t3: t, t4: t };
    const frame: WsFrame = { type: MessageType.PingPong, data: sample };
    this.link.sendToClient(this.codec.encode(frame));
  }
}
