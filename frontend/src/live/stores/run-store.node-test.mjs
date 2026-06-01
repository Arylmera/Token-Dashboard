import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Stub localStorage for settings/vault-store peers
globalThis.localStorage = (() => {
  const s = {};
  return { getItem: (k) => s[k] ?? null, setItem: (k, v) => { s[k] = v; }, removeItem: (k) => { delete s[k]; }, clear: () => { for (const k of Object.keys(s)) delete s[k]; } };
})();

// sessions.js is imported transitively; it now lazy-imports @tauri-apps/api/core so
// no stubbing is needed for the module graph to load under Node.

import {
  cwdLabel,
  repoLabel,
  nextStatus,
  startRun,
  stopRun,
  closeSession,
  renameSession,
  isRunning,
  newLocalSession,
  isLocalSession,
  adoptSession,
  ownedClaudeIds,
  localSessionsStore,
  _setTransport,
} from "./run-store.js";

// --- transport stub ---
const h = { emit: [], lastOnEvent: null, runCalls: [], stopCalls: [] };

const stubTransport = {
  runClaude: async (_runId, _prompt, onEvent, _opts) => {
    h.lastOnEvent = onEvent;
    h.runCalls.push({ runId: _runId, prompt: _prompt, opts: _opts });
    for (const e of h.emit) onEvent(e);
  },
  stopClaude: async (runId) => {
    h.stopCalls.push(runId);
  },
};

_setTransport(stubTransport);

const RUNCOMPLETE = { type: "runComplete", data: { exitCode: 0 } };

// --- cwdLabel ---
describe("cwdLabel", () => {
  test("returns the basename of a unix path", () => {
    assert.equal(cwdLabel("/home/u/projects/praetorium"), "praetorium");
  });
  test("ignores a trailing slash", () => {
    assert.equal(cwdLabel("/home/u/projects/praetorium/"), "praetorium");
  });
  test("handles Windows separators", () => {
    assert.equal(cwdLabel("C:\\Users\\guill\\praetorium"), "praetorium");
  });
  test("handles a trailing Windows separator", () => {
    assert.equal(cwdLabel("C:\\Users\\guill\\praetorium\\"), "praetorium");
  });
  test("falls back to 'local run' when undefined", () => {
    assert.equal(cwdLabel(undefined), "local run");
  });
  test("falls back to 'local run' for an empty string", () => {
    assert.equal(cwdLabel(""), "local run");
  });
});

// --- repoLabel ---
describe("repoLabel", () => {
  test("extracts repo from worktree path", () => {
    assert.equal(repoLabel("/home/u/myrepo/.claude/worktrees/feat-branch"), "myrepo");
  });
  test("returns undefined when not in a worktree", () => {
    assert.equal(repoLabel("/home/u/projects/praetorium"), undefined);
  });
  test("returns undefined for undefined", () => {
    assert.equal(repoLabel(undefined), undefined);
  });
});

// --- nextStatus ---
describe("nextStatus", () => {
  test("running → done on runComplete", () => {
    assert.equal(nextStatus("running", { type: "runComplete", data: { exitCode: 0 } }), "done");
  });
  test("running → failed on runError", () => {
    assert.equal(nextStatus("running", { type: "runError", data: { message: "x" } }), "failed");
  });
  test("running → failed on errored result", () => {
    assert.equal(nextStatus("running", { type: "result", data: { isError: true, result: "x" } }), "failed");
  });
  test("failed stays failed on a later runComplete", () => {
    assert.equal(nextStatus("failed", { type: "runComplete", data: { exitCode: 1 } }), "failed");
  });
  test("stopped is sticky", () => {
    assert.equal(nextStatus("stopped", { type: "runComplete", data: { exitCode: -1 } }), "stopped");
  });
  test("non-terminal events keep the status", () => {
    assert.equal(nextStatus("running", { type: "assistantText", data: { text: "hi", parentToolUseId: null } }), "running");
  });
});

// --- newLocalSession ---
describe("newLocalSession", () => {
  test("allocates ids sequentially, each idle", () => {
    const a = newLocalSession();
    assert.ok(typeof a === "string");
    assert.equal(localSessionsStore.get().get(a)?.status, "idle");
    const b = newLocalSession();
    assert.notEqual(a, b);
    assert.ok(/^local(-\d+)?$/.test(b));
  });
});

// --- startRun ---
describe("startRun", () => {
  beforeEach(() => {
    h.runCalls = [];
    h.stopCalls = [];
    h.lastOnEvent = null;
    h.emit = [RUNCOMPLETE];
  });

  test("forwards opts (no resumeId on first run) and a generated runId", async () => {
    const sid = newLocalSession();
    await startRun(sid, "hello", { cwd: "/home/u/proj", model: "opus" });
    assert.equal(h.runCalls.length, 1);
    const { runId, prompt, opts } = h.runCalls[0];
    assert.equal(typeof runId, "string");
    assert.equal(prompt, "hello");
    assert.equal(opts.cwd, "/home/u/proj");
    assert.equal(opts.model, "opus");
    assert.equal(opts.resumeId, undefined);
  });

  test("ignores empty prompts", async () => {
    const sid = newLocalSession();
    await startRun(sid, "   ");
    assert.equal(h.runCalls.length, 0);
  });

  test("captures claudeSessionId from systemInit and resumes on the next run", async () => {
    const sid = newLocalSession();
    h.emit = [{ type: "systemInit", data: { sessionId: "claude-abc" } }, RUNCOMPLETE];
    await startRun(sid, "first", { cwd: "/p" });
    assert.equal(localSessionsStore.get().get(sid)?.claudeSessionId, "claude-abc");

    h.runCalls = [];
    h.emit = [RUNCOMPLETE];
    await startRun(sid, "second");
    const { opts } = h.runCalls[0];
    assert.equal(opts.cwd, "/p");
    assert.equal(opts.resumeId, "claude-abc");
  });

  test("locks cwd/model after the first run", async () => {
    const sid = newLocalSession();
    h.emit = [RUNCOMPLETE];
    await startRun(sid, "first", { cwd: "/locked", model: "opus" });
    h.runCalls = [];
    await startRun(sid, "second", { cwd: "/ignored", model: "haiku" });
    const { opts } = h.runCalls[0];
    assert.equal(opts.cwd, "/locked");
    assert.equal(opts.model, "opus");
  });

  test("sets status done on completion", async () => {
    const sid = newLocalSession();
    h.emit = [RUNCOMPLETE];
    await startRun(sid, "go");
    assert.equal(localSessionsStore.get().get(sid)?.status, "done");
  });
});

// --- concurrency ---
describe("concurrency", () => {
  beforeEach(() => {
    h.runCalls = [];
    h.stopCalls = [];
    h.lastOnEvent = null;
    h.emit = []; // leave runs in-flight
  });

  test("marks the session running and blocks a second run on it", async () => {
    const sid = newLocalSession();
    await startRun(sid, "first");
    assert.equal(isRunning(sid), true);
    await startRun(sid, "second");
    assert.equal(h.runCalls.length, 1);
  });

  test("allows different sessions concurrently", async () => {
    const a = newLocalSession();
    const b = newLocalSession();
    await startRun(a, "a");
    await startRun(b, "b");
    assert.equal(isRunning(a), true);
    assert.equal(isRunning(b), true);
    assert.equal(h.runCalls.length, 2);
  });
});

// --- stopRun ---
describe("stopRun", () => {
  beforeEach(() => {
    h.runCalls = [];
    h.stopCalls = [];
    h.lastOnEvent = null;
    h.emit = [];
  });

  test("sets status stopped and calls stopClaude with the runId", async () => {
    const sid = newLocalSession();
    await startRun(sid, "go");
    await stopRun(sid);
    assert.equal(localSessionsStore.get().get(sid)?.status, "stopped");
    assert.equal(h.stopCalls.length, 1);
    assert.equal(typeof h.stopCalls[0], "string");
  });

  test("a late runComplete does not flip stopped back to done", async () => {
    const sid = newLocalSession();
    await startRun(sid, "go");
    await stopRun(sid);
    h.lastOnEvent?.(RUNCOMPLETE);
    assert.equal(localSessionsStore.get().get(sid)?.status, "stopped");
  });
});

// --- closeSession / renameSession ---
describe("closeSession / renameSession", () => {
  beforeEach(() => { h.emit = [RUNCOMPLETE]; });

  test("closeSession removes it from localSessionsStore", async () => {
    const sid = newLocalSession();
    await closeSession(sid);
    assert.equal(localSessionsStore.get().has(sid), false);
  });

  test("renameSession sets and clears the label", () => {
    const sid = newLocalSession();
    renameSession(sid, "my run");
    assert.equal(localSessionsStore.get().get(sid)?.label, "my run");
    renameSession(sid, "");
    assert.equal(localSessionsStore.get().get(sid)?.label, undefined);
  });
});

// --- isLocalSession ---
describe("isLocalSession (membership)", () => {
  test("true once a session is in the map", () => {
    adoptSession({ id: "claude-xyz", project: "p", title: "t", lastActivityMs: 0, state: "idle", cwd: "/p" });
    assert.equal(isLocalSession("claude-xyz"), true);
  });
  test("false for an unknown id", () => {
    assert.equal(isLocalSession("nope-not-here"), false);
  });
  test("false for null/undefined", () => {
    assert.equal(isLocalSession(null), false);
    assert.equal(isLocalSession(undefined), false);
  });
});

// --- adoptSession ---
describe("adoptSession (resume in place)", () => {
  beforeEach(() => { h.runCalls = []; h.emit = [RUNCOMPLETE]; });

  test("adds an owned entry carrying claudeSessionId and cwd", () => {
    adoptSession({ id: "claude-r", project: "p", title: "t", lastActivityMs: 0, state: "idle", cwd: "/work/dir" });
    const s = localSessionsStore.get().get("claude-r");
    assert.equal(s?.claudeSessionId, "claude-r");
    assert.equal(s?.cwd, "/work/dir");
  });

  test("a subsequent run resumes via the adopted claudeSessionId", async () => {
    adoptSession({ id: "claude-r2", project: "p", title: "t", lastActivityMs: 0, state: "idle", cwd: "/d" });
    await startRun("claude-r2", "go");
    const { opts } = h.runCalls[0];
    assert.equal(opts.cwd, "/d");
    assert.equal(opts.model, undefined);
    assert.equal(opts.resumeId, "claude-r2");
  });
});

// --- ownedClaudeIds ---
describe("ownedClaudeIds (suppress observed mirror)", () => {
  beforeEach(() => { h.runCalls = []; });

  test("includes the CLI session id captured from systemInit on a local run", async () => {
    const sid = newLocalSession();
    h.emit = [{ type: "systemInit", data: { sessionId: "cli-generated-1" } }, RUNCOMPLETE];
    await startRun(sid, "go");
    assert.ok(ownedClaudeIds().has("cli-generated-1"));
    assert.notEqual(sid, "cli-generated-1");
  });

  test("includes the id of an adopted (resumed) session", () => {
    adoptSession({ id: "claude-adopted", project: "p", title: "t", lastActivityMs: 0, state: "idle", cwd: "/d" });
    assert.ok(ownedClaudeIds().has("claude-adopted"));
  });
});
