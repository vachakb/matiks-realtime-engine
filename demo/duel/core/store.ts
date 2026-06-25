// useSyncExternalStore-shaped store contract (subscribe + getSnapshot), with zero React dependency
// so the core stays framework-agnostic and Node-testable.

export interface ExternalStore<T> {
  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Current value. MUST return a stable reference while the value is unchanged (so React can bail). */
  getSnapshot(): T;
}

// Derive a memoized slice store: notifies only when selector(base) changes under isEqual
// (default Object.is), and getSnapshot returns a stable reference between changes.
export function select<T, U>(
  base: ExternalStore<T>,
  selector: (state: T) => U,
  isEqual: (a: U, b: U) => boolean = Object.is,
): ExternalStore<U> {
  // Seed eagerly so the first base notification compares against a real value (not `undefined`,
  // which would spuriously fire on the first change of any sibling slice).
  let memo: { value: U } = { value: selector(base.getSnapshot()) };

  // Recompute the slice; reuse the previous reference when equal so identity stays stable.
  const compute = (): U => {
    const next = selector(base.getSnapshot());
    if (isEqual(memo.value, next)) return memo.value;
    memo = { value: next };
    return next;
  };

  return {
    getSnapshot: compute,
    subscribe(listener: () => void): () => void {
      return base.subscribe(() => {
        const before = memo.value;
        const after = compute();
        if (!isEqual(before, after)) listener();
      });
    },
  };
}
