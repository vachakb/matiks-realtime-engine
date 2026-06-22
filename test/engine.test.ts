import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeEngine, type ServerSnapshot } from '../src/core/engine.ts';
import { MockTransport } from '../src/core/transport.ts';
import { MsgpackCodec } from '../src/core/codec.ts';
import { Channels, type WsFrame } from '../src/core/types.ts';

const tick = () => Promise.resolve(); // lets the inbound-coalescing microtask run

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
