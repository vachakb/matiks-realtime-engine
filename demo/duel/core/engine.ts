// RealtimeEngine — transport + codec + prediction + inbound coalescing + offline outbox behind a
// drop-in WebSocket-client API, and a useSyncExternalStore-compatible store (notifies once per
// coalesced flush, only on real change, with stable per-slice identities). No React in the core.
import { MsgpackCodec, type Codec } from './codec';
import { Batcher } from './ringbuffer';
import { PredictionEngine, type PredictionMetrics } from './prediction';
import {
  applyAnswer, seqOf, initialDuelState, cloneDuelState, duelStateEqual,
  type DuelState, type AnswerInput,
} from './duel';
import { MessageType, Channels, type WsFrame } from './types';
import type { Transport } from './transport';
import type { ExternalStore } from './store';

export type DuelPhase = 'idle' | 'active' | 'ended';

export interface DuelTiming {
  startedAt: number;
  endsAt: number;
}

export interface OpponentState {
  userId?: string;
  score: number;
  questionIndex: number;
}

export interface IntegrityState {
  flagged: boolean;
  reason?: string;
}

// Authoritative snapshot broadcast on the GAME_EVENT channel.
export interface ServerSnapshot {
  gameId: string;
  t: number;
  self: DuelState;
  lastProcessedSeq: number; // reconciliation anchor
  opponent?: { userId?: string; score: number; questionIndex: number };
  integrity?: IntegrityState;
  timing?: DuelTiming;
  finished?: boolean; // time up / completed → phase 'ended'
}

// Immutable UI view. Each slice keeps a stable reference while unchanged, so slice selectors bail.
export interface EngineSnapshot {
  readonly self: DuelState;
  readonly opponent?: OpponentState;
  readonly integrity?: IntegrityState;
  readonly phase: DuelPhase;
  readonly timing?: DuelTiming;
}

export interface EngineOptions {
  transport: Transport;
  userId: string;
  codec?: Codec;
  monotonic?: () => number;
  inboundBatch?: number;
}

export interface EngineMetrics {
  bytesSent: number;
  framesSent: number;
  bytesReceived: number;
  framesReceived: number;
  publishes: number;
  prediction: PredictionMetrics;
}

type StateListener = (state: DuelState) => void;
type PhaseListener = (phase: DuelPhase) => void;

function opponentEqual(a: OpponentState | undefined, b: OpponentState | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.userId === b.userId && a.score === b.score && a.questionIndex === b.questionIndex;
}

function integrityEqual(a: IntegrityState | undefined, b: IntegrityState | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.flagged === b.flagged && a.reason === b.reason;
}

function timingEqual(a: DuelTiming | undefined, b: DuelTiming | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.startedAt === b.startedAt && a.endsAt === b.endsAt;
}

export class RealtimeEngine implements ExternalStore<EngineSnapshot> {
  readonly #t: Transport;
  readonly #codec: Codec;
  readonly #now: () => number;
  readonly #userId: string;
  readonly #pred: PredictionEngine<DuelState, AnswerInput>;
  readonly #inbound: Batcher<WsFrame>;

  #seq = 0;
  #gameId = '';
  #open = false;
  #flushScheduled = false;
  #outbox: WsFrame[] = [];
  #opponent: OpponentState | undefined;
  #integrity: IntegrityState | undefined;
  #timing: DuelTiming | undefined;
  #phase: DuelPhase = 'idle';
  #snapshot: EngineSnapshot;
  #subs = new Set<() => void>();
  #phaseListeners = new Set<PhaseListener>();
  #m = { bytesSent: 0, framesSent: 0, bytesReceived: 0, framesReceived: 0, publishes: 0 };

  constructor(opts: EngineOptions) {
    this.#t = opts.transport;
    this.#codec = opts.codec ?? MsgpackCodec;
    this.#userId = opts.userId;
    this.#now = opts.monotonic ?? (() => Date.now());
    this.#pred = new PredictionEngine<DuelState, AnswerInput>({
      initialState: initialDuelState, reduce: applyAnswer, seqOf,
      clone: cloneDuelState, equal: duelStateEqual,
    });
    this.#snapshot = { self: initialDuelState, phase: 'idle' };
    this.#inbound = new Batcher<WsFrame>(opts.inboundBatch ?? 16, (batch) => {
      for (const f of batch) this.#handle(f);
      this.#publish(); // one publish per coalesced batch, not per frame
    });

    this.#t.onMessage((bytes) => this.#onBytes(bytes));
    this.#t.onOpen(() => { this.#open = true; this.#flushOutbox(); });
    this.#t.onClose(() => { this.#open = false; });
  }

  connect(): void { this.#t.connect(); }

  close(): void {
    this.#inbound.flush();
    this.#setPhase('ended');
    this.#publish();
    this.#t.close();
  }

  joinGame(gameId: string): void {
    this.#gameId = gameId;
    this.#setPhase('active');
    this.#send({ type: MessageType.JoinChannel, channel: Channels.game(gameId) });
    this.#publish();
  }

  // useSyncExternalStore surface.
  subscribe(listener: () => void): () => void {
    this.#subs.add(listener);
    return () => { this.#subs.delete(listener); };
  }

  getSnapshot(): EngineSnapshot { return this.#snapshot; }

  // Duel-phase transitions — use to pause non-essential UI-thread work in-match.
  onPhase(cb: PhaseListener): () => void {
    this.#phaseListeners.add(cb);
    return () => { this.#phaseListeners.delete(cb); };
  }

  onState(cb: StateListener): void {
    this.#subs.add(() => cb(this.#snapshot.self));
  }

  get predicted(): DuelState { return this.#pred.predicted; }
  get opponent(): OpponentState | undefined { return this.#opponent; }
  get integrity(): IntegrityState | undefined { return this.#integrity; }
  get phase(): DuelPhase { return this.#phase; }
  get metrics(): EngineMetrics {
    return { ...this.#m, prediction: this.#pred.metrics };
  }

  // Returns the predicted state synchronously (zero felt latency); the server correction arrives via reconcile.
  submitAnswer(a: { questionId: string; submittedValue: number; correctValue: number }): DuelState {
    const input: AnswerInput = {
      seq: ++this.#seq,
      questionId: a.questionId,
      submittedValue: a.submittedValue,
      correctValue: a.correctValue,
      timeOfSubmission: this.#now(),
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
    this.#publish();
    return predicted;
  }

  #send(frame: WsFrame): void {
    if (!this.#open) { this.#outbox.push(frame); return; } // offline queue
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
    catch { return; } // drop malformed frames
    this.#inbound.add(frame);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => { this.#flushScheduled = false; this.#inbound.flush(); });
  }

  #handle(frame: WsFrame): void {
    if (typeof frame.channel === 'string' && frame.channel.startsWith('GAME_EVENT')) {
      const snap = frame.data as ServerSnapshot | undefined;
      if (snap && snap.self) {
        this.#pred.reconcile(snap.self, snap.lastProcessedSeq);
        if (snap.opponent) {
          this.#opponent = {
            userId: snap.opponent.userId,
            score: snap.opponent.score,
            questionIndex: snap.opponent.questionIndex,
          };
        }
        this.#integrity = snap.integrity;
        if (snap.timing) this.#timing = snap.timing;
        if (snap.finished || snap.integrity?.flagged) this.#setPhase('ended');
      }
    }
  }

  #setPhase(phase: DuelPhase): void {
    if (phase === this.#phase) return;
    this.#phase = phase;
    for (const l of this.#phaseListeners) l(phase);
  }

  // Rebuild the snapshot, reusing the previous reference for unchanged slices so selectors bail;
  // notify only if something changed.
  #publish(): void {
    const prev = this.#snapshot;
    const self = duelStateEqual(prev.self, this.#pred.predicted) ? prev.self : this.#pred.predicted;
    const opponent = opponentEqual(prev.opponent, this.#opponent) ? prev.opponent : this.#opponent;
    const integrity = integrityEqual(prev.integrity, this.#integrity) ? prev.integrity : this.#integrity;
    const timing = timingEqual(prev.timing, this.#timing) ? prev.timing : this.#timing;
    const phase = this.#phase;

    if (
      self === prev.self && opponent === prev.opponent && integrity === prev.integrity &&
      timing === prev.timing && phase === prev.phase
    ) {
      return;
    }

    this.#snapshot = { self, opponent, integrity, phase, timing };
    this.#m.publishes++;
    for (const s of this.#subs) s();
  }
}
