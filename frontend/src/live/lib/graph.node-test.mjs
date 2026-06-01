import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, reduceWatch, emptyGraph, MASTER_ID } from "./graph.js";

const run = (events) => events.reduce(reduce, emptyGraph());

// ---- graph reducer ----
test("graph reducer: creates the master node on first event", () => {
  const s = run([{ type: "systemInit", data: { sessionId: "s1" } }]);
  assert.equal(s.nodes.get(MASTER_ID)?.kind, "master");
});

test("graph reducer: adds a subagent node + edge from master", () => {
  const s = run([
    { type: "subagentSpawn", data: { toolUseId: "a1", subagentType: "genetor", parentToolUseId: null } },
  ]);
  assert.equal(s.nodes.get("a1")?.kind, "agent");
  assert.ok(s.edges.has(`${MASTER_ID}->a1`));
});

test("graph reducer: adds a folder node + edge for a toolCall with filePath", () => {
  const s = run([
    { type: "toolCall", data: { toolUseId: "t1", name: "Read", filePath: "/x/y.md", parentToolUseId: null } },
  ]);
  assert.equal(s.nodes.get("/x")?.kind, "folder");
  assert.ok(s.edges.has(`${MASTER_ID}->/x`));
});

test("graph reducer: marks toolResult completing the agent node", () => {
  const s = run([
    { type: "subagentSpawn", data: { toolUseId: "a1", subagentType: "g", parentToolUseId: null } },
    { type: "toolResult", data: { toolUseId: "a1", isError: false, parentToolUseId: null } },
  ]);
  assert.equal(s.nodes.get("a1")?.status, "complete");
});

test("graph reducer: marks master complete on result event", () => {
  const s = run([
    { type: "result", data: { isError: false, result: "done" } },
  ]);
  assert.equal(s.nodes.get(MASTER_ID)?.status, "complete");
});

test("graph reducer: toolCall with unknown parentToolUseId falls back to master", () => {
  const s = run([
    { type: "toolCall", data: { toolUseId: "t1", name: "Read", filePath: "/x/y.md", parentToolUseId: "ghost" } },
  ]);
  assert.ok(s.edges.has(`${MASTER_ID}->/x`));
});

test("graph reducer: does not mutate the previous state", () => {
  const a = emptyGraph();
  const b = reduce(a, { type: "subagentSpawn", data: { toolUseId: "a1", subagentType: "g", parentToolUseId: null } });
  assert.equal(a.nodes.size, 0);
  assert.ok(b.nodes.size > 0);
});

// ---- reduceWatch toolDone → failed nodes ----
const SID = "sess1";
const ev = (agentRef, event) =>
  ({ type: "session", data: { sessionId: SID, project: "proj", agentRef, event } });
const master = `${SID}:master`;

test("reduceWatch toolDone: marks the session master node failed on an errored master-level call", () => {
  let g = reduceWatch(emptyGraph(), ev("master", { kind: "toolActivity", data: { toolUseId: "t1", name: "Bash", filePath: "/r/a.txt" } }));
  assert.equal(g.nodes.get(master).status, "running");
  g = reduceWatch(g, ev("master", { kind: "toolDone", data: { toolUseId: "t1", isError: true } }));
  assert.equal(g.nodes.get(master).status, "failed");
});

test("reduceWatch toolDone: does not mark the owner failed on a successful call", () => {
  let g = reduceWatch(emptyGraph(), ev("master", { kind: "toolActivity", data: { toolUseId: "t1", name: "Read", filePath: "/r/a.txt" } }));
  g = reduceWatch(g, ev("master", { kind: "toolDone", data: { toolUseId: "t1", isError: false } }));
  assert.equal(g.nodes.get(master).status, "running");
});

test("reduceWatch toolDone: marks an errored subagent-level call's owning subagent node failed, not master", () => {
  let g = reduceWatch(emptyGraph(), ev("genetor", { kind: "toolActivity", data: { toolUseId: "t9", name: "Edit", filePath: "/r/x.ts" } }));
  const subId = `${SID}:genetor`;
  assert.equal(g.nodes.get(subId).status, "running");
  g = reduceWatch(g, ev("genetor", { kind: "toolDone", data: { toolUseId: "t9", isError: true } }));
  assert.equal(g.nodes.get(subId).status, "failed");
  assert.equal(g.nodes.get(master).status, "running");
});

test("reduceWatch toolDone: marks a spawned agent node complete when its spawn-id toolDone arrives", () => {
  let g = reduceWatch(emptyGraph(), ev("master", { kind: "subagentSpawn", data: { toolUseId: "a1", subagentType: "genetor" } }));
  const agentId = `${SID}:a1`;
  assert.equal(g.nodes.get(agentId).status, "running");
  g = reduceWatch(g, ev("master", { kind: "toolDone", data: { toolUseId: "a1", isError: false } }));
  assert.equal(g.nodes.get(agentId).status, "complete");
});
