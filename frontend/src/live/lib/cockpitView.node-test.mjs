import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolCategory,
  buildNodeLive,
  buildAggregates,
  buildDetail,
  collapseFinishedAgents,
  collapseByTitle,
  pruneArchived,
  IDLE_MS,
} from "./cockpitView.js";

// ---- builders -------------------------------------------------------------
const node = (id, over = {}) => ({
  id, kind: "agent", label: id, status: "running", ...over,
});
const edge = (source, target) => ({ id: `${source}->${target}`, source, target });
const graphOf = (nodes, edges = [], activity = []) => ({
  nodes: new Map(nodes.map((n) => [n.id, n])),
  edges: new Map(edges.map((e) => [e.id, e])),
  activity,
});
const call = (over = {}) => ({
  id: "t1", name: "Read", filePath: "/a/b.ts", agentRef: "master", startMs: 0, status: "ok", ...over,
});
const insightsOf = (rec) => new Map(Object.entries(rec));
const meta = (id, over = {}) => ({
  id, project: "praetorium", title: "Title", lastActivityMs: 0, state: "active", ...over,
});

// ---- toolCategory ----------------------------------------------------------
test("toolCategory: categorizes known tools", () => {
  assert.equal(toolCategory("Read"), "read");
  assert.equal(toolCategory("Edit"), "edit");
  assert.equal(toolCategory("Bash"), "bash");
  assert.equal(toolCategory("WebSearch"), "web");
  assert.equal(toolCategory("Grep"), "search");
  assert.equal(toolCategory("Glob"), "search");
});

test("toolCategory: falls back to other for unknown tools", () => {
  assert.equal(toolCategory("TaskCreate"), "other");
  assert.equal(toolCategory(""), "other");
});

// ---- buildNodeLive --------------------------------------------------------
test("buildNodeLive: attributes calls to master and subagent node ids", () => {
  const insights = insightsOf({
    s1: [
      call({ id: "a", agentRef: "master", name: "Read", startMs: 100, endMs: 150, status: "ok" }),
      call({ id: "b", agentRef: "sub7", name: "Edit", startMs: 200, endMs: 260, status: "error" }),
      call({ id: "c", agentRef: "sub7", name: "Bash", startMs: 300, status: "running" }),
    ],
  });
  const live = buildNodeLive(insights, 1000);
  assert.equal(live.get("s1:master")?.callCount, 1);
  assert.equal(live.get("s1:master")?.lastTool, "read");
  const sub = live.get("s1:sub7");
  assert.equal(sub.callCount, 2);
  assert.equal(sub.failCount, 1);
  assert.equal(sub.lastTool, "bash"); // most recent by startMs
});

test("buildNodeLive: computes lastActivityMs/idleMs from latest call edge", () => {
  const insights = insightsOf({ s1: [call({ startMs: 100, endMs: 400 })] });
  const live = buildNodeLive(insights, 1400);
  assert.equal(live.get("s1:master")?.lastActivityMs, 400);
  assert.equal(live.get("s1:master")?.idleMs, 1000);
});

test("buildNodeLive: recentRate reflects calls within the last 10s, clamped to 0..1", () => {
  const now = 100_000;
  const calls = [];
  for (let i = 0; i < 10; i++) calls.push(call({ id: `r${i}`, startMs: now - 1000 - i * 100 }));
  const live = buildNodeLive(insightsOf({ s1: calls }), now);
  assert.equal(live.get("s1:master")?.recentRate, 1);

  const few = insightsOf({ s2: [call({ agentRef: "master", startMs: now - 500 })] });
  const live2 = buildNodeLive(few, now);
  const r = live2.get("s2:master").recentRate;
  assert.ok(r > 0);
  assert.ok(r < 1);
});

// ---- buildAggregates ------------------------------------------------------
test("buildAggregates: counts kinds, fails, idle and buckets callsPerSec", () => {
  const g = graphOf([
    node("s1:master", { kind: "master", session: "s1", status: "running" }),
    node("s1:sub", { kind: "agent", session: "s1", status: "failed" }),
    node("s2:master", { kind: "master", session: "s2", status: "running" }),
    node("/a", { kind: "folder" }),
    node("/b", { kind: "folder" }),
    node("proj:praetorium", { kind: "project" }),
  ]);
  const now = 60_000;
  const insights = insightsOf({
    s1: [call({ agentRef: "master", startMs: now - 500 })], // s1 master active → not idle
    // s2 has no calls → idle
  });
  const live = buildNodeLive(insights, now);
  const agg = buildAggregates(g, live, insights, now);
  assert.equal(agg.agents, 1);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.folders, 2);
  assert.equal(agg.fails, 1); // the failed agent node
  assert.equal(agg.idle, 1);  // s2:master never active
  assert.equal(agg.callsPerSec.length, 60);
  assert.equal(agg.callsPerSec[59], 1); // one call in the last second bucket
});

// ---- buildDetail ----------------------------------------------------------
test("buildDetail: assembles session detail for a master node", () => {
  const g = graphOf(
    [
      node("s1:master", { kind: "master", session: "s1", label: "praetorium", status: "running" }),
      node("s1:sub", { kind: "agent", session: "s1", label: "Explore", status: "complete" }),
      node("/a", { kind: "folder", label: "/a" }),
      node("/b", { kind: "folder", label: "/b" }),
    ],
    [edge("s1:master", "s1:sub"), edge("s1:master", "/a"), edge("s1:sub", "/b")],
  );
  const insights = insightsOf({
    s1: [
      call({ id: "a", agentRef: "master", name: "Read", filePath: "/a/x.ts", startMs: 100, endMs: 150, status: "ok" }),
      call({ id: "b", agentRef: "sub", name: "Bash", filePath: null, startMs: 200, endMs: 800, status: "error" }),
    ],
  });
  const metas = new Map([["s1", meta("s1", { state: "active", title: "Refactor auth" })]]);
  const d = buildDetail(g, "s1:master", insights, metas, 2000);
  assert.equal(d.state, "active");
  assert.equal(d.calls, 2);
  assert.equal(d.fails, 1);
  assert.deepEqual(d.subagents, [{ label: "Explore", status: "complete" }]);
  assert.deepEqual(d.folders.sort(), ["/a", "/b"]); // union across master + subagent
  const lastCall = d.recentCalls[d.recentCalls.length - 1];
  assert.equal(lastCall.tool, "bash");
  assert.equal(lastCall.status, "error");
  assert.equal(lastCall.durMs, 600);
});

test("buildDetail: scopes recent calls to the agent for an agent node", () => {
  const g = graphOf(
    [
      node("s1:master", { kind: "master", session: "s1", label: "praetorium", status: "running" }),
      node("s1:sub", { kind: "agent", session: "s1", label: "Explore", status: "complete" }),
      node("/a", { kind: "folder", label: "/a" }),
      node("/b", { kind: "folder", label: "/b" }),
    ],
    [edge("s1:master", "s1:sub"), edge("s1:master", "/a"), edge("s1:sub", "/b")],
  );
  const insights = insightsOf({
    s1: [
      call({ id: "a", agentRef: "master", name: "Read", filePath: "/a/x.ts", startMs: 100, endMs: 150, status: "ok" }),
      call({ id: "b", agentRef: "sub", name: "Bash", filePath: null, startMs: 200, endMs: 800, status: "error" }),
    ],
  });
  const metas = new Map([["s1", meta("s1", { state: "active", title: "Refactor auth" })]]);
  const d = buildDetail(g, "s1:sub", insights, metas, 2000);
  assert.equal(d.calls, 1);
  assert.equal(d.recentCalls.length, 1);
  assert.equal(d.recentCalls[0].tool, "bash");
  assert.equal(d.recentCalls[0].status, "error");
});

test("buildDetail: returns null for a missing node", () => {
  const g = graphOf([]);
  const insights = insightsOf({});
  const metas = new Map();
  assert.equal(buildDetail(g, "nope", insights, metas, 2000), null);
});

// ---- collapseFinishedAgents -----------------------------------------------
test("collapseFinishedAgents: folds finished subagents into a done count on the master and redirects their folders", () => {
  const g = graphOf(
    [
      node("s1:master", { kind: "master", session: "s1", status: "running" }),
      node("s1:run", { kind: "agent", session: "s1", status: "running" }),
      node("s1:ok", { kind: "agent", session: "s1", status: "complete" }),
      node("s1:bad", { kind: "agent", session: "s1", status: "failed" }),
      node("/a", { kind: "folder" }),
      node("/b", { kind: "folder" }),
    ],
    [
      edge("s1:master", "s1:run"),
      edge("s1:master", "s1:ok"),
      edge("s1:master", "s1:bad"),
      edge("s1:ok", "/a"),   // finished agent's folder → should redirect to master
      edge("s1:run", "/b"),  // running agent's folder → untouched
    ],
  );
  const out = collapseFinishedAgents(g);
  // finished agents removed, running one kept
  assert.ok(!out.nodes.has("s1:ok"));
  assert.ok(!out.nodes.has("s1:bad"));
  assert.ok(out.nodes.has("s1:run"));
  // master annotated
  const m = out.nodes.get("s1:master");
  assert.equal(m.done, 2);
  assert.equal(m.doneFailed, 1);
  // finished subagents' identities preserved for the detail panel
  assert.deepEqual(m.doneAgents, [
    { label: "s1:ok", status: "complete" },
    { label: "s1:bad", status: "failed" },
  ]);
  // folder of the finished agent now hangs off the master
  assert.ok(out.edges.has("s1:master->/a"));
  assert.ok(out.nodes.has("/a"));
});

test("collapseFinishedAgents: is a no-op when there are no finished subagents", () => {
  const g = graphOf(
    [node("s1:master", { kind: "master", session: "s1", status: "running" }),
     node("s1:run", { kind: "agent", session: "s1", status: "running" })],
    [edge("s1:master", "s1:run")],
  );
  assert.equal(collapseFinishedAgents(g), g);
});

test("IDLE_MS: is a positive threshold", () => {
  assert.ok(IDLE_MS > 0);
});

// ---- pruneArchived --------------------------------------------------------
test("pruneArchived: drops archived sessions and the project/folder hubs left empty", () => {
  const isLive = (sid) => sid === "s1"; // only s1 is live
  const g = graphOf(
    [
      node("proj:p", { kind: "project" }),
      node("s1:master", { kind: "master", session: "s1", status: "running" }),
      node("s2:master", { kind: "master", session: "s2", status: "complete" }),
      node("/shared", { kind: "folder" }),
      node("/onlyArchived", { kind: "folder" }),
    ],
    [
      edge("proj:p", "s1:master"),
      edge("proj:p", "s2:master"),
      edge("s1:master", "/shared"),
      edge("s2:master", "/shared"),
      edge("s2:master", "/onlyArchived"),
    ],
  );
  const out = pruneArchived(g, isLive);
  assert.equal(out.nodes.has("s1:master"), true);
  assert.equal(out.nodes.has("s2:master"), false);
  assert.equal(out.nodes.has("proj:p"), true);        // still owns the live s1
  assert.equal(out.nodes.has("/shared"), true);       // a live session points at it
  assert.equal(out.nodes.has("/onlyArchived"), false); // only the archived session touched it
  assert.equal(out.edges.has("proj:p->s2:master"), false);
});

// ---- collapseByTitle ------------------------------------------------------
test("collapseByTitle: merges same-project same-title masters into one weighted node", () => {
  const titleOf = (sid) => (sid === "a" || sid === "b" ? "Same prompt" : "Other");
  const g = graphOf(
    [
      node("a:master", { kind: "master", session: "a", label: "praetorium", status: "running" }),
      node("b:master", { kind: "master", session: "b", label: "praetorium", status: "running" }),
      node("a:sub", { kind: "agent", session: "a", status: "running" }),
    ],
    [edge("a:master", "a:sub"), edge("b:master", "a:sub")],
  );
  const out = collapseByTitle(g, titleOf);
  const masters = [...out.nodes.values()].filter((n) => n.kind === "master");
  assert.equal(masters.length, 1);
  assert.equal(masters[0].weight, 2);
  const gid = masters[0].id;
  assert.equal(out.edges.has(`${gid}->a:sub`), true);
});

test("collapseByTitle: keeps distinct titles as separate masters", () => {
  const titleOf = (sid) => (sid === "a" || sid === "b" ? "Same prompt" : "Other");
  const g = graphOf([
    node("a:master", { kind: "master", session: "a", label: "praetorium", status: "running" }),
    node("c:master", { kind: "master", session: "c", label: "praetorium", status: "running" }),
  ]);
  const out = collapseByTitle(g, titleOf);
  assert.equal([...out.nodes.values()].filter((n) => n.kind === "master").length, 2);
});
