import { test } from "node:test";
import assert from "node:assert/strict";
import { stemOf, folderOf, linksToGraph } from "./linksGraph.js";

test("linksGraph stemOf: strips extension and path prefix", () => {
  assert.equal(stemOf("docs/Intro.md"), "Intro");
  assert.equal(stemOf("Note.md"), "Note");
  assert.equal(stemOf("a/b/c.MD"), "c");
});

test("linksGraph folderOf: returns first path segment or root", () => {
  assert.equal(folderOf("docs/x.md"), "docs");
  assert.equal(folderOf("Note.md"), "root");
});

test("linksGraph linksToGraph: creates nodes for notes and linked targets", () => {
  const g = linksToGraph([
    { rel: "A.md", links: ["B.md", "C.md"], unresolved: 0 },
    { rel: "B.md", links: [], unresolved: 0 },
  ]);
  assert.ok(g.nodes.has("A.md"));
  assert.ok(g.nodes.has("B.md"));
  assert.ok(g.nodes.has("C.md"));
});

test("linksGraph linksToGraph: creates edges for each link", () => {
  const g = linksToGraph([{ rel: "A.md", links: ["B.md"], unresolved: 0 }]);
  assert.ok(g.edges.has("A.md->B.md"));
});

test("linksGraph linksToGraph: sets weight equal to degree (in + out)", () => {
  const g = linksToGraph([
    { rel: "A.md", links: ["Hub.md"], unresolved: 0 },
    { rel: "B.md", links: ["Hub.md"], unresolved: 0 },
  ]);
  assert.equal(g.nodes.get("Hub.md")?.weight, 2);
  assert.equal(g.nodes.get("A.md")?.weight, 1);
});

test("linksGraph linksToGraph: deduplicates repeated links", () => {
  const g = linksToGraph([{ rel: "A.md", links: ["B.md", "B.md"], unresolved: 0 }]);
  assert.equal(g.edges.size, 1);
});

test("linksGraph linksToGraph: uses folder prefix as session tag", () => {
  const g = linksToGraph([{ rel: "docs/X.md", links: [], unresolved: 0 }]);
  assert.equal(g.nodes.get("docs/X.md")?.session, "docs");
});
