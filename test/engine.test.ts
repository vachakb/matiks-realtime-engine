import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeEngine, type ServerSnapshot, type DuelPhase } from '../src/core/engine.ts';
import { MockTransport } from '../src/core/transport.ts';
import { MsgpackCodec } from '../src/core/codec.ts';
import { Channels, type WsFrame } from '../src/core/types.ts';
import { select } from '../src/core/store.ts';

const tick = () => Promise.resolve(); // lets the inbound-coalescing microtask run

const gameFrame = (gameId: string, snap: ServerSnapshot) =>
  MsgpackCodec.encode({ type: 'game_event', channel: Channels.game(gameId), data: snap });

test('submitAnswer returns the predicted state synchronously and emits a submitAnswerV2 frame', () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');

  const s = e.submitAnswer({ questionId: 'g1_0', submittedValue: 5, correctValue: 5 });
  assert.equal(s.score, 4, 'optimistic score is available immediately, no await');

  const frames = mt.sent.map((b) => MsgpackCodec.decode(b) as WsFrame);
  const submit = frames.find((f) => f.type === 'submitAnswerV2');
  assert.ok(submit, 'a submitAnswerV2 frame was sent');
  assert.equal((submit!.data as { seq: number }).seq, 1);
});

test('offline outbox: frames queued before connect flush on open (mirrors Matiks today)', () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.joinGame('g1'); // before connect
  assert.equal(mt.sent.length, 0, 'nothing sent while closed');
  e.connect();
  assert.ok(mt.sent.length >= 1, 'queued frame flushed on open');
});

test('reconciles against an authoritative server snapshot and emits corrected state', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');
  e.submitAnswer({ questionId: 'g1_0', submittedValue: 5, correctValue: 5 }); // predicts +4

  let emitted: number | undefined;
  e.onState((st) => { emitted = st.score; });

  // Server rejected it (authoritative) — score stays 0.
  const snap: ServerSnapshot = { gameId: 'g1', t: 1000, self: { score: 0, questionIndex: 1, answered: { g1_0: false } }, lastProcessedSeq: 1 };
  mt.deliver(MsgpackCodec.encode({ type: 'game_event', channel: Channels.game('g1'), data: snap }));
  await tick();

  assert.equal(e.predicted.score, 0, 'reconciled to authoritative truth');
  assert.equal(e.metrics.prediction.rollbacks, 1);
  assert.equal(emitted, 0, 'listener received the corrected state');
});

test('malformed inbound bytes are dropped, never crash the engine', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  assert.doesNotThrow(() => mt.deliver(new Uint8Array([0xc1]))); // 0xc1 = invalid msgpack prefix
  await tick();
  assert.ok(e.metrics.framesReceived >= 1, 'still counted, but handled safely');
  assert.equal(e.predicted.score, 0);
});

test('multiple inbound frames in one tick coalesce into a single processing pass', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');
  for (let i = 0; i < 5; i++) {
    const snap: ServerSnapshot = { gameId: 'g1', t: i, self: { score: i, questionIndex: i, answered: {} }, lastProcessedSeq: i };
    mt.deliver(MsgpackCodec.encode({ type: 'game_event', channel: Channels.game('g1'), data: snap }));
  }
  await tick();
  assert.equal(e.predicted.score, 4, 'last snapshot wins after coalesced batch');
  assert.equal(e.metrics.framesReceived, 5);
});

test('store: a burst of inbound frames triggers exactly ONE publish (one re-render), not one per frame', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');
  const before = e.metrics.publishes;
  for (let i = 0; i < 5; i++) {
    mt.deliver(gameFrame('g1', { gameId: 'g1', t: i, self: { score: i, questionIndex: i, answered: {} }, lastProcessedSeq: i }));
  }
  await tick();
  assert.equal(e.metrics.publishes - before, 1, '5 coalesced frames → a single store notification');
  assert.equal(e.predicted.score, 4);
});

test('store: unchanged slices keep stable identity across publishes (selectors bail out)', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');

  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 1, self: { score: 0, questionIndex: 0, answered: {} }, lastProcessedSeq: 0, opponent: { score: 2, questionIndex: 1 } }));
  await tick();
  const a = e.getSnapshot();

  // self changes; opponent is byte-for-byte the same.
  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 2, self: { score: 4, questionIndex: 1, answered: { g1_0: true } }, lastProcessedSeq: 0, opponent: { score: 2, questionIndex: 1 } }));
  await tick();
  const b = e.getSnapshot();

  assert.notEqual(b, a, 'top-level snapshot identity changed');
  assert.notEqual(b.self, a.self, 'self changed identity (its consumers re-render)');
  assert.equal(b.opponent, a.opponent, 'opponent identity reused → its panel does NOT re-render');
});

test('store: a slice selector fires only when its own slice changes', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');
  const scoreSlice = select(e, (s) => s.self.score);
  let fires = 0;
  scoreSlice.subscribe(() => fires++);

  // opponent-only change → score selector must stay quiet
  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 1, self: { score: 0, questionIndex: 0, answered: {} }, lastProcessedSeq: 0, opponent: { score: 1, questionIndex: 0 } }));
  await tick();
  assert.equal(fires, 0, 'opponent change did not fire the score selector');

  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 2, self: { score: 8, questionIndex: 1, answered: {} }, lastProcessedSeq: 0 }));
  await tick();
  assert.equal(fires, 1, 'score change fired the selector exactly once');
});

test('phase: idle → active on join → ended on bot flag; onPhase fires once per transition', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  const seen: DuelPhase[] = [];
  e.onPhase((p) => seen.push(p));
  assert.equal(e.phase, 'idle');
  e.connect();
  e.joinGame('g1');
  assert.equal(e.phase, 'active');

  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 1, self: { score: 0, questionIndex: 1, answered: {} }, lastProcessedSeq: 1, integrity: { flagged: true, reason: 'superhuman cadence' } }));
  await tick();
  assert.equal(e.phase, 'ended');
  assert.deepEqual(seen, ['active', 'ended'], 'each transition emitted exactly once');
});

test('store: the match deadline is surfaced for native-driver countdowns', async () => {
  const mt = new MockTransport();
  const e = new RealtimeEngine({ transport: mt, userId: 'u1' });
  e.connect();
  e.joinGame('g1');
  mt.deliver(gameFrame('g1', { gameId: 'g1', t: 1, self: { score: 0, questionIndex: 0, answered: {} }, lastProcessedSeq: 0, timing: { startedAt: 1000, endsAt: 31000 } }));
  await tick();
  assert.deepEqual(e.getSnapshot().timing, { startedAt: 1000, endsAt: 31000 });
});
