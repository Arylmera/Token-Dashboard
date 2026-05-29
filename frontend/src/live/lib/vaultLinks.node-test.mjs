import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLinkMaps } from "./vaultLinks.js";

test("buildLinkMaps: builds a forward map of each note's outgoing links", () => {
  const notes = [
    { rel: "A.md", links: ["B.md", "C.md"], unresolved: 0 },
    { rel: "B.md", links: [], unresolved: 1 },
  ];
  const { forward } = buildLinkMaps(notes);
  assert.deepEqual(forward.get("A.md"), ["B.md", "C.md"]);
  assert.deepEqual(forward.get("B.md"), []);
});

test("buildLinkMaps: builds a backward (reverse) map of who links to a note", () => {
  const notes = [
    { rel: "A.md", links: ["C.md"], unresolved: 0 },
    { rel: "B.md", links: ["C.md"], unresolved: 0 },
  ];
  const { backward } = buildLinkMaps(notes);
  assert.deepEqual(backward.get("C.md"), ["A.md", "B.md"]);
});

test("buildLinkMaps: omits dangling targets from the backward map", () => {
  const notes = [{ rel: "A.md", links: ["B.md"], unresolved: 2 }];
  const { backward } = buildLinkMaps(notes);
  assert.deepEqual(backward.get("B.md"), ["A.md"]);
  assert.ok(!backward.has("Ghost"));
});

test("buildLinkMaps: dedupes a source that links the same target twice in backward map", () => {
  // links arrive deduped from Rust, but guard anyway
  const notes = [{ rel: "A.md", links: ["B.md", "B.md"], unresolved: 0 }];
  const { backward } = buildLinkMaps(notes);
  assert.deepEqual(backward.get("B.md"), ["A.md"]);
});

test("buildLinkMaps: handles a note linked by several others", () => {
  const notes = [
    { rel: "A.md", links: ["Hub.md"], unresolved: 0 },
    { rel: "B.md", links: ["Hub.md"], unresolved: 0 },
    { rel: "C.md", links: ["Hub.md"], unresolved: 0 },
  ];
  const { backward } = buildLinkMaps(notes);
  assert.deepEqual(backward.get("Hub.md"), ["A.md", "B.md", "C.md"]);
});
