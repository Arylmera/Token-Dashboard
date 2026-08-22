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
