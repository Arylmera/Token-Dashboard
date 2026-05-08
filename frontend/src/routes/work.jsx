import React, { useState } from "react";
import { D } from "../data-store.js";
import { fmtCost, fmtTokens } from "../format.js";
import { HBar } from "../components/atoms.jsx";

const ProjectsTable = ({ rows, max }) => (
  <div className="a-table-scroll">
    <table className="a-table a-sink-table">
      <thead><tr><th>project</th><th>last active</th><th className="num">sessions</th><th className="num">tokens</th><th className="num">cost</th><th>distribution</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.slug} className="clickable">
            <td className="mono" style={{ color: "var(--bone)" }}>{p.name}</td>
            <td className="muted">{p.lastActive}</td>
            <td className="num">{p.sessions}</td>
            <td className="num">{fmtTokens(p.tokens)}</td>
            <td className="num tone-good">{fmtCost(p.cost)}</td>
            <td style={{ width: 240 }}><HBar value={p.cost} max={max} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const SkillsTable = ({ rows, max }) => (
  <div className="a-table-scroll">
    <table className="a-table a-sink-table">
      <thead><tr><th>skill</th><th className="num">invocations</th><th className="num">tokens</th><th className="num">cost</th><th>distribution</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.name}>
            <td className="mono" style={{ color: "var(--bone)" }}>{s.name}</td>
            <td className="num">{s.invocations}</td>
            <td className="num">{fmtTokens(s.tokens)}</td>
            <td className="num tone-good">{fmtCost(s.cost)}</td>
            <td style={{ width: 240 }}><HBar value={s.cost} max={max} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export const Work = () => {
  const [view, setView] = useState("projects");
  const rawRows = view === "projects" ? (D.projects || []) : (D.skills || []);
  const rows = [...rawRows].sort((a, b) => (b.tokens || 0) - (a.tokens || 0));
  const max = Math.max(1, ...rows.map((r) => r.cost || 0));
  const total = rows.reduce((a, b) => a + (b.cost || 0), 0);
  const totalSuffix = view === "projects" ? "all-time" : "attributed";
  return (
    <div className="a-route">
      <section className="a-card">
        <div className="a-card-head">
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <h2>Token sink</h2>
            <div className="a-range" style={{ marginLeft: 4 }}>
              <button className={`a-range-tab ${view === "projects" ? "is-active" : ""}`} onClick={() => setView("projects")}>projects</button>
              <button className={`a-range-tab ${view === "skills" ? "is-active" : ""}`} onClick={() => setView("skills")}>skills</button>
            </div>
          </div>
          <span className="a-card-meta">{rows.length} {view} · {fmtCost(total)} {totalSuffix}</span>
        </div>
        {view === "projects"
          ? <ProjectsTable rows={rows} max={max} />
          : <SkillsTable rows={rows} max={max} />}
      </section>
    </div>
  );
};
