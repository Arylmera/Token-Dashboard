import React, { useState } from "react";
import { D } from "../data-store.js";
import { THEMES } from "../theme.js";

const PLANS = [
  { id: "api",   label: "API (pay-as-you-go)", note: "exact cost as the Anthropic API would bill" },
  { id: "pro",   label: "Pro · $20/mo",        note: "5x usage cap, Sonnet only" },
  { id: "max",   label: "Max · $100/mo",       note: "20x usage cap, Sonnet + Opus" },
  { id: "max20", label: "Max-20x · $200/mo",   note: "100x usage cap, all models" },
];

const ThemeCard = ({ themeIdx, onPickTheme }) => (
  <section className="a-card">
    <div className="a-card-head"><h2>Theme</h2><span className="a-card-meta">appearance</span></div>
    <div className="a-theme-picker">
      {THEMES.map((t, i) => (
        <button
          key={t.id}
          className={`a-pill-btn ${themeIdx === i ? "is-active" : ""}`}
          onClick={() => onPickTheme(i)}
        >
          <span style={{ marginRight: 6 }}>◐</span>{t.label}
        </button>
      ))}
    </div>
  </section>
);

const PlanCard = ({ plan, saving, onPick }) => (
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

const PricingTable = () => {
  const models = (D.plan && D.plan.pricing && D.plan.pricing.models) || {};
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Pricing table</h2><span className="a-card-meta">USD per 1M tokens</span></div>
      <table className="a-table">
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
    </section>
  );
};

const DeveloperCard = () => {
  if (!window.td || typeof window.td.toggleDevTools !== "function") return null;
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Developer</h2><span className="a-card-meta">renderer debugging</span></div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="a-pill-btn"
          onClick={() => { try { window.td.toggleDevTools(); } catch (_) {} }}
        >
          <span style={{ marginRight: 6 }}>{`{}`}</span>open devtools
        </button>
        <span className="a-card-meta">opens a detached Chromium DevTools window</span>
      </div>
    </section>
  );
};

const Glossary = () => (
  <section className="a-card">
    <div className="a-card-head"><h2>Glossary</h2></div>
    <dl className="a-glossary">
      <dt>input tokens</dt>
      <dd>What you sent to the model — your prompt plus the conversation history. Billed at the lowest rate.</dd>
      <dt>output tokens</dt>
      <dd>What the model generated. Billed at roughly 5x the input rate.</dd>
      <dt>cache read</dt>
      <dd>Repeated input the API already has cached. Billed at 1/10th the input rate. Big <code>CLAUDE.md</code> files become almost free on repeat.</dd>
      <dt>cache write</dt>
      <dd>The first time a chunk of context is sent, it's cached for 5 minutes. Billed at 1.25x input.</dd>
    </dl>
  </section>
);

export const Settings = ({ themeIdx, onPickTheme }) => {
  const [plan, setPlan] = useState((D.plan && D.plan.id) || "max");
  const [saving, setSaving] = useState(false);
  const onPick = async (id) => {
    setPlan(id);
    setSaving(true);
    try {
      await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: id }),
      });
    } catch (_) {}
    setSaving(false);
  };
  return (
    <div className="a-route">
      <ThemeCard themeIdx={themeIdx} onPickTheme={onPickTheme} />
      <PlanCard plan={plan} saving={saving} onPick={onPick} />
      <PricingTable />
      <DeveloperCard />
      <Glossary />
    </div>
  );
};
