import { createStore } from "./create-store.js";
import { reduceWatch, emptyGraph, clearSession as clearGraphSession } from "../lib/graph.js";
import { reduceInsights, emptyInsights } from "../lib/insightsStore.js";
import { listLiveSessions } from "../lib/sessions.js";

export const sessionsStore = createStore(new Map());
export const graphStore = createStore(emptyGraph());
export const insightsStore = createStore(emptyInsights());
// Default focus is the synthetic local console so its input shows on load and
// an externally-observed session arriving first doesn't steal focus (and hide it).
export const activeIdStore = createStore("local");
export const metasStore = createStore(new Map());
// `${sessionId}:${toolUseId}` -> subagent type, so the Console can name nested agents.
export const subagentTypesStore = createStore(new Map());

export const setActiveId = (v) => activeIdStore.set(v);

// Injected by runStore: reports whether a session id is locally driven (owned).
// Used to drop duplicate file-watch events for sessions we already stream.
let isOwned = () => false;
export function setOwnershipProbe(fn) { isOwned = fn; }

/** Wipe one session from every live store (transcript, insights, subagent names,
 *  constellation graph). Used by the Console's NEW button to reset the local run. */
export function clearSession(id) {
  sessionsStore.set((prev) => { const next = new Map(prev); next.delete(id); return next; });
  insightsStore.set((prev) => { const next = new Map(prev); next.delete(id); return next; });
  subagentTypesStore.set((prev) => {
    const next = new Map(prev);
    for (const k of prev.keys()) if (k.startsWith(`${id}:`)) next.delete(k);
    return next;
  });
  graphStore.set((g) => clearGraphSession(g, id));
}

/** Seed an empty session so it appears in the rail before any turns arrive.
 *  No-op if the session already exists. */
export function ensureSession(sid, project) {
  sessionsStore.set((prev) => {
    if (prev.has(sid)) return prev;
    return new Map(prev).set(sid, { project, lines: [] });
  });
}

/** Remove a session entirely (used when closing a local session). */
export function removeSession(sid) {
  sessionsStore.set((prev) => {
    if (!prev.has(sid)) return prev;
    const next = new Map(prev);
    next.delete(sid);
    return next;
  });
  if (activeIdStore.get() === sid) activeIdStore.set(null);
}

export async function refreshMetas() {
  const list = await listLiveSessions();
  metasStore.set(new Map(list.map((m) => [m.id, m])));
}

export function applyWatch(e, opts) {
  if (e.type !== "session") return;
  if (opts?.external && isOwned(e.data.sessionId)) return; // owned run is source of truth
  const { sessionId, project, repo, event, agentRef } = e.data;
  sessionsStore.set((prev) => {
    const next = new Map(prev);
    const cur = next.get(sessionId) ?? { project, repo: repo ?? undefined, lines: [] };
    cur.project = cur.project ?? project;
    cur.repo = cur.repo ?? repo ?? undefined;
    if (event.kind === "turn") {
      cur.lines = [...cur.lines.slice(-499), { agentRef, role: event.data.role, text: event.data.text }];
    }
    next.set(sessionId, cur);
    return next;
  });
  if (event.kind === "subagentSpawn") {
    subagentTypesStore.set((prev) => new Map(prev).set(`${sessionId}:${event.data.toolUseId}`, event.data.subagentType || "agent"));
  }
  graphStore.set((g) => reduceWatch(g, e));
  // Stamp arrival time here (live-only scope): the insights store has no Rust timestamps.
  insightsStore.set((i) => reduceInsights(i, e, Date.now()));
  if (activeIdStore.get() === null) activeIdStore.set(sessionId);
}
