# Retry / Loop Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect sessions where the same tool was invoked against the same target ≥ N times in close succession, especially after errors — a strong signal of a stuck loop. Flag these and link to the offending session.

**Architecture:** `core::loop_detector` scans `tool_calls` ordered by `(message_uuid, timestamp)`, walks within each session, and groups consecutive runs of identical `(tool_name, target)` pairs. Emits a row per "stuck run" with the count, error count, and time span. Endpoint: `/api/loops?min_run=3&days=N`. The Tips engine can consume the same data for a "stuck loops" tip.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/loop_detector.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-core/src/tips.rs` — add a rule that reads loop_detector
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/routes/sessions.jsx` — add a "Loops" column or panel

---

### Task 1: Core detection

**Files:**
- Create: `crates/token-dashboard-core/src/loop_detector.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [x] **Step 1: Register**

```rust
pub mod loop_detector;
```

- [x] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct StuckRun {
    pub session_id: String,
    pub tool_name: String,
    pub target: String,
    pub count: u32,
    pub errors: u32,
    pub first_seen: String,
    pub last_seen: String,
}

pub fn detect(conn: &Connection, min_run: u32, days: u32) -> rusqlite::Result<Vec<StuckRun>> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('m1','s','p','assistant','2026-05-20T10:00:00Z','x',0,0,0,0,0)", []).unwrap();
        for i in 0..5 {
            c.execute(
                "INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m1','Bash','npm test',?,0,1,?)",
                rusqlite::params![format!("t{i}"), format!("2026-05-20T10:00:0{}Z", i)],
            ).unwrap();
        }
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m1','Read','x.rs','tr',0,0,'2026-05-20T10:00:10Z')", []).unwrap();
    }

    #[test]
    fn detects_run_of_three_or_more_identical_calls() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let runs = detect(&c, 3, 30).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].tool_name, "Bash");
        assert_eq!(runs[0].count, 5);
        assert_eq!(runs[0].errors, 5);
    }
}
```

- [x] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core loop_detector`
Expected: FAIL.

- [x] **Step 4: Implement**

```rust
pub fn detect(conn: &Connection, min_run: u32, days: u32) -> rusqlite::Result<Vec<StuckRun>> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut stmt = conn.prepare(
        "SELECT m.session_id, tc.tool_name, COALESCE(tc.target, ''), tc.is_error, tc.timestamp \
         FROM tool_calls tc JOIN messages m ON m.uuid = tc.message_uuid \
         WHERE tc.timestamp >= ?1 \
         ORDER BY m.session_id, tc.timestamp"
    )?;
    let rows: Vec<(String, String, String, u32, String)> = stmt.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)? as u32, r.get::<_, String>(4)?))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::new();
    let mut cur: Option<StuckRun> = None;
    let flush = |out: &mut Vec<StuckRun>, run: Option<StuckRun>, min_run: u32| {
        if let Some(r) = run { if r.count >= min_run { out.push(r); } }
    };
    for (session_id, tool, target, is_error, ts) in rows {
        let matches = cur.as_ref().map_or(false, |r| {
            r.session_id == session_id && r.tool_name == tool && r.target == target
        });
        if matches {
            let r = cur.as_mut().unwrap();
            r.count += 1;
            r.errors += is_error;
            r.last_seen = ts;
        } else {
            flush(&mut out, cur.take(), min_run);
            cur = Some(StuckRun {
                session_id, tool_name: tool, target, count: 1, errors: is_error,
                first_seen: ts.clone(), last_seen: ts,
            });
        }
    }
    flush(&mut out, cur, min_run);
    out.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(out)
}
```

- [x] **Step 5: Run**

`cargo test -p token-dashboard-core loop_detector` → PASS.

- [x] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,loop_detector}.rs
git commit -m "feat(core): tool-call loop detector"
```

---

### Task 2: API + Tips rule + UI

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `crates/token-dashboard-core/src/tips.rs`
- Modify: `frontend/src/routes/sessions.jsx`

- [x] **Step 1: Endpoint**

```rust
#[derive(serde::Deserialize, Default)]
struct LoopsQuery { min_run: Option<u32>, days: Option<u32> }

async fn get_loops(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<LoopsQuery>,
) -> axum::response::Json<Vec<token_dashboard_core::loop_detector::StuckRun>> {
    let min_run = q.min_run.unwrap_or(3).clamp(2, 1000);
    let days = q.days.unwrap_or(30).clamp(1, 365);
    axum::response::Json(
        token_dashboard_core::loop_detector::detect(&state.conn(), min_run, days).unwrap_or_default()
    )
}
```

Register `.route("/api/loops", axum::routing::get(get_loops))`.

- [x] **Step 2: Tips rule**

In `tips.rs`, add a rule that calls `loop_detector::detect(conn, 4, 7)` and emits a Tip if any rows are returned, naming the worst offender.

- [x] **Step 3: Sessions UI**

In `sessions.jsx`, fetch `/api/loops?days=30` once. Build a `Map<session_id, runs[]>`. For each session row that has runs, render a 🔁 chip with `runs.length` and tooltip showing the top run's tool + count.

- [x] **Step 4: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs crates/token-dashboard-core/src/tips.rs frontend/src/routes/sessions.jsx
git commit -m "feat: surface stuck-tool loops in Tips + Sessions"
```

---

## Self-Review Notes

- We collapse consecutive identical calls. Non-consecutive repeats (e.g. interleaved with other calls) are intentionally not flagged on this pass — those are usually intentional retries with a fix in between.
- `target` is whatever the scanner stored: file path for Edit/Read, command string for Bash. Empty target means "non-targeted tool" and is still grouped correctly.
