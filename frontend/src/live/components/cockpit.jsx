import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useStore } from "../stores/use-store.js";
import { graphStore, insightsStore, metasStore, sessionsStore } from "../stores/session-store.js";
import { layoutNameStore, setLayout } from "../stores/settings.js";
import { RadialForceLayout, HierarchicalLayout } from "../lib/layout.js";
import {
  buildAggregates, buildDetail, buildNodeLive, collapseFinishedAgents, collapseByTitle, pruneArchived,
  CATEGORY_COLOR, IDLE_MS, toolCategory,
} from "../lib/cockpitView.js";

const W = 1400, H = 980;
const strategies = {
  radial: new RadialForceLayout(),
  hierarchical: new HierarchicalLayout(),
};

const hue = (sid) => sid ? (Array.from(sid).reduce((a, c) => a + c.charCodeAt(0), 0) * 47) % 360 : 0;
const nodeStroke = (n) =>
  n.status === "failed" ? "var(--bad)"
  : n.kind === "folder" ? "var(--gull)"
  : n.session ? `hsl(${hue(n.session)},70%,60%)` : "var(--accent)";
const truncate = (s, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const folderBase = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

const TOOL_GLYPH = {
  read: "▤", edit: "⊞", bash: "$", web: "◍", search: "⌕", other: "•",
};

export function Cockpit() {
  const graph = useStore(graphStore);
  const insights = useStore(insightsStore);
  const metas = useStore(metasStore);
  const sessions = useStore(sessionsStore);
  const layoutName = useStore(layoutNameStore);

  // Coarse 1-second clock for idle/heat/sparkline recomputation.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState("");
  const [projFilter, setProjFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [legendOpen, setLegendOpen] = useState(false);
  const svgEl = useRef(null);

  // Helper: session title for display.
  const sessionTitle = useCallback((sid) => {
    const m = metas.get(sid)?.title;
    if (m && m !== sid) return m;
    const first = sessions.get(sid)?.lines.find((l) => l.role === "user")?.text;
    return first ?? sid.slice(0, 6);
  }, [metas, sessions]);

  // A session is visible when it's a local run or still tracked in live metas.
  const isVisible = useCallback(
    (sid) => !sid || sid === "local" || sid.startsWith("local-") || metas.has(sid),
    [metas]
  );

  // Prune archived → collapse same-title sessions → fold finished subagents.
  const displayGraph = useMemo(
    () => collapseFinishedAgents(collapseByTitle(pruneArchived(graph, isVisible), sessionTitle)),
    [graph, isVisible, sessionTitle]
  );

  // Live per-node liveness + machine aggregates.
  const nodeLive = useMemo(() => buildNodeLive(insights, now), [insights, now]);
  const liveOf = useCallback((n) =>
    n.kind === "master" && n.session ? nodeLive.get(`${n.session}:master`) : nodeLive.get(n.id),
    [nodeLive]
  );
  const aggregates = useMemo(
    () => buildAggregates(displayGraph, nodeLive, insights, now),
    [displayGraph, nodeLive, insights, now]
  );

  // Topology key: only changes when nodes/edges change, not on activity pings.
  const topoKey = useMemo(() => {
    return `${[...displayGraph.nodes.keys()].join(",")}|${[...displayGraph.edges.keys()].join(",")}`;
  }, [displayGraph]);

  // Recompute layout only when topology or chosen layout changes.
  const positions = useMemo(() => {
    const layout = strategies[layoutName] ?? strategies.hierarchical;
    return new Map(displayGraph.nodes.size ? layout.layout(displayGraph, W, H).map((p) => [p.id, p]) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey, layoutName]);

  // Auto-fit bounds (+ label padding).
  const bounds = useMemo(() => {
    const pts = [...positions.values()];
    if (!pts.length) return { bx: 0, by: 0, bw: W, bh: H };
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const pad = 60, labelPad = 200;
    const bx = Math.min(...xs) - pad, by = Math.min(...ys) - pad;
    return { bx, by, bw: Math.max(...xs) + labelPad - bx, bh: Math.max(...ys) + pad - by };
  }, [positions]);

  const viewBox = useMemo(() => {
    const b = bounds;
    const w = b.bw / zoom, h = b.bh / zoom;
    const cx = b.bx + b.bw / 2 + pan.x, cy = b.by + b.bh / 2 + pan.y;
    return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
  }, [bounds, zoom, pan]);

  // Pointer / wheel handlers (pan + zoom).
  // Attached natively (not via React props) because React 18 delegates events
  // at the root: that makes onWheel passive (preventDefault ignored → zoom dead)
  // and routes pointer events through the root, breaking setPointerCapture-based
  // dragging. Native listeners on the svg restore the pre-port (Solid) behavior.
  const drag = useRef(false);
  const moved = useRef(false);
  const captured = useRef(false);
  const lx = useRef(0), ly = useRef(0);

  const boundsRef = useRef(bounds); boundsRef.current = bounds;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;

  useEffect(() => {
    const svg = svgEl.current;
    if (!svg) return;

    const onWheel = (e) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setZoom((z) => Math.min(8, Math.max(0.4, z * f)));
    };
    const onDown = (e) => {
      drag.current = true; moved.current = false; captured.current = false;
      lx.current = e.clientX; ly.current = e.clientY;
    };
    const onMove = (e) => {
      if (!drag.current) return;
      if (!moved.current) {
        if (Math.abs(e.clientX - lx.current) + Math.abs(e.clientY - ly.current) <= 3) return;
        moved.current = true;
        svg.setPointerCapture?.(e.pointerId);
        captured.current = true;
        lx.current = e.clientX; ly.current = e.clientY;
        return;
      }
      const r = svg.getBoundingClientRect();
      const scale = (boundsRef.current.bw / zoomRef.current) / r.width;
      setPan((p) => ({ x: p.x - (e.clientX - lx.current) * scale, y: p.y - (e.clientY - ly.current) * scale }));
      lx.current = e.clientX; ly.current = e.clientY;
    };
    const onUp = (e) => {
      drag.current = false;
      if (captured.current) { svg.releasePointerCapture?.(e.pointerId); captured.current = false; }
    };

    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointerleave", onUp);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("pointerdown", onDown);
      svg.removeEventListener("pointermove", onMove);
      svg.removeEventListener("pointerup", onUp);
      svg.removeEventListener("pointerleave", onUp);
    };
  }, []);

  const reset = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  // Distinct projects for filter dropdown.
  const projects = useMemo(() => {
    const set = new Set();
    for (const n of displayGraph.nodes.values()) if (n.kind === "project" || n.kind === "master") set.add(n.label);
    return [...set].sort();
  }, [displayGraph]);

  const nodeProject = useCallback((n) =>
    n.kind === "project" || n.kind === "master" ? n.label
    : n.session ? metas.get(n.session)?.project : undefined,
    [metas]
  );

  const isDimmed = useCallback((n) => {
    const q = query.trim().toLowerCase();
    if (q) {
      const hay = `${n.label} ${n.kind === "master" && n.session ? sessionTitle(n.session) : ""}`.toLowerCase();
      if (!hay.includes(q)) return true;
    }
    if (projFilter !== "all" && n.kind !== "folder" && nodeProject(n) !== projFilter) return true;
    if (statusFilter !== "all" && (n.kind === "master" || n.kind === "agent")) {
      const live = liveOf(n);
      const idle = n.status === "running" && (live?.idleMs === undefined || live.idleMs > IDLE_MS);
      if (statusFilter === "running" && !(n.status === "running" && !idle)) return true;
      if (statusFilter === "failed" && n.status !== "failed") return true;
      if (statusFilter === "idle" && !idle) return true;
    }
    return false;
  }, [query, projFilter, statusFilter, nodeProject, liveOf, sessionTitle]);

  const detail = useMemo(() => {
    return selected ? buildDetail(displayGraph, selected, insights, metas, now) : null;
  }, [selected, displayGraph, insights, metas, now]);

  const fmtDur = (ms) => ms === undefined ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtIdle = (ms) => ms === undefined ? "—" : ms < 1000 ? "now" : `${Math.floor(ms / 1000)}s`;

  const nodeLabel = useCallback((n) => {
    if (n.kind === "master" && n.session) {
      const count = (n.weight ?? 1) > 1 ? ` \xD7${n.weight}` : "";
      return truncate(sessionTitle(n.session)) + count;
    }
    return truncate(n.kind === "folder" ? folderBase(n.label) : n.label);
  }, [sessionTitle]);

  const fullLabel = useCallback((n) =>
    n.kind === "master" && n.session
      ? sessionTitle(n.session) + ((n.weight ?? 1) > 1 ? ` \xD7${n.weight}` : "")
      : n.label,
    [sessionTitle]
  );

  return (
    <section className="a-card" style={{ display: "flex", flexDirection: "column", height: "100%", padding: 0, minHeight: 0 }}>
      <div className="a-card-head" style={{ margin: 0, padding: "14px 16px", borderBottom: "1px solid var(--iron-border)" }}>
        <h2>Agent graph</h2>
        <span className="a-card-meta">
          {aggregates.sessions} <span style={{ color: "var(--gull-2)" }}>sessions</span>
          {" · "}{aggregates.agents} <span style={{ color: "var(--gull-2)" }}>agents</span>
          {aggregates.fails > 0 && <span style={{ color: "var(--bad)" }}>{" · "}{aggregates.fails} fail</span>}
        </span>
      </div>
      <div
        style={{
          position: "relative", overflow: "hidden",
          flex: 1, minHeight: 0,
          background: "var(--panel)",
          backgroundImage: "radial-gradient(var(--grid-dot) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      >
      <svg ref={svgEl} width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="xMidYMid meet"
        style={{ cursor: "grab", touchAction: "none", position: "absolute", inset: 0 }}
        onClick={() => { if (!moved.current) setSelected(null); }}>
        {[...displayGraph.edges.values()].map((e) => {
          const a = positions.get(e.source);
          const b = positions.get(e.target);
          if (!a || !b) return null;
          const sn = displayGraph.nodes.get(e.source), tn = displayGraph.nodes.get(e.target);
          const dim = (sn && isDimmed(sn)) || (tn && isDimmed(tn));
          return (
            <line key={e.id} className={["cockpit-edge", dim && "is-dimmed"].filter(Boolean).join(" ")}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--iron-border)" strokeWidth="1.5"
              opacity={dim ? 0.25 : 0.6} />
          );
        })}
        {displayGraph.activity.slice(-12).map((ping, i) => {
          const p = positions.get(ping.folderId);
          const color = CATEGORY_COLOR[toolCategory(ping.tool ?? "")];
          if (!p) return null;
          return <circle key={`ping-${i}`} className="cockpit-ring" cx={p.x} cy={p.y} r="8" stroke={color} />;
        })}
        {[...displayGraph.nodes.values()].map((n) => {
          const p = positions.get(n.id);
          if (!p) return null;
          const baseR = (n.kind === "master" || n.kind === "project") ? 14 : n.kind === "agent" ? 10 : 7;
          const live = liveOf(n);
          const rate = live?.recentRate ?? 0;
          const r = baseR + (n.kind === "agent" || n.kind === "master" ? rate * 3 : 0);
          const isRunning = n.status === "running" && (n.kind === "agent" || n.kind === "master");
          const idle = isRunning && (live?.idleMs === undefined || live.idleMs > IDLE_MS);
          const ringColor = n.status === "failed" ? "var(--bad)" : n.status === "complete" ? "var(--good)" : "var(--accent)";
          const glow = (n.kind === "agent" || n.kind === "master") && rate > 0
            ? `drop-shadow(0 0 ${4 + rate * 14}px ${nodeStroke(n)})` : "none";
          const dimmed = isDimmed(n);
          return (
            <g key={n.id}
              className={["", dimmed && "is-dimmed", idle && "is-idle", selected === n.id && "is-selected"].filter(Boolean).join(" ")}
              style={{ cursor: "pointer" }}
              onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, text: fullLabel(n) })}
              onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, text: fullLabel(n) })}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => { e.stopPropagation(); if (!moved.current) setSelected(n.id); }}>
              {(n.kind === "agent" || n.kind === "master") && (
                <circle className={["cockpit-status-ring", n.status === "running" && "is-running"].filter(Boolean).join(" ")}
                  cx={p.x} cy={p.y} r={r + 4} fill="none" stroke={ringColor} strokeWidth="1.5" />
              )}
              <circle className="cockpit-node" cx={p.x} cy={p.y} r={r} fill="var(--panel-solid)"
                stroke={nodeStroke(n)} strokeWidth="2" style={{ filter: glow }} />
              <text x={p.x + r + 4} y={p.y + 4}
                style={{ fill: "var(--bone)", font: "500 12px var(--font-mono)" }}>{nodeLabel(n)}</text>
              {idle && live?.idleMs !== undefined && (
                <text x={p.x + r + 4} y={p.y + 16}
                  style={{ fill: "var(--gull)", font: "400 10px var(--font-mono)" }}>idle {fmtIdle(live.idleMs)}</text>
              )}
              {n.kind === "master" && (n.done ?? 0) > 0 && (
                <text x={p.x + r + 4} y={p.y + 16}
                  style={{ fill: (n.doneFailed ?? 0) > 0 ? "var(--bad)" : "var(--good)", font: "400 10px var(--font-mono)" }}>
                  +{n.done} done{(n.doneFailed ?? 0) > 0 ? ` \xB7 ${n.doneFailed} ✗` : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* layout toggle pinned top-right */}
      <div className="a-pill-btn-row" style={{ position: "absolute", top: 12, right: 12, zIndex: 4 }}>
        <button className={`a-pill-btn${layoutName === "radial" ? " is-active" : ""}`} onClick={() => setLayout("radial")}>radial</button>
        <button className={`a-pill-btn${layoutName === "hierarchical" ? " is-active" : ""}`} onClick={() => setLayout("hierarchical")}>hier</button>
      </div>

      {/* mini legend pinned top-left, expandable */}
      <div
        className="a-card"
        style={{ position: "absolute", top: 12, left: 12, zIndex: 4, padding: "8px 10px", margin: 0 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {[["read","read"],["edit","edit"],["bash","bash"],["web","web"],["search","grep"],["other","other"]].map(([cat,lbl]) => (
            <span key={cat} style={{ display: "inline-flex", alignItems: "center", gap: 5, font: "400 11px var(--font-mono)", color: "var(--gull)" }}>
              <i style={{ width: 8, height: 8, borderRadius: "50%", background: CATEGORY_COLOR[cat], display: "inline-block" }} />{lbl}
            </span>
          ))}
          <button
            className={`a-pill-btn${legendOpen ? " is-active" : ""}`}
            style={{ padding: "2px 8px" }}
            onClick={() => setLegendOpen((v) => !v)}
          >?</button>
        </div>
        {legendOpen && (
          <div style={{ maxWidth: 320, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--iron-border)" }}>
            <div className="a-card-head" style={{ marginBottom: 8 }}><h2>LIVE AGENT GRAPH</h2></div>
            <p style={{ margin: 0, font: "400 12px/1.5 var(--font-mono)", color: "var(--gull-2)" }}>
              Each <b style={{ color: "var(--bone)" }}>project</b> spawns <b style={{ color: "var(--bone)" }}>sessions</b> (one per master) which dispatch <b style={{ color: "var(--bone)" }}>subagents</b> linked to the <b style={{ color: "var(--bone)" }}>folders</b> they touch. Pulses = file activity, colored by tool. A node&apos;s <b style={{ color: "var(--bone)" }}>glow</b> tracks recent activity; a faded node with <b style={{ color: "var(--bone)" }}>idle Ns</b> is running but quiet. The ring is green on success, red on failure.
            </p>
            <div style={{ marginTop: 8, font: "400 11px var(--font-mono)", color: "var(--gull)" }}>
              scroll = zoom &middot; drag = pan &middot;{" "}
              <a onClick={reset} style={{ color: "var(--accent)", cursor: "pointer" }}>reset view</a>
            </div>
          </div>
        )}
      </div>

      {/* slide-in detail panel (single-click a node) */}
      {detail && (() => {
        const detailLabelStyle = { font: "500 10px var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--gull)", margin: "14px 0 6px" };
        const chipBase = { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, font: "400 11px var(--font-mono)", border: "1px solid var(--iron-border)", color: "var(--gull-2)", background: "var(--panel-2)" };
        return (
        <section
          className="a-card"
          style={{ position: "absolute", top: 12, right: 12, zIndex: 5, width: 320, maxHeight: "calc(100% - 110px)", overflowY: "auto", margin: 0 }}
        >
          <button
            onClick={() => setSelected(null)}
            style={{ position: "absolute", top: 8, right: 10, background: "none", border: "none", color: "var(--gull)", cursor: "pointer", font: "400 18px var(--font-mono)", lineHeight: 1 }}
          >&times;</button>
          <div className="a-card-head" style={{ paddingRight: 24 }}>
            <h2>
              {selected?.startsWith("proj:") || detail.kind === "folder"
                ? truncate(folderBase(detail.label), 40)
                : detail.sessionId ? sessionTitle(detail.sessionId) : detail.label}
            </h2>
            <span className="a-card-meta" style={{ color: detail.state === "failed" ? "var(--bad)" : "var(--good)" }}>{detail.state}</span>
          </div>
          <div style={{ font: "400 11px var(--font-mono)", color: "var(--gull)", marginTop: 4 }}>{detail.project ?? detail.kind}</div>
          <div style={{ display: "flex", gap: 14, marginTop: 12, font: "400 12px var(--font-mono)", color: "var(--bone)", flexWrap: "wrap" }}>
            <span>&#x23F1; {fmtDur(detail.durationMs)}</span>
            <span style={{ color: detail.fails > 0 ? "var(--bad)" : undefined }}>&times; {detail.fails}</span>
            <span>&#x26A1; {detail.calls}</span>
            <span style={{ color: "var(--gull)" }}>idle {fmtIdle(detail.idleMs)}</span>
          </div>
          {detail.recentCalls.length > 0 && (
            <>
              <div style={detailLabelStyle}>recent calls</div>
              {[...detail.recentCalls].reverse().map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", font: "400 11px var(--font-mono)", color: c.status === "error" ? "var(--bad)" : "var(--gull-2)" }}>
                  <span style={{ color: "var(--accent)" }}>{TOOL_GLYPH[c.tool]}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}{c.target ? ` ${folderBase(c.target)}` : ""}</span>
                  <span style={{ color: "var(--gull)" }}>{c.status === "error" ? "✗" : c.status === "ok" ? "✓" : "⟳"} {fmtDur(c.durMs)}</span>
                </div>
              ))}
            </>
          )}
          {(detail.subagents.length > 0 || (detail.subagentsDone ?? 0) > 0) && (
            <>
              <div style={detailLabelStyle}>
                subagents ({detail.subagents.length} active{(detail.subagentsDone ?? 0) > 0 ? ` \xB7 +${detail.subagentsDone} done` : ""})
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {detail.subagents.map((a, i) => (
                  <span key={i} style={{ ...chipBase, borderColor: a.status === "failed" ? "var(--bad)" : "var(--accent)", color: a.status === "failed" ? "var(--bad)" : "var(--bone)" }}>{a.label}</span>
                ))}
                {(detail.doneSubagents ?? []).map((a, i) => (
                  <span key={`done-${i}`} style={{ ...chipBase, color: a.status === "failed" ? "var(--bad)" : "var(--good)" }}>
                    {a.status === "failed" ? "✗" : "✓"} {a.label}
                  </span>
                ))}
              </div>
            </>
          )}
          {detail.folders.length > 0 && (
            <>
              <div style={detailLabelStyle}>folders touched ({detail.folders.length})</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {detail.folders.map((f, i) => (
                  <span key={i} style={chipBase}>{folderBase(f)}</span>
                ))}
              </div>
            </>
          )}
        </section>
        );
      })()}

      {/* persistent bottom bar */}
      {(() => {
        const stat = (n, label, tone) => (
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
            <span className="a-strip-num" style={{ fontSize: 20, marginTop: 0, color: tone ?? "var(--bone)" }}>{n}</span>
            <span className="a-strip-unit" style={{ marginLeft: 0 }}>{label}</span>
          </span>
        );
        const ctrl = {
          font: "400 12px var(--font-mono)", color: "var(--bone)",
          background: "var(--panel-2)", border: "1px solid var(--iron-border)",
          borderRadius: 4, padding: "4px 8px", outline: "none",
        };
        return (
        <div
          style={{
            position: "absolute", left: 0, right: 0, bottom: 0, zIndex: 4,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
            padding: "10px 14px", background: "var(--panel-solid)", borderTop: "1px solid var(--iron-border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            {stat(aggregates.agents, "agents")}
            {stat(aggregates.sessions, "sessions")}
            {stat(aggregates.fails, "fail", "var(--bad)")}
            {stat(aggregates.idle, "idle", "var(--gull)")}
            {stat(aggregates.folders, "folders")}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ font: "400 11px var(--font-mono)", color: "var(--gull)" }}>activity</span>
            <svg width="120" height="24" viewBox="0 0 120 24" preserveAspectRatio="none">
              <line x1="0" y1="23.5" x2="120" y2="23.5" stroke="var(--iron-border)" strokeWidth="1" />
              {(() => {
                const data = aggregates.callsPerSec;
                const max = Math.max(1, ...data);
                const bw = 120 / data.length;
                return data.map((v, i) => (
                  <rect key={i} x={i * bw + 0.15} y={24 - Math.max(v ? 1.5 : 0, (v / max) * 23)}
                    width={Math.max(0.6, bw - 0.3)} height={Math.max(v ? 1.5 : 0, (v / max) * 23)}
                    fill="var(--accent)" opacity="0.85" />
                ));
              })()}
            </svg>
            <input style={{ ...ctrl, width: 110 }} placeholder="search" value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onChange={(e) => setQuery(e.currentTarget.value)} />
            <select style={ctrl} value={projFilter} onChange={(e) => setProjFilter(e.currentTarget.value)}>
              <option value="all">all projects</option>
              {projects.map((p) => <option key={p} value={p}>{truncate(p, 22)}</option>)}
            </select>
            <select style={ctrl} value={statusFilter} onChange={(e) => setStatusFilter(e.currentTarget.value)}>
              <option value="all">any status</option>
              <option value="running">running</option>
              <option value="failed">failed</option>
              <option value="idle">idle</option>
            </select>
          </div>
        </div>
        );
      })()}

      {hover && (
        <div
          style={{
            position: "fixed", left: `${hover.x + 14}px`, top: `${hover.y + 14}px`, zIndex: 10,
            pointerEvents: "none", padding: "4px 8px", borderRadius: 4, maxWidth: 320,
            font: "400 12px var(--font-mono)", color: "var(--bone)",
            background: "var(--panel-solid)", border: "1px solid var(--iron-border-2)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}
        >
          {hover.text}
        </div>
      )}
      </div>
    </section>
  );
}
