import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../src/core/clock.ts';

test('symmetric path with no offset yields ~0 offset and correct RTT', () => {
  const c = new ClockSync();
  // client sends @0, 50ms each way, server processes instantly
  c.addSample({ t1: 0, t2: 50, t3: 50, t4: 100 });
  assert.equal(c.offsetMs, 0);
  assert.equal(c.rttMs, 100);
});

test('recovers a known server clock offset', () => {
  const c = new ClockSync();
  // server clock is +1000ms ahead; 50ms each way
  c.addSample({ t1: 0, t2: 1050, t3: 1050, t4: 100 });
  assert.equal(c.offsetMs, 1000);
  assert.equal(c.rttMs, 100);
});

test('keeps the lowest-RTT sample and ignores a noisier one', () => {
  const c = new ClockSync();
  c.addSample({ t1: 0, t2: 1050, t3: 1050, t4: 100 });   // rtt 100, offset 1000 (good)
  c.addSample({ t1: 0, t2: 1200, t3: 1200, t4: 1000 });  // rtt 1000, offset 700 (noisy)
  assert.equal(c.rttMs, 100);
  assert.equal(c.offsetMs, 1000, 'noisy higher-RTT sample must not override the good one');
});

test('ignores bogus samples with negative RTT (clock warp)', () => {
  const c = new ClockSync();
  c.addSample({ t1: 0, t2: 50, t3: 50, t4: 100 }); // good
  c.addSample({ t1: 0, t2: 0, t3: 200, t4: 100 }); // rtt = 100 - 200 = -100 -> ignore
  assert.equal(c.rttMs, 100);
  assert.equal(c.offsetMs, 0);
});

test('serverNow is monotonic and applies offset (no Date.now)', () => {
  let mono = 1000;
  const c = new ClockSync(() => mono);
  c.addSample({ t1: 0, t2: 5050, t3: 5050, t4: 100 }); // offset 5000
  const a = c.serverNow();
  mono = 1016; // one frame later on the monotonic clock
  const b = c.serverNow();
  assert.equal(a, 6000);
  assert.equal(b, 6016);
  assert.ok(b > a, 'server time must never go backwards');
});

test('reports jitter as the spread of recent offsets', () => {
  const c = new ClockSync();
  assert.equal(c.jitterMs, 0); // no samples
  c.addSample({ t1: 0, t2: 50, t3: 50, t4: 100 });
  c.addSample({ t1: 0, t2: 60, t3: 60, t4: 100 });
  assert.ok(c.jitterMs > 0);
});
