import React from "react";
import { D } from "../../data-store.js";

const PLANS = [
  { id: "api",   label: "API (pay-as-you-go)", note: "exact cost as the Anthropic API would bill" },
  { id: "pro",   label: "Pro · $20/mo",        note: "5x usage cap, Sonnet only" },
  { id: "max",   label: "Max · $100/mo",       note: "20x usage cap, Sonnet + Opus" },
  { id: "max-20x", label: "Max-20x · $200/mo", note: "100x usage cap, all models" },
];

export const PlanCard = ({ plan, saving, onPick }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Pricing plan</h2>
      <span className="a-card-meta">{saving ? "saving…" : "drives all cost figures"}</span>
    </div>
    <div className="a-plans">
      {PLANS.map((p) => (
        <label key={p.id} className={`a-plan ${plan === p.id ? "is-active" : ""}`}>
          <input type="radio" name="plan" checked={plan === p.id} onChange={() => onPick(p.id)} />
          <div>
            <div className="a-plan-title">{p.label}</div>
            <div className="a-plan-note">{p.note}</div>
          </div>
        </label>
      ))}
    </div>
  </section>
);

export const PricingTable = () => {
  const models = (D.plan && D.plan.pricing && D.plan.pricing.models) || {};
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Pricing table</h2><span className="a-card-meta">USD per 1M tokens</span></div>
      <div className="a-table-scroll">
        <table className="a-table a-pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Cache read</th>
              <th className="num">Cache 5m</th>
              <th className="num">Cache 1h</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(models).map(([id, r]) => (
              <tr key={id}>
                <td><span className={`a-badge badge-${r.tier}`}>{id}</span></td>
                <td className="num">${r.input.toFixed(2)}</td>
                <td className="num">${r.output.toFixed(2)}</td>
                <td className="num">${r.cache_read.toFixed(2)}</td>
                <td className="num">${r.cache_create_5m.toFixed(2)}</td>
                <td className="num">${r.cache_create_1h.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
