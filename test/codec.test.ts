import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MsgpackCodec, JsonCodec } from '../src/core/codec.ts';
import type { AnswerSubmission } from '../src/core/types.ts';

/** msgpack must losslessly round-trip every value type we put on the wire. */
test('msgpack round-trips primitives and edge integers', () => {
  const cases: unknown[] = [
    null, true, false,
    0, 1, 127, 128, 255, 256, 65535, 65536, 4294967295,
    -1, -32, -33, -128, -129, -32768, -32769, -2147483648, -2147483649,
    3.14, -0.5, Math.PI, 2 ** 40, // big ints fall back to float64 but remain exact
  ];
  for (const v of cases) {
    assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode(v)), v, `value ${String(v)}`);
  }
});

test('msgpack round-trips strings incl. unicode and long forms', () => {
  const cases = ['', 'a', 'héllo🎮', 'x'.repeat(40), 'y'.repeat(300), 'z'.repeat(70000)];
  for (const v of cases) {
    assert.equal(MsgpackCodec.decode(MsgpackCodec.encode(v)), v, `len ${v.length}`);
  }
});

test('msgpack round-trips arrays, nested objects, and binary', () => {
  assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode([])), []);
  assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode([1, 2, 3])), [1, 2, 3]);
  const nested = { a: 1, b: [2, { c: 3, d: ['e', null, true] }], f: 'g' };
  assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode(nested)), nested);
  const bin = new Uint8Array([0, 1, 2, 255, 128]);
  assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode(bin)), bin);
});

test('msgpack drops undefined object values, matching JSON semantics', () => {
  const decoded = MsgpackCodec.decode(MsgpackCodec.encode({ a: 1, b: undefined, c: 3 }));
  assert.deepEqual(decoded, { a: 1, c: 3 });
});

test('a realistic answer frame round-trips and is smaller than JSON', () => {
  const submission: AnswerSubmission = {
    gameId: '6a29576de8315b32867ee3c0',
    questionId: '6a29576de8315b32867ee3c0_7',
    submittedValue: 42,
    timeOfSubmission: 18234.5,
    userId: '6939e0b124b8cb8b709674b3',
    seq: 7,
  };
  const frame = { type: 'submitAnswerV2', channel: `GAME_EVENT_${submission.gameId}_V2`, data: submission };
  assert.deepEqual(MsgpackCodec.decode(MsgpackCodec.encode(frame)), frame);

  const jsonBytes = JsonCodec.encode(frame).length;
  const msgpackBytes = MsgpackCodec.encode(frame).length;
  assert.ok(msgpackBytes < jsonBytes, `msgpack ${msgpackBytes}B should beat json ${jsonBytes}B`);
});

test('decoding a truncated/garbage buffer throws rather than silently corrupting', () => {
  assert.throws(() => MsgpackCodec.decode(new Uint8Array([0xc1]))); // 0xc1 is the never-used prefix
});
