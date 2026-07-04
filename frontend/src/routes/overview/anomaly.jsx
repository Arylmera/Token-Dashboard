import React from "react";
import { D } from "../../data-store.js";
import { fmtCost } from "../../format.js";
import { displayProject } from "../../project-name.js";

export const AnomalyCard = () => {
  const rows = D.anomalies || [];
  if (rows.length === 0) return null;
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Anomalous sessions · 30d (≥3σ)</h2>
        <span className="a-card-meta">cost outliers vs project baseline</span>
      </div>
      <table className="a-table">
        <thead>
          <tr>
            <th>session</th>
            <th>project</th>
            <th className="num">cost</th>
            <th className="num">z-score</th>
            <th className="num">baseline mean</th>
            <th>first seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr
              key={a.session_id}
              className="clickable"
              onClick={() => { window.location.hash = `/sessions/${encodeURIComponent(a.session_id)}`; }}
            >
              <td className="mono">{a.session_id.slice(0, 8)}</td>
              <td className="mono" title={a.project_slug}>{displayProject(a.project_slug)}</td>
              <td className="num tone-bad">{fmtCost(a.cost_usd)}</td>
              <td className="num">{a.z_score.toFixed(1)}σ</td>
              <td className="num">{fmtCost(a.baseline_mean)}</td>
              <td>{(a.first_seen || "").slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
};
