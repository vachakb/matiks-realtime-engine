import { test } from 'node:test';
import assert from 'node:assert/strict';
import { select, type ExternalStore } from '../src/core/store.ts';

/** A tiny mutable base store for exercising select() in isolation. */
function makeStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  const store: ExternalStore<T> = {
    subscribe(l) { subs.add(l); return () => subs.delete(l); },
    getSnapshot() { return value; },
  };
  return { store, set: (v: T) => { value = v; for (const s of subs) s(); } };
}

test('select: getSnapshot keeps a stable reference until the slice changes', () => {
  const { store, set } = makeStore({ a: 1, b: 1 });
  const a = select(store, (s) => s.a);
  assert.equal(a.getSnapshot(), 1);
  set({ a: 1, b: 2 });            // sibling slice changed, `a` did not
  assert.equal(a.getSnapshot(), 1);
});

test('select: notifies only when the SELECTED slice changes', () => {
  const { store, set } = makeStore({ a: 1, b: 1 });
  const a = select(store, (s) => s.a);
  let fires = 0;
  a.subscribe(() => fires++);
  set({ a: 1, b: 2 });            // b changed → score selector must stay quiet
  assert.equal(fires, 0, 'sibling-only change did not fire the selector');
  set({ a: 2, b: 2 });            // a changed → fire once
  assert.equal(fires, 1);
});

test('select: object slice with custom isEqual stays identity-stable across equal values', () => {
  const shallowScore = (x: { score: number }, y: { score: number }) => x.score === y.score;
  const { store, set } = makeStore({ p: { score: 0 }, q: 0 });
  const p = select(store, (s) => s.p, shallowScore);
  const first = p.getSnapshot();
  set({ p: { score: 0 }, q: 1 }); // brand-new object, same score → treated as unchanged
  assert.equal(p.getSnapshot(), first, 'identity reused → consumer can bail out of re-render');
  set({ p: { score: 9 }, q: 1 });
  assert.notEqual(p.getSnapshot(), first);
  assert.equal(p.getSnapshot().score, 9);
});

test('select: unsubscribe stops notifications', () => {
  const { store, set } = makeStore({ a: 0 });
  const a = select(store, (s) => s.a);
  let fires = 0;
  const off = a.subscribe(() => fires++);
  set({ a: 1 });
  off();
  set({ a: 2 });
  assert.equal(fires, 1, 'no notification after unsubscribe');
});
