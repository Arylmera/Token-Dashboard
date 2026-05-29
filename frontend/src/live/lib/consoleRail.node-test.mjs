import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRail } from "./consoleRail.js";

const entry = (over) => ({
  id: "x", title: "t", owned: true, observed: false, status: "idle",
  failCount: 0, lastActivityMs: 0, cwd: undefined, subagents: [], ...over,
});

test("buildRail: groups by cwd and labels with the basename", () => {
  const groups = buildRail([
    entry({ id: "a", cwd: "C:/git/praetorium", lastActivityMs: 1 }),
    entry({ id: "b", cwd: "C:/git/praetorium", lastActivityMs: 3 }),
    entry({ id: "c", cwd: "C:/git/token-dashboard", lastActivityMs: 2 }),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ["praetorium", "token-dashboard"]);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["b", "a"]);
});

test("buildRail: orders groups by their most-recent session", () => {
  const groups = buildRail([
    entry({ id: "a", cwd: "C:/x", lastActivityMs: 1 }),
    entry({ id: "b", cwd: "C:/y", lastActivityMs: 5 }),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ["y", "x"]);
});

test("buildRail: derives a repo sublabel for worktree cwds", () => {
  const groups = buildRail([
    entry({ id: "a", cwd: "C:/git/praetorium/.claude/worktrees/kind-bartik" }),
  ]);
  assert.equal(groups[0].repo, "praetorium");
});

test("buildRail: places cwd-less owned sessions under the resolved app cwd", () => {
  const groups = buildRail([entry({ id: "a", cwd: undefined })], "C:/git/praetorium");
  assert.equal(groups[0].label, "praetorium");
  assert.equal(groups[0].dir, "C:/git/praetorium");
});

test("buildRail: keeps sub-agents nested on their session", () => {
  const groups = buildRail([
    entry({ id: "a", cwd: "C:/x", subagents: [{ ref: "r1", name: "Explore", steps: 6 }] }),
  ]);
  assert.deepEqual(groups[0].sessions[0].subagents, [{ ref: "r1", name: "Explore", steps: 6 }]);
});

test("buildRail: retains observed tagging", () => {
  const groups = buildRail([entry({ id: "a", cwd: "C:/x", owned: false, observed: true })]);
  assert.equal(groups[0].sessions[0].observed, true);
  assert.equal(groups[0].sessions[0].owned, false);
});
