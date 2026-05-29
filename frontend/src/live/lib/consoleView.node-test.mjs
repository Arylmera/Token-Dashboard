import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolSegs, masterFlow, answerLines, lanes, timeSpan, orderedAgentRefs, subagentSteps,
} from "./consoleView.js";

const line = (over = {}) => ({ agentRef: "master", role: "assistant", text: "", ...over });
const call = (over = {}) => ({ id: "t", name: "Read", filePath: null, agentRef: "master", startMs: 0, status: "ok", ...over });

test("toolSegs: splits tool placeholders from prose", () => {
  const segs = toolSegs("thinking\n[Read src/a.ts]\n[Bash]");
  assert.deepEqual(segs[0], { tool: false, text: "thinking" });
  assert.deepEqual(segs[1], { tool: true, name: "Read", arg: "src/a.ts" });
  assert.deepEqual(segs[2], { tool: true, name: "Bash", arg: "" });
});

test("masterFlow: keeps master lines and emits one marker per first subagent appearance", () => {
  const lines = [
    line({ text: "a" }),
    line({ agentRef: "sub1", text: "x" }),
    line({ agentRef: "sub1", text: "y" }),
    line({ text: "b" }),
    line({ agentRef: "sub2", text: "z" }),
  ];
  const flow = masterFlow(lines);
  assert.deepEqual(flow.map((f) => f.kind), ["line", "marker", "line", "marker"]);
  assert.deepEqual(flow.filter((f) => f.kind === "marker").map((f) => f.ref), ["sub1", "sub2"]);
});

test("answerLines: marks the last assistant line before each user turn", () => {
  const a1 = line({ text: "narration" });
  const a2 = line({ text: "answer 1" });
  const u = line({ role: "user", text: "q2" });
  const a3 = line({ text: "answer 2" });
  const set = answerLines([line({ role: "user", text: "q1" }), a1, a2, u, a3], false);
  assert.equal(set.has(a2), true);
  assert.equal(set.has(a1), false);
  assert.equal(set.has(a3), true);
});

test("answerLines: does not mark the trailing answer while still running", () => {
  const a = line({ text: "partial" });
  assert.equal(answerLines([line({ role: "user" }), a], true).has(a), false);
});

test("lanes: orders master first, then subagents in first-seen order", () => {
  const calls = [call({ agentRef: "sub2" }), call({ agentRef: "master" }), call({ agentRef: "sub1" }), call({ agentRef: "sub2" })];
  assert.deepEqual(lanes(calls), ["master", "sub2", "sub1"]);
});

test("timeSpan: returns a 1s default window when there are no calls", () => {
  assert.deepEqual(timeSpan([], 1000), { t0: 0, ms: 1000 });
});
test("timeSpan: spans first start to last end, clamped to a 1s minimum", () => {
  assert.deepEqual(timeSpan([call({ startMs: 100, endMs: 5100 })], 9999), { t0: 100, ms: 5000 });
  assert.deepEqual(timeSpan([call({ startMs: 100, endMs: 200 })], 9999), { t0: 100, ms: 1000 });
});
test("timeSpan: uses now for an open-ended running call", () => {
  assert.deepEqual(timeSpan([call({ startMs: 0, endMs: undefined, status: "running" })], 3000), { t0: 0, ms: 3000 });
});

test("orderedAgentRefs: collects non-master refs first from lines then from calls", () => {
  const lines = [line({ agentRef: "sub1" }), line({ agentRef: "master" })];
  const calls = [call({ agentRef: "sub1" }), call({ agentRef: "sub2" })];
  assert.deepEqual(orderedAgentRefs(lines, calls), ["sub1", "sub2"]);
});

test("subagentSteps: tallies steps per subagent ref, ignoring master", () => {
  const lines = [line({ agentRef: "master" }), line({ agentRef: "sub1" }), line({ agentRef: "sub1" }), line({ agentRef: "sub2" })];
  const { refs, steps } = subagentSteps(lines);
  assert.deepEqual(refs, ["sub1", "sub2"]);
  assert.equal(steps.get("sub1"), 2);
  assert.equal(steps.get("sub2"), 1);
});
