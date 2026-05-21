# Anomaly Alerts (3σ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect sessions whose cost is anomalously high (default: > 3 standard deviations above the rolling 30-day baseline for that project). Show them on Overview and feed the Tips engine.

**Architecture:** `core::anomaly` computes rolling mean+stdev of per-session cost per project over a configurable window, then flags any session whose cost exceeds `mean + k * stdev` (default k=3). Endpoint: `/api/anomalies?days=30&k=3`. Frontend: a card on Overview listing the flagged sessions with their cost and Z-score, linking back to the session detail.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/anomaly.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-core/src/tips.rs` — rule that consumes anomalies
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/routes/overview.jsx` — `AnomalyCard`

---

### Task 1: Core anomaly detection

**Files:**
- Create: `crates/token-dashboard-core/src/anomaly.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [x] **Step 1: Register**

```rust
pub mod anomaly;
```

- [x] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct Anomaly {
    pub session_id: String,
    pub project_slug: String,
    pub cost_usd: f64,
    pub baseline_mean: f64,
    pub baseline_stdev: f64,
    pub z_score: f64,
    pub first_seen: String,
}

pub fn detect(conn: &Connection, days: u32, k: f64) -> rusqlite::Result<Vec<Anomaly>> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // 9 normal sessions in project A, cost ~ $1 each (1M output tokens)
        for i in 0..9 {
            c.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES (?, ?, 'A', 'assistant', '2026-05-15T12:00:00Z', 'claude-opus-4-7', 0, 1000000, 0, 0, 0)",
                rusqlite::params![format!("u{i}"), format!("s{i}")],
            ).unwrap();
        }
        // 1 outlier in project A, 20x bigger
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('uX','sX','A','assistant','2026-05-18T12:00:00Z','claude-opus-4-7',0,20000000,0,0,0)",
            [],
        ).unwrap();
    }

    #[test]
    fn flags_only_outliers() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let rows = detect(&c, 30, 3.0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "sX");
        assert!(rows[0].z_score > 3.0);
    }

    #[test]
    fn returns_empty_when_baseline_too_small() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u','s','A','assistant','2026-05-18T12:00:00Z','x',0,1000,0,0,0)", []).unwrap();
        let rows = detect(&c, 30, 3.0).unwrap();
        assert!(rows.is_empty());
    }
}
```

- [x] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core anomaly`
Expected: FAIL.

- [x] **Step 4: Implement**

```rust
pub fn detect(conn: &Connection, days: u32, k: f64) -> rusqlite::Result<Vec<Anomaly>> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let pricing = crate::pricing::load_default();

    let mut stmt = conn.prepare(
        "SELECT session_id, COALESCE(project_slug, '(none)'), model, MIN(timestamp), \
                SUM(input_tokens), SUM(output_tokens), \
                SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens) \
         FROM messages WHERE type='assistant' AND timestamp >= ?1 \
         GROUP BY session_id, model"
    )?;
    // per-session cost = sum of per-model cost segments
    let mut per_session: std::collections::HashMap<String, (String, f64, String)> = Default::default();
    for row in stmt.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64,
            r.get::<_, i64>(6)? as u64, r.get::<_, i64>(7)? as u64, r.get::<_, i64>(8)? as u64))
    })? {
        let (session_id, project, model, ts, inp, out, cr, c5, c1) = row?;
        let cost = pricing.cost_for(model.as_deref(), inp, out, cr, c5, c1);
        let entry = per_session.entry(session_id.clone()).or_insert((project.clone(), 0.0, ts.clone()));
        entry.1 += cost;
        if ts < entry.2 { entry.2 = ts; }
    }

    // Group by project, compute mean/stdev (excluding the candidate itself? simpler: include all and require min sample size).
    let mut by_proj: std::collections::HashMap<String, Vec<(String, f64, String)>> = Default::default();
    for (sid, (project, cost, ts)) in per_session {
        by_proj.entry(project).or_default().push((sid, cost, ts));
    }
    let mut out = Vec::new();
    for (project, sessions) in by_proj {
        if sessions.len() < 5 { continue; } // need a baseline
        let n = sessions.len() as f64;
        let mean = sessions.iter().map(|s| s.1).sum::<f64>() / n;
        let var = sessions.iter().map(|s| (s.1 - mean).powi(2)).sum::<f64>() / n;
        let stdev = var.sqrt();
        if stdev == 0.0 { continue; }
        for (sid, cost, ts) in sessions {
            let z = (cost - mean) / stdev;
            if z > k {
                out.push(Anomaly {
                    session_id: sid, project_slug: project.clone(),
                    cost_usd: cost, baseline_mean: mean, baseline_stdev: stdev,
                    z_score: z, first_seen: ts,
                });
            }
        }
    }
    out.sort_by(|a, b| b.z_score.partial_cmp(&a.z_score).unwrap());
    Ok(out)
}
```

- [x] **Step 5: Run**

`cargo test -p token-dashboard-core anomaly` → PASS.

- [ ] **Step 6: Commit** _(pending — staged for caveman-commit)_

```bash
git add crates/token-dashboard-core/src/{lib,anomaly}.rs
git commit -m "feat(core): 3σ session-cost anomaly detector"
```

---

### Task 2: API + Tips rule + Overview card

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `crates/token-dashboard-core/src/tips.rs`
- Modify: `frontend/src/routes/overview.jsx`

- [x] **Step 1: Endpoint**

```rust
#[derive(serde::Deserialize, Default)]
struct AnomalyQuery { days: Option<u32>, k: Option<f64> }

async fn get_anomalies(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<AnomalyQuery>,
) -> axum::response::Json<Vec<token_dashboard_core::anomaly::Anomaly>> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let k = q.k.unwrap_or(3.0).max(0.5);
    axum::response::Json(
        token_dashboard_core::anomaly::detect(&state.conn(), days, k).unwrap_or_default()
    )
}
```

Register `.route("/api/anomalies", axum::routing::get(get_anomalies))`.

- [x] **Step 2: Tips rule**

In `tips.rs`, call `anomaly::detect(conn, 30, 3.0)`. If non-empty, emit a Tip naming the worst offender (`session_id`, project, z-score).

- [x] **Step 3: Overview card**

```jsx
function AnomalyCard() {
  const [rows, setRows] = useState([]);
  useEffect(() => { fetch('/api/anomalies?days=30&k=3').then(r=>r.json()).then(setRows); }, []);
  if (rows.length === 0) return null;
  return (
    <div className="a-card">
      <div className="a-card-head">Anomalous sessions · 30d (≥3σ)</div>
      <table className="a-table">
        <thead><tr><th>Session</th><th>Project</th><th>Cost</th><th>Z</th><th>When</th></tr></thead>
        <tbody>
          {rows.map(a => (
            <tr key={a.session_id}>
              <td><a href={`#/sessions/${a.session_id}`}>{a.session_id.slice(0,8)}</a></td>
              <td>{a.project_slug}</td>
              <td>${a.cost_usd.toFixed(2)}</td>
              <td>{a.z_score.toFixed(1)}σ</td>
              <td>{a.first_seen.slice(0,10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Render in `Overview`.

- [ ] **Step 4: Commit** _(pending — staged for caveman-commit)_

```bash
git add crates/token-dashboard-cli/src/lib.rs crates/token-dashboard-core/src/tips.rs frontend/src/routes/overview.jsx
git commit -m "feat: anomaly detection endpoint + Tips + Overview card"
```

---

## Self-Review Notes

- We include the candidate session in its own baseline, which slightly drags mean toward the outlier and shrinks the Z-score. Acceptable for now; switching to leave-one-out is a one-line change in the loop.
- A "5+ sessions" minimum is arbitrary but prevents pathological alerts from tiny samples. Tune as users complain.
- Log-transforming costs before computing mean/stdev would be more robust for heavy-tailed cost distributions; that's an iteration-2 improvement.
