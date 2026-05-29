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

  return (
    <div className="pr-console-grid">
      {/* live sessions */}
      <aside className="pr-sessions">
        <div className="pr-sessions-head">
          <span className="pr-sessions-title">LIVE SESSIONS</span>
          <span className="pr-sessions-sub">{list.length} active</span>
          <button className="pr-new-session" type="button" onClick={() => newLocalSession()}
            title="start a new local session">+ NEW</button>
        </div>
        <div className="pr-sessions-list">
          {railGroups.map((g) => (
            <div key={g.dir || "__root__"} className="pr-session-group">
              <div className="pr-session-group-head" onClick={() => toggleGroup(g.dir)} title={g.dir || g.label}>
                <span className="pr-folder-chevron">{isGroupOpen(g.dir) ? "▾" : "▸"}</span>
                <span className="pr-session-group-dir">{g.label}</span>
                {g.repo && <span className="pr-session-group-repo">{g.repo}</span>}
                <span className="pr-folder-count">{g.sessions.length}</span>
              </div>
              {isGroupOpen(g.dir) && (
                g.sessions.map((e) => {
                  const bulletCls = e.failCount > 0 ? " is-failed" : (e.status ? ` is-${e.status}` : "");
                  return (
                    <React.Fragment key={e.id}>
                      <div
                        className={`pr-session${e.id === activeId && viewRef === null ? " is-active" : ""}`}
                        onClick={() => { setActiveId(e.id); setViewRef(null); }}
                        title={e.id}
                      >
                        <span className={`pr-session-bullet${bulletCls}`} />
                        {renaming === e.id ? (
                          <input
                            className="pr-session-rename"
                            autoFocus
                            defaultValue={sess(e.id)?.label ?? ""}
                            onClick={(ev) => ev.stopPropagation()}
                            onBlur={(ev) => { renameSession(e.id, ev.currentTarget.value); setRenaming(null); }}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter") { renameSession(e.id, ev.currentTarget.value); setRenaming(null); }
                              else if (ev.key === "Escape") setRenaming(null);
                            }}
                          />
                        ) : (
                          <span
                            className="pr-session-title"
                            onDoubleClick={(ev) => { ev.stopPropagation(); if (e.owned) setRenaming(e.id); }}
                          >
                            {e.title}
                          </span>
                        )}
                        <span className="pr-session-time">
                          {e.observed ? "" : e.status === "running" ? "live" : "now"}
                        </span>
                        {e.owned && e.status === "running" && (
                          <button className="pr-session-stop" type="button" title="stop run"
                            onClick={(ev) => { ev.stopPropagation(); void stopRun(e.id); }}>■</button>
                        )}
                        {e.owned && (
                          <button className="pr-session-close" type="button" title="close session"
                            onClick={(ev) => { ev.stopPropagation(); void closeSession(e.id); }}>×</button>
                        )}
                        {e.observed && <span className="pr-session-observed">observed</span>}
                      </div>
                      {e.subagents.map((sub) => (
                        <div
                          key={sub.ref}
                          className={`pr-session-sub${e.id === activeId && viewRef === sub.ref ? " is-active" : ""}`}
                          onClick={() => { setActiveId(e.id); setViewRef(sub.ref); }}
                          title={`${sub.name} · ${sub.steps} steps`}
                        >
                          <span className="pr-session-sub-arrow">↳</span>
                          <span className="pr-session-sub-name">{sub.name}</span>
                          <span className="pr-session-sub-steps">{sub.steps}</span>
                        </div>
                      ))}
                    </React.Fragment>
                  );
                })
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* stream */}
      <section className="pr-console-right">
        <div className="pr-stream-head">
          <div className="pr-stream-crumb">
            <span className="pr-crumb-loc" onClick={() => setViewRef(null)}>{activeTitle}</span>
            {viewRef && (
              <>
                <span className="pr-crumb-sep">/</span>
                <b>{agentName(viewRef)}</b>
              </>
            )}
          </div>
          <div className="pr-stream-stats">
            <div className="pr-stream-stat"><span className="lbl">TURNS</span><span className="val">{active?.lines.length ?? 0}</span></div>
          </div>
        </div>

        <div className="pr-stream" ref={streamRef}>
          {active && failCount(activeId) > 0 && (
            <div className="pr-fail-banner">
              <div className="pr-fail-banner-head" onClick={scrollToFirstFailure} title="scroll to first failure">
                <span className="glyph">▲</span>
                <span className="count">{failCount(activeId)}</span>
                <span>{failCount(activeId) === 1 ? "failure" : "failures"}</span>
              </div>
              {failingCalls.length > 0 && (
                <ul className="pr-fail-list">
                  {failingCalls.map((c, i) => (
                    <li key={i} className="pr-fail-item" onClick={() => scrollToAgent(c.agentRef)} title={c.errorText ?? "scroll to this call"}>
                      <span className="pr-fail-tool">{c.name}</span>
                      {c.filePath && <span className="pr-fail-path">{baseName(c.filePath)}</span>}
                      {c.errorText && <span className="pr-fail-msg">{firstLine(c.errorText)}</span>}
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
                    <button key={`marker-${item.ref}`} className="pr-spawn-marker" type="button"
                      onClick={() => setViewRef(item.ref)}>
                      ↳ spawned {agentName(item.ref)}
                    </button>
                  ) : (
                    item.line.role === "user" ? (
                      <div key={i} className="pr-line pr-line-prompt">{item.line.text}</div>
                    ) : (
                      <div key={i} className={answerLines.has(item.line) ? "pr-answer" : undefined}>
                        {toolSegs(item.line.text).map((s, j) =>
                          s.tool ? (
                            <div key={j} className="pr-line pr-tool-line">
                              <span className="pr-tool">
                                <span className="pr-tool-n">{s.name}</span>
                                {s.arg && <span className="pr-tool-a">{s.arg}</span>}
                              </span>
                            </div>
                          ) : (
                            s.text.trim() ? (
                              <div key={j} className={answerLines.has(item.line) ? "pr-line pr-answer-text" : "pr-line pr-line-asst"}>{s.text}</div>
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
                    <div key={i} className="pr-line pr-line-prompt">{l.text}</div>
                  ) : (
                    toolSegs(l.text).map((s, j) =>
                      s.tool ? (
                        <div key={`${i}-${j}`} className="pr-line pr-tool-line">
                          <span className="pr-tool">
                            <span className="pr-tool-n">{s.name}</span>
                            {s.arg && <span className="pr-tool-a">{s.arg}</span>}
                          </span>
                        </div>
                      ) : (
                        s.text.trim() ? (
                          <div key={`${i}-${j}`} className="pr-line pr-line-asst">{s.text}</div>
                        ) : null
                      )
                    )
                  )
                ))}
              </div>
            )
          )}
        </div>

        {activeCalls.length > 0 && (
          <div className={`pr-timeline${timelineOpen ? " is-open" : ""}`}>
            <button className="pr-timeline-head" type="button" onClick={() => setTimelineOpen((v) => !v)}>
              <span className="pr-timeline-title">TIMELINE</span>
              <span className="pr-timeline-sub">{activeCalls.length} calls · {lanes.length} {lanes.length === 1 ? "lane" : "lanes"}</span>
            </button>
            {timelineOpen && (
              <div className="pr-timeline-body">
                <div className="pr-timeline-axis"><span>t+0s</span><span>t+{(span.ms / 1000).toFixed(1)}s</span></div>
                {lanes.map((ref) => (
                  <div key={ref} className="pr-timeline-lane">
                    <span className="pr-timeline-lane-label" title={laneName(ref)}>{laneName(ref)}</span>
                    <div className="pr-timeline-track">
                      {activeCalls.filter((c) => c.agentRef === ref).map((c, i) => {
                        const { t0, ms } = span;
                        const end = c.endMs ?? now;
                        const left = ((c.startMs - t0) / ms) * 100;
                        const width = ((end - c.startMs) / ms) * 100;
                        const dur = c.endMs ? `${c.endMs - c.startMs}ms` : "running…";
                        const cls = c.status === "ok" ? "is-ok" : c.status === "error" ? "is-error" : "is-running";
                        return (
                          <div
                            key={i}
                            className={`pr-timeline-bar ${cls}`}
                            style={{ left: `${left}%`, width: `${Math.max(width, 0)}%` }}
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

        <form className="pr-inputbar" onSubmit={submit}>
          <div className="pr-launch-opts">
            {locked ? (
              <>
                <span className="pr-cwd-chip is-locked" title={activeSess?.cwd ?? "app working directory"}>
                  {activeSess?.cwd ? cwdLabel(activeSess.cwd) : "cwd: default"}
                </span>
                <span className="pr-model-chip is-locked">{activeSess?.model ?? "default"}</span>
              </>
            ) : (
              <>
                <button type="button" className="pr-cwd-chip" onClick={pickCwd} disabled={activeRunning}
                  title={cwd ?? appDir ?? "run in app's working directory"}>
                  <span className="pr-cwd-label">{cwd ? cwdLabel(cwd) : appDir ? cwdLabel(appDir) : "cwd: default"}</span>
                  {cwd && (
                    <span className="pr-cwd-clear" role="button" aria-label="clear working directory"
                      onClick={(e) => { e.stopPropagation(); if (!activeRunning) setCwd(undefined); }}>×</span>
                  )}
                </button>
                <select className="pr-model-select" value={model} disabled={activeRunning}
                  onChange={(e) => setModel(e.currentTarget.value)}>
                  <option value="default">default</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
              </>
            )}
          </div>
          <div className="pr-input-wrap">
            <span className="pr-input-ps">$</span>
            <input
              className="pr-input"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              placeholder={activeRunning ? "running…" : canContinue ? "continue…" : "ask Claude (this machine)…"}
              disabled={activeRunning}
            />
          </div>
          <button className={`pr-run${activeRunning ? " is-running" : ""}`} type="submit" disabled={activeRunning}>
            {activeRunning ? "RUNNING" : canContinue ? "CONTINUE" : "RUN"}
          </button>
        </form>
      </section>
    </div>
  );
}
