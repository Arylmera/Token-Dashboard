import { test } from "node:test";
import assert from "node:assert/strict";
import { reduce, emptyGraph, MASTER_ID } from "./graph.js";

// End-to-end: the exact ClaudeEvent sequence the Rust parser emits for a real
// subagent run (mirrors src-tauri/tests/fixtures/subagent-run.jsonl after serde
// serialization) folded through the reducer. Proves the full non-visual pipeline:
// parser wire-shape -> reducer -> final graph the Cockpit renders.
const transcript = [
  { type: "systemInit", data: { sessionId: "s1" } },
  { type: "assistantText", data: { text: "Spawning a subagent.", parentToolUseId: null } },
  { type: "subagentSpawn", data: { toolUseId: "toolu_agent1", subagentType: "genetor", parentToolUseId: null } },
  { type: "toolCall", data: { toolUseId: "toolu_read1", name: "Read", filePath: "/repo/Hera/Technical/Network/Map.md", parentToolUseId: "toolu_agent1" } },
  { type: "toolResult", data: { toolUseId: "toolu_read1", isError: false, parentToolUseId: "toolu_agent1" } },
  { type: "toolCall", data: { toolUseId: "toolu_edit1", name: "Edit", filePath: "/repo/Hera/Technical/Network/Map.md", parentToolUseId: "toolu_agent1" } },
  { type: "toolResult", data: { toolUseId: "toolu_agent1", isError: false, parentToolUseId: null } },
  { type: "result", data: { isError: false, result: "finished" } },
];

const g = transcript.reduce(reduce, emptyGraph());
const FOLDER = "/repo/Hera/Technical/Network";

// ---- end-to-end subagent run -> graph ----

test("end-to-end subagent run -> graph: produces master + one subagent + one folder node", () => {
  assert.equal(g.nodes.size, 3);
  assert.equal(g.nodes.get(MASTER_ID)?.kind, "master");
  assert.equal(g.nodes.get("toolu_agent1")?.kind, "agent");
  assert.equal(g.nodes.get("toolu_agent1")?.label, "genetor");
  assert.equal(g.nodes.get(FOLDER)?.kind, "folder");
});

test("end-to-end subagent run -> graph: wires master->subagent and subagent->folder edges", () => {
  assert.ok(g.edges.has(`${MASTER_ID}->toolu_agent1`));
  assert.ok(g.edges.has(`toolu_agent1->${FOLDER}`));
  assert.equal(g.edges.size, 2); // no duplicate folder edge despite two file ops
});

test("end-to-end subagent run -> graph: marks the subagent complete and the master complete", () => {
  assert.equal(g.nodes.get("toolu_agent1")?.status, "complete");
  assert.equal(g.nodes.get(MASTER_ID)?.status, "complete");
});

test("end-to-end subagent run -> graph: records one activity ping per file touch (read + edit)", () => {
  assert.equal(g.activity.length, 2);
  assert.ok(g.activity.every((a) => a.folderId === FOLDER));
});
