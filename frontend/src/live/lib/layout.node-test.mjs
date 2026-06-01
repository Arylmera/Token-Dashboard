import { test } from "node:test";
import assert from "node:assert/strict";
import { RadialForceLayout, HierarchicalLayout } from "./layout.js";
import { reduce, emptyGraph } from "./graph.js";

// Hub-and-spoke: one root with N children (the shape that produced spoke crossings).
function hubAndSpoke(children) {
  const nodes = new Map();
  const edges = new Map();
  const mk = (id) => ({ id, kind: "folder", label: id, status: "complete" });
  nodes.set("root", mk("root"));
  for (let i = 0; i < children; i++) {
    const id = `c${i}`;
    nodes.set(id, mk(id));
    edges.set(`root->${id}`, { id: `root->${id}`, source: "root", target: id });
  }
  return { nodes, edges, activity: [] };
}

// Two unrelated projects, each a small root→master→folder chain (distinct roots).
function twoProjects() {
  const nodes = new Map();
  const edges = new Map();
  const addEdge = (s, t) => edges.set(`${s}->${t}`, { id: `${s}->${t}`, source: s, target: t });
  for (const p of ["A", "B"]) {
    nodes.set(`proj:${p}`, { id: `proj:${p}`, kind: "project", label: p, status: "running" });
    nodes.set(`m:${p}`, { id: `m:${p}`, kind: "master", label: p, status: "running" });
    nodes.set(`f:${p}`, { id: `f:${p}`, kind: "folder", label: `${p}/src`, status: "complete" });
    addEdge(`proj:${p}`, `m:${p}`);
    addEdge(`m:${p}`, `f:${p}`);
  }
  return { nodes, edges, activity: [] };
}

const state = ([
  { type: "subagentSpawn", data: { toolUseId: "a1", subagentType: "g", parentToolUseId: null } },
  { type: "toolCall", data: { toolUseId: "t1", name: "Edit", filePath: "/repo/src/x.ts", parentToolUseId: "a1" } },
]).reduce(reduce, emptyGraph());

// ---- RadialForceLayout ----
test("RadialForceLayout: assigns a finite position to every node", () => {
  const pos = new RadialForceLayout().layout(state, 800, 600);
  assert.equal(pos.length, state.nodes.size);
  for (const p of pos) {
    assert.ok(Number.isFinite(p.x));
    assert.ok(Number.isFinite(p.y));
  }
});

test("RadialForceLayout: returns one position per node id", () => {
  const pos = new RadialForceLayout().layout(state, 800, 600);
  const ids = new Set(pos.map((p) => p.id));
  assert.deepEqual(ids, new Set(state.nodes.keys()));
});

test("RadialForceLayout: bands nodes into depth rings: children sit farther from center than the root", () => {
  const W = 1200, H = 860, cx = W / 2, cy = H / 2;
  const pos = new RadialForceLayout().layout(hubAndSpoke(8), W, H);
  const r = (id) => {
    const p = pos.find((q) => q.id === id);
    return Math.hypot(p.x - cx, p.y - cy);
  };
  const rootR = r("root");
  const childRs = [...Array(8)].map((_, i) => r(`c${i}`));
  // Every child should sit outside the root's ring (root depth 0, children depth 1).
  for (const cr of childRs) assert.ok(cr > rootR);
  // Children share a ring: their radii should be tightly clustered, not scattered.
  const mean = childRs.reduce((a, b) => a + b, 0) / childRs.length;
  for (const cr of childRs) assert.ok(Math.abs(cr - mean) / mean < 0.35);
});

test("RadialForceLayout: separates distinct project roots: each project's cluster keeps its distance", () => {
  const pos = new RadialForceLayout().layout(twoProjects(), 1200, 860);
  const at = (id) => pos.find((p) => p.id === id);
  const centroid = (p) => {
    const ns = [`proj:${p}`, `m:${p}`, `f:${p}`].map(at);
    return { x: ns.reduce((s, n) => s + n.x, 0) / 3, y: ns.reduce((s, n) => s + n.y, 0) / 3 };
  };
  const a = centroid("A"), b = centroid("B");
  // The inter-group separation force pushes the two project clusters well apart.
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 240);
});

// ---- HierarchicalLayout ----
test("HierarchicalLayout: assigns finite positions for a rooted graph", () => {
  const pos = new HierarchicalLayout().layout(state, 800, 600);
  assert.equal(pos.length, state.nodes.size);
  for (const p of pos) {
    assert.ok(Number.isFinite(p.x));
    assert.ok(Number.isFinite(p.y));
  }
});
