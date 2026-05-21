# Week-Over-Week Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare two adjacent time windows (default: last 7 days vs the 7 days before) and show per-project, per-model, and per-tool deltas — both absolute and percentage.

**Architecture:** `core::period_diff` computes summary totals for two windows side-by-side (current, prior) and returns a `Diff` struct with per-group rows. Endpoint: `/api/diff?window=7d&groupBy=project|model|tool`. Frontend: a new top-level `Diff` view with selectors for window size and grouping; render as a table showing prior, current, Δ, %.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/period_diff.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Create: `frontend/src/routes/diff.jsx`
- Modify: route table to register `#/diff`

---

### Task 1: Core diff computation

**Files:**
- Create: `crates/token-dashboard-core/src/period_diff.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Module**

```rust
pub mod period_diff;
```

- [ ] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct DiffRow {
    pub key: String,
    pub prior_cost_usd: f64,
    pub current_cost_usd: f64,
    pub delta_usd: f64,
    pub pct_change: Option<f64>,
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
pub enum GroupBy { Project, Model, Tool }

pub fn compute(conn: &Connection, window_days: u32, group_by: GroupBy, now: chrono::DateTime<chrono::Utc>) -> rusqlite::Result<Vec<DiffRow>> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // Prior week (May 6-12): project A spent
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('p1','s','A','assistant','2026-05-10T10:00:00Z','x',0,1000,0,0,0)", []).unwrap();
        // Current week (May 13-19): project A spent more, project B new
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('p2','s','A','assistant','2026-05-15T10:00:00Z','x',0,2000,0,0,0)", []).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('p3','s','B','assistant','2026-05-16T10:00:00Z','x',0,500,0,0,0)", []).unwrap();
    }

    #[test]
    fn computes_per_project_delta_and_handles_new_projects() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let now = chrono::Utc.with_ymd_and_hms(2026, 5, 20, 0, 0, 0).unwrap();
        let rows = compute(&c, 7, GroupBy::Project, now).unwrap();
        let a = rows.iter().find(|r| r.key == "A").unwrap();
        assert!(a.current_cost_usd > a.prior_cost_usd);
        let b = rows.iter().find(|r| r.key == "B").unwrap();
        assert_eq!(b.prior_cost_usd, 0.0);
        assert!(b.pct_change.is_none()); // new entrant: undefined %
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core period_diff`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn compute(conn: &Connection, window_days: u32, group_by: GroupBy, now: chrono::DateTime<chrono::Utc>) -> rusqlite::Result<Vec<DiffRow>> {
    let cur_start = now - chrono::Duration::days(window_days as i64);
    let prior_start = cur_start - chrono::Duration::days(window_days as i64);
    let iso = |t: chrono::DateTime<chrono::Utc>| t.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let pricing = crate::pricing::load_default();

    let (key_sql, joins) = match group_by {
        GroupBy::Project => ("COALESCE(m.project_slug, '(none)')", ""),
        GroupBy::Model   => ("COALESCE(m.model, '(none)')", ""),
        GroupBy::Tool    => ("COALESCE(tc.tool_name, '(none)')", "JOIN tool_calls tc ON tc.message_uuid = m.uuid"),
    };

    let sql = format!(
        "SELECT {key_sql} AS k, m.model, \
                SUM(m.input_tokens), SUM(m.output_tokens), \
                SUM(m.cache_read_tokens), SUM(m.cache_create_5m_tokens), SUM(m.cache_create_1h_tokens), \
                CASE WHEN m.timestamp >= ?2 THEN 'cur' ELSE 'prior' END AS bucket \
         FROM messages m {joins} \
         WHERE m.type='assistant' AND m.timestamp >= ?1 \
         GROUP BY k, m.model, bucket"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut prior: std::collections::HashMap<String, f64> = Default::default();
    let mut current: std::collections::HashMap<String, f64> = Default::default();
    for row in stmt.query_map(rusqlite::params![iso(prior_start), iso(cur_start)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64,
            r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64, r.get::<_, i64>(6)? as u64,
            r.get::<_, String>(7)?))
    })? {
        let (k, m, inp, out, cr, c5, c1, bucket) = row?;
        let cost = pricing.cost_for(m.as_deref(), inp, out, cr, c5, c1);
        if bucket == "cur" { *current.entry(k).or_insert(0.0) += cost; }
        else { *prior.entry(k).or_insert(0.0) += cost; }
    }
    let mut keys: std::collections::BTreeSet<String> = prior.keys().chain(current.keys()).cloned().collect();
    let mut out = Vec::with_capacity(keys.len());
    for key in keys.drain(..) {
        let p = *prior.get(&key).unwrap_or(&0.0);
        let c = *current.get(&key).unwrap_or(&0.0);
        let delta = c - p;
        let pct = if p > 0.0 { Some((delta / p) * 100.0) } else { None };
        out.push(DiffRow { key, prior_cost_usd: p, current_cost_usd: c, delta_usd: delta, pct_change: pct });
    }
    out.sort_by(|a, b| b.delta_usd.partial_cmp(&a.delta_usd).unwrap());
    Ok(out)
}
```

- [ ] **Step 5: Run**

`cargo test -p token-dashboard-core period_diff` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,period_diff}.rs
git commit -m "feat(core): period diff computation"
```

---

### Task 2: API + Diff view

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Create: `frontend/src/routes/diff.jsx`
- Modify: `frontend/src/App.jsx` (or wherever routes are registered)

- [ ] **Step 1: Handler**

```rust
#[derive(serde::Deserialize, Default)]
struct DiffQuery { window: Option<String>, group_by: Option<String> }

async fn get_diff(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<DiffQuery>,
) -> axum::response::Json<Vec<token_dashboard_core::period_diff::DiffRow>> {
    let window_days = match q.window.as_deref() {
        Some("30d") => 30, Some("14d") => 14, Some("7d") | None => 7, _ => 7,
    };
    let group_by = match q.group_by.as_deref() {
        Some("model") => token_dashboard_core::period_diff::GroupBy::Model,
        Some("tool")  => token_dashboard_core::period_diff::GroupBy::Tool,
        _              => token_dashboard_core::period_diff::GroupBy::Project,
    };
    axum::response::Json(
        token_dashboard_core::period_diff::compute(&state.conn(), window_days, group_by, chrono::Utc::now()).unwrap_or_default()
    )
}
```

Register `.route("/api/diff", axum::routing::get(get_diff))`.

- [ ] **Step 2: Diff view**

```jsx
import React, { useEffect, useState } from 'react';

export default function DiffView() {
  const [windowKey, setWindow] = useState('7d');
  const [group, setGroup] = useState('project');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    fetch(`/api/diff?window=${windowKey}&group_by=${group}`).then(r=>r.json()).then(setRows);
  }, [windowKey, group]);
  return (
    <div className="a-card">
      <div className="a-card-head">
        Diff
        <select value={windowKey} onChange={e=>setWindow(e.target.value)}>
          <option>7d</option><option>14d</option><option>30d</option>
        </select>
        <select value={group} onChange={e=>setGroup(e.target.value)}>
          <option value="project">Project</option>
          <option value="model">Model</option>
          <option value="tool">Tool</option>
        </select>
      </div>
      <table className="a-table">
        <thead><tr><th>Key</th><th>Prior</th><th>Current</th><th>Δ</th><th>%</th></tr></thead>
        <tbody>
          {rows.map(r => {
            const tone = r.delta_usd > 0 ? 'bad' : r.delta_usd < 0 ? 'good' : 'gull';
            return (
              <tr key={r.key}>
                <td>{r.key}</td>
                <td>${r.prior_cost_usd.toFixed(2)}</td>
                <td>${r.current_cost_usd.toFixed(2)}</td>
                <td className={`tone-${tone}`}>{r.delta_usd >= 0 ? '+' : ''}${r.delta_usd.toFixed(2)}</td>
                <td>{r.pct_change == null ? 'new' : `${r.pct_change.toFixed(1)}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

Add to the existing route table: `Route path="/diff"`. Nav entry next to "Sessions".

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/routes/diff.jsx frontend/src/App.jsx
git commit -m "feat: period-diff view + endpoint"
```

---

## Self-Review Notes

- "New entrant" rows have no prior baseline; `pct_change = null`, displayed as "new". Consider an opposite "vanished" pseudo-row for prior-only keys if it proves useful.
- The Tool grouping joins `tool_calls`, which inflates per-message contributions; that's intentional (each tool gets credited) but document so the user doesn't try to sum the column.
