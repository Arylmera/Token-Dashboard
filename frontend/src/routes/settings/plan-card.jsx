import React, { useEffect, useState } from "react";

const PLANS = [
  { id: "api",     name: "api",     price: "API",           priceUnit: "",     subtitle: "pay-as-you-go", note: "exact cost as the Anthropic API would bill" },
  { id: "pro",     name: "pro",     price: "$20",           priceUnit: "/mo",  subtitle: "5× cap",    note: "5x usage cap, Sonnet only" },
  { id: "max",     name: "max",     price: "$100",          priceUnit: "/mo",  subtitle: "20× cap",   note: "20x usage cap, Sonnet + Opus" },
  { id: "max-20x", name: "max-20x", price: "$200",          priceUnit: "/mo",  subtitle: "100× cap",  note: "100x usage cap, all models" },
];

const padIdx = (i) => String(i + 1).padStart(2, "0");

export const PlanCard = ({ plan, saving, onPick }) => (
  <section className="a-card">
    <div className="a-card-head">
      <h2>Pricing plan</h2>
      <span className="a-card-meta">{saving ? "saving…" : "drives all cost figures"}</span>
    </div>
    <div className="a-plans">
      {PLANS.map((p, i) => {
        const active = plan === p.id;
        return (
          <label key={p.id} className={`a-plan ${active ? "is-active" : ""}`}>
            <input type="radio" name="plan" checked={active} onChange={() => onPick(p.id)} />
            <div className="a-plan-inner">
              <div className="a-plan-kicker">
                <span>{padIdx(i)} · {p.name.toUpperCase()}</span>
                {active ? <span className="a-plan-kicker-badge">CURRENT</span> : <span className="a-plan-kicker-meta">{p.subtitle}</span>}
              </div>
              <div className="a-plan-price">
                {p.price}{p.priceUnit && <span className="a-plan-price-unit">{p.priceUnit}</span>}
              </div>
              <div className="a-plan-note">{p.note}</div>
            </div>
          </label>
        );
      })}
    </div>
  </section>
);

const FIELDS = [
  { id: "input",           label: "Input" },
  { id: "output",          label: "Output" },
  { id: "cache_read",      label: "Cache read" },
  { id: "cache_create_5m", label: "Cache 5m" },
  { id: "cache_create_1h", label: "Cache 1h" },
];

const fmtCell = (v) => (typeof v === "number" ? v.toFixed(2) : "");

export const PricingTable = () => {
  const [data, setData] = useState(null);     // { defaults, overrides, effective }
  const [drafts, setDrafts] = useState({});   // { [model]: { [field]: string } }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const applyData = (d) => {
    setData(d);
    const next = {};
    for (const [model, row] of Object.entries(d.effective || {})) {
      next[model] = {};
      for (const f of FIELDS) next[model][f.id] = fmtCell(row[f.id]);
    }
    setDrafts(next);
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/pricing")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d) applyData(d); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const persistField = async (model, field, raw) => {
    const trimmed = String(raw || "").trim();
    if (trimmed === "") {
      // empty → restore current effective into draft, no save
      setDrafts((d) => ({ ...d, [model]: { ...d[model], [field]: fmtCell(data.effective[model][field]) } }));
      return;
    }
    const num = Number(trimmed);
    if (Number.isNaN(num) || num < 0) {
      setError(`invalid value for ${field}`);
      return;
    }
    if (num === data.effective[model][field]) return;  // no-op
    setError("");
    setSaving(true);
    try {
      const r = await fetch(`/api/pricing/${encodeURIComponent(model)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: num }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `save failed (${r.status})`);
      } else {
        applyData(await r.json());
        if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      }
    } catch (_) {
      setError("save failed");
    }
    setSaving(false);
  };

  const resetModel = async (model) => {
    setError("");
    setSaving(true);
    try {
      const r = await fetch(`/api/pricing/${encodeURIComponent(model)}/clear`, { method: "POST" });
      if (r.ok) {
        applyData(await r.json());
        if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      }
    } catch (_) {}
    setSaving(false);
  };

  const resetAll = async () => {
    setError("");
    setSaving(true);
    try {
      const r = await fetch("/api/pricing/clear-all", { method: "POST" });
      if (r.ok) {
        applyData(await r.json());
        if (window.RELOAD_STATIC) window.RELOAD_STATIC();
      }
    } catch (_) {}
    setSaving(false);
  };

  const overrides = (data && data.overrides) || {};
  const effective = (data && data.effective) || {};
  const defaults  = (data && data.defaults)  || {};
  const hasAnyOverride = Object.keys(overrides).length > 0;

  const meta = !loaded
    ? "loading…"
    : saving
      ? "saving…"
      : error
        ? error
        : "USD per 1M tokens · edit any cell to override";

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Pricing table</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className={`a-card-meta${error ? " is-error" : ""}`}>{meta}</span>
          {hasAnyOverride && (
            <button type="button" className="a-pill-btn" onClick={resetAll} disabled={saving}>
              Reset all
            </button>
          )}
        </div>
      </div>
      <div className="a-table-scroll">
        <table className="a-table a-pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              {FIELDS.map((f) => <th key={f.id} className="num">{f.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(effective).map(([id, r]) => {
              const isOverridden = !!overrides[id];
              const def = defaults[id] || {};
              return (
                <tr key={id} className={isOverridden ? "is-overridden" : ""}>
                  <td><span className={`a-badge badge-${r.tier}`}>{id}</span></td>
                  {FIELDS.map((f) => {
                    const fieldOverridden = overrides[id] && f.id in overrides[id];
                    const defaultVal = def[f.id];
                    const title = fieldOverridden && typeof defaultVal === "number"
                      ? `default: $${defaultVal.toFixed(2)}`
                      : "";
                    return (
                      <td key={f.id} className="num">
                        <span className={`a-pricing-input${fieldOverridden ? " is-modified" : ""}`} title={title}>
                          <span className="a-pricing-currency">$</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={(drafts[id] && drafts[id][f.id]) ?? ""}
                            onChange={(e) => setDrafts((d) => ({
                              ...d,
                              [id]: { ...d[id], [f.id]: e.target.value },
                            }))}
                            onBlur={(e) => persistField(id, f.id, e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                          />
                        </span>
                      </td>
                    );
                  })}
                  <td className="num">
                    {isOverridden && (
                      <button type="button" className="a-pill-btn" onClick={() => resetModel(id)} disabled={saving}>
                        Reset
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
