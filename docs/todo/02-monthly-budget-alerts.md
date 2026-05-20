# Monthly Budget Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fire OS-level notifications when monthly spend crosses 50%, 80%, and 100% of the configured budget. Each threshold fires once per month; user can mute per-threshold from Settings.

**Architecture:** `core::budget_alerts` computes month-to-date spend, compares against `Preferences.budget_usd`, and returns which thresholds have just been crossed. State (which thresholds already fired this month) is stored as JSON in the `preferences` table under key `budget_alerts_state`. The Tauri shell calls this check after every scan and uses `tauri-plugin-notification` to surface OS notifications. CLI-only mode logs to stderr instead.

**Tech Stack:** Rust core, `tauri-plugin-notification` (Tauri 2), existing preferences store.

---

## File Structure

- Create: `crates/token-dashboard-core/src/budget_alerts.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs` — `pub mod budget_alerts;`
- Modify: `crates/token-dashboard-core/src/preferences.rs` — add `budget_thresholds: Vec<u32>`, `budget_alerts_muted: Vec<u32>`
- Modify: `crates/token-dashboard-tauri/Cargo.toml` — add `tauri-plugin-notification`
- Modify: `crates/token-dashboard-tauri/src/main.rs` — register plugin + post-scan hook
- Modify: `crates/token-dashboard-cli/src/lib.rs` — `GET /api/budget_alerts` (manual trigger / inspection)
- Modify: `frontend/src/routes/settings/budget-card.jsx` — threshold checkboxes
- Test: in `crates/token-dashboard-core/src/budget_alerts.rs`

---

### Task 1: Core compute + state model

**Files:**
- Create: `crates/token-dashboard-core/src/budget_alerts.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Register module**

In `lib.rs`:
```rust
pub mod budget_alerts;
```

- [ ] **Step 2: Write the failing test**

```rust
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Default, Clone, PartialEq)]
pub struct AlertsState {
    pub month: String, // "2026-05"
    pub fired: Vec<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct AlertResult {
    pub mtd_cost_usd: f64,
    pub budget_usd: f64,
    pub percent: f64,
    pub thresholds: Vec<u32>,
    pub newly_crossed: Vec<u32>,
    pub state: AlertsState,
}

pub fn check(
    conn: &Connection,
    budget_usd: f64,
    thresholds: &[u32],
    muted: &[u32],
    prior: AlertsState,
    now: chrono::DateTime<chrono::Utc>,
) -> rusqlite::Result<AlertResult> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc.with_ymd_and_hms(2026, 5, 20, 12, 0, 0).unwrap()
    }

    fn seed_with_cost(conn: &Connection, output_per_msg: i64, count: i64) {
        crate::db::migrate(conn).unwrap();
        for i in 0..count {
            conn.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES (?, 's', 'p', 'assistant', '2026-05-10T12:00:00Z', 'claude-opus-4-7', 0, ?, 0, 0, 0)",
                rusqlite::params![format!("u-{i}"), output_per_msg],
            ).unwrap();
        }
    }

    #[test]
    fn fires_crossed_thresholds_once() {
        let conn = Connection::open_in_memory().unwrap();
        seed_with_cost(&conn, 1_000_000, 60); // ~60M tokens
        let prior = AlertsState { month: "2026-05".into(), fired: vec![] };
        let res = check(&conn, 100.0, &[50, 80, 100], &[], prior, now()).unwrap();
        assert_eq!(res.newly_crossed, vec![50, 80, 100]); // assuming cost exceeds 100
        // Second call should not re-fire
        let res2 = check(&conn, 100.0, &[50, 80, 100], &[], res.state.clone(), now()).unwrap();
        assert!(res2.newly_crossed.is_empty());
    }

    #[test]
    fn muted_threshold_is_skipped() {
        let conn = Connection::open_in_memory().unwrap();
        seed_with_cost(&conn, 1_000_000, 60);
        let prior = AlertsState { month: "2026-05".into(), fired: vec![] };
        let res = check(&conn, 100.0, &[50, 80, 100], &[80], prior, now()).unwrap();
        assert!(!res.newly_crossed.contains(&80));
    }

    #[test]
    fn new_month_resets_fired() {
        let conn = Connection::open_in_memory().unwrap();
        seed_with_cost(&conn, 1_000_000, 60);
        let prior = AlertsState { month: "2026-04".into(), fired: vec![50, 80, 100] };
        let res = check(&conn, 100.0, &[50, 80, 100], &[], prior, now()).unwrap();
        assert_eq!(res.state.month, "2026-05");
        assert!(!res.newly_crossed.is_empty());
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core budget_alerts`
Expected: FAIL.

- [ ] **Step 4: Implement check()**

```rust
pub fn check(
    conn: &Connection,
    budget_usd: f64,
    thresholds: &[u32],
    muted: &[u32],
    prior: AlertsState,
    now: chrono::DateTime<chrono::Utc>,
) -> rusqlite::Result<AlertResult> {
    let month = now.format("%Y-%m").to_string();
    let month_start = now.format("%Y-%m-01T00:00:00Z").to_string();

    let pricing = crate::pricing::load_default();
    let mut stmt = conn.prepare(
        "SELECT model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens) \
         FROM messages WHERE type='assistant' AND timestamp >= ?1 GROUP BY model"
    )?;
    let mut mtd_cost = 0.0;
    let rows = stmt.query_map(rusqlite::params![month_start], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64, r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64))
    })?;
    for row in rows {
        let (m, inp, out, cr, c5, c1) = row?;
        mtd_cost += pricing.cost_for(m.as_deref(), inp, out, cr, c5, c1);
    }

    let percent = if budget_usd > 0.0 { (mtd_cost / budget_usd) * 100.0 } else { 0.0 };
    let prior_fired: Vec<u32> = if prior.month == month { prior.fired } else { vec![] };

    let mut newly_crossed = Vec::new();
    let mut fired = prior_fired.clone();
    for &t in thresholds {
        if muted.contains(&t) { continue; }
        if percent >= t as f64 && !prior_fired.contains(&t) {
            newly_crossed.push(t);
            fired.push(t);
        }
    }

    Ok(AlertResult {
        mtd_cost_usd: mtd_cost,
        budget_usd,
        percent,
        thresholds: thresholds.to_vec(),
        newly_crossed,
        state: AlertsState { month, fired },
    })
}
```

- [ ] **Step 5: Confirm passing**

Run: `cargo test -p token-dashboard-core budget_alerts -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,budget_alerts}.rs
git commit -m "feat(core): monthly budget alert thresholds"
```

---

### Task 2: Persist thresholds + alert state in preferences

**Files:**
- Modify: `crates/token-dashboard-core/src/preferences.rs`

- [ ] **Step 1: Add fields to the Preferences struct**

Open `crates/token-dashboard-core/src/preferences.rs`. Find the `Preferences` struct. Add:

```rust
#[serde(default = "default_thresholds")]
pub budget_thresholds: Vec<u32>,
#[serde(default)]
pub budget_alerts_muted: Vec<u32>,
#[serde(default)]
pub budget_alerts_state: crate::budget_alerts::AlertsState,
```

Add helper:

```rust
fn default_thresholds() -> Vec<u32> { vec![50, 80, 100] }
```

- [ ] **Step 2: Test serialization round-trip**

Append to the test module:

```rust
#[test]
fn budget_alert_fields_round_trip() {
    let p = Preferences { budget_thresholds: vec![25, 50], ..Default::default() };
    let s = serde_json::to_string(&p).unwrap();
    let p2: Preferences = serde_json::from_str(&s).unwrap();
    assert_eq!(p2.budget_thresholds, vec![25, 50]);
}
```

- [ ] **Step 3: Run**

Run: `cargo test -p token-dashboard-core preferences`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-core/src/preferences.rs
git commit -m "feat(prefs): persist budget alert thresholds + state"
```

---

### Task 3: `/api/budget_alerts` endpoint

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Add handler**

```rust
async fn get_budget_alerts(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> axum::response::Json<token_dashboard_core::budget_alerts::AlertResult> {
    let conn = state.conn();
    let mut prefs = token_dashboard_core::preferences::load(&conn).unwrap_or_default();
    let budget = prefs.budget_usd.unwrap_or(0.0);
    let result = token_dashboard_core::budget_alerts::check(
        &conn, budget, &prefs.budget_thresholds, &prefs.budget_alerts_muted,
        prefs.budget_alerts_state.clone(), chrono::Utc::now(),
    ).unwrap();
    if !result.newly_crossed.is_empty() {
        prefs.budget_alerts_state = result.state.clone();
        let _ = token_dashboard_core::preferences::save(&conn, &prefs);
    }
    axum::response::Json(result)
}
```

Register: `.route("/api/budget_alerts", axum::routing::get(get_budget_alerts))`

- [ ] **Step 2: Smoke test**

Run: `curl -s http://127.0.0.1:8080/api/budget_alerts`
Expected: JSON with `percent`, `newly_crossed`, etc.

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs
git commit -m "feat(cli): /api/budget_alerts"
```

---

### Task 4: Tauri OS notifications

**Files:**
- Modify: `crates/token-dashboard-tauri/Cargo.toml`
- Modify: `crates/token-dashboard-tauri/src/main.rs`

- [ ] **Step 1: Add dep**

In `crates/token-dashboard-tauri/Cargo.toml` under `[dependencies]`:

```toml
tauri-plugin-notification = "2"
```

- [ ] **Step 2: Register plugin and post-scan hook**

In `main.rs` builder chain:

```rust
.plugin(tauri_plugin_notification::init())
```

After the existing scan-completion path (search for the SSE broadcaster or scan handler), call:

```rust
fn fire_budget_alerts(app: &tauri::AppHandle, conn: &rusqlite::Connection) {
    use tauri_plugin_notification::NotificationExt;
    let mut prefs = token_dashboard_core::preferences::load(conn).unwrap_or_default();
    let Some(budget) = prefs.budget_usd else { return };
    if budget <= 0.0 { return; }
    let result = match token_dashboard_core::budget_alerts::check(
        conn, budget, &prefs.budget_thresholds, &prefs.budget_alerts_muted,
        prefs.budget_alerts_state.clone(), chrono::Utc::now(),
    ) {
        Ok(r) => r,
        Err(_) => return,
    };
    for t in &result.newly_crossed {
        let title = format!("Token Dashboard — {t}% of budget");
        let body = format!("${:.2} of ${:.2} this month.", result.mtd_cost_usd, budget);
        let _ = app.notification().builder().title(title).body(body).show();
    }
    if !result.newly_crossed.is_empty() {
        prefs.budget_alerts_state = result.state;
        let _ = token_dashboard_core::preferences::save(conn, &prefs);
    }
}
```

Wire `fire_budget_alerts(&app_handle, &conn)` into the post-scan callback.

- [ ] **Step 3: Manual verification**

Run:
```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

Temporarily set `budget_usd=0.01` in Settings, trigger a scan, expect OS notification.

- [ ] **Step 4: Commit**

```bash
git add crates/token-dashboard-tauri/Cargo.toml crates/token-dashboard-tauri/src/main.rs
git commit -m "feat(tauri): OS notifications for budget thresholds"
```

---

### Task 5: Settings UI for thresholds

**Files:**
- Modify: `frontend/src/routes/settings/budget-card.jsx`
- Modify: `frontend/src/api-client.js`

- [ ] **Step 1: Add controls**

In `budget-card.jsx`, below the existing budget input, add:

```jsx
const allThresholds = [25, 50, 75, 80, 90, 100];
function ThresholdRow({ prefs, save }) {
  const enabled = new Set(prefs.budget_thresholds || []);
  const muted = new Set(prefs.budget_alerts_muted || []);
  const toggle = (t) => {
    const next = new Set(enabled);
    next.has(t) ? next.delete(t) : next.add(t);
    save({ ...prefs, budget_thresholds: [...next].sort((a,b)=>a-b) });
  };
  const toggleMute = (t) => {
    const next = new Set(muted);
    next.has(t) ? next.delete(t) : next.add(t);
    save({ ...prefs, budget_alerts_muted: [...next].sort((a,b)=>a-b) });
  };
  return (
    <div className="a-threshold-row">
      <div className="a-label">Alert at</div>
      {allThresholds.map(t => (
        <label key={t} className="a-chip">
          <input type="checkbox" checked={enabled.has(t)} onChange={() => toggle(t)} /> {t}%
          {enabled.has(t) && (
            <button onClick={() => toggleMute(t)} className={muted.has(t) ? 'is-muted' : ''}>
              {muted.has(t) ? 'muted' : 'mute'}
            </button>
          )}
        </label>
      ))}
    </div>
  );
}
```

Render `<ThresholdRow prefs={prefs} save={savePrefs} />` after the budget input.

- [ ] **Step 2: Confirm POST /api/preferences accepts new fields**

`api-client.js` already serializes prefs as JSON; no change needed unless the existing save helper strips unknown fields.

- [ ] **Step 3: Manual check**

Tick 50/80/100, save, reload page, confirm checkboxes persist.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/settings/budget-card.jsx
git commit -m "feat(ui): budget alert threshold controls"
```

---

## Self-Review Notes

- The "fire once" guarantee depends on `preferences::save` being atomic. If save fails after notification, the alert can re-fire — acceptable on first iteration.
- Linux requires a notification daemon; if missing the call silently no-ops.
- macOS first launch will prompt for notification permission — document in CHANGELOG once shipped.
