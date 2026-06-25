/**
 * A minimal external-store contract — deliberately the exact shape React's `useSyncExternalStore`
 * expects (`subscribe(listener) => unsubscribe` + `getSnapshot()`), but with ZERO React
 * dependency so the core stays framework-agnostic and Node-testable. The native/web shims and
 * the RN app wire it to `useSyncExternalStore`; the tests wire it to a plain function.
 *
 * Why this exists: the duel trace showed the whole screen re-mounting on every state change
 * (Fabric `MountItemDispatcher` / 800ms `traversal` on the UI thread). The RN docs' fix is
 * slice subscriptions — "a component only re-renders if the slice it selected changed"
 * (state-management.md). `select()` is that primitive: it memoizes a derived slice and only
 * notifies when the slice actually changes, so a score update never re-renders the choices grid.
 */

export interface ExternalStore<T> {
  /** Register a listener; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Current value. MUST return a stable reference while the value is unchanged (so React can bail). */
  getSnapshot(): T;
}

/**
 * Derive a memoized slice store from a base store. The returned store only notifies its listeners
 * when `selector(base)` changes under `isEqual` (default `Object.is`), and `getSnapshot()` returns
 * a stable reference between changes — both required for a safe `useSyncExternalStore` selector.
 *
 *   const score = select(engine, s => s.self.score);          // primitive slice
 *   const opp   = select(engine, s => s.opponent, shallowEq);  // object slice
 */
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
