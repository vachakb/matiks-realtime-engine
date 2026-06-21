/**
 * Client-side prediction + server reconciliation (the Gabriel Gambetta / Valve model).
 *
 * The flow:
 *   1. The player makes an input (an answer). We apply it OPTIMISTICALLY to a local
 *      "predicted" state and show it instantly — zero perceived latency.
 *   2. The input is sent to the server, tagged with a monotonically increasing `seq`.
 *   3. The server is authoritative. When it broadcasts a snapshot, it includes the last
 *      input `seq` it has processed for us.
 *   4. We rebase onto that authoritative snapshot and REPLAY any still-unacked inputs.
 *      If the replayed result differs from what we were showing, that's a visible
 *      correction (a rollback) — which, for a math duel, should be near-zero because
 *      answer correctness is deterministic and known on the client.
 *
 * This is what lets Matiks go server-authoritative (closing the bot-cheating hole) WITHOUT
 * adding felt latency. The engine here is generic; the duel reducer lives in `duel.ts`.
 */

export interface PredictionOptions<S, I> {
  initialState: S;
  /** Pure reducer — MUST NOT mutate `state`. */
  reduce: (state: S, input: I) => S;
  /** Extract the sequence number of an input. */
  seqOf: (input: I) => number;
  /** Deep clone of state before replay (defaults to structuredClone). */
  clone?: (s: S) => S;
  /** Equality used to detect a visible correction (defaults to structural JSON compare). */
  equal?: (a: S, b: S) => boolean;
}

export interface ReconcileResult<S> {
  state: S;
  /** True if the authoritative truth differed from what we were optimistically showing. */
  rolledBack: boolean;
  /** How many unacked inputs were replayed on top of the snapshot. */
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

  /** The optimistic state to render right now. */
  get predicted(): S { return this.#predicted; }
  /** The last authoritative state from the server. */
  get confirmed(): S { return this.#confirmed; }
  get pendingCount(): number { return this.#pending.length; }
  get metrics(): PredictionMetrics { return { ...this.#stats }; }

  /** Optimistically apply an input and return the new predicted state immediately. */
  submit(input: I): S {
    this.#pending.push(input);
    this.#predicted = this.#reduce(this.#predicted, input);
    this.#stats.submits++;
    return this.#predicted;
  }

  /** Apply an authoritative snapshot; rebase + replay unacked inputs. */
  reconcile(authoritative: S, lastProcessedSeq: number): ReconcileResult<S> {
    if (lastProcessedSeq < this.#lastAckSeq) {
      // Stale / out-of-order snapshot — keep our newer prediction.
      return { state: this.#predicted, rolledBack: false, replayed: 0 };
    }
    this.#lastAckSeq = lastProcessedSeq;
    this.#confirmed = authoritative;
    this.#pending = this.#pending.filter((i) => this.#seqOf(i) > lastProcessedSeq);

    let next = this.#clone(authoritative);
    for (const input of this.#pending) next = this.#reduce(next, input);

    const rolledBack = !this.#equal(next, this.#predicted);
    this.#predicted = next;
    this.#stats.reconciliations++;
    this.#stats.replays += this.#pending.length;
    if (rolledBack) this.#stats.rollbacks++;

    return { state: next, rolledBack, replayed: this.#pending.length };
  }
}
