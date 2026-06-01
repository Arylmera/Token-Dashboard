import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, flattenVisible } from "./fileTree.js";

const f = (rel) => ({ rel, name: rel.split("/").pop(), dir: rel.split("/").slice(0, -1).join("/") });

test("fileTree buildTree: groups files under folders", () => {
  const tree = buildTree([f("src/a.ts"), f("src/b.ts"), f("docs/x.md")]);
  const names = tree.folders.map((x) => x.name).sort();
  assert.deepEqual(names, ["docs", "src"]);
  const src = tree.folders.find((x) => x.name === "src");
  assert.equal(src.files.length, 2);
});

test("fileTree buildTree: counts total descendant files", () => {
  const tree = buildTree([f("a/b/c.ts"), f("a/d.ts")]);
  const a = tree.folders.find((x) => x.name === "a");
  assert.equal(a.count, 2);
});

test("fileTree buildTree: normalizes windows backslashes", () => {
  const tree = buildTree([{ rel: "src\\x.ts", name: "x.ts", dir: "src" }]);
  assert.equal(tree.folders[0].files[0].rel, "src/x.ts");
});

test("fileTree buildTree: sorts folders and files alphabetically", () => {
  const tree = buildTree([f("z/b.ts"), f("a/a.ts"), f("a/c.ts"), f("z/a.ts")]);
  assert.deepEqual(tree.folders.map((x) => x.name), ["a", "z"]);
  const z = tree.folders.find((x) => x.name === "z");
  assert.deepEqual(z.files.map((x) => x.name), ["a.ts", "b.ts"]);
});

test("fileTree flattenVisible: only shows open folder contents", () => {
  const tree = buildTree([f("src/a.ts"), f("src/b.ts"), f("docs/x.md")]);
  // Nothing open → only top-level folders
  const closed = flattenVisible(tree, new Set());
  assert.equal(closed.length, 2); // src, docs
  assert.ok(closed.every((r) => r.kind === "folder"));

  // Open src → shows src + its files
  const open = flattenVisible(tree, new Set(["src"]));
  assert.equal(open.length, 4); // src, a.ts, b.ts, docs
});
