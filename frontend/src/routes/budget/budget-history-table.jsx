import React, { useEffect, useState } from "react";
import { fmtCost } from "../../format.js";

function toneFor(pct) {
  if (pct == null) return "";
  if (pct >= 100) return "tone-bad";
  if (pct >= 80) return "tone-warn";
  return "tone-good";
}

export function BudgetHistoryTable() {
  const [rows, setRows] = useState(null);
  const [months, setMonths] = useState(6);

  useEffect(() => {
    fetch(`/api/budget/history?months=${months}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setRows)
      .catch(() => setRows([]));
  }, [months]);

  if (!rows) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>History</h2>
        </div>
        <div className="a-hint">Loading…</div>
      </section>
    );
  }

  // Render newest first for at-a-glance reading.
  const ordered = [...rows].reverse();

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>History</h2>
        <div className="a-window-switcher">
          {[3, 6, 12, 24].map((n) => (
            <button
              key={n}
              type="button"
              className={n === months ? "active" : ""}
              onClick={() => setMonths(n)}
            >
              {n}mo
            </button>
          ))}
        </div>
      </div>
      {ordered.length === 0 ? (
        <div className="a-hint">No activity in the selected window.</div>
      ) : (
        <table className="a-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Spend</th>
              <th>Budget</th>
              <th>%</th>
              <th>Threshold hit</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((r) => {
              const tone = toneFor(r.percent);
              return (
                <tr key={r.month}>
                  <td>{r.month}</td>
                  <td>{fmtCost(r.total_cost_usd || 0)}</td>
                  <td>{r.budget_at_time != null ? fmtCost(r.budget_at_time) : "—"}</td>
                  <td className={tone}>
                    {r.percent != null ? `${r.percent.toFixed(0)}%` : "—"}
                  </td>
                  <td className={tone}>
                    {r.max_threshold_fired != null ? `${r.max_threshold_fired}%` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.some((r) => r.budget_at_time != null) && (
        <div className="a-hint">
          % uses the current monthly budget for every row — historical budget
          changes aren&apos;t tracked yet.
        </div>
      )}
    </section>
  );
}
