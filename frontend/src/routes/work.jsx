import React, { useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { SortHeader, useSortable } from "../components/sortable.jsx";

const pctStyle = (v, max) => ({ "--pct": Math.min(100, Math.round(((v || 0) / (max || 1)) * 100)) });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtLastActive = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
};

const ProjectsTable = ({ rows, max }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "tokens", "desc", {
    name: (r) => r.name,
    lastActive: (r) => r.lastActive,
    sessions: (r) => r.sessions || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>project</SortHeader>
          <SortHeader sortKey="lastActive" {...headProps}>last active</SortHeader>
          <SortHeader sortKey="sessions" className="num" {...headProps}>sessions</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.slug} className="clickable has-bar" style={pctStyle(p.cost, max)}>
              <td>
                <div className="a-proj-nick">{p.name}</div>
                {p.slug && p.slug !== p.name && <div className="a-proj-slug">{p.slug}</div>}
              </td>
              <td className="muted">{fmtLastActive(p.lastActive)}</td>
              <td className="num">{p.sessions}</td>
              <td className="num">{fmtTokens(p.tokens)}</td>
              <td className="num tone-good">{fmtCost(p.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const SkillsTable = ({ rows }) => {
  const barMax = Math.max(1, ...rows.map((r) => r.tokens || 0));
  const { sorted, sortState, requestSort } = useSortable(rows, "tokens", "desc", {
    name: (r) => r.name,
    invocations: (r) => r.invocations || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <colgroup>
          <col />
          <col style={{ width: 110 }} />
          <col style={{ width: 130 }} />
          <col style={{ width: 110 }} />
        </colgroup>
        <thead><tr>
          <SortHeader sortKey="name" {...headProps}>skill</SortHeader>
          <SortHeader sortKey="invocations" className="num" {...headProps}>invocations</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>est. tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>est. cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.name} className="has-bar" style={pctStyle(s.tokens || 0, barMax)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.name}</td>
              <td className="num">{s.invocations}</td>
              <td className="num muted">{s.tokens != null ? `~${fmtTokens(s.tokens)}` : "—"}</td>
              <td className="num tone-good">{s.cost != null ? `~${fmtCost(s.cost)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const SessionsTable = ({ rows, max }) => {
  const { sorted, sortState, requestSort } = useSortable(rows, "cost", "desc", {
    id: (r) => r.id,
    project: (r) => r.project,
    started: (r) => r.started,
    turns: (r) => r.turns || 0,
    tokens: (r) => r.tokens || 0,
    cost: (r) => r.cost || 0,
  });
  const headProps = { state: sortState, requestSort };
  return (
    <div className="a-table-scroll">
      <table className="a-table a-sink-table">
        <thead><tr>
          <SortHeader sortKey="id" {...headProps}>session</SortHeader>
          <SortHeader sortKey="project" {...headProps}>project</SortHeader>
          <SortHeader sortKey="started" {...headProps}>started</SortHeader>
          <SortHeader sortKey="turns" className="num" {...headProps}>turns</SortHeader>
          <SortHeader sortKey="tokens" className="num" {...headProps}>tokens</SortHeader>
          <SortHeader sortKey="cost" className="num" {...headProps}>cost</SortHeader>
        </tr></thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.fullId || s.id} className="has-bar" style={pctStyle(s.cost, max)}>
              <td className="mono" style={{ color: "var(--bone)" }}>{s.id}</td>
              <td className="mono">{s.project}</td>
              <td className="muted">{s.started}</td>
              <td className="num">{s.turns}</td>
              <td className="num">{fmtTokens(s.tokens)}</td>
              <td className="num tone-good">{fmtCost(s.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const Work = () => {
  const [view, setView] = useState("projects");
  const source = view === "projects" ? (D.projects || [])
    : view === "skills" ? (D.skills || [])
    : (D.topSessions || []);
  const rows = source;
  const max = Math.max(1, ...rows.map((r) => r.cost || 0));
  const total = rows.reduce((a, b) => a + (b.cost || 0), 0);
  const totalLabel = view === "skills" && total > 0 ? `~${fmtCost(total)}` : fmtCost(total);
  const totalSuffix = view === "projects" ? "all-time"
    : view === "skills" ? "est. attributed"
    : "top by cost";
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <h2>Token sink</h2>
            <div className="a-range" style={{ marginLeft: 4 }}>
              <button className={`a-range-tab ${view === "projects" ? "is-active" : ""}`} onClick={() => setView("projects")}>projects</button>
              <button className={`a-range-tab ${view === "skills" ? "is-active" : ""}`} onClick={() => setView("skills")}>skills</button>
              <button className={`a-range-tab ${view === "sessions" ? "is-active" : ""}`} onClick={() => setView("sessions")}>sessions</button>
            </div>
          </div>
          <span className="a-card-meta">{rows.length} {view} · {totalLabel} {totalSuffix}</span>
        </div>
        {view === "skills" && (
          <div className="a-card-note muted" style={{ padding: "0 16px 8px", fontSize: 12 }}>
            Estimate. Skill bodies load via system-reminder and aren't directly observable; tokens = invocations × definition size, cost prices the first load per session at Sonnet cache-write and subsequent loads at cache-read. Project-local and subagent-dispatched skills show <span className="mono">—</span> when the definition isn't on disk.
          </div>
        )}
        {view === "projects"
          ? <ProjectsTable rows={rows} max={max} />
          : view === "skills"
          ? <SkillsTable rows={rows} />
          : <SessionsTable rows={rows} max={max} />}
      </section>
    </div>
  );
};
