import React, { useEffect, useState } from "react";

const BUDGET_FIELDS = [
  { id: "daily",   label: "Daily cap",   note: "warns once today's spend trends toward this number" },
  { id: "weekly",  label: "Weekly cap",  note: "rolling Monday-to-Sunday spend" },
  { id: "monthly", label: "Monthly cap", note: "calendar-month spend" },
];

export const BudgetCard = () => {
  const [values, setValues] = useState({ daily: "", weekly: "", monthly: "" });
  const [drafts, setDrafts] = useState({ daily: "", weekly: "", monthly: "" });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/budget")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d) return;
        const next = {
          daily:   d.daily?.cap_usd   != null ? String(d.daily.cap_usd)   : "",
          weekly:  d.weekly?.cap_usd  != null ? String(d.weekly.cap_usd)  : "",
          monthly: d.monthly?.cap_usd != null ? String(d.monthly.cap_usd) : "",
        };
        setValues(next);
        setDrafts(next);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);
  const persist = async (key, raw) => {
    const trimmed = String(raw || "").trim();
    const amount = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && (Number.isNaN(amount) || amount < 0)) return;
    setSaving(true);
    try {
      await fetch("/api/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: amount }),
      });
      setValues((v) => ({ ...v, [key]: trimmed }));
      if (window.RELOAD_STATIC) window.RELOAD_STATIC();
    } catch (_) {}
    setSaving(false);
  };
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Budgets</h2>
        <span className="a-card-meta">{saving ? "saving…" : (loaded ? "leave blank to disable a window" : "loading…")}</span>
      </div>
      <div className="a-budget-grid">
        {BUDGET_FIELDS.map((f) => (
          <label key={f.id} className="a-budget-field">
            <div className="a-plan-title">{f.label}</div>
            <div className="a-plan-note">{f.note}</div>
            <div className="a-budget-input">
              <span className="a-budget-currency">$</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={drafts[f.id]}
                placeholder="—"
                onChange={(e) => setDrafts((d) => ({ ...d, [f.id]: e.target.value }))}
                onBlur={(e) => { if (e.target.value !== values[f.id]) persist(f.id, e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
              />
            </div>
          </label>
        ))}
      </div>
    </section>
  );
};
