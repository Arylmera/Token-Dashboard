import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatcher } from "./batch.js";

// Manual scheduler: captures the callback so the test drives the tick.
function manualScheduler() {
  let pending = null;
  const schedule = (cb) => { pending = cb; };
  const tick = () => { const cb = pending; pending = null; cb?.(); };
  const isPending = () => pending !== null;
  return { schedule, tick, isPending };
}

test("createBatcher: does not flush before the tick", () => {
  const s = manualScheduler();
  const flushes = [];
  const push = createBatcher((items) => flushes.push(items), s.schedule);
  push(1);
  push(2);
  assert.equal(flushes.length, 0);
});

test("createBatcher: flushes all queued items in one call, in order", () => {
  const s = manualScheduler();
  const flushes = [];
  const push = createBatcher((items) => flushes.push(items), s.schedule);
  push(1); push(2); push(3);
  s.tick();
  assert.equal(flushes.length, 1, "three pushes must produce exactly one flush");
  assert.deepEqual(flushes[0], [1, 2, 3]);
});

test("createBatcher: schedules only once per batch", () => {
  let scheduleCalls = 0;
  let pending = null;
  const schedule = (cb) => { scheduleCalls++; pending = cb; };
  const push = createBatcher(() => {}, schedule);
  push("a"); push("b"); push("c");
  assert.equal(scheduleCalls, 1);
  pending();
  push("d");
  assert.equal(scheduleCalls, 2, "a push after the flush must schedule a fresh tick");
});

test("createBatcher: a flush that throws still clears the queue", () => {
  const s = manualScheduler();
  let calls = 0;
  const push = createBatcher(() => { calls++; throw new Error("boom"); }, s.schedule);
  push(1);
  assert.throws(() => s.tick());
  push(2);
  // This flush throws too — what is under test is that a second batch was
  // scheduled and reached the flush at all, not that it stopped throwing.
  assert.throws(() => s.tick());
  assert.equal(calls, 2, "the batcher must keep working after a throwing flush");
});
