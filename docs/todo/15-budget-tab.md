# Budget Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated "Budget" page between Overview and Prompts that bundles all budget UX in one place: threshold picker, budget editor, expanded burn-rate graph, per-project allocation, and threshold history.

**Architecture:** A new top-level route `#/budget` rendered by `frontend/src/routes/budget.jsx`, composed of five sub-cards. Reuses existing endpoints (`/api/budget`, `/api/budget-alerts*`, `/api/burn-rate`, `/api/projects`) and adds two new ones:
- `GET /api/budget/projects?month=YYYY-MM` — per-project MTD spend + optional caps.
- `GET /api/budget/history?months=N` — past N months: MTD totals, max threshold fired, end-of-month %.

Per-project caps are stored in the existing `plan` k/v table under keys `budget_project_<slug>_usd`. A migration is not needed; `preferences::set_project_budget` adds/clears the key.

**Tech Stack:** Rust (axum, rusqlite), React 18, existing `D` data-store, existing `StripSpark`/`AreaChart` chart helpers.

---

## File Structure

- Create: `frontend/src/routes/budget.jsx` — page shell
- Create: `frontend/src/routes/budget/threshold-picker.jsx`
- Create: `frontend/src/routes/budget/budget-editor.jsx`
- Create: `frontend/src/routes/budget/burn-rate-panel.jsx`
- Create: `frontend/src/routes/budget/project-allocation.jsx`
- Create: `frontend/src/routes/budget/budget-history-table.jsx`
- Modify: route registration (search for the existing route table — likely `frontend/src/App.jsx` or `entry.jsx`)
- Modify: nav tabs (search for "Overview" string near nav rendering)
- Modify: `frontend/src/api-client.js` — add REG entries for new endpoints; map into MOCK_DATA
- Create: `crates/token-dashboard-core/src/budget_projects.rs` — per-project MTD aggregation
- Create: `crates/token-dashboard-core/src/budget_history.rs` — past-month totals + threshold-fired lookup
- Modify: `crates/token-dashboard-core/src/preferences.rs` — `get_project_budget` / `set_project_budget` / `list_project_budgets`
- Modify: `crates/token-dashboard-core/src/lib.rs` — register new modules
- Modify: `crates/token-dashboard-cli/src/lib.rs` — new handlers + route registration
- Modify: `frontend/styles.css` — `.a-budget-tab` layout, `.a-stacked-bar` styles

Implementation phased across tasks 1-7. Each task ends in a commit; an integrator may merge as one PR or split into a series.

---

### Task 1: Wire the route + empty page

**Files:**
- Create: `frontend/src/routes/budget.jsx`
- Modify: route table file
- Modify: nav file

- [ ] **Step 1: Page skeleton**

```jsx
import React from "react";

export const Budget = () => (
  <div className="a-route a-budget-tab">
    <h1>Budget</h1>
    <p className="a-hint">Coming online — see sub-cards below.</p>
  </div>
);
```

- [ ] **Step 2: Register the hash route**

Find the existing routes table (search for `path="/overview"` or `case "overview":`). Add:

```jsx
import { Budget } from "./routes/budget.jsx";
// ...within the switch / route table:
case "budget": return <Budget />;
// or
<Route path="/budget" element={<Budget />} />
```

- [ ] **Step 3: Add the nav tab**

Find the nav header (likely a `<nav>` block in `App.jsx` or similar with "Overview", "Sessions" strings). Insert between Overview and Prompts:

```jsx
<a href="#/budget" className={cur === "budget" ? "active" : ""}>Budget</a>
```

- [ ] **Step 4: Verify**

```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

Click the new tab, confirm route renders. URL should be `#/budget`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/budget.jsx frontend/src/App.jsx
git commit -m "feat(ui): scaffold Budget tab + nav entry"
```

---

### Task 2: Threshold picker

**Files:**
- Create: `frontend/src/routes/budget/threshold-picker.jsx`
- Modify: `frontend/src/api-client.js` (add `budgetAlertsConfig` REG entry)
- Modify: `frontend/src/routes/budget.jsx`

- [ ] **Step 1: REG entry**

In `api-client.js`:

```js
{ key: "budgetAlertsConfig", trigger: "static", url: () => "/api/budget-alerts/config", fallback: () => null },
```

And in `_rebuildMockData`:

```js
budgetAlertsConfig: c.budgetAlertsConfig || null,
```

- [ ] **Step 2: Picker component**

```jsx
import React, { useEffect, useState } from "react";

const ALL = [25, 50, 75, 80, 90, 100];

export function ThresholdPicker() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => {
    fetch("/api/budget-alerts/config").then(r => r.json()).then(setCfg);
  }, []);
  const save = (next) => {
    fetch("/api/budget-alerts/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    }).then(r => r.json()).then(setCfg);
  };
  if (!cfg) return <div className="a-card">Loading…</div>;
  const enabled = new Set(cfg.thresholds || []);
  const muted = new Set(cfg.muted || []);
  const toggle = (t) => {
    const next = new Set(enabled);
    next.has(t) ? next.delete(t) : next.add(t);
    save({ thresholds: [...next].sort((a, b) => a - b), muted: cfg.muted });
  };
  const toggleMute = (t) => {
    const next = new Set(muted);
    next.has(t) ? next.delete(t) : next.add(t);
    save({ thresholds: cfg.thresholds, muted: [...next].sort((a, b) => a - b) });
  };
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Alert thresholds</h2></div>
      <div className="a-threshold-row">
        {ALL.map(t => (
          <label key={t} className={`a-chip ${enabled.has(t) ? "is-on" : ""} ${muted.has(t) ? "is-muted" : ""}`}>
            <input type="checkbox" checked={enabled.has(t)} onChange={() => toggle(t)} />
            <span>{t}%</span>
            {enabled.has(t) && (
              <button onClick={(e) => { e.preventDefault(); toggleMute(t); }}>
                {muted.has(t) ? "muted" : "mute"}
              </button>
            )}
          </label>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Wire it in**

In `budget.jsx`:

```jsx
import { ThresholdPicker } from "./budget/threshold-picker.jsx";
// ...inside the page:
<ThresholdPicker />
```

- [ ] **Step 4: CSS**

Append to `frontend/styles.css`:

```css
.dir-a-root .a-budget-tab { display: flex; flex-direction: column; gap: 16px; padding: 16px; }
.dir-a-root .a-threshold-row { display: flex; gap: 8px; flex-wrap: wrap; }
.dir-a-root .a-threshold-row .a-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 8px; border: 1px solid var(--iron-border); border-radius: 4px;
  cursor: pointer; font-size: 12px;
}
.dir-a-root .a-threshold-row .a-chip.is-on { background: color-mix(in oklab, var(--accent) 12%, transparent); }
.dir-a-root .a-threshold-row .a-chip.is-muted { opacity: 0.5; }
.dir-a-root .a-threshold-row .a-chip input { margin: 0; }
.dir-a-root .a-threshold-row .a-chip button {
  background: transparent; border: none; color: var(--gull); font-size: 11px; cursor: pointer;
}
```

- [ ] **Step 5: Verify**

Open the tab, toggle thresholds, refresh, confirm persistence. Try the mute button.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/budget/threshold-picker.jsx frontend/src/routes/budget.jsx frontend/src/api-client.js frontend/styles.css
git commit -m "feat(ui): budget threshold picker"
```

---

### Task 3: Budget editor

**Files:**
- Create: `frontend/src/routes/budget/budget-editor.jsx`
- Modify: `frontend/src/routes/budget.jsx`

- [ ] **Step 1: Editor component**

```jsx
import React, { useEffect, useState } from "react";
import { fmtCost } from "../../format.js";

export function BudgetEditor() {
  const [budgets, setBudgets] = useState({ daily: null, weekly: null, monthly: null });
  useEffect(() => {
    fetch("/api/budget").then(r => r.json()).then(setBudgets);
  }, []);
  const save = (partial) => {
    fetch("/api/budget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...budgets, ...partial }),
    }).then(() => fetch("/api/budget")).then(r => r.json()).then(setBudgets);
  };
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const inferredDaily = budgets.monthly ? budgets.monthly / daysInMonth : null;
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Budget</h2></div>
      <div className="a-budget-grid">
        {["daily", "weekly", "monthly"].map(k => (
          <label key={k}>
            <span className="a-label">{k} ($)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={budgets[k] ?? ""}
              onChange={(e) => save({ [k]: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      {inferredDaily != null && (
        <div className="a-hint">Monthly at {fmtCost(inferredDaily)}/day on-pace ({daysInMonth} days).</div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire it in**

In `budget.jsx` add `<BudgetEditor />` next to the picker.

- [ ] **Step 3: CSS**

```css
.dir-a-root .a-budget-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(120px, 1fr));
  gap: 12px;
}
.dir-a-root .a-budget-grid input { width: 100%; padding: 6px 8px; }
```

- [ ] **Step 4: Verify**

Change a value, confirm `/api/budget` reflects it, confirm `/api/budget-alerts` percent updates on next refresh.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/budget/budget-editor.jsx frontend/src/routes/budget.jsx frontend/styles.css
git commit -m "feat(ui): budget editor card"
```

---

### Task 4: Expanded burn-rate panel

**Files:**
- Create: `frontend/src/routes/budget/burn-rate-panel.jsx`
- Modify: `frontend/src/routes/budget.jsx`
- Modify: `frontend/src/api-client.js` (optional: pre-fetch additional windows)

- [ ] **Step 1: Panel component**

```jsx
import React, { useEffect, useState } from "react";
import { fmtCost } from "../../format.js";
import { AreaChart } from "../../components/charts.jsx";

const WINDOWS = [7, 30, 60, 90];

export function BurnRatePanel() {
  const [windowDays, setWindow] = useState(30);
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch(`/api/burn-rate?window_days=${windowDays}`).then(r => r.json()).then(setData);
  }, [windowDays]);
  if (!data) return <div className="a-card">Loading…</div>;
  const series = (data.daily_series || []).map((d, i) => ({ x: i, y: d.cost_usd, label: d.date }));
  const onPace = data.monthly_budget_usd != null
    ? data.monthly_budget_usd / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
    : null;
  return (
    <section className="a-card">
      <div className="a-card-head">
        <h2>Burn rate</h2>
        <div className="a-window-switcher">
          {WINDOWS.map(w => (
            <button key={w} className={w === windowDays ? "active" : ""} onClick={() => setWindow(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>
      <div className="a-kpi-row">
        <div className="a-kpi"><div className="a-kpi-label">avg/day</div><div className="a-kpi-value">{fmtCost(data.avg_daily_cost_usd)}</div></div>
        <div className="a-kpi"><div className="a-kpi-label">days left</div><div className="a-kpi-value">{data.days_remaining != null ? data.days_remaining.toFixed(1) : "—"}</div></div>
        {onPace != null && (
          <div className="a-kpi"><div className="a-kpi-label">on-pace</div><div className="a-kpi-value">{fmtCost(onPace)}/day</div></div>
        )}
      </div>
      <AreaChart data={series} height={160} guidelineY={onPace} />
    </section>
  );
}
```

If `AreaChart` doesn't support a `guidelineY` prop, add one (a horizontal dashed line). Otherwise fall back to `StripSpark` and draw the guideline with raw SVG.

- [ ] **Step 2: Wire it in**

`<BurnRatePanel />` in `budget.jsx`.

- [ ] **Step 3: CSS**

```css
.dir-a-root .a-window-switcher { display: inline-flex; gap: 4px; }
.dir-a-root .a-window-switcher button {
  padding: 2px 8px; background: transparent; border: 1px solid var(--iron-border);
  color: var(--gull); cursor: pointer; border-radius: 3px;
}
.dir-a-root .a-window-switcher button.active { color: var(--bone); border-color: var(--accent); }
```

- [ ] **Step 4: Verify**

Switch windows, confirm graph re-renders with the new range and the on-pace guideline is visible when a monthly budget is set.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/routes/budget/burn-rate-panel.jsx frontend/src/routes/budget.jsx frontend/styles.css frontend/src/components/charts.jsx
git commit -m "feat(ui): expanded burn-rate panel with window switcher"
```

---

### Task 5: Per-project allocation (core + endpoint)

**Files:**
- Create: `crates/token-dashboard-core/src/budget_projects.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-core/src/preferences.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Per-project caps in preferences**

Add to `preferences.rs`:

```rust
fn project_cap_key(slug: &str) -> String { format!("budget_project_{slug}_usd") }

pub fn get_project_budget<P: AsRef<Path>>(db: P, slug: &str) -> rusqlite::Result<Option<f64>> {
    let key = project_cap_key(slug);
    Ok(read_str(db, &key)?.and_then(|v| v.parse::<f64>().ok()).filter(|f| *f > 0.0))
}

pub fn set_project_budget<P: AsRef<Path>>(db: P, slug: &str, amount: Option<f64>) -> rusqlite::Result<()> {
    let key = project_cap_key(slug);
    match amount.filter(|v| *v > 0.0) {
        Some(v) => write_str(db, &key, &v.to_string()),
        None => delete_key(db, &key),
    }
}

pub fn list_project_budgets<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<(String, f64)>> {
    let c = open(db)?;
    let mut stmt = c.prepare("SELECT k, v FROM plan WHERE k LIKE 'budget_project_%_usd'")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for row in rows {
        let (k, v) = row?;
        if let Some(slug) = k.strip_prefix("budget_project_").and_then(|s| s.strip_suffix("_usd")) {
            if let Ok(amount) = v.parse::<f64>() {
                if amount > 0.0 { out.push((slug.to_string(), amount)); }
            }
        }
    }
    Ok(out)
}
```

- [ ] **Step 2: budget_projects module**

```rust
use std::path::Path;
use serde::Serialize;
use rusqlite::params;

use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectAllocation {
    pub project_slug: String,
    pub mtd_cost_usd: f64,
    pub cap_usd: Option<f64>,
    pub percent: Option<f64>,
}

pub fn allocations<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<ProjectAllocation>> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let caps: std::collections::HashMap<String, f64> = crate::preferences::list_project_budgets(db)?.into_iter().collect();

    let mut stmt = conn.prepare(
        "SELECT COALESCE(project_slug, '(none)'), model, \
                COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND substr(timestamp, 1, 10) >= strftime('%Y-%m-01', 'now') \
         GROUP BY project_slug, model"
    )?;

    let mut by_project: std::collections::BTreeMap<String, f64> = Default::default();
    for row in stmt.query_map([], |r| Ok((
        r.get::<_, String>(0)?,
        r.get::<_, Option<String>>(1)?,
        r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?,
        r.get::<_, i64>(5)?, r.get::<_, i64>(6)?,
    )))? {
        let (slug, model, inp, out, cr, c5, c1) = row?;
        let usage = Usage {
            input_tokens: inp, output_tokens: out, cache_read_tokens: cr,
            cache_create_5m_tokens: c5, cache_create_1h_tokens: c1,
        };
        if let Some(m) = model {
            *by_project.entry(slug).or_insert(0.0) += cost_for(&m, &usage, &pricing).usd.unwrap_or(0.0);
        }
    }

    let mut out: Vec<ProjectAllocation> = by_project.into_iter().map(|(slug, cost)| {
        let cap = caps.get(&slug).copied();
        let percent = cap.map(|c| if c > 0.0 { (cost / c) * 100.0 } else { 0.0 });
        ProjectAllocation { project_slug: slug, mtd_cost_usd: cost, cap_usd: cap, percent }
    }).collect();
    out.sort_by(|a, b| b.mtd_cost_usd.partial_cmp(&a.mtd_cost_usd).unwrap());
    Ok(out)
}

#[cfg(test)]
mod tests {
    // Insert two assistant messages in different projects for the current month,
    // set a cap on one, assert allocations() returns expected percentages.
}
```

Register `pub mod budget_projects;` in `lib.rs`.

- [ ] **Step 3: Endpoints**

In CLI `lib.rs`:

```rust
async fn budget_projects_get(
    State(s): State<AppState>,
) -> Result<Json<Vec<token_dashboard_core::budget_projects::ProjectAllocation>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_projects::allocations(path.as_ref())).await
}

#[derive(Deserialize)]
struct ProjectBudgetBody { slug: String, amount: Option<f64> }

async fn budget_projects_post(
    State(s): State<AppState>,
    Json(body): Json<ProjectBudgetBody>,
) -> Result<StatusCode, ApiError> {
    let path = s.db_path.clone();
    blocking_unit(move || {
        token_dashboard_core::preferences::set_project_budget(path.as_ref(), &body.slug, body.amount)
    }).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

Register:

```rust
.route("/api/budget/projects", get(budget_projects_get).post(budget_projects_post))
```

- [ ] **Step 4: Tests**

```bash
cargo test -p token-dashboard-core budget_projects
```

- [ ] **Step 5: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,budget_projects,preferences}.rs crates/token-dashboard-cli/src/lib.rs
git commit -m "feat(core): per-project budget allocations + endpoint"
```

---

### Task 6: Per-project allocation UI

**Files:**
- Create: `frontend/src/routes/budget/project-allocation.jsx`
- Modify: `frontend/src/routes/budget.jsx`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/styles.css`

- [ ] **Step 1: REG entry**

```js
{ key: "budgetProjects", trigger: "any", url: () => "/api/budget/projects", fallback: () => [] },
```

Add `budgetProjects: c.budgetProjects || []` to MOCK_DATA.

- [ ] **Step 2: Component**

```jsx
import React, { useState } from "react";
import { D } from "../../data-store.js";
import { fmtCost } from "../../format.js";

export function ProjectAllocation() {
  const rows = D.budgetProjects || [];
  const max = Math.max(0.0001, ...rows.map(r => r.mtd_cost_usd));
  const [editing, setEditing] = useState(null);
  const saveCap = (slug, amount) => {
    fetch("/api/budget/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, amount }),
    }).then(() => window.RELOAD_DATA && window.RELOAD_DATA());
    setEditing(null);
  };
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>Per-project allocation (MTD)</h2></div>
      <table className="a-table">
        <thead><tr><th>Project</th><th>MTD</th><th>Cap</th><th>%</th><th>Bar</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const pct = r.percent;
            const tone = pct == null ? "" : pct >= 100 ? "tone-bad" : pct >= 80 ? "tone-warn" : "tone-good";
            const w = (r.mtd_cost_usd / max) * 100;
            return (
              <tr key={r.project_slug}>
                <td>{r.project_slug}</td>
                <td>{fmtCost(r.mtd_cost_usd)}</td>
                <td>
                  {editing === r.project_slug ? (
                    <input
                      autoFocus
                      type="number"
                      defaultValue={r.cap_usd ?? ""}
                      onBlur={(e) => saveCap(r.project_slug, e.target.value === "" ? null : Number(e.target.value))}
                    />
                  ) : (
                    <button className="a-link" onClick={() => setEditing(r.project_slug)}>
                      {r.cap_usd != null ? fmtCost(r.cap_usd) : "set…"}
                    </button>
                  )}
                </td>
                <td className={tone}>{pct != null ? `${pct.toFixed(0)}%` : "—"}</td>
                <td><div className="a-stacked-bar"><div className={`a-stacked-bar-fill ${tone}`} style={{ width: `${w}%` }} /></div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 3: CSS**

```css
.dir-a-root .a-stacked-bar { width: 120px; height: 8px; background: var(--panel-2); border-radius: 4px; overflow: hidden; }
.dir-a-root .a-stacked-bar-fill { height: 100%; background: var(--accent); }
.dir-a-root .a-stacked-bar-fill.tone-warn { background: var(--warn); }
.dir-a-root .a-stacked-bar-fill.tone-bad { background: var(--bad); }
```

- [ ] **Step 4: Wire it in**

`<ProjectAllocation />` in `budget.jsx`.

- [ ] **Step 5: Verify**

Set a cap on one project, confirm % shows and tone reflects threshold.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/budget/project-allocation.jsx frontend/src/routes/budget.jsx frontend/src/api-client.js frontend/styles.css
git commit -m "feat(ui): per-project budget allocation"
```

---

### Task 7: Threshold history

**Files:**
- Create: `crates/token-dashboard-core/src/budget_history.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Create: `frontend/src/routes/budget/budget-history-table.jsx`
- Modify: `frontend/src/routes/budget.jsx`
- Modify: `frontend/src/api-client.js`

- [ ] **Step 1: Core history query**

```rust
use std::path::Path;
use serde::Serialize;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MonthRow {
    pub month: String,             // "YYYY-MM"
    pub total_cost_usd: f64,
    pub budget_at_time: Option<f64>, // best-effort: current monthly budget
    pub percent: Option<f64>,
    pub max_threshold_fired: Option<u32>,
}

pub fn history<P: AsRef<Path>>(db: P, months: u32) -> rusqlite::Result<Vec<MonthRow>> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let budget = crate::preferences::get_budgets(db)?.monthly;

    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m', timestamp) AS m, model, \
                COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), \
                COALESCE(SUM(cache_read_tokens),0), \
                COALESCE(SUM(cache_create_5m_tokens),0), \
                COALESCE(SUM(cache_create_1h_tokens),0) \
         FROM messages \
         WHERE type='assistant' AND timestamp >= date('now', ?1) \
         GROUP BY m, model ORDER BY m DESC"
    )?;
    let offset = format!("-{} months", months as i64);
    let mut by_month: std::collections::BTreeMap<String, f64> = Default::default();
    for row in stmt.query_map(rusqlite::params![offset], |r| Ok((
        r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?,
        r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?,
        r.get::<_, i64>(5)?, r.get::<_, i64>(6)?,
    )))? {
        let (m, model, inp, out, cr, c5, c1) = row?;
        let u = Usage { input_tokens: inp, output_tokens: out, cache_read_tokens: cr, cache_create_5m_tokens: c5, cache_create_1h_tokens: c1 };
        if let Some(model) = model {
            *by_month.entry(m).or_insert(0.0) += cost_for(&model, &u, &pricing).usd.unwrap_or(0.0);
        }
    }

    // max_threshold_fired = max threshold <= percent (when budget is known and present)
    let thresholds = crate::budget_alerts::get_config(db).map(|c| c.thresholds).unwrap_or_else(|_| vec![50, 80, 100]);
    let mut out: Vec<MonthRow> = by_month.into_iter().rev().map(|(month, total_cost_usd)| {
        let (percent, max_threshold_fired) = match budget {
            Some(b) if b > 0.0 => {
                let pct = (total_cost_usd / b) * 100.0;
                let max = thresholds.iter().rev().find(|t| pct >= **t as f64).copied();
                (Some(pct), max)
            }
            _ => (None, None),
        };
        MonthRow { month, total_cost_usd, budget_at_time: budget, percent, max_threshold_fired }
    }).collect();
    out.truncate(months as usize);
    Ok(out)
}
```

Register `pub mod budget_history;`.

- [ ] **Step 2: Endpoint**

```rust
#[derive(Deserialize, Default)]
struct BudgetHistoryQuery { months: Option<u32> }

async fn budget_history_get(
    State(s): State<AppState>,
    Query(q): Query<BudgetHistoryQuery>,
) -> Result<Json<Vec<token_dashboard_core::budget_history::MonthRow>>, ApiError> {
    let months = q.months.unwrap_or(6).clamp(1, 36);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_history::history(path.as_ref(), months)).await
}
```

Register `.route("/api/budget/history", get(budget_history_get))`.

- [ ] **Step 3: REG + UI**

```js
{ key: "budgetHistory", trigger: "static", url: () => "/api/budget/history?months=6", fallback: () => [] },
```

```jsx
import { fmtCost } from "../../format.js";
import { D } from "../../data-store.js";

export function BudgetHistoryTable() {
  const rows = D.budgetHistory || [];
  if (rows.length === 0) return null;
  return (
    <section className="a-card">
      <div className="a-card-head"><h2>History</h2></div>
      <table className="a-table">
        <thead><tr><th>Month</th><th>Total</th><th>Budget</th><th>%</th><th>Max threshold</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.month}>
              <td>{r.month}</td>
              <td>{fmtCost(r.total_cost_usd)}</td>
              <td>{r.budget_at_time != null ? fmtCost(r.budget_at_time) : "—"}</td>
              <td>{r.percent != null ? `${r.percent.toFixed(0)}%` : "—"}</td>
              <td>{r.max_threshold_fired != null ? `${r.max_threshold_fired}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 4: Wire it in**

`<BudgetHistoryTable />` in `budget.jsx`.

- [ ] **Step 5: Verify**

For brand-new installs the table will mostly be empty. Confirm at least the current month shows.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,budget_history}.rs crates/token-dashboard-cli/src/lib.rs frontend/src/routes/budget/budget-history-table.jsx frontend/src/routes/budget.jsx frontend/src/api-client.js
git commit -m "feat: budget history table + endpoint"
```

---

## Self-Review Notes

- **`budget_at_time`** is a known imperfection: we use the current monthly budget for every historical month because we don't track historical budget changes. Acceptable — flagging "you would have crossed N% at then-budget" is more honest than fabricating a history.
- **Per-project caps** use the `plan` k/v store, not a new table. Cheap and follows the existing convention. If we ever need an audit log of cap changes, that's a follow-up.
- **AreaChart guideline** — if the existing `AreaChart` doesn't accept a `guidelineY`, add it in the same PR (one extra prop + a dashed `<line>`). Don't fork the chart component.
- **Settings page** still has BudgetCard/LimitsCard. Leave them; they're harmless and link-throughs to the new Budget tab can land in iteration 2.
- The OS-notification flow is a separate plan ([14-os-notifications.md](./14-os-notifications.md)). The Budget tab does not block on it.
