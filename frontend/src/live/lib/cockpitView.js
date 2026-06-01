// Pure view-model joining the three live stores (graph topology, insights
// per-call data, session metas) into the fields the Cockpit renders. No Solid
// signals here so every function is unit-testable as plain (in) → (out).

// ---- tool categorization --------------------------------------------------
export function toolCategory(name) {
  switch (name) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Bash":
      return "bash";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Grep":
    case "Glob":
      return "search";
    default:
      return "other";
  }
}

/** Pulse / swatch color per tool category (CSS var references; resolved by the DOM). */
export const CATEGORY_COLOR = {
  read: "var(--accent)",
  edit: "var(--warn)",
  bash: "var(--good)",
  web: "#b98bf0",
  search: "var(--gull)",
  other: "var(--gull-2)",
};

/** A node is "idle" once it has gone this long without observed activity. */
export const IDLE_MS = 30_000;
/** calls-in-last-10s that maps to full heat intensity. */
const RATE_FULL = 6;
const RECENT_WINDOW_MS = 10_000;
const SPARK_BUCKETS = 60; // one per second, last 60s
const DONE_AGENTS_CAP = 50; // most-recent finished subagents retained for the detail panel

// ---- collapse finished subagents ------------------------------------------
/** Fold every FINISHED (complete/failed) subagent into a `done` count on its
 *  parent master, removing the node but redirecting the folders it touched to
 *  the master so the "where" trace survives. Running subagents stay as nodes.
 *  Returns the same reference when nothing collapses (cheap no-op). */
export function collapseFinishedAgents(g) {
  const parentMaster = new Map(); // agentId -> masterId
  for (const e of g.edges.values()) {
    const s = g.nodes.get(e.source), t = g.nodes.get(e.target);
    if (s?.kind === "master" && t?.kind === "agent") parentMaster.set(t.id, s.id);
  }
  const remove = new Set();
  const done = new Map();
  const failed = new Map();
  const agents = new Map();
  for (const n of g.nodes.values()) {
    if (n.kind !== "agent" || n.status === "running") continue;
    const m = parentMaster.get(n.id);
    if (!m) continue; // orphan finished agent: leave it rather than drop silently
    remove.add(n.id);
    done.set(m, (done.get(m) ?? 0) + 1);
    if (n.status === "failed") failed.set(m, (failed.get(m) ?? 0) + 1);
    const list = agents.get(m) ?? agents.set(m, []).get(m);
    list.push({ label: n.label, status: n.status });
    if (list.length > DONE_AGENTS_CAP) list.shift(); // bound memory; `done` keeps the true total
  }
  if (!remove.size) return g;

  const nodes = new Map();
  for (const [id, n] of g.nodes) {
    if (remove.has(id)) continue;
    nodes.set(id, done.has(id)
      ? { ...n, done: done.get(id), doneFailed: failed.get(id) ?? 0, doneAgents: agents.get(id) }
      : n);
  }
  const edges = new Map();
  for (const [id, e] of g.edges) {
    if (remove.has(e.target)) continue;          // edge into a removed agent
    if (remove.has(e.source)) {                  // edge out of a removed agent
      const t = g.nodes.get(e.target);
      const m = parentMaster.get(e.source);
      if (t?.kind === "folder" && m && nodes.has(m) && nodes.has(e.target)) {
        const rid = `${m}->${e.target}`;
        if (!edges.has(rid)) edges.set(rid, { id: rid, source: m, target: e.target });
      }
      continue;
    }
    if (nodes.has(e.source) && nodes.has(e.target)) edges.set(id, e);
  }
  return { nodes, edges, activity: g.activity };
}

// ---- prune archived sessions ----------------------------------------------
/** Keep only what a live session anchors. Visible master/agent nodes are roots;
 *  a folder survives when a kept session points at it (shared folders stay shared),
 *  and a project survives when it still owns a kept child — so repo->worktree chains
 *  collapse cleanly and empty repo/worktree hubs (archived-only) are dropped.
 *  `isVisible` decides whether a session id is still live. */
export function pruneArchived(g, isVisible) {
  const outT = new Map(); // source -> targets
  const inS = new Map();  // target -> sources
  for (const e of g.edges.values()) {
    if (!g.nodes.has(e.source) || !g.nodes.has(e.target)) continue;
    (outT.get(e.source) ?? outT.set(e.source, []).get(e.source)).push(e.target);
    (inS.get(e.target) ?? inS.set(e.target, []).get(e.target)).push(e.source);
  }
  const keep = new Set();
  for (const n of g.nodes.values())
    if ((n.kind === "master" || n.kind === "agent") && isVisible(n.session)) keep.add(n.id);
  // Fixpoint: folders need a kept source; projects need a kept target (repo->worktree->master).
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of g.nodes.values()) {
      if (keep.has(n.id)) continue;
      const ok = n.kind === "folder" ? (inS.get(n.id) ?? []).some((s) => keep.has(s))
        : n.kind === "project" ? (outT.get(n.id) ?? []).some((t) => keep.has(t))
        : false;
      if (ok) { keep.add(n.id); changed = true; }
    }
  }
  const nodes = new Map();
  for (const [id, n] of g.nodes) if (keep.has(id)) nodes.set(id, n);
  const edges = new Map();
  for (const [id, e] of g.edges) if (nodes.has(e.source) && nodes.has(e.target)) edges.set(id, e);
  return { nodes, edges, activity: g.activity };
}

// ---- collapse same-title sessions -----------------------------------------
/** Collapse same-title sessions (same triggering prompt, within a project) into one
 *  grouped master node with a ×count. Their subagents/folders re-link to the group.
 *  `titleOf` resolves a session id to its display title. */
export function collapseByTitle(g, titleOf) {
  const remap = new Map();
  const nodes = new Map();
  const count = new Map();
  for (const n of g.nodes.values()) {
    if (n.kind === "master" && n.session) {
      // Normalize the title (trim + 60-char prefix) so the same prompt always groups,
      // regardless of whether the title came from the 80-char meta or the full transcript.
      const gid = `grp:${n.label}:${titleOf(n.session).trim().slice(0, 60)}`; // n.label = project
      remap.set(n.id, gid);
      count.set(gid, (count.get(gid) ?? 0) + 1);
      if (!nodes.has(gid)) nodes.set(gid, { id: gid, kind: "master", label: n.label, status: "running", session: n.session });
    } else if (!nodes.has(n.id)) {
      nodes.set(n.id, n);
    }
  }
  for (const [gid, c] of count) { const node = nodes.get(gid); if (node) nodes.set(gid, { ...node, weight: c }); }
  const edges = new Map();
  for (const e of g.edges.values()) {
    const s = remap.get(e.source) ?? e.source;
    const t = remap.get(e.target) ?? e.target;
    if (s === t) continue;
    const id = `${s}->${t}`;
    if (!edges.has(id)) edges.set(id, { id, source: s, target: t });
  }
  return { nodes, edges, activity: g.activity };
}

// ---- per-node liveness ----------------------------------------------------

/** Graph node id a session+agentRef maps to (mirrors graph.ts attribution). */
const nodeIdFor = (sid, agentRef) =>
  agentRef === "master" ? `${sid}:master` : `${sid}:${agentRef}`;

const callEdgeMs = (c) => Math.max(c.startMs, c.endMs ?? c.startMs);

/** Per agent/master node liveness derived from insights, keyed by graph node id. */
export function buildNodeLive(insights, nowMs) {
  // Accumulate raw fields, then derive idle/rate.
  const acc = new Map();
  for (const [sid, calls] of insights) {
    for (const c of calls) {
      const id = nodeIdFor(sid, c.agentRef);
      const a = acc.get(id) ?? { count: 0, fails: 0, last: -Infinity, recent: 0, lastStart: -Infinity };
      a.count++;
      if (c.status === "error") a.fails++;
      const edge = callEdgeMs(c);
      if (edge > a.last) a.last = edge;
      if (c.startMs >= a.lastStart) { a.lastStart = c.startMs; a.lastTool = toolCategory(c.name); }
      if (nowMs - c.startMs <= RECENT_WINDOW_MS) a.recent++;
      acc.set(id, a);
    }
  }
  const out = new Map();
  for (const [id, a] of acc) {
    const lastActivityMs = a.last === -Infinity ? undefined : a.last;
    out.set(id, {
      callCount: a.count,
      failCount: a.fails,
      lastActivityMs,
      idleMs: lastActivityMs === undefined ? undefined : Math.max(0, nowMs - lastActivityMs),
      recentRate: Math.min(1, a.recent / RATE_FULL),
      lastTool: a.lastTool,
    });
  }
  return out;
}

// ---- machine-wide aggregates ----------------------------------------------

/** Idle if no node-live activity yet, or stale beyond IDLE_MS. */
const isIdle = (live) =>
  !live || live.idleMs === undefined || live.idleMs > IDLE_MS;

export function buildAggregates(graph, live, insights, nowMs) {
  let agents = 0, sessions = 0, folders = 0, fails = 0, idle = 0;
  for (const n of graph.nodes.values()) {
    if (n.kind === "agent") agents++;
    else if (n.kind === "master") sessions++;
    else if (n.kind === "folder") folders++;
    if (n.kind === "agent" || n.kind === "master") {
      if (n.status === "failed") fails++;
      fails += n.doneFailed ?? 0; // failures from collapsed subagents stay counted
      // Idle = running but quiet; finished (complete/failed) nodes aren't "idle".
      if (n.status === "running" && isIdle(live.get(n.id))) idle++;
    }
  }
  // Sparkline: bucket every call's startMs into the last SPARK_BUCKETS seconds.
  const callsPerSec = new Array(SPARK_BUCKETS).fill(0);
  const windowMs = SPARK_BUCKETS * 1000;
  for (const calls of insights.values()) {
    for (const c of calls) {
      const age = nowMs - c.startMs;
      if (age < 0 || age >= windowMs) continue;
      const bucket = SPARK_BUCKETS - 1 - Math.floor(age / 1000);
      if (bucket >= 0 && bucket < SPARK_BUCKETS) callsPerSec[bucket]++;
    }
  }
  return { agents, sessions, folders, fails, idle, callsPerSec };
}

// ---- selected-node detail -------------------------------------------------
const MAX_DETAIL_CALLS = 8;

/** Outgoing targets of `id` whose node has the given kind. */
function targetsOfKind(graph, id, kind) {
  const out = [];
  for (const e of graph.edges.values()) {
    if (e.source !== id) continue;
    const t = graph.nodes.get(e.target);
    if (t && t.kind === kind) out.push(t);
  }
  return out;
}

export function buildDetail(graph, nodeId, insights, metas, nowMs) {
  const node = graph.nodes.get(nodeId);
  if (!node) return null;

  const sid = node.session;
  const meta = sid ? metas.get(sid) : undefined;
  const all = sid ? insights.get(sid) ?? [] : [];

  // Master → whole-session calls; agent → that agent's calls only.
  let scoped = all;
  if (node.kind === "agent" && sid) {
    const ref = nodeId.startsWith(`${sid}:`) ? nodeId.slice(sid.length + 1) : nodeId;
    scoped = all.filter((c) => c.agentRef === ref);
  } else if (node.kind === "master") {
    // master node id is `${sid}:master`; keep every call in the session.
    scoped = all;
  }

  const fails = scoped.reduce((n, c) => n + (c.status === "error" ? 1 : 0), 0);
  const starts = scoped.map((c) => c.startMs);
  const ends = scoped.map(callEdgeMs);
  const firstStart = starts.length ? Math.min(...starts) : undefined;
  const lastEdge = ends.length ? Math.max(...ends) : undefined;
  const durationMs = firstStart !== undefined && lastEdge !== undefined ? lastEdge - firstStart : undefined;
  const idleMs = lastEdge !== undefined ? Math.max(0, nowMs - lastEdge) : undefined;

  const recentCalls = scoped
    .slice(-MAX_DETAIL_CALLS)
    .map((c) => ({
      tool: toolCategory(c.name),
      name: c.name,
      target: c.filePath ?? undefined,
      status: c.status,
      durMs: c.endMs !== undefined ? c.endMs - c.startMs : undefined,
    }));

  const subagents = targetsOfKind(graph, nodeId, "agent").map((a) => ({ label: a.label, status: a.status }));

  // Folders touched = folders linked from this node and from its subagent children.
  const folderSet = new Set();
  for (const f of targetsOfKind(graph, nodeId, "folder")) folderSet.add(f.label);
  for (const a of subagents.length ? targetsOfKind(graph, nodeId, "agent") : []) {
    for (const f of targetsOfKind(graph, a.id, "folder")) folderSet.add(f.label);
  }

  return {
    sessionId: sid,
    kind: node.kind,
    label: node.label,
    state: meta?.state ?? node.status,
    project: node.kind === "master" ? node.label : undefined,
    durationMs,
    fails,
    calls: scoped.length,
    idleMs,
    recentCalls,
    subagents,
    subagentsDone: node.done,
    doneSubagents: node.doneAgents,
    folders: [...folderSet],
  };
}
