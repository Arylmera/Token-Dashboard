import React, { useEffect, useState } from "react";
import { fmtCost } from "../../format.js";

const FIELDS = [
  { key: "daily", label: "daily ($)" },
  { key: "weekly", label: "weekly ($)" },
  { key: "monthly", label: "monthly ($)" },
];

export function BudgetEditor() {
  const [budgets, setBudgets] = useState(null);
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    fetch("/api/budget")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setBudgets(b || { daily: null, weekly: null, monthly: null }));
  }, []);

  const commit = async (key, raw) => {
    const value = raw === "" ? null : Number(raw);
    if (raw !== "" && !Number.isFinite(value)) return;
    const next = { ...budgets, [key]: value };
    setBudgets(next);
    setDrafts((d) => ({ ...d, [key]: undefined }));
    await fetch("/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
  };

  if (!budgets) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Budget</h2>
        </div>
        <div className="a-hint">Loading…</div>
      </section>
    );
  }

  const monthly = budgets.monthly;
  const daysInMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth() + 1,
    0,
  ).getDate();
  const onPaceDaily = monthly != null && monthly > 0 ? monthly / daysInMonth : null;

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Budget</h2>
        <span className="a-card-meta">caps for the burn-rate and alert math</span>
      </div>
      <div className="a-budget-grid">
        {FIELDS.map(({ key, label }) => {
          const stored = budgets[key];
          const draft = drafts[key];
          const display = draft !== undefined ? draft : stored ?? "";
          return (
            <label key={key} className="a-budget-field-stack">
              <span className="a-label">{label}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={display}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [key]: e.target.value }))
                }
                onBlur={(e) => commit(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  } else if (e.key === "Escape") {
                    setDrafts((d) => ({ ...d, [key]: undefined }));
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>
          );
        })}
      </div>
      {onPaceDaily != null && (
        <div className="a-hint">
          On-pace: {fmtCost(onPaceDaily)}/day this month ({daysInMonth} days).
        </div>
      )}
    </section>
  );
}
