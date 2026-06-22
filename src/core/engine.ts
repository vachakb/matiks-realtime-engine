/**
 * RealtimeEngine — the orchestrator. Ties together transport + codec + clock + prediction +
 * inbound coalescing + an offline outbox, behind a small API that mirrors Matiks' current
 * WebSocket client surface so it's a drop-in swap.
 *
 * What it changes vs. today:
 *   - binary codec by default (msgpack) instead of JSON.stringify/parse
 *   - answer feel is instant via client-side prediction (returns synchronously)
 *   - reconciles against authoritative server snapshots (enables server-authoritative scoring)
 *   - monotonic clock for answer timing (no Date.now())
 *   - inbound frames are coalesced into one dispatch per tick (no per-frame flood)
 * What it deliberately keeps (Matiks already does these well): an offline send-queue.
 */
import { MsgpackCodec, type Codec } from './codec.ts';
import { ClockSync } from './clock.ts';
import { Batcher } from './ringbuffer.ts';
import { PredictionEngine, type PredictionMetrics } from './prediction.ts';
import { applyAnswer, seqOf, initialDuelState, type DuelState, type AnswerInput } from './duel.ts';
import { MessageType, Channels, type WsFrame, type PingSample } from './types.ts';
import type { Transport } from './transport.ts';

/** Authoritative snapshot the server broadcasts on the GAME_EVENT channel. */
export interface ServerSnapshot {
  gameId: string;
  /** server time (ms) of this snapshot — used for opponent interpolation. */
  t: number;
  /** authoritative duel state for THIS user (in production, projected from the leaderboard). */
  self: DuelState;
  /** last input seq the server processed for us — the reconciliation anchor. */
  lastProcessedSeq: number;
  opponent?: { userId: string; score: number; questionIndex: number };
  /** Server-authoritative integrity verdict (bot/anomaly detection). Absent = clean. */
  integrity?: { flagged: boolean; reason?: string };
}

export interface EngineOptions {
  transport: Transport;
  userId: string;
  /** wire codec; defaults to binary (msgpack). Pass JsonCodec to A/B against today's path. */
  codec?: Codec;
  /** monotonic clock source for timing + clock-sync (defaults to performance.now). */
  monotonic?: () => number;
  /** max inbound frames coalesced before a forced flush (also flushed each microtask). */
  inboundBatch?: number;
}

export interface EngineMetrics {
  bytesSent: number;
  framesSent: number;
  bytesReceived: number;
  framesReceived: number;
  prediction: PredictionMetrics;
  clock: { offsetMs: number; rttMs: number; jitterMs: number };
}

type StateListener = (state: DuelState) => void;

export class RealtimeEngine {
  readonly #t: Transport;
  readonly #codec: Codec;
  readonly #clock: ClockSync;
  readonly #userId: string;
  readonly #pred: PredictionEngine<DuelState, AnswerInput>;
  readonly #inbound: Batcher<WsFrame>;

  #seq = 0;
  #gameId = '';
  #open = false;
  #flushScheduled = false;
  #outbox: WsFrame[] = [];
  #opponent: ServerSnapshot['opponent'];
  #integrity: ServerSnapshot['integrity'];
  #stateListeners: StateListener[] = [];
  #m = { bytesSent: 0, framesSent: 0, bytesReceived: 0, framesReceived: 0 };

  constructor(opts: EngineOptions) {
    this.#t = opts.transport;
    this.#codec = opts.codec ?? MsgpackCodec;
    this.#userId = opts.userId;
    const mono = opts.monotonic ?? (() => performance.now());
    this.#clock = new ClockSync(mono);
    this.#pred = new PredictionEngine<DuelState, AnswerInput>({ initialState: initialDuelState, reduce: applyAnswer, seqOf });
    this.#inbound = new Batcher<WsFrame>(opts.inboundBatch ?? 16, (batch) => { for (const f of batch) this.#handle(f); });

    this.#t.onMessage((bytes) => this.#onBytes(bytes));
    this.#t.onOpen(() => { this.#open = true; this.#flushOutbox(); });
    this.#t.onClose(() => { this.#open = false; });
  }

  connect(): void { this.#t.connect(); }
  close(): void { this.#inbound.flush(); this.#t.close(); }

  joinGame(gameId: string): void {
    this.#gameId = gameId;
    this.#send({ type: MessageType.JoinChannel, channel: Channels.game(gameId) });
  }

  onState(cb: StateListener): void { this.#stateListeners.push(cb); }

  get predicted(): DuelState { return this.#pred.predicted; }
  get opponent(): ServerSnapshot['opponent'] { return this.#opponent; }
  /** Latest server integrity verdict — `{flagged:true,reason}` when the server caught a bot. */
  get integrity(): ServerSnapshot['integrity'] { return this.#integrity; }
  get serverTime(): number { return this.#clock.serverNow(); }
  get metrics(): EngineMetrics {
    return {
      ...this.#m,
      prediction: this.#pred.metrics,
      clock: { offsetMs: this.#clock.offsetMs, rttMs: this.#clock.rttMs, jitterMs: this.#clock.jitterMs },
    };
  }

  /**
   * Submit an answer. Returns the predicted state SYNCHRONOUSLY — the UI updates with zero
   * felt latency. The authoritative correction (if any) arrives later via reconcile.
   */
  submitAnswer(a: { questionId: string; submittedValue: number; correctValue: number }): DuelState {
    const input: AnswerInput = {
      seq: ++this.#seq,
      questionId: a.questionId,
      submittedValue: a.submittedValue,
      correctValue: a.correctValue,
      timeOfSubmission: this.#clock.serverNow(),
    };
    const predicted = this.#pred.submit(input);
    this.#send({
      type: MessageType.SubmitAnswerV2,
      channel: Channels.game(this.#gameId),
      data: {
        gameId: this.#gameId,
        questionId: a.questionId,
        submittedValue: a.submittedValue,
        timeOfSubmission: input.timeOfSubmission,
        userId: this.#userId,
        seq: input.seq,
      },
    });
    this.#emit(predicted);
    return predicted;
  }

  // ---- internals ----

  #send(frame: WsFrame): void {
    if (!this.#open) { this.#outbox.push(frame); return; } // offline queue (like Matiks today)
    const bytes = this.#codec.encode(frame);
    this.#m.bytesSent += bytes.length;
    this.#m.framesSent++;
    this.#t.send(bytes);
  }

  #flushOutbox(): void {
    const queued = this.#outbox;
    this.#outbox = [];
    for (const f of queued) this.#send(f);
  }

  #onBytes(bytes: Uint8Array): void {
    this.#m.bytesReceived += bytes.length;
    this.#m.framesReceived++;
    let frame: WsFrame;
    try { frame = this.#codec.decode(bytes) as WsFrame; }
    catch { return; } // malformed frame — drop, never crash the engine
    this.#inbound.add(frame);
    this.#scheduleFlush();
  }

  /** Coalesce all frames that arrive within one tick into a single dispatch. */
  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => { this.#flushScheduled = false; this.#inbound.flush(); });
  }

  #handle(frame: WsFrame): void {
    if (frame.type === MessageType.PingPong) {
      this.#clock.addSample(frame.data as PingSample);
      return;
    }
    if (typeof frame.channel === 'string' && frame.channel.startsWith('GAME_EVENT')) {
      const snap = frame.data as ServerSnapshot | undefined;
      if (snap && snap.self) {
        const r = this.#pred.reconcile(snap.self, snap.lastProcessedSeq);
        if (snap.opponent) this.#opponent = snap.opponent;
        this.#integrity = snap.integrity;
        this.#emit(r.state);
      }
    }
  }

  #emit(state: DuelState): void {
    for (const l of this.#stateListeners) l(state);
  }
}
