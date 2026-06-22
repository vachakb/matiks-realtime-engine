import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RealtimeEngine } from '../src/core/engine.ts';
import { Loopback } from '../src/sim/loopback.ts';
import { MockMatiksServer } from '../src/sim/server.ts';
import { makeQuestions } from '../src/sim/questions.ts';

// Drain microtasks + 0ms timers so queued snapshots reconcile.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setup(opts: { latencyMs?: number; minHumanMs?: number; anomalyStreak?: number } = {}) {
  const clock = { t: 1000 };
  const now = () => clock.t;
  const link = new Loopback({ latencyMs: opts.latencyMs ?? 0 });
  const gameId = 'g1';
  const qs = makeQuestions(gameId, 10);
  const server = new MockMatiksServer({
    link, gameId, userId: 'me', questionCount: 10, now,
    opponentIntervalMs: 1_000_000, // opponent idle unless explicitly ticked
    minHumanMs: opts.minHumanMs ?? 350,
    anomalyStreak: opts.anomalyStreak ?? 3,
  });
  server.start();
  const engine = new RealtimeEngine({ transport: link.clientTransport, userId: 'me', monotonic: now });
  engine.connect();
  engine.joinGame(gameId);
  return { clock, engine, server, qs };
}

test('sim: makeQuestions is deterministic (client & server agree without shipping answers)', () => {
  assert.deepEqual(makeQuestions('g1', 5), makeQuestions('g1', 5));
  assert.notDeepEqual(makeQuestions('g1', 5), makeQuestions('g2', 5));
});

test('sim: honest play — predicted score matches the authoritative server', async () => {
  const { clock, engine, server, qs } = setup();
  for (let i = 0; i < 5; i++) {
    engine.submitAnswer({ questionId: qs[i].questionId, submittedValue: qs[i].answer, correctValue: qs[i].answer });
    clock.t += 1500; // human pace, so the anomaly detector stays quiet
  }
  await flush();
  assert.equal(engine.predicted.score, 20); // 5 correct × 4
  assert.equal(server.selfState.score, 20);
  assert.equal(engine.integrity?.flagged ?? false, false);
});

test('sim: prediction is synchronous — instant feel, before any round-trip', () => {
  const { engine, qs } = setup({ latencyMs: 50 });
  const s = engine.submitAnswer({ questionId: qs[0].questionId, submittedValue: qs[0].answer, correctValue: qs[0].answer });
  assert.equal(s.score, 4, 'score updates the moment you answer, not after the server replies');
});

test('sim: reconciliation — an over-optimistic prediction is corrected to the server snapshot', async () => {
  const { engine, server, qs } = setup();
  const wrong = qs[0].answer + 1;
  // Client submits a wrong value but optimistically claims it correct (correctValue = its own value).
  const predicted = engine.submitAnswer({ questionId: qs[0].questionId, submittedValue: wrong, correctValue: wrong });
  assert.equal(predicted.score, 4, 'optimistic score inflates locally');
  await flush();
  assert.equal(server.selfState.score, 0, 'server scored it against its OWN key');
  assert.equal(engine.predicted.score, 0, 'client reconciled down to the authoritative truth');
});

test('sim: integrity — a bot at superhuman cadence is flagged and its score voided', async () => {
  const { clock, engine, server, qs } = setup({ minHumanMs: 350, anomalyStreak: 3 });
  for (let i = 0; i < 4; i++) {
    engine.submitAnswer({ questionId: qs[i].questionId, submittedValue: qs[i].answer, correctValue: qs[i].answer });
    clock.t += 50; // 50ms between answers — no human does that
  }
  await flush();
  assert.equal(server.isFlagged, true, 'server caught the cadence');
  assert.equal(engine.integrity?.flagged, true, 'client learns it via the snapshot');
  assert.equal(engine.predicted.score, 0, 'flagged ⇒ authoritative score voided ⇒ visible rollback');
});

test('sim: honest human cadence is NOT flagged', async () => {
  const { clock, engine, qs } = setup({ minHumanMs: 350, anomalyStreak: 3 });
  for (let i = 0; i < 4; i++) {
    engine.submitAnswer({ questionId: qs[i].questionId, submittedValue: qs[i].answer, correctValue: qs[i].answer });
    clock.t += 1200; // human pace
  }
  await flush();
  assert.equal(engine.integrity?.flagged ?? false, false);
  assert.equal(engine.predicted.score, 16);
});
