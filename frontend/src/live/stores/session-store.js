import { createStore } from "./create-store.js";
import { reduceWatch, emptyGraph, clearSession as clearGraphSession } from "../lib/graph.js";
import { reduceInsights, emptyInsights } from "../lib/insightsStore.js";
import { listLiveSessions } from "../lib/sessions.js";
import { truncateText } from "../lib/truncate.js";

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

// Externally-observed sessions are never explicitly closed, so retention is
// bounded here: keep the most recently touched N, plus whatever has focus and
// whatever we drive ourselves.
export const MAX_LIVE_SESSIONS = 12;
const lastTouched = new Map(); // sessionId -> monotonic counter
let touchSeq = 0;

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

/** Apply a burst of watch events as ONE commit per store. The watcher emits an
 *  event per appended transcript line; committing per event re-rendered the
 *  whole console that many times per frame. */
export function applyWatchBatch(events, opts) {
  const relevant = events.filter(
    (e) => e.type === "session" && !(opts?.external && isOwned(e.data.sessionId)), // owned run is source of truth
  );
  if (relevant.length === 0) return;
  for (const e of relevant) lastTouched.set(e.data.sessionId, ++touchSeq);

  sessionsStore.set((prev) => {
    const next = new Map(prev);
    for (const e of relevant) {
      const { sessionId, project, repo, event, agentRef } = e.data;
      const cur = next.get(sessionId) ?? { project, repo: repo ?? undefined, lines: [] };
      cur.project = cur.project ?? project;
      cur.repo = cur.repo ?? repo ?? undefined;
      if (event.kind === "turn") {
        cur.lines = [...cur.lines.slice(-499), { agentRef, role: event.data.role, text: truncateText(event.data.text) }];
      }
      next.set(sessionId, cur);
    }
    return next;
  });

  const spawns = relevant.filter((e) => e.data.event.kind === "subagentSpawn");
  if (spawns.length > 0) {
    subagentTypesStore.set((prev) => {
      const next = new Map(prev);
      for (const { data: { sessionId, event } } of spawns) {
        next.set(`${sessionId}:${event.data.toolUseId}`, event.data.subagentType || "agent");
      }
      return next;
    });
  }

  graphStore.set((g) => relevant.reduce(reduceWatch, g));
  // Stamp arrival time here (live-only scope): the insights store has no Rust
  // timestamps. One stamp for the batch — they arrived in the same frame.
  const now = Date.now();
  insightsStore.set((i) => relevant.reduce((acc, e) => reduceInsights(acc, e, now), i));

  if (activeIdStore.get() === null) activeIdStore.set(relevant[0].data.sessionId);
}

export function applyWatch(e, opts) {
  applyWatchBatch([e], opts);
}

/** Drop all but the most recently touched MAX_LIVE_SESSIONS. `clearSession`
 *  wipes the session from sessionsStore, insightsStore, subagentTypesStore and
 *  the graph, so eviction reclaims all four. */
export function pruneSessions() {
  const sessions = sessionsStore.get();
  if (sessions.size <= MAX_LIVE_SESSIONS) return;

  const active = activeIdStore.get();
  // Pinned: the one in focus, and anything we drive locally — a local run has
  // no watch events to touch it, so recency would evict it first.
  const pinned = new Set([...sessions.keys()].filter((id) => id === active || isOwned(id)));
  const ranked = [...sessions.keys()]
    .filter((id) => !pinned.has(id))
    .sort((a, b) => (lastTouched.get(b) ?? 0) - (lastTouched.get(a) ?? 0));

  const keep = new Set([...pinned, ...ranked.slice(0, Math.max(0, MAX_LIVE_SESSIONS - pinned.size))]);
  for (const id of sessions.keys()) {
    if (!keep.has(id)) {
      clearSession(id);
      lastTouched.delete(id);
    }
  }
}
