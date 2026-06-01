import { test } from "node:test";
import assert from "node:assert/strict";
import { groupByLocation, groupBy, relativeTime, canonicalLocation } from "./sessionGroup.js";

const s = (id, location, mtimeMs) =>
  ({ id, location, mtimeMs, title: id, sizeBytes: 0, projectDir: location });

test("groupByLocation: groups sessions by location", () => {
  const g = groupByLocation([s("a", "C:/x", 1), s("b", "C:/y", 2), s("c", "C:/x", 3)]);
  const map = new Map(g);
  assert.deepEqual(map.get("C:/x").map((x) => x.id), ["c", "a"]); // newest first within group
  assert.deepEqual(map.get("C:/y").map((x) => x.id), ["b"]);
});

test("groupByLocation: orders groups by their most-recent session", () => {
  const g = groupByLocation([s("a", "C:/x", 1), s("b", "C:/y", 5)]);
  assert.deepEqual(g.map(([loc]) => loc), ["C:/y", "C:/x"]);
});

test("canonicalLocation: strips the .claude/worktrees/<branch> suffix", () => {
  assert.equal(
    canonicalLocation("C:\\Users\\me\\git\\praetorium\\.claude\\worktrees\\bold-kepler-d0cbfd"),
    "C:\\Users\\me\\git\\praetorium",
  );
  assert.equal(
    canonicalLocation("/home/me/praetorium/.claude/worktrees/foo"),
    "/home/me/praetorium",
  );
});

test("canonicalLocation: leaves non-worktree paths untouched", () => {
  assert.equal(canonicalLocation("C:/x/praetorium"), "C:/x/praetorium");
});

test("groupByLocation: collapses worktree sessions into the project group", () => {
  const g = groupByLocation([
    s("a", "C:/git/praetorium", 1),
    s("b", "C:/git/praetorium/.claude/worktrees/feat-x", 3),
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0][1].map((x) => x.id), ["b", "a"]);
  assert.equal(g[0][0], "C:/git/praetorium");
});

test("groupBy: groups items by key, preserving first-seen order of keys and items", () => {
  const items = [
    { id: "a", dir: "praetorium" },
    { id: "b", dir: "token-dashboard" },
    { id: "c", dir: "praetorium" },
    { id: "d", dir: "token-dashboard" },
  ];
  const g = groupBy(items, (x) => x.dir);
  assert.deepEqual(g.map(([k]) => k), ["praetorium", "token-dashboard"]);
  assert.deepEqual(g[0][1].map((x) => x.id), ["a", "c"]);
  assert.deepEqual(g[1][1].map((x) => x.id), ["b", "d"]);
});

test("groupBy: returns an empty list for no items", () => {
  assert.deepEqual(groupBy([], (x) => x.dir), []);
});

test("relativeTime: formats recent times", () => {
  const now = 10_000_000;
  assert.equal(relativeTime(now - 30_000, now), "just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});
