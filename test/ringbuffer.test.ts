import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer, Batcher } from '../src/core/ringbuffer.ts';

test('FIFO order and size accounting', () => {
  const rb = new RingBuffer<number>(4);
  assert.ok(rb.isEmpty);
  rb.push(1); rb.push(2); rb.push(3);
  assert.equal(rb.size, 3);
  assert.equal(rb.peek(), 1);
  assert.equal(rb.shift(), 1);
  assert.equal(rb.shift(), 2);
  assert.deepEqual(rb.toArray(), [3]);
});

test('drop-oldest overflow policy returns the evicted item', () => {
  const rb = new RingBuffer<number>(3);
  rb.push(1); rb.push(2); rb.push(3);
  assert.ok(rb.isFull);
  const dropped = rb.push(4); // evicts 1
  assert.equal(dropped, 1);
  assert.equal(rb.size, 3);
  assert.deepEqual(rb.toArray(), [2, 3, 4]);
});

test('wraps around correctly under interleaved push/shift', () => {
  const rb = new RingBuffer<number>(3);
  rb.push(1); rb.push(2); rb.shift(); // head moves
  rb.push(3); rb.push(4);             // wrap into freed slot
  assert.deepEqual(rb.toArray(), [2, 3, 4]);
  assert.equal(rb.shift(), 2);
  assert.equal(rb.shift(), 3);
  assert.equal(rb.shift(), 4);
  assert.equal(rb.shift(), undefined);
});

test('capacity < 1 is rejected', () => {
  assert.throws(() => new RingBuffer<number>(0));
});

test('Batcher flushes at threshold, preserving order', () => {
  const batches: number[][] = [];
  const b = new Batcher<number>(3, (batch) => batches.push(batch));
  b.add(1); b.add(2);
  assert.equal(b.pending, 2);
  assert.equal(batches.length, 0);
  b.add(3); // hits threshold -> flush
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [1, 2, 3]);
  assert.equal(b.pending, 0);
});

test('Batcher manual flush drains remainder; empty flush is a no-op', () => {
  const batches: number[][] = [];
  const b = new Batcher<number>(10, (batch) => batches.push(batch));
  b.add(1); b.add(2);
  b.flush();
  assert.deepEqual(batches, [[1, 2]]);
  b.flush(); // nothing pending
  assert.equal(batches.length, 1);
});
