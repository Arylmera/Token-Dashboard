import React from "react";
import { fmtCost, fmtNum, fmtPct, fmtTokens } from "../../format.js";

const PHASE_COLORS = {
  plan:    "var(--gull)",
  execute: "var(--accent)",
  other:   "var(--iron-border-2)",
};

export const PhaseSplitCard = ({ phase }) => {
  if (!phase) return null;
  const total = (phase.plan?.billable_tokens || 0)
    + (phase.execute?.billable_tokens || 0)
    + (phase.other?.billable_tokens || 0);
  if (total === 0) return null;
  const seg = (k) => ({
    key: k,
    label: k,
    tokens: phase[k]?.billable_tokens || 0,
    cost: phase[k]?.cost_usd || 0,
    turns: phase[k]?.turns || 0,
    share: (phase[k]?.billable_tokens || 0) / total,
  });
  const segs = ["plan", "execute", "other"].map(seg);
  const planExec = (segs[0].tokens && segs[1].tokens)
    ? (segs[1].tokens / segs[0].tokens).toFixed(2)
    : null;
  return (
    <div className="a-card">
      <div className="a-card-head">
        <h2>Plan vs execute</h2>
        <span className="a-card-meta">
          billable tokens by phase{planExec ? ` · 1 : ${planExec} ratio` : ""}
        </span>
      </div>
      <div className="a-split-wrap">
        <div className="a-split-bar" role="img" aria-label="phase split">
          {segs.map((s) => (
            <div
              key={s.key}
              className={`a-split-seg a-split-seg-${s.key}`}
              style={{ flex: s.share || 0.0001, background: PHASE_COLORS[s.key] }}
              title={`${s.label} · ${fmtPct(s.share)}`}
            >
              {s.share >= 0.06 ? fmtPct(s.share) : ""}
            </div>
          ))}
        </div>
        <div className="a-split-meta">
          {segs.map((s) => (
            <div key={s.key} className="a-split-meta-cell">
              <div className={`a-split-meta-k a-split-meta-k-${s.key}`}>
                <span className="a-split-meta-sw" style={{ background: PHASE_COLORS[s.key] }} />
                {s.label}
              </div>
              <div className="a-split-meta-v">{fmtTokens(s.tokens)}</div>
              <div className="a-split-meta-s">{fmtCost(s.cost)} · {fmtNum(s.turns)} turns</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
