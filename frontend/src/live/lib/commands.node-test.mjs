import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommands, filterCommands } from "./commands.js";

const meta = (id, over = {}) => ({
  id,
  project: "proj",
  title: "Title",
  lastActivityMs: 0,
  state: "active",
  ...over,
});

// ---- filterCommands ----
const list = [
  { id: "nav:console", title: "Console", group: "Navigate", run: () => {} },
  { id: "nav:settings", title: "Settings", group: "Navigate", run: () => {} },
  { id: "session:s1", title: "alpha", group: "Session", hint: "praetorium", run: () => {} },
];

test("filterCommands: returns all commands on an empty or whitespace query", () => {
  assert.equal(filterCommands(list, "").length, 3);
  assert.equal(filterCommands(list, "   ").length, 3);
});

test("filterCommands: matches a substring of the title", () => {
  assert.deepEqual(filterCommands(list, "sole").map((c) => c.id), ["nav:console"]);
});

test("filterCommands: is case-insensitive", () => {
  assert.deepEqual(filterCommands(list, "CONSOLE").map((c) => c.id), ["nav:console"]);
});

test("filterCommands: matches on the hint", () => {
  assert.deepEqual(filterCommands(list, "praet").map((c) => c.id), ["session:s1"]);
});

test("filterCommands: preserves group order", () => {
  assert.deepEqual(filterCommands(list, "").map((c) => c.group), [
    "Navigate",
    "Navigate",
    "Session",
  ]);
});

// ---- buildCommands ----
const noSessions = () => new Map();
const noMetas = () => new Map();

test("buildCommands: always includes the navigate commands in order", () => {
  const cmds = buildCommands({ sessions: noSessions, metas: noMetas, themedCopy: () => undefined });
  assert.deepEqual(cmds.filter((c) => c.group === "Navigate").map((c) => c.title), [
    "console",
    "cockpit",
    "explorer",
  ]);
});

test("buildCommands: honors themed nav labels when present", () => {
  const cmds = buildCommands({
    sessions: noSessions,
    metas: noMetas,
    themedCopy: () => ({
      nav: { console: "COMMS", cockpit: "HELM", explorer: "CHARTS" },
    }),
  });
  assert.deepEqual(cmds.filter((c) => c.group === "Navigate").map((c) => c.title), [
    "COMMS",
    "HELM",
    "CHARTS",
  ]);
});

test("buildCommands: emits one session command per session", () => {
  const sessions = () =>
    new Map([
      ["s1", { project: "p1" }],
      ["s2", { project: "p2" }],
    ]);
  const metas = () => new Map([["s1", meta("s1", { title: "First", project: "p1" })]]);
  const sess = buildCommands({ sessions, metas, themedCopy: () => undefined }).filter(
    (c) => c.group === "Session",
  );
  assert.equal(sess.length, 2);
  assert.equal(sess[0].title, "First");
  assert.equal(sess[1].title, "p2"); // no meta → falls back to project
  assert.equal(sess[1].hint, "p2");
});

test("buildCommands: session command activates the session then switches to console", () => {
  let active = "";
  let viewed = "";
  const sessions = () => new Map([["sid", { project: "p" }]]);
  const cmd = buildCommands({
    sessions,
    metas: noMetas,
    themedCopy: () => undefined,
    setActiveId: (id) => { active = id; },
    setView: (v) => { viewed = v; },
  }).find((c) => c.group === "Session");
  cmd.run();
  assert.equal(active, "sid");
  assert.equal(viewed, "console");
});
