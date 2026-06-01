import { createStore } from "./create-store.js";
import { basename } from "../lib/path.js";
import * as _claudeLib from "../lib/claude.js";
import { applyWatch, ensureSession, removeSession, setActiveId, activeIdStore, setOwnershipProbe } from "./session-store.js";

// Seam for testing: replace with stubs via _setTransport({ runClaude, stopClaude })
let _transport = _claudeLib;
export function _setTransport(t) { _transport = t; }

const LOCAL_PROJECT = "local run";

/** Pure status transition for a session given a streamed event. `stopped` is sticky. */
export function nextStatus(prev, ev) {
  if (prev === "stopped") return "stopped";
  switch (ev.type) {
    case "runError":
      return "failed";
    case "result":
      return ev.data.isError ? "failed" : prev;
    case "runComplete":
      return prev === "failed" ? "failed" : "done";
    default:
      return prev;
  }
}

export const localSessionsStore = createStore(new Map());

/** True for any owned (locally-driven) session — one present in the map. This
 *  includes both `newLocalSession` ids and observed sessions adopted for resume. */
export function isLocalSession(id) {
  return !!id && localSessionsStore.get().has(id);
}

/** Claude session ids currently driven by an owned local session — captured from
 *  systemInit on a run, or seeded by adoptSession. The `claude` CLI writes its
 *  transcript under this id, which the file-watcher would otherwise surface as a
 *  duplicate "observed" mirror of a run we already own. Used to suppress it. */
export function ownedClaudeIds() {
  const out = new Set();
  for (const s of localSessionsStore.get().values()) if (s.claudeSessionId) out.add(s.claudeSessionId);
  return out;
}

export function isRunning(sid) {
  return localSessionsStore.get().get(sid)?.status === "running";
}
export function anyRunning() {
  return [...localSessionsStore.get().values()].some((s) => s.status === "running");
}

function updateSession(sid, patch) {
  localSessionsStore.set((prev) => {
    const cur = prev.get(sid);
    if (!cur) return prev;
    return new Map(prev).set(sid, { ...cur, ...patch });
  });
}

let localCount = 0;
/** Allocate a fresh local session ("local", then "local-2", …), seed it so it
 *  shows in the rail immediately, make it active, and return its id. */
export function newLocalSession() {
  localCount += 1;
  const sid = localCount === 1 ? "local" : `local-${localCount}`;
  localSessionsStore.set((prev) => new Map(prev).set(sid, { sid, status: "idle" }));
  ensureSession(sid);
  setActiveId(sid);
  return sid;
}

/** Adopt an observed session as an owned one so it can be resumed in place:
 *  key it under its own Claude session id, seed claudeSessionId (the resume
 *  target) and the real cwd, and focus it. No-op if already owned. */
export function adoptSession(meta) {
  if (localSessionsStore.get().has(meta.id)) { setActiveId(meta.id); return; }
  localSessionsStore.set((prev) => new Map(prev).set(meta.id, {
    sid: meta.id, claudeSessionId: meta.id, cwd: meta.cwd, status: "idle",
  }));
  ensureSession(meta.id);
  setActiveId(meta.id);
}

/** Derive the local session's project label from the chosen cwd: its basename,
 *  or "local run" when no cwd is set. Tolerates trailing and Windows separators. */
export function cwdLabel(cwd) {
  if (!cwd) return LOCAL_PROJECT;
  return basename(cwd) || LOCAL_PROJECT;
}

/** Parent-repo label for a git-worktree cwd (.../<repo>/.claude/worktrees/<name>).
 *  Returns the segment just before `.claude` so worktrees nest under their repo;
 *  undefined when the cwd isn't inside a worktree. */
export function repoLabel(cwd) {
  if (!cwd) return undefined;
  const parts = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  const i = parts.findIndex((p, idx) => p === ".claude" && parts[idx + 1] === "worktrees");
  return i > 0 ? parts[i - 1] : undefined;
}

/** Translate a locally-launched run's ClaudeEvent into a WatchEvent so the app's
 *  own run flows through the same sessionStore pipeline as observed sessions. */
function toWatch(ev, sid, project, repo) {
  const wrap = (agentRef, event) =>
    ({ type: "session", data: { sessionId: sid, project, repo, agentRef, event } });
  switch (ev.type) {
    case "assistantText":
      return wrap(ev.data.parentToolUseId ?? "master", { kind: "turn", data: { role: "assistant", text: ev.data.text } });
    case "subagentSpawn":
      return wrap(ev.data.parentToolUseId ?? "master", { kind: "subagentSpawn", data: { toolUseId: ev.data.toolUseId, subagentType: ev.data.subagentType } });
    case "toolCall":
      return wrap(ev.data.parentToolUseId ?? "master", { kind: "toolActivity", data: { toolUseId: ev.data.toolUseId, name: ev.data.name, filePath: ev.data.filePath } });
    case "toolResult":
      return wrap(ev.data.parentToolUseId ?? "master", { kind: "toolDone", data: { toolUseId: ev.data.toolUseId, isError: ev.data.isError } });
    default:
      return null;
  }
}

export async function startRun(sid, prompt, opts) {
  const s = localSessionsStore.get().get(sid);
  if (!s || s.status === "running" || !prompt.trim()) return;
  // Lock cwd/model onto the thread on the first run; ignore opts thereafter.
  const cwd = s.cwd ?? opts?.cwd;
  const model = s.model ?? opts?.model;
  const project = s.label ?? cwdLabel(cwd);
  const repo = repoLabel(cwd);
  const runId = crypto.randomUUID();
  const resumeId = s.claudeSessionId;
  const turn = (role, text) =>
    ({ type: "session", data: { sessionId: sid, project, repo, agentRef: "master", event: { kind: "turn", data: { role, text } } } });

  updateSession(sid, { status: "running", runId, cwd, model });
  applyWatch(turn("user", prompt));
  try {
    await _transport.runClaude(runId, prompt, (ev) => {
      if (ev.type === "systemInit") updateSession(sid, { claudeSessionId: ev.data.sessionId });
      const w = toWatch(ev, sid, project, repo);
      if (w) applyWatch(w);
      else if (ev.type === "result" && ev.data.isError) applyWatch(turn("assistant", ev.data.result));
      else if (ev.type === "runError") applyWatch(turn("assistant", ev.data.message));
      const prev = localSessionsStore.get().get(sid)?.status ?? "running";
      updateSession(sid, { status: nextStatus(prev, ev) });
    }, { cwd, model, resumeId });
  } catch (e) {
    applyWatch(turn("assistant", String(e)));
    updateSession(sid, { status: "failed" });
  }
}

export async function stopRun(sid) {
  const s = localSessionsStore.get().get(sid);
  if (!s || s.status !== "running" || !s.runId) return;
  updateSession(sid, { status: "stopped" });
  await _transport.stopClaude(s.runId);
}

export async function closeSession(sid) {
  const s = localSessionsStore.get().get(sid);
  if (!s) return;
  if (s.status === "running") await stopRun(sid);
  localSessionsStore.set((prev) => {
    if (!prev.has(sid)) return prev;
    const next = new Map(prev);
    next.delete(sid);
    return next;
  });
  removeSession(sid);
  if (activeIdStore.get() === null) {
    const fallback = [...localSessionsStore.get().keys()][0];
    if (fallback) setActiveId(fallback);
  }
}

export function renameSession(sid, label) {
  updateSession(sid, { label: label.trim() || undefined });
}

// Let sessionStore drop file-watch events for sessions we already drive.
setOwnershipProbe((id) => localSessionsStore.get().has(id) || ownedClaudeIds().has(id));
