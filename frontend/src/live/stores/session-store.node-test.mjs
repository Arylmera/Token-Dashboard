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
