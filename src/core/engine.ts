/**
 * RealtimeEngine — transport + codec + prediction + inbound coalescing + offline outbox behind a
 * drop-in WebSocket-client API. Also a `useSyncExternalStore`-compatible store: notifies once per
 * coalesced flush and only on real change (stable per-slice identities), and exposes the match
 * deadline and duel phase. No React dependency in the core.
 */
import { MsgpackCodec, type Codec } from './codec.ts';
import { Batcher } from './ringbuffer.ts';
import { PredictionEngine, type PredictionMetrics } from './prediction.ts';
import {
  applyAnswer, seqOf, initialDuelState, cloneDuelState, duelStateEqual,
  type DuelState, type AnswerInput,
} from './duel.ts';
import { MessageType, Channels, type WsFrame } from './types.ts';
import type { Transport } from './transport.ts';
import type { ExternalStore } from './store.ts';

/** Lifecycle of a duel from the client's point of view. */
export type DuelPhase = 'idle' | 'active' | 'ended';

/** Absolute match-window timing (engine clock, ms). Lets the UI animate the countdown natively. */
export interface DuelTiming {
  startedAt: number;
  endsAt: number;
}

/** The opponent slice, kept as its own object so its identity is stable while it's unchanged. */
export interface OpponentState {
  userId?: string;
  score: number;
  questionIndex: number;
}

/** Behavioral/cadence verdict from the server (bot detection). */
export interface IntegrityState {
  flagged: boolean;
  reason?: string;
}

/** Authoritative snapshot the server broadcasts on the GAME_EVENT channel. */
export interface ServerSnapshot {
  gameId: string;
  /** server time (ms) of this snapshot — used for opponent interpolation. */
  t: number;
  /** authoritative duel state for THIS user (in production, projected from the leaderboard). */
  self: DuelState;
  /** last input seq the server processed for us — the reconciliation anchor. */
  lastProcessedSeq: number;
  opponent?: { userId?: string; score: number; questionIndex: number };
  /** Behavioral/cadence verdict from the server (bot detection). Absent = clean. */
  integrity?: IntegrityState;
  /** Absolute match window — surfaced so the UI can animate the countdown off the JS thread. */
  timing?: DuelTiming;
  /** Server says the match is over (time up / completed). Drives `phase: 'ended'`. */
  finished?: boolean;
}

/**
 * An immutable view of everything the UI renders. Each slice keeps a STABLE reference while its
 * value is unchanged, so `useSyncExternalStore(engine.subscribe, () => engine.getSnapshot().X)`
 * re-renders only the components that read the slice that actually changed.
 */
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
  /** wire codec; defaults to binary (msgpack). Pass JsonCodec to A/B against today's path. */
  codec?: Codec;
  /** clock source for the answer timestamp (defaults to Date.now). */
  monotonic?: () => number;
  /** max inbound frames coalesced before a forced flush (also flushed each microtask). */
  inboundBatch?: number;
}

export interface EngineMetrics {
  bytesSent: number;
  framesSent: number;
  bytesReceived: number;
  framesReceived: number;
  /** Store notifications actually delivered to subscribers — i.e. real re-render triggers. */
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
    // Duel-specific clone/equal (instead of structuredClone + JSON.stringify) — the GC fix.
    this.#pred = new PredictionEngine<DuelState, AnswerInput>({
      initialState: initialDuelState, reduce: applyAnswer, seqOf,
      clone: cloneDuelState, equal: duelStateEqual,
    });
    this.#snapshot = { self: initialDuelState, phase: 'idle' };
    // One #publish() per coalesced batch (not per frame): the docs' "batch N packets into one
    // JS dispatch per tick" applied to the React commit, not just the decode.
    this.#inbound = new Batcher<WsFrame>(opts.inboundBatch ?? 16, (batch) => {
      for (const f of batch) this.#handle(f);
      this.#publish();
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

  // ---- store surface (useSyncExternalStore-compatible) ----

  /** Subscribe to ANY change. Returns an unsubscribe fn. Pair with `getSnapshot` + a selector. */
  subscribe(listener: () => void): () => void {
    this.#subs.add(listener);
    return () => { this.#subs.delete(listener); };
  }

  /** Current immutable view. Stable reference (and stable per-slice references) until something changes. */
  getSnapshot(): EngineSnapshot { return this.#snapshot; }

  /** Duel-phase transitions ('active' → 'ended'). Use to pause non-essential UI-thread work in-match. */
  onPhase(cb: PhaseListener): () => void {
    this.#phaseListeners.add(cb);
    return () => { this.#phaseListeners.delete(cb); };
  }

  /** Back-compat convenience: fires with the `self` duel state whenever it changes. */
  onState(cb: StateListener): void {
    this.#subs.add(() => cb(this.#snapshot.self));
  }

  get predicted(): DuelState { return this.#pred.predicted; }
  get opponent(): OpponentState | undefined { return this.#opponent; }
  /** Latest server behavioral verdict — `{flagged:true,reason}` when the server caught a bot. */
  get integrity(): IntegrityState | undefined { return this.#integrity; }
  get phase(): DuelPhase { return this.#phase; }
  get metrics(): EngineMetrics {
    return { ...this.#m, prediction: this.#pred.metrics };
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

  /**
   * Rebuild the snapshot from current state, REUSING the previous reference for any slice that
   * didn't change (so `Object.is` selectors bail out), and notify subscribers only if anything
   * changed. This is the whole-tree-re-render fix: one notification, minimal slice churn.
   */
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
      return; // nothing changed — no new snapshot, no notification, no re-render
    }

    this.#snapshot = { self, opponent, integrity, phase, timing };
    this.#m.publishes++;
    for (const s of this.#subs) s();
  }
}
