import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWatch, sessionsStore, clearSession } from "./session-store.js";
import { MAX_TURN_CHARS } from "../lib/truncate.js";

const SID = "trunc-1";

function turnEvent(text, sessionId = SID) {
  return {
    type: "session",
    data: {
      sessionId,
      project: "p",
      repo: null,
      agentRef: "master",
      event: { kind: "turn", data: { role: "assistant", text } },
    },
  };
}

test("applyWatch: stores over-cap turn text truncated", () => {
  clearSession(SID);
  applyWatch(turnEvent("y".repeat(MAX_TURN_CHARS + 1000)));
  const line = sessionsStore.get().get(SID).lines.at(-1);
  assert.ok(line.text.length < MAX_TURN_CHARS + 60, `retained ${line.text.length} chars`);
});

test("applyWatch: stores under-cap turn text verbatim", () => {
  clearSession(SID);
  applyWatch(turnEvent("short"));
  assert.equal(sessionsStore.get().get(SID).lines.at(-1).text, "short");
});

import { applyWatchBatch } from "./session-store.js";

test("applyWatchBatch: one notification for many events", () => {
  const sid = "batch-1";
  clearSession(sid);
  let notifications = 0;
  const unsub = sessionsStore.subscribe(() => { notifications++; });
  applyWatchBatch([
    turnEvent("a", sid),
    turnEvent("b", sid),
    turnEvent("c", sid),
  ]);
  unsub();
  assert.equal(notifications, 1, "three events must commit once, not three times");
  assert.deepEqual(sessionsStore.get().get(sid).lines.map((l) => l.text), ["a", "b", "c"]);
});

test("applyWatchBatch: an empty batch commits nothing", () => {
  let notifications = 0;
  const unsub = sessionsStore.subscribe(() => { notifications++; });
  applyWatchBatch([]);
  unsub();
  assert.equal(notifications, 0);
});

test("applyWatchBatch: still caps a session at 500 lines across a batch", () => {
  const sid = "batch-cap";
  clearSession(sid);
  applyWatchBatch(Array.from({ length: 700 }, (_, i) => turnEvent(String(i), sid)));
  const lines = sessionsStore.get().get(sid).lines;
  assert.equal(lines.length, 500);
  assert.equal(lines.at(-1).text, "699", "the cap must drop the OLDEST lines");
  assert.equal(lines[0].text, "200");
});

test("applyWatch: remains a working single-event wrapper", () => {
  const sid = "wrapper-1";
  clearSession(sid);
  applyWatch(turnEvent("solo", sid));
  assert.equal(sessionsStore.get().get(sid).lines.at(-1).text, "solo");
});

import { pruneSessions, MAX_LIVE_SESSIONS, setActiveId } from "./session-store.js";

test("pruneSessions: keeps the most recently touched sessions up to the cap", () => {
  for (const id of sessionsStore.get().keys()) clearSession(id);
  for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i++) {
    applyWatch(turnEvent("x", `prune-${i}`));
  }
  pruneSessions();
  const ids = [...sessionsStore.get().keys()];
  assert.equal(ids.length, MAX_LIVE_SESSIONS);
  // The oldest-touched must be gone and the newest-touched must survive.
  assert.ok(!ids.includes("prune-0"));
  assert.ok(ids.includes(`prune-${MAX_LIVE_SESSIONS + 4}`));
});

test("pruneSessions: never evicts the active session", () => {
  for (const id of sessionsStore.get().keys()) clearSession(id);
  applyWatch(turnEvent("x", "sticky"));
  for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i++) {
    applyWatch(turnEvent("x", `flood-${i}`));
  }
  setActiveId("sticky");
  pruneSessions();
  assert.ok(sessionsStore.get().has("sticky"), "the focused session must survive pruning");
  assert.equal(sessionsStore.get().size, MAX_LIVE_SESSIONS);
});

test("pruneSessions: is a no-op below the cap", () => {
  for (const id of sessionsStore.get().keys()) clearSession(id);
  applyWatch(turnEvent("x", "only-one"));
  let notifications = 0;
  const unsub = sessionsStore.subscribe(() => { notifications++; });
  pruneSessions();
  unsub();
  assert.equal(notifications, 0, "pruning below the cap must not commit");
  assert.equal(sessionsStore.get().size, 1);
});

import { setOwnershipProbe, ensureSession } from "./session-store.js";

test("pruneSessions: never evicts a locally-owned session", () => {
  for (const id of sessionsStore.get().keys()) clearSession(id);
  setOwnershipProbe((id) => id === "mine");
  // Seeded by the Console's NEW button: it lives in sessionsStore but no watch
  // event ever touches it, so pure recency ranking would evict it first.
  ensureSession("mine", "p");
  for (let i = 0; i < MAX_LIVE_SESSIONS + 5; i++) applyWatch(turnEvent("x", `own-${i}`));
  pruneSessions();
  setOwnershipProbe(() => false);
  assert.ok(sessionsStore.get().has("mine"), "a local run must survive pruning");
  assert.equal(sessionsStore.get().size, MAX_LIVE_SESSIONS);
});

test("MAX_LIVE_SESSIONS: is a small absolute bound", () => {
  // The prune tests above size their floods FROM the constant, so they stay
  // green at any cap. This is the assertion that actually bounds retention.
  assert.ok(MAX_LIVE_SESSIONS <= 32, `cap must stay small, got ${MAX_LIVE_SESSIONS}`);
});
