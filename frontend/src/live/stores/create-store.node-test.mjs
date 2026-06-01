import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./create-store.js";

test("get returns initial value", () => {
  const s = createStore(1);
  assert.equal(s.get(), 1);
});

test("set with value updates and notifies", () => {
  const s = createStore(0);
  let seen = 0;
  s.subscribe(() => { seen = s.get(); });
  s.set(5);
  assert.equal(s.get(), 5);
  assert.equal(seen, 5);
});

test("set with updater fn receives prev", () => {
  const s = createStore(2);
  s.set((p) => p + 3);
  assert.equal(s.get(), 5);
});

test("unsubscribe stops notifications", () => {
  const s = createStore(0);
  let calls = 0;
  const off = s.subscribe(() => { calls += 1; });
  s.set(1);
  off();
  s.set(2);
  assert.equal(calls, 1);
});
