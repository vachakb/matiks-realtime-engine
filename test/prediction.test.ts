import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionEngine } from '../src/core/prediction.ts';
import { applyAnswer, seqOf, initialDuelState, type DuelState, type AnswerInput } from '../src/core/duel.ts';

const mk = (seq: number, qid: string, val: number, correct: number): AnswerInput => ({
  seq, questionId: qid, submittedValue: val, correctValue: correct, timeOfSubmission: seq * 1000,
});

const newEngine = () =>
  new PredictionEngine<DuelState, AnswerInput>({ initialState: initialDuelState, reduce: applyAnswer, seqOf });

/** A faithful "server": runs the SAME reducer over the inputs it has processed. */
const serverState = (inputs: AnswerInput[]): DuelState =>
  inputs.reduce<DuelState>((s, i) => applyAnswer(s, i), initialDuelState);

test('submit applies optimistically and returns the predicted state instantly', () => {
  const e = newEngine();
  const s = e.submit(mk(1, 'g_0', 5, 5)); // correct
  assert.equal(s.score, 4);
  assert.equal(s.questionIndex, 1);
  assert.equal(e.pendingCount, 1);
});

test('correct prediction: server agrees -> no rollback, pending cleared', () => {
  const e = newEngine();
  const inputs = [mk(1, 'g_0', 5, 5), mk(2, 'g_1', 3, 7)]; // one right, one wrong
  inputs.forEach((i) => e.submit(i));
  assert.equal(e.predicted.score, 4);

  const r = e.reconcile(serverState(inputs), 2);
  assert.equal(r.rolledBack, false);
  assert.equal(e.pendingCount, 0);
  assert.deepEqual(e.predicted, serverState(inputs));
  assert.equal(e.metrics.rollbacks, 0);
});

test('anti-cheat override: server rejects an answer we predicted correct -> rollback', () => {
  const e = newEngine();
  e.submit(mk(1, 'g_0', 5, 5)); // client predicts +4
  assert.equal(e.predicted.score, 4);

  // Server is authoritative and rejected it (e.g. impossible speed) -> score stays 0.
  const authoritative: DuelState = { score: 0, questionIndex: 1, answered: { g_0: false } };
  const r = e.reconcile(authoritative, 1);
  assert.equal(r.rolledBack, true);
  assert.equal(e.predicted.score, 0);
  assert.equal(e.metrics.rollbacks, 1);
});

test('partial ack: unacked inputs are replayed on top of the snapshot', () => {
  const e = newEngine();
  const inputs = [mk(1, 'g_0', 5, 5), mk(2, 'g_1', 9, 9), mk(3, 'g_2', 1, 1)];
  inputs.forEach((i) => e.submit(i));
  assert.equal(e.predicted.score, 12);

  // Server has only processed seq 1 so far.
  const r = e.reconcile(serverState(inputs.slice(0, 1)), 1);
  assert.equal(r.rolledBack, false, 'replay should reproduce the same prediction');
  assert.equal(r.replayed, 2, 'seq 2 and 3 are still pending');
  assert.equal(e.pendingCount, 2);
  assert.equal(e.predicted.score, 12);
});

test('stale / out-of-order snapshot is ignored', () => {
  const e = newEngine();
  const inputs = [mk(1, 'g_0', 5, 5), mk(2, 'g_1', 9, 9)];
  inputs.forEach((i) => e.submit(i));
  e.reconcile(serverState(inputs), 2); // ack up to 2
  const before = e.predicted;

  const r = e.reconcile(serverState(inputs.slice(0, 1)), 1); // older snapshot
  assert.equal(r.rolledBack, false);
  assert.equal(r.replayed, 0);
  assert.deepEqual(e.predicted, before, 'newer prediction must survive a stale snapshot');
});

test('duplicate ack (same seq) is idempotent', () => {
  const e = newEngine();
  e.submit(mk(1, 'g_0', 5, 5));
  const a = e.reconcile(serverState([mk(1, 'g_0', 5, 5)]), 1);
  const b = e.reconcile(serverState([mk(1, 'g_0', 5, 5)]), 1);
  assert.equal(a.rolledBack, false);
  assert.equal(b.rolledBack, false);
  assert.equal(e.pendingCount, 0);
});

test('reconnection mid-flight: many pending, snapshot rebases + replays the tail', () => {
  const e = newEngine();
  const inputs = [1, 2, 3, 4, 5].map((n) => mk(n, `g_${n}`, n, n)); // all correct
  inputs.forEach((i) => e.submit(i));
  assert.equal(e.predicted.score, 20);

  const r = e.reconcile(serverState(inputs.slice(0, 3)), 3); // server got first 3
  assert.equal(e.pendingCount, 2);
  assert.equal(r.replayed, 2);
  assert.deepEqual(e.predicted, serverState(inputs), 'rebased+replayed equals full server truth');
});

test('reducer is idempotent per question (no double counting on replay)', () => {
  const e = newEngine();
  e.submit(mk(1, 'g_0', 5, 5));
  const dupScore = e.submit(mk(2, 'g_0', 5, 5)).score; // same question id
  assert.equal(dupScore, 4, 'answering the same question twice must not double-score');
});
