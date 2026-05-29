import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyInsights, reduceInsights, failures, MAX_CALLS_PER_SESSION } from "./insightsStore.js";

const SID = "s1";

function ev(agentRef, event, sessionId = SID) {
  return { type: "session", data: { sessionId, project: "p", agentRef, event } };
}
const activity = (id, name = "Read", filePath = null) =>
  ({ kind: "toolActivity", data: { toolUseId: id, name, filePath } });
const done = (id, isError = false) =>
  ({ kind: "toolDone", data: { toolUseId: id, isError } });

// ---- reduceInsights ----

test("reduceInsights: toolActivity opens a running call stamped with arrival time", () => {
  const s = reduceInsights(emptyInsights(), ev("master", activity("t1", "Bash", "/a/b")), 1000);
  const calls = s.get(SID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "t1");
  assert.equal(calls[0].name, "Bash");
  assert.equal(calls[0].filePath, "/a/b");
  assert.equal(calls[0].agentRef, "master");
  assert.equal(calls[0].startMs, 1000);
  assert.equal(calls[0].status, "running");
  assert.equal(calls[0].endMs, undefined);
});

test("reduceInsights: toolDone pairs by toolUseId, sets endMs and duration, status ok", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("t1")), 1000);
  s = reduceInsights(s, ev("master", done("t1", false)), 1300);
  const c = s.get(SID)[0];
  assert.equal(c.status, "ok");
  assert.equal(c.endMs, 1300);
  assert.equal(c.endMs - c.startMs, 300);
});

test("reduceInsights: toolDone with isError marks the call error", () => {
  let s = reduceInsights(emptyInsights(), ev("sub-a", activity("t1")), 1000);
  s = reduceInsights(s, ev("sub-a", done("t1", true)), 1100);
  assert.equal(s.get(SID)[0].status, "error");
});

test("reduceInsights: out-of-order toolDone before its toolActivity is ignored (orphan)", () => {
  const s = reduceInsights(emptyInsights(), ev("master", done("ghost", true)), 1000);
  assert.equal((s.get(SID) ?? []).length, 0);
});

test("reduceInsights: missing toolDone: call stays running indefinitely", () => {
  const s = reduceInsights(emptyInsights(), ev("master", activity("t1")), 1000);
  assert.equal(s.get(SID)[0].status, "running");
  assert.equal(s.get(SID)[0].endMs, undefined);
});

test("reduceInsights: duplicate toolDone: last one wins", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("t1")), 1000);
  s = reduceInsights(s, ev("master", done("t1", false)), 1100);
  s = reduceInsights(s, ev("master", done("t1", true)), 1200);
  const c = s.get(SID)[0];
  assert.equal(c.status, "error");
  assert.equal(c.endMs, 1200);
});

test("reduceInsights: per-session cap bounds retained calls", () => {
  let s = emptyInsights();
  for (let i = 0; i < MAX_CALLS_PER_SESSION + 50; i++) {
    s = reduceInsights(s, ev("master", activity(`t${i}`)), 1000 + i);
  }
  assert.equal(s.get(SID).length, MAX_CALLS_PER_SESSION);
  // oldest dropped, newest kept
  assert.equal(s.get(SID)[s.get(SID).length - 1].id, `t${MAX_CALLS_PER_SESSION + 49}`);
});

test("reduceInsights: master vs subagent attribution preserved", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("m1")), 1000);
  s = reduceInsights(s, ev("genetor", activity("g1")), 1010);
  const refs = s.get(SID).map((c) => c.agentRef);
  assert.deepEqual(refs, ["master", "genetor"]);
});

test("reduceInsights: calls are isolated per session", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("a"), "s1"), 1000);
  s = reduceInsights(s, ev("master", activity("b"), "s2"), 1010);
  assert.equal(s.get("s1").length, 1);
  assert.equal(s.get("s2").length, 1);
});

test("reduceInsights: non tool events (turn/subagentSpawn) do not create calls", () => {
  let s = reduceInsights(emptyInsights(), ev("master", { kind: "turn", data: { role: "user", text: "hi" } }), 1000);
  s = reduceInsights(s, ev("master", { kind: "subagentSpawn", data: { toolUseId: "x", subagentType: "genetor" } }), 1010);
  assert.equal((s.get(SID) ?? []).length, 0);
});

// ---- failures selector ----

test("failures: counts error calls for a session", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("t1")), 1000);
  s = reduceInsights(s, ev("master", done("t1", true)), 1100);
  s = reduceInsights(s, ev("master", activity("t2")), 1200);
  s = reduceInsights(s, ev("master", done("t2", false)), 1300);
  s = reduceInsights(s, ev("master", activity("t3")), 1400);
  s = reduceInsights(s, ev("master", done("t3", true)), 1500);
  assert.equal(failures(s, SID), 2);
});

test("failures: includes a run error", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("t1")), 1000);
  s = reduceInsights(s, ev("master", done("t1", true)), 1100);
  assert.equal(failures(s, SID, { runError: true }), 2);
});

test("failures: isolates per session", () => {
  let s = reduceInsights(emptyInsights(), ev("master", activity("t1"), "s1"), 1000);
  s = reduceInsights(s, ev("master", done("t1", true), "s1"), 1100);
  s = reduceInsights(s, ev("master", activity("t2"), "s2"), 1200);
  s = reduceInsights(s, ev("master", done("t2", false), "s2"), 1300);
  assert.equal(failures(s, "s1"), 1);
  assert.equal(failures(s, "s2"), 0);
});

test("failures: zero when session unknown", () => {
  assert.equal(failures(emptyInsights(), "nope"), 0);
});
