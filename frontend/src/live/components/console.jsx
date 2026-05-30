import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  sessionsStore,
  insightsStore as insightsStoreObj,
  activeIdStore,
  metasStore,
  subagentTypesStore,
  setActiveId,
} from "../stores/session-store.js";
import {
  localSessionsStore,
  startRun,
  stopRun,
  closeSession,
  renameSession,
  isRunning,
  newLocalSession,
  isLocalSession,
  cwdLabel,
  adoptSession,
  ownedClaudeIds,
} from "../stores/run-store.js";
import { useStore } from "../stores/use-store.js";
import { appCwd } from "../lib/sessions.js";
import { buildRail } from "../lib/consoleRail.js";
import { buildAgentNames } from "../lib/agentNaming.js";
import { failures } from "../lib/insightsStore.js";

// ---- inline style tokens (native theme vars only; no shared-CSS edits) ----
const MONO = 'var(--font-mono, "JetBrains Mono")';

const statusColor = (failCount, status) =>
  failCount > 0 ? "var(--bad)"
  : status === "running" ? "var(--accent)"
  : status === "idle" ? "var(--gull-2)"
  : "var(--good)";

export function Console() {
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState(undefined);
  const [model, setModel] = useState("default");
  const [timelineOpen, setTimelineOpen] = useState(true);
  // 1s heartbeat so open-ended (running) bars keep growing between watch events.
  const [now, setNow] = useState(() => Date.now());
  const [appDir, setAppDir] = useState(undefined);
  const [viewRef, setViewRef] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [openGroups, setOpenGroups] = useState(() => new Set());

  const streamRef = useRef(null);

  // Store subscriptions
  const sessions = useStore(sessionsStore);
  const insightsState = useStore(insightsStoreObj);
  const activeId = useStore(activeIdStore);
  const metas = useStore(metasStore);
  const subagentTypesMap = useStore(subagentTypesStore);
  const localSessions = useStore(localSessionsStore);

  // 1s heartbeat
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  // Load appCwd on mount
  useEffect(() => {
    appCwd().then((v) => setAppDir(v));
  }, []);

  // Show only live sessions (in the index, active within ~10 min) + local runs;
  // hide archived, and hide the watcher's "observed" mirror of a run we own
  const list = useMemo(() => {
    const owned = ownedClaudeIds();
    return [...sessions.entries()].filter(([id]) =>
      isLocalSession(id) || (metas.has(id) && !owned.has(id)));
  }, [sessions, metas, localSessions]);

  const active = activeId ? sessions.get(activeId) : undefined;

  // Disable the input/RUN only when the *active* local session is itself in-flight
  const activeRunning = isLocalSession(activeId) && isRunning(activeId);

  const sess = (id) => localSessions.get(id);
  const activeSess = isLocalSession(activeId) ? sess(activeId) : undefined;
  const canContinue = !!activeSess?.claudeSessionId;
  const locked = !!(activeSess && (activeSess.cwd !== undefined || activeSess.model !== undefined) && activeSess.status !== "idle");

  // ---- Run Insights: tool-call timeline + failure radar ----
  const calls = (id) => (id ? insightsState.get(id) ?? [] : []);
  const activeCalls = calls(activeId);
  const failCount = (id) => (id ? failures(insightsState, id) : 0);
  const failingCalls = activeCalls.filter((c) => c.status === "error");

  // Basename for the failure list; keeps long paths from blowing out the banner.
  const baseName = (p) => p.split(/[\\/]/).pop() || p;
  // First non-empty line of the captured error — CSS handles the horizontal ellipsis.
  const firstLine = (s) => s.split("\n").find((l) => l.trim()) ?? s;

  // Ordered swimlanes: master first, then each subagent ref in first-seen order.
  const lanes = useMemo(() => {
    const seen = [];
    for (const c of activeCalls) if (!seen.includes(c.agentRef)) seen.push(c.agentRef);
    return seen.sort((a, b) => (a === "master" ? -1 : b === "master" ? 1 : 0));
  }, [activeCalls]);

  // Time window relative to the session's first call; min 1s so bars stay visible.
  const span = useMemo(() => {
    const cs = activeCalls;
    if (cs.length === 0) return { t0: 0, ms: 1000 };
    const t0 = Math.min(...cs.map((c) => c.startMs));
    const tEnd = Math.max(...cs.map((c) => c.endMs ?? now));
    return { t0, ms: Math.max(1000, tEnd - t0) };
  }, [activeCalls, now]);

  // Stable, legible names for nested agents
  const agentNames = useMemo(() => {
    const refs = [];
    for (const l of active?.lines ?? []) if (l.agentRef !== "master" && !refs.includes(l.agentRef)) refs.push(l.agentRef);
    for (const c of activeCalls) if (c.agentRef !== "master" && !refs.includes(c.agentRef)) refs.push(c.agentRef);
    const typeOf = (r) => subagentTypesMap.get(`${activeId}:${r}`);
    return buildAgentNames(refs, typeOf);
  }, [active, activeCalls, activeId, subagentTypesMap]);

  const agentName = (ref) => agentNames.get(ref) ?? ref;
  const laneName = (ref) => (ref === "master" ? "master" : agentName(ref));

  function scrollToAgent(ref) {
    streamRef.current?.querySelector(`[data-agent-ref="${CSS.escape(ref)}"]`)?.scrollIntoView({ block: "center" });
  }
  function scrollToFirstFailure() {
    const f = activeCalls.find((c) => c.status === "error");
    if (f) scrollToAgent(f.agentRef);
  }

  const activeTitle = useMemo(() => {
    if (!activeId) return "";
    return metas.get(activeId)?.title ?? sessions.get(activeId)?.project ?? activeId.slice(0, 8);
  }, [activeId, metas, sessions]);

  const railSubs = useCallback((id) => {
    const lines = sessions.get(id)?.lines ?? [];
    const refs = [];
    const steps = new Map();
    for (const l of lines) if (l.agentRef !== "master") {
      if (!refs.includes(l.agentRef)) refs.push(l.agentRef);
      steps.set(l.agentRef, (steps.get(l.agentRef) ?? 0) + 1);
    }
    const names = buildAgentNames(refs, (r) => subagentTypesMap.get(`${id}:${r}`));
    return refs.map((r) => ({ ref: r, name: names.get(r) ?? r, steps: steps.get(r) ?? 0 }));
  }, [sessions, subagentTypesMap]);

  const railGroups = useMemo(() => {
    const entries = list.map(([id, s]) => {
      const ls = sess(id);
      const m = metas.get(id);
      return {
        id,
        title: ls?.label ?? m?.title ?? s.project ?? id.slice(0, 8),
        owned: isLocalSession(id),
        observed: !isLocalSession(id) && metas.has(id),
        status: ls?.status,
        failCount: failCount(id),
        lastActivityMs: m?.lastActivityMs ?? (isLocalSession(id) ? now : 0),
        cwd: ls?.cwd ?? m?.cwd,
        subagents: railSubs(id),
      };
    });
    return buildRail(entries, appDir);
  }, [list, localSessions, metas, insightsState, now, appDir, subagentTypesMap, sessions]);

  // ---- Collapsible folder state for the rail (keyed by each group's unique dir) ----
  const defaultOpen = useMemo(() => {
    const g = railGroups;
    if (!g.length) return new Set();
    const next = new Set([g[0].dir]);
    for (const grp of g) if (grp.sessions.some((e) => e.id === activeId)) next.add(grp.dir);
    return next;
  }, [railGroups, activeId]);

  const isGroupOpen = (key) => (openGroups.size ? openGroups : defaultOpen).has(key);

  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const base = prev.size ? prev : defaultOpen;
      const next = new Set(base);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  async function submit(e) {
    e.preventDefault();
    const p = prompt;
    if (!p.trim()) return;
    setPrompt("");
    const m = model;
    const id = activeId;
    let sid;
    if (isLocalSession(id)) sid = id;
    else if (id && metas.has(id)) { adoptSession(metas.get(id)); sid = id; }
    else sid = newLocalSession();
    setViewRef(null);
    await startRun(sid, p, { cwd, model: m === "default" ? undefined : m });
  }

  async function pickCwd() {
    if (activeRunning) return;
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") setCwd(picked);
  }

  // Master stream as a flat flow: master lines verbatim, with a one-time jump
  // marker at the first appearance of each subagent
  const masterFlow = useMemo(() => {
    const out = [];
    const seenSub = new Set();
    for (const l of active?.lines ?? []) {
      if (l.agentRef === "master") out.push({ kind: "line", line: l });
      else if (!seenSub.has(l.agentRef)) { seenSub.add(l.agentRef); out.push({ kind: "marker", ref: l.agentRef }); }
    }
    return out;
  }, [active]);

  // Split tool-call lines from prose
  const toolSegs = (text) =>
    text.split("\n").map((s) => {
      const m = s.match(/^\[(\S+)(?:\s+([\s\S]+?))?\]$/);
      return m ? { tool: true, name: m[1], arg: m[2] ?? "" } : { tool: false, text: s };
    });

  // Answer lines: the last master assistant line per user turn
  const answerLines = useMemo(() => {
    const master = (active?.lines ?? []).filter((l) => l.agentRef === "master");
    const set = new Set();
    for (let i = 0; i < master.length; i++) {
      const l = master[i];
      if (l.role === "user") continue;
      const next = master[i + 1];
      if (!next) { if (!activeRunning) set.add(l); }
      else if (next.role === "user") set.add(l);
    }
    return set;
  }, [active, activeRunning]);

  // ---- presentational helpers (inline, theme-var only) ----
  const lineBase = { font: `400 12px ${MONO}`, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "1px 0" };
  const promptLineStyle = {
    ...lineBase, color: "var(--bone)", fontWeight: 500,
    borderLeft: "2px solid var(--accent)", paddingLeft: 10, margin: "10px 0 6px",
  };
  const asstLineStyle = { ...lineBase, color: "var(--gull)" };
  const answerLineStyle = { ...lineBase, color: "var(--bone)" };
  const toolLineStyle = { ...lineBase, color: "var(--gull-2)" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 280px) minmax(0, 1fr)", gap: 12, alignItems: "stretch", height: "calc(100vh - 130px)", minHeight: 440 }}>
      {/* ============ LEFT RAIL: live sessions ============ */}
      <aside className="a-card" style={{ padding: 0, overflow: "hidden", minHeight: 0 }}>
        <div className="a-card-head" style={{ margin: 0, padding: "12px 14px", borderBottom: "1px solid var(--iron-border)" }}>
          <h2>Live Sessions</h2>
          <span className="a-card-meta">{list.length} active</span>
        </div>
        <div style={{ padding: "8px 10px 10px" }}>
          <button
            className="a-pill-btn"
            type="button"
            onClick={() => newLocalSession()}
            title="start a new local session"
            style={{ width: "100%", textAlign: "center" }}
          >
            + New session
          </button>
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "0 6px 8px" }}>
          {railGroups.map((g) => {
            const open = isGroupOpen(g.dir);
            return (
              <div key={g.dir || "__root__"} style={{ marginBottom: 2 }}>
                <div
                  onClick={() => toggleGroup(g.dir)}
                  title={g.dir || g.label}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                    padding: "5px 8px", font: `500 10px ${MONO}`, color: "var(--gull-2)",
                    textTransform: "uppercase", letterSpacing: "0.08em",
                  }}
                >
                  <span style={{ width: 10, color: "var(--gull)" }}>{open ? "▾" : "▸"}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--gull)" }}>{g.label}</span>
                  {g.repo && <span style={{ color: "var(--accent-2)", letterSpacing: 0, textTransform: "none" }}>{g.repo}</span>}
                  <span style={{ color: "var(--gull-2)" }}>{g.sessions.length}</span>
                </div>
                {open && g.sessions.map((e) => {
                  const rowActive = e.id === activeId && viewRef === null;
                  return (
                    <React.Fragment key={e.id}>
                      <div
                        onClick={() => { setActiveId(e.id); setViewRef(null); }}
                        title={e.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
                          padding: "6px 8px", marginLeft: 4,
                          background: rowActive ? "var(--panel-2)" : "transparent",
                          boxShadow: rowActive ? "inset 2px 0 0 var(--accent)" : "none",
                          transition: "background 100ms",
                        }}
                      >
                        <span style={{
                          width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto",
                          background: statusColor(e.failCount, e.status),
                        }} />
                        {renaming === e.id ? (
                          <input
                            className="a-text-input"
                            autoFocus
                            defaultValue={sess(e.id)?.label ?? ""}
                            onClick={(ev) => ev.stopPropagation()}
                            onBlur={(ev) => { renameSession(e.id, ev.currentTarget.value); setRenaming(null); }}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter") { renameSession(e.id, ev.currentTarget.value); setRenaming(null); }
                              else if (ev.key === "Escape") setRenaming(null);
                            }}
                            style={{ flex: 1, minWidth: 0, padding: "2px 6px", fontSize: 12 }}
                          />
                        ) : (
                          <span
                            onDoubleClick={(ev) => { ev.stopPropagation(); if (e.owned) setRenaming(e.id); }}
                            style={{
                              flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              font: `500 12px ${MONO}`, color: rowActive ? "var(--bone)" : "var(--gull)",
                            }}
                          >
                            {e.title}
                          </span>
                        )}
                        <span style={{ font: `400 10px ${MONO}`, color: e.status === "running" ? "var(--accent)" : "var(--gull-2)" }}>
                          {e.observed ? "" : e.status === "running" ? "live" : "now"}
                        </span>
                        {e.owned && e.status === "running" && (
                          <button
                            type="button" title="stop run"
                            onClick={(ev) => { ev.stopPropagation(); void stopRun(e.id); }}
                            style={{ background: "none", border: 0, cursor: "pointer", color: "var(--bad)", font: `700 10px ${MONO}`, padding: 0 }}
                          >■</button>
                        )}
                        {e.owned && (
                          <button
                            type="button" title="close session"
                            onClick={(ev) => { ev.stopPropagation(); void closeSession(e.id); }}
                            style={{ background: "none", border: 0, cursor: "pointer", color: "var(--gull-2)", font: `700 13px ${MONO}`, padding: 0, lineHeight: 1 }}
                          >×</button>
                        )}
                        {e.observed && (
                          <span style={{ font: `400 9px ${MONO}`, color: "var(--gull-2)", textTransform: "uppercase", letterSpacing: "0.06em" }}>observed</span>
                        )}
                      </div>
                      {e.subagents.map((sub) => {
                        const subActive = e.id === activeId && viewRef === sub.ref;
                        return (
                          <div
                            key={sub.ref}
                            onClick={() => { setActiveId(e.id); setViewRef(sub.ref); }}
                            title={`${sub.name} · ${sub.steps} steps`}
                            style={{
                              display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
                              padding: "4px 8px 4px 22px", marginLeft: 4,
                              background: subActive ? "var(--panel-2)" : "transparent",
                              boxShadow: subActive ? "inset 2px 0 0 var(--accent-2)" : "none",
                            }}
                          >
                            <span style={{ color: "var(--gull-2)", font: `400 11px ${MONO}` }}>{"↳"}</span>
                            <span style={{
                              flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                              font: `400 11px ${MONO}`, color: subActive ? "var(--bone)" : "var(--gull-2)",
                            }}>{sub.name}</span>
                            <span style={{ font: `400 10px ${MONO}`, color: "var(--gull-2)" }}>{sub.steps}</span>
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
      </aside>

      {/* ============ RIGHT: transcript / stream ============ */}
      <section className="a-card" style={{ padding: 0, minHeight: 0, overflow: "hidden" }}>
        {/* breadcrumb head */}
        <div className="a-card-head" style={{ margin: 0, padding: "12px 16px", borderBottom: "1px solid var(--iron-border)" }}>
          <h2 style={{ minWidth: 0 }}>
            <span
              onClick={() => setViewRef(null)}
              style={{ cursor: "pointer", color: viewRef ? "var(--gull)" : "var(--bone)", textTransform: "none", letterSpacing: 0, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {activeTitle}
            </span>
            {viewRef && (
              <>
                <span style={{ color: "var(--gull-2)", margin: "0 2px" }}>/</span>
                <b style={{ color: "var(--bone)", textTransform: "none", letterSpacing: 0 }}>{agentName(viewRef)}</b>
              </>
            )}
          </h2>
          <span className="a-card-meta">
            {active?.lines.length ?? 0} <span style={{ color: "var(--gull-2)" }}>turns</span>
          </span>
        </div>

        {/* scroll container — keep ref + data-agent-ref intact */}
        <div ref={streamRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 16px" }}>
          {active && failCount(activeId) > 0 && (
            <div style={{ border: "1px solid var(--bad)", background: "var(--panel-2)", marginBottom: 14 }}>
              <div
                onClick={scrollToFirstFailure}
                title="scroll to first failure"
                style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "8px 12px", font: `500 11px ${MONO}`, color: "var(--bad)", textTransform: "uppercase", letterSpacing: "0.06em" }}
              >
                <span>{"▲"}</span>
                <span style={{ fontWeight: 700 }}>{failCount(activeId)}</span>
                <span>{failCount(activeId) === 1 ? "failure" : "failures"}</span>
              </div>
              {failingCalls.length > 0 && (
                <ul style={{ listStyle: "none", margin: 0, padding: "0 0 6px" }}>
                  {failingCalls.map((c, i) => (
                    <li
                      key={i}
                      onClick={() => scrollToAgent(c.agentRef)}
                      title={c.errorText ?? "scroll to this call"}
                      style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: "pointer", padding: "3px 12px", font: `400 11px ${MONO}`, overflow: "hidden" }}
                    >
                      <span style={{ color: "var(--bad)", fontWeight: 500, flex: "0 0 auto" }}>{c.name}</span>
                      {c.filePath && <span style={{ color: "var(--gull)", flex: "0 0 auto" }}>{baseName(c.filePath)}</span>}
                      {c.errorText && <span style={{ color: "var(--gull-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{firstLine(c.errorText)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {active && (
            viewRef === null ? (
              <div data-agent-ref="master">
                {masterFlow.map((item, i) => (
                  item.kind === "marker" ? (
                    <button
                      key={`marker-${item.ref}`}
                      type="button"
                      onClick={() => setViewRef(item.ref)}
                      style={{
                        display: "block", margin: "8px 0", padding: "4px 10px", cursor: "pointer",
                        background: "var(--panel-2)", border: "1px solid var(--iron-border)",
                        color: "var(--accent-2)", font: `500 11px ${MONO}`, textAlign: "left",
                      }}
                    >
                      {"↳"} spawned {agentName(item.ref)}
                    </button>
                  ) : (
                    item.line.role === "user" ? (
                      <div key={i} style={promptLineStyle}>{item.line.text}</div>
                    ) : (
                      <div key={i}>
                        {toolSegs(item.line.text).map((s, j) =>
                          s.tool ? (
                            <div key={j} style={toolLineStyle}>
                              <span style={{ color: "var(--accent)", fontWeight: 500 }}>{s.name}</span>
                              {s.arg && <span style={{ color: "var(--gull-2)", marginLeft: 6 }}>{s.arg}</span>}
                            </div>
                          ) : (
                            s.text.trim() ? (
                              <div key={j} style={answerLines.has(item.line) ? answerLineStyle : asstLineStyle}>{s.text}</div>
                            ) : null
                          )
                        )}
                      </div>
                    )
                  )
                ))}
              </div>
            ) : (
              <div data-agent-ref={viewRef}>
                {(active?.lines ?? []).filter((l) => l.agentRef === viewRef).map((l, i) => (
                  l.role === "user" ? (
                    <div key={i} style={promptLineStyle}>{l.text}</div>
                  ) : (
                    toolSegs(l.text).map((s, j) =>
                      s.tool ? (
                        <div key={`${i}-${j}`} style={toolLineStyle}>
                          <span style={{ color: "var(--accent)", fontWeight: 500 }}>{s.name}</span>
                          {s.arg && <span style={{ color: "var(--gull-2)", marginLeft: 6 }}>{s.arg}</span>}
                        </div>
                      ) : (
                        s.text.trim() ? (
                          <div key={`${i}-${j}`} style={asstLineStyle}>{s.text}</div>
                        ) : null
                      )
                    )
                  )
                ))}
              </div>
            )
          )}
        </div>

        {/* tool-call timeline */}
        {activeCalls.length > 0 && (
          <div style={{ borderTop: "1px solid var(--iron-border)", background: "var(--panel)" }}>
            <button
              type="button"
              onClick={() => setTimelineOpen((v) => !v)}
              style={{
                width: "100%", display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                background: "transparent", border: 0, padding: "8px 16px", textAlign: "left",
                font: `500 10px ${MONO}`, color: "var(--gull)", textTransform: "uppercase", letterSpacing: "0.1em",
              }}
            >
              <span style={{ color: "var(--bone)" }}>{timelineOpen ? "▾" : "▸"} Timeline</span>
              <span style={{ color: "var(--gull-2)", letterSpacing: "0.04em" }}>
                {activeCalls.length} calls · {lanes.length} {lanes.length === 1 ? "lane" : "lanes"}
              </span>
            </button>
            {timelineOpen && (
              <div style={{ padding: "0 16px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", font: `500 10px ${MONO}`, color: "var(--gull-2)", margin: "0 0 6px" }}>
                  <span>t+0s</span><span>t+{(span.ms / 1000).toFixed(1)}s</span>
                </div>
                {lanes.map((ref) => (
                  <div key={ref} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span
                      title={laneName(ref)}
                      style={{ width: 90, flex: "0 0 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: `400 10px ${MONO}`, color: "var(--gull)" }}
                    >{laneName(ref)}</span>
                    <div style={{ position: "relative", flex: 1, height: 14, background: "var(--panel-2)", border: "1px solid var(--iron-border)" }}>
                      {activeCalls.filter((c) => c.agentRef === ref).map((c, i) => {
                        const { t0, ms } = span;
                        const end = c.endMs ?? now;
                        const left = ((c.startMs - t0) / ms) * 100;
                        const width = ((end - c.startMs) / ms) * 100;
                        const dur = c.endMs ? `${c.endMs - c.startMs}ms` : "running…";
                        const barColor = c.status === "ok" ? "var(--good)" : c.status === "error" ? "var(--bad)" : "var(--accent)";
                        return (
                          <div
                            key={i}
                            style={{ position: "absolute", top: 1, bottom: 1, left: `${left}%`, width: `${Math.max(width, 0.5)}%`, background: barColor, cursor: "pointer", minWidth: 2 }}
                            title={`${c.name}${c.filePath ? ` ${c.filePath}` : ""} · ${dur}`}
                            onClick={() => scrollToAgent(ref)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* input bar */}
        <form
          onSubmit={submit}
          style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "10px 16px", borderTop: "1px solid var(--iron-border)", background: "var(--panel)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {locked ? (
              <>
                <span className="a-pill-btn is-active" title={activeSess?.cwd ?? "app working directory"} style={{ cursor: "default" }}>
                  {activeSess?.cwd ? cwdLabel(activeSess.cwd) : "cwd: default"}
                </span>
                <span className="a-pill-btn is-active" style={{ cursor: "default" }}>{activeSess?.model ?? "default"}</span>
              </>
            ) : (
              <>
                <button
                  type="button" className="a-pill-btn" onClick={pickCwd} disabled={activeRunning}
                  title={cwd ?? appDir ?? "run in app's working directory"}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: activeRunning ? 0.5 : 1 }}
                >
                  <span>{cwd ? cwdLabel(cwd) : appDir ? cwdLabel(appDir) : "cwd: default"}</span>
                  {cwd && (
                    <span
                      role="button" aria-label="clear working directory"
                      onClick={(e) => { e.stopPropagation(); if (!activeRunning) setCwd(undefined); }}
                      style={{ color: "var(--gull-2)", cursor: "pointer" }}
                    >{"×"}</span>
                  )}
                </button>
                <select
                  className="a-text-input"
                  value={model}
                  disabled={activeRunning}
                  onChange={(e) => setModel(e.currentTarget.value)}
                  style={{ flex: "0 0 auto", width: "auto", padding: "4px 8px", fontSize: 11, cursor: "pointer" }}
                >
                  <option value="default">default</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
              </>
            )}
          </div>
          <div className="a-search-prompt" style={{ flex: 1, minWidth: 200 }}>
            <span className="a-search-prompt-glyph">$</span>
            <input
              className="a-search"
              style={{ flex: 1, minWidth: 0, width: "100%" }}
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              placeholder={activeRunning ? "running…" : canContinue ? "continue…" : "ask Claude (this machine)…"}
              disabled={activeRunning}
            />
          </div>
          <button
            className={`a-pill-btn${activeRunning ? "" : " is-active"}`}
            type="submit"
            disabled={activeRunning}
            style={{
              padding: "6px 16px",
              borderColor: activeRunning ? "var(--iron-border)" : "var(--accent)",
              color: activeRunning ? "var(--gull-2)" : "var(--accent)",
              opacity: activeRunning ? 0.7 : 1,
            }}
          >
            {activeRunning ? "RUNNING" : canContinue ? "CONTINUE" : "RUN"}
          </button>
        </form>
      </section>
    </div>
  );
}
