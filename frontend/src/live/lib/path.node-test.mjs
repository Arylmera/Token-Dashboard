import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePath, basename, dirname } from "./path.js";

test("normalizePath: rewrites Windows separators", () => {
  assert.equal(normalizePath("C:\\Users\\x\\proj"), "C:/Users/x/proj");
});
test("normalizePath: leaves POSIX paths untouched", () => {
  assert.equal(normalizePath("/home/x/proj"), "/home/x/proj");
});

test("basename: returns the last unix segment", () => {
  assert.equal(basename("/home/u/projects/praetorium"), "praetorium");
});
test("basename: ignores a trailing slash", () => {
  assert.equal(basename("/home/u/projects/praetorium/"), "praetorium");
});
test("basename: handles Windows separators and a trailing one", () => {
  assert.equal(basename("C:\\Users\\g\\praetorium\\"), "praetorium");
});
test("basename: returns '' for empty or separator-only input", () => {
  assert.equal(basename(""), "");
  assert.equal(basename("/"), "");
});

test("dirname: returns the parent of a file path", () => {
  assert.equal(dirname("/repo/src/a.ts"), "/repo/src");
});
test("dirname: normalizes Windows separators", () => {
  assert.equal(dirname("C:\\repo\\src\\a.ts"), "C:/repo/src");
});
test("dirname: returns the whole path when there is no parent", () => {
  assert.equal(dirname("a.ts"), "a.ts");
  assert.equal(dirname("/top"), "/top");
});
