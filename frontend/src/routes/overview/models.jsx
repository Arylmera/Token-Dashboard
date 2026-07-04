import React from "react";
import { D } from "../../data-store.js";
import { fmtCost, fmtPct } from "../../format.js";
import { ModelBadge } from "../../components/atoms.jsx";
import { Donut } from "../../components/charts.jsx";

const MODEL_COLORS = ["var(--bone)", "var(--accent)", "var(--gull)", "var(--accent-2)"];
const colorFor = (i) => MODEL_COLORS[i] || "var(--gull)";

// Cost-per-accepted-edit leaderboard, sibling of `ModelsCard`. Data comes
// from `/api/model_efficiency?days=30` and is rendered cheapest-first so
// the top row is the actionable "use this model for edits" recommendation.
export const ModelLeaderboard = () => {
  const rows = D.modelEfficiency || [];
  if (rows.length === 0) {
    return (
      <div className="a-card">
        <div className="a-card-head">
          <h2>Model efficiency</h2>
          <span className="a-card-meta">cost per accepted edit · 30d</span>
        </div>
        <div className="a-empty">No accepted edits in the last 30 days.</div>
      </div>
    );
  }
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Model efficiency</h2>
        <span className="a-card-meta">cost per accepted edit · 30d</span>
      </div>
      <table className="a-table">
        <thead>
          <tr>
            <th>model</th>
            <th className="num">cost</th>
            <th className="num">edits</th>
            <th className="num">$/edit</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model || "(unknown)"}>
              <td><ModelBadge model={r.model || "unknown"} /></td>
              <td className="num">{fmtCost(r.cost_usd || 0)}</td>
              <td className="num">{r.edits || 0}</td>
              <td className="num tone-good">
                {r.cost_per_edit_usd != null ? fmtCost(r.cost_per_edit_usd) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const ModelsCard = ({ tc }) => (
  <div className="a-card">
    <div className="a-card-head"><h2>{tc?.card?.["By model"] ?? "By model"}</h2></div>
    <div className="a-model-block">
      <Donut size={130} thickness={14} segments={(D.models || []).slice(0, 3).map((m, i) => ({
        value: m.share,
        color: colorFor(i),
      }))} />
      <div className="a-model-stack">
        {(D.models || []).map((m, i) => (
          <div key={m.name} className="a-model-legend">
            <span className="a-model-swatch" style={{ background: colorFor(i) }} />
            <span className="a-model-name">{m.short}</span>
            <span className="a-model-pct">{fmtPct(m.share)}</span>
            <span className="a-model-cost">{fmtCost(m.cost)}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);
