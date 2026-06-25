// Client-side prediction + server reconciliation (Gambetta/Valve): apply inputs optimistically,
// rebase onto the authoritative snapshot, replay unacked inputs. Generic; the duel reducer is in duel.ts.

export interface PredictionOptions<S, I> {
  initialState: S;
  reduce: (state: S, input: I) => S; // must not mutate state
  seqOf: (input: I) => number;
  clone?: (s: S) => S;               // defaults to structuredClone
  equal?: (a: S, b: S) => boolean;   // detects a visible rollback; defaults to JSON compare
}

export interface ReconcileResult<S> {
  state: S;
  rolledBack: boolean;
  replayed: number;
}

export interface PredictionMetrics {
  submits: number;
  reconciliations: number;
  rollbacks: number;
  replays: number;
}

export class PredictionEngine<S, I> {
  readonly #reduce: (s: S, i: I) => S;
  readonly #seqOf: (i: I) => number;
  readonly #clone: (s: S) => S;
  readonly #equal: (a: S, b: S) => boolean;

  #confirmed: S;
  #predicted: S;
  #pending: I[] = [];
  #lastAckSeq = -Infinity;
  #stats: PredictionMetrics = { submits: 0, reconciliations: 0, rollbacks: 0, replays: 0 };

  constructor(opts: PredictionOptions<S, I>) {
    this.#reduce = opts.reduce;
    this.#seqOf = opts.seqOf;
    this.#clone = opts.clone ?? ((s) => structuredClone(s));
    this.#equal = opts.equal ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b));
    this.#confirmed = opts.initialState;
    this.#predicted = opts.initialState;
  }

  get predicted(): S { return this.#predicted; }
  get confirmed(): S { return this.#confirmed; }
  get pendingCount(): number { return this.#pending.length; }
  get metrics(): PredictionMetrics { return { ...this.#stats }; }

  submit(input: I): S {
    this.#pending.push(input);
    this.#predicted = this.#reduce(this.#predicted, input);
    this.#stats.submits++;
    return this.#predicted;
  }

  reconcile(authoritative: S, lastProcessedSeq: number): ReconcileResult<S> {
    if (lastProcessedSeq < this.#lastAckSeq) {
      return { state: this.#predicted, rolledBack: false, replayed: 0 }; // stale / out-of-order
    }
    this.#lastAckSeq = lastProcessedSeq;
    this.#confirmed = authoritative;
    this.#pending = this.#pending.filter((i) => this.#seqOf(i) > lastProcessedSeq);

    // Fast path: nothing unacked → adopt the snapshot without clone/replay. Safe: reduce never mutates.
    let next: S;
    if (this.#pending.length === 0) {
      next = authoritative;
    } else {
      next = this.#clone(authoritative);
      for (const input of this.#pending) next = this.#reduce(next, input);
    }

    const rolledBack = !this.#equal(next, this.#predicted);
    this.#predicted = next;
    this.#stats.reconciliations++;
    this.#stats.replays += this.#pending.length;
    if (rolledBack) this.#stats.rollbacks++;

    return { state: next, rolledBack, replayed: this.#pending.length };
  }
}
