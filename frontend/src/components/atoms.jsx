import React from "react";

export const Label = ({ children, style }) => (
  <div className="a-label" style={style}>{children}</div>
);

export const KPI = ({ label, value, sub, tone, delta }) => (
  <div className="a-kpi">
    <Label>{label}</Label>
    <div className={`a-metric ${tone === "good" ? "tone-good" : ""}`}>{value}</div>
    {sub && <div className="a-kpi-sub">{sub}</div>}
    {delta != null && (
      <div className={`a-delta ${delta >= 0 ? "tone-good" : "tone-bad"}`}>
        {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%
      </div>
    )}
  </div>
);

export const ModelBadge = ({ model }) => {
  const m = (model || "").toLowerCase();
  const cls = m.includes("opus") ? "badge-opus"
    : m.includes("sonnet") ? "badge-sonnet"
    : "badge-haiku";
  return <span className={`a-badge ${cls}`}>{model || "—"}</span>;
};

export const HBar = ({ value, max, accent = "var(--accent)" }) => (
  <div className="a-hbar">
    <div className="a-hbar-fill" style={{ width: `${(value / (max || 1)) * 100}%`, background: accent }} />
  </div>
);
