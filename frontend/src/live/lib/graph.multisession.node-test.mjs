import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceWatch, emptyGraph } from "./graph.js";

const fileAct = (sid, agentRef, fp) => ({
  type: "session", data: { sessionId: sid, project: "p", agentRef, event: { kind: "toolActivity", data: { toolUseId: "t" + Math.random(), name: "Edit", filePath: fp } } },
});

test("reduceWatch constellation: namespaces masters per session", () => {
  const g = ([
    { type: "session", data: { sessionId: "s1", project: "Terra", agentRef: "master", event: { kind: "turn", data: { role: "user", text: "hi" } } } },
    { type: "session", data: { sessionId: "s2", project: "praet", agentRef: "master", event: { kind: "turn", data: { role: "user", text: "yo" } } } },
  ]).reduce(reduceWatch, emptyGraph());
  assert.ok(g.nodes.has("s1:master"));
  assert.ok(g.nodes.has("s2:master"));
});

test("reduceWatch constellation: shares a global folder node across two sessions", () => {
  const g = [fileAct("s1", "master", "/repo/shared/x.md"), fileAct("s2", "master", "/repo/shared/y.md")].reduce(reduceWatch, emptyGraph());
  assert.equal(g.nodes.get("/repo/shared")?.kind, "folder");
  assert.ok(g.edges.has("s1:master->/repo/shared"));
  assert.ok(g.edges.has("s2:master->/repo/shared"));
  assert.equal([...g.nodes.values()].filter((n) => n.kind === "folder").length, 1);
});

test("reduceWatch constellation: groups same-project sessions under one project node", () => {
  const mk = (sid, project) => ({ type: "session", data: { sessionId: sid, project, agentRef: "master", event: { kind: "turn", data: { role: "user", text: "hi" } } } });
  const g = [mk("s1", "Terra"), mk("s2", "Terra"), mk("s3", "Other")].reduce(reduceWatch, emptyGraph());
  assert.equal(g.nodes.get("proj:Terra")?.kind, "project");
  assert.ok(g.edges.has("proj:Terra->s1:master"));
  assert.ok(g.edges.has("proj:Terra->s2:master"));
  assert.equal([...g.nodes.values()].filter((n) => n.kind === "project").length, 2); // Terra + Other
});

test("reduceWatch constellation: hangs a worktree session directly off its parent repo (no codename node)", () => {
  const g = ([
    { type: "session", data: { sessionId: "s1", project: "gallant-tesla-f7dbcd", repo: "praetorium", agentRef: "master", event: { kind: "turn", data: { role: "user", text: "hi" } } } },
  ]).reduce(reduceWatch, emptyGraph());
  assert.equal(g.nodes.get("proj:praetorium")?.kind, "project");
  assert.ok(!g.nodes.has("proj:gallant-tesla-f7dbcd")); // codename node collapsed
  assert.ok(g.edges.has("proj:praetorium->s1:master"));
});

test("reduceWatch constellation: does not add a parent repo node when repo equals project", () => {
  const g = ([
    { type: "session", data: { sessionId: "s1", project: "praet", repo: "praet", agentRef: "master", event: { kind: "turn", data: { role: "user", text: "hi" } } } },
  ]).reduce(reduceWatch, emptyGraph());
  assert.equal([...g.nodes.values()].filter((n) => n.kind === "project").length, 1);
});
