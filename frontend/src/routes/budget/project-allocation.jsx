import React, { useEffect, useState } from "react";
import { fmtCost } from "../../format.js";

function toneFor(pct) {
  if (pct == null) return "";
  if (pct >= 100) return "tone-bad";
  if (pct >= 80) return "tone-warn";
  return "tone-good";
}

export function ProjectAllocation() {
  const [rows, setRows] = useState(null);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    fetch("/api/budget/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then(setRows)
      .catch(() => setRows([]));
  };

  useEffect(() => {
    load();
  }, []);

  const saveCap = async (slug, raw) => {
    const trimmed = raw.trim();
    const amount = trimmed === "" ? null : Number(trimmed);
    if (trimmed !== "" && !Number.isFinite(amount)) {
      setEditing(null);
      return;
    }
    setSaving(true);
    try {
      await fetch("/api/budget/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, amount }),
      });
      load();
    } finally {
      setSaving(false);
      setEditing(null);
      setDraft("");
    }
  };

  if (!rows) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Per-project allocation</h2>
        </div>
        <div className="a-hint">Loading…</div>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="a-card">
        <div className="a-card-head">
          <h2>Per-project allocation</h2>
          <span className="a-card-meta">month-to-date</span>
        </div>
        <div className="a-hint">
          No assistant activity this month yet. Set a cap below once a project shows up.
        </div>
      </section>
    );
  }

  const maxCost = Math.max(0.0001, ...rows.map((r) => r.mtd_cost_usd || 0));

  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Per-project allocation</h2>
        <span className="a-card-meta">month-to-date — set caps to track per-project</span>
      </div>
      <table className="a-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>MTD</th>
            <th>Cap</th>
            <th>%</th>
            <th>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pct = r.percent;
            const tone = toneFor(pct);
            const widthPct = ((r.mtd_cost_usd || 0) / maxCost) * 100;
            const isEditing = editing === r.project_slug;
            return (
              <tr key={r.project_slug}>
                <td title={r.project_slug}>{r.project_slug}</td>
                <td>{fmtCost(r.mtd_cost_usd || 0)}</td>
                <td>
                  {isEditing ? (
                    <input
                      autoFocus
                      type="number"
                      min="0"
                      step="0.01"
                      value={draft}
                      disabled={saving}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={(e) => saveCap(r.project_slug, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.currentTarget.blur();
                        } else if (e.key === "Escape") {
                          setEditing(null);
                          setDraft("");
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="a-link-button"
                      onClick={() => {
                        setEditing(r.project_slug);
                        setDraft(r.cap_usd != null ? String(r.cap_usd) : "");
                      }}
                    >
                      {r.cap_usd != null ? fmtCost(r.cap_usd) : "set…"}
                    </button>
                  )}
                </td>
                <td className={tone}>
                  {pct != null ? `${pct.toFixed(0)}%` : "—"}
                </td>
                <td>
                  <div className="a-stacked-bar">
                    <div
                      className={`a-stacked-bar-fill ${tone}`}
                      style={{ width: `${widthPct}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
