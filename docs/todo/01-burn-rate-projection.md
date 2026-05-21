# Burn-Rate Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show projected "days until budget exhausted" on the Overview, based on the user's recent burn rate.

**Architecture:** A new query in `core::queries` computes a windowed mean daily spend (default 7-day, configurable). A new `/api/burn_rate` endpoint returns the projection alongside the active budget target. The Overview renders a small "Burn-Rate" card with the projected exhaustion date, current rate, and a sparkline of daily spend.

**Tech Stack:** Rust (axum, rusqlite, serde), React 18 (existing chart helpers in `frontend/src/routes/overview.jsx`).

---

## File Structure

- Create: `crates/token-dashboard-core/src/burn_rate.rs` — burn-rate computation
- Modify: `crates/token-dashboard-core/src/lib.rs` — register `pub mod burn_rate;`
- Modify: `crates/token-dashboard-cli/src/lib.rs` — register `/api/burn_rate` route
- Modify: `frontend/src/api-client.js` — add `fetchBurnRate()`
- Modify: `frontend/src/routes/overview.jsx` — render `BurnRateCard` between `KpiRow` and `LimitsCard`
- Test: `crates/token-dashboard-core/src/burn_rate.rs` — `#[cfg(test)] mod tests`

---

### Task 1: Core computation skeleton + failing test

**Files:**
- Create: `crates/token-dashboard-core/src/burn_rate.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Add the module declaration**

In `crates/token-dashboard-core/src/lib.rs`, add next to the other `pub mod` lines:

```rust
pub mod burn_rate;
```

- [ ] **Step 2: Write the failing test**

Create `crates/token-dashboard-core/src/burn_rate.rs`:

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct BurnRate {
    pub window_days: u32,
    pub avg_daily_cost_usd: f64,
    pub avg_daily_tokens: u64,
    pub budget_usd: Option<f64>,
    pub days_remaining: Option<f64>,
    pub projected_exhaustion_date: Option<String>, // ISO 8601
    pub daily_series: Vec<DailySpend>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct DailySpend {
    pub date: String,
    pub cost_usd: f64,
    pub tokens: u64,
}

pub fn compute(conn: &Connection, window_days: u32, budget_usd: Option<f64>) -> rusqlite::Result<BurnRate> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn seed(conn: &Connection) {
        crate::db::migrate(conn).unwrap();
        // Insert 7 days of identical spend at $1/day so avg_daily_cost_usd ~= 1.0
        for d in 0..7 {
            let day = format!("2026-05-{:02}", 14 - d);
            conn.execute(
                "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
                 VALUES (?, 's1', 'p1', 'assistant', ?, 'claude-opus-4-7', 0, 1000000, 0, 0, 0)",
                rusqlite::params![format!("u-{d}"), format!("{day}T12:00:00Z")],
            ).unwrap();
        }
    }

    #[test]
    fn computes_avg_daily_cost_and_days_remaining() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let br = compute(&conn, 7, Some(30.0)).unwrap();
        assert_eq!(br.window_days, 7);
        assert!(br.avg_daily_cost_usd > 0.0);
        assert!(br.days_remaining.unwrap() > 0.0);
        assert_eq!(br.daily_series.len(), 7);
    }

    #[test]
    fn no_budget_returns_none_remaining() {
        let conn = Connection::open_in_memory().unwrap();
        seed(&conn);
        let br = compute(&conn, 7, None).unwrap();
        assert!(br.days_remaining.is_none());
        assert!(br.projected_exhaustion_date.is_none());
    }
}
```

- [ ] **Step 3: Run the failing test**

Run: `cargo test -p token-dashboard-core burn_rate`
Expected: FAIL with "not implemented".

- [ ] **Step 4: Implement compute()**

Replace the `unimplemented!()` with:

```rust
pub fn compute(conn: &Connection, window_days: u32, budget_usd: Option<f64>) -> rusqlite::Result<BurnRate> {
    let pricing = crate::pricing::load_default();
    let cutoff = chrono::Utc::now() - chrono::Duration::days(window_days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let mut stmt = conn.prepare(
        "SELECT substr(timestamp, 1, 10) AS day, \
                model, \
                SUM(input_tokens), SUM(output_tokens), \
                SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens) \
         FROM messages \
         WHERE type='assistant' AND timestamp >= ?1 \
         GROUP BY day, model ORDER BY day"
    )?;
    let rows = stmt.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64,
            r.get::<_, i64>(4)? as u64,
            r.get::<_, i64>(5)? as u64,
            r.get::<_, i64>(6)? as u64,
        ))
    })?;

    let mut by_day: std::collections::BTreeMap<String, (f64, u64)> = Default::default();
    for row in rows {
        let (day, model, inp, out, cr, c5, c1) = row?;
        let cost = pricing.cost_for(model.as_deref(), inp, out, cr, c5, c1);
        let entry = by_day.entry(day).or_default();
        entry.0 += cost;
        entry.1 += inp + out + cr + c5 + c1;
    }

    let daily_series: Vec<DailySpend> = by_day.iter()
        .map(|(d, (c, t))| DailySpend { date: d.clone(), cost_usd: *c, tokens: *t })
        .collect();
    let total_cost: f64 = daily_series.iter().map(|d| d.cost_usd).sum();
    let total_tokens: u64 = daily_series.iter().map(|d| d.tokens).sum();
    let divisor = window_days.max(1) as f64;
    let avg_daily_cost_usd = total_cost / divisor;
    let avg_daily_tokens = (total_tokens as f64 / divisor) as u64;

    let (days_remaining, projected_exhaustion_date) = match budget_usd {
        Some(b) if avg_daily_cost_usd > 0.0 => {
            let days = (b / avg_daily_cost_usd).max(0.0);
            let exhaust = chrono::Utc::now() + chrono::Duration::seconds((days * 86400.0) as i64);
            (Some(days), Some(exhaust.format("%Y-%m-%d").to_string()))
        }
        _ => (None, None),
    };

    Ok(BurnRate {
        window_days,
        avg_daily_cost_usd,
        avg_daily_tokens,
        budget_usd,
        days_remaining,
        projected_exhaustion_date,
        daily_series,
    })
}
```

Note: `pricing::cost_for` may not exist by that exact signature. Inspect `crates/token-dashboard-core/src/pricing.rs` and adapt the call to whatever cost helper it exposes. If no per-model helper exists, write `cost_for(model: Option<&str>, input: u64, output: u64, cache_read: u64, cache_5m: u64, cache_1h: u64) -> f64` as a thin wrapper.

- [ ] **Step 5: Run the tests**

Run: `cargo test -p token-dashboard-core burn_rate -- --nocapture`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/burn_rate.rs crates/token-dashboard-core/src/lib.rs
git commit -m "feat(core): add burn-rate projection"
```

---

### Task 2: Expose `/api/burn_rate`

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Find the router**

Open `crates/token-dashboard-cli/src/lib.rs`. Locate the `Router::new().route(...)` chain. Identify how an existing GET endpoint (e.g. `/api/budget`) is wired — copy that handler shape.

- [ ] **Step 2: Write the handler**

Add near the other `async fn` handlers:

```rust
#[derive(serde::Deserialize, Default)]
struct BurnRateQuery {
    window_days: Option<u32>,
}

async fn get_burn_rate(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<BurnRateQuery>,
) -> axum::response::Json<token_dashboard_core::burn_rate::BurnRate> {
    let window = q.window_days.unwrap_or(7).clamp(1, 90);
    let prefs = token_dashboard_core::preferences::load(&state.conn()).unwrap_or_default();
    let budget = prefs.budget_usd; // adjust field name to match preferences::Preferences
    let br = token_dashboard_core::burn_rate::compute(&state.conn(), window, budget)
        .unwrap_or_else(|_| token_dashboard_core::burn_rate::BurnRate {
            window_days: window, avg_daily_cost_usd: 0.0, avg_daily_tokens: 0,
            budget_usd: budget, days_remaining: None,
            projected_exhaustion_date: None, daily_series: vec![],
        });
    axum::response::Json(br)
}
```

Adjust `AppState` and `state.conn()` to match the existing handler pattern.

- [ ] **Step 3: Register the route**

In the router chain, add:

```rust
.route("/api/burn_rate", axum::routing::get(get_burn_rate))
```

- [ ] **Step 4: Smoke-test**

Run: `cargo run -p token-dashboard-cli` (in one terminal)
Then: `curl -s http://127.0.0.1:8080/api/burn_rate?window_days=7 | head -c 200`
Expected: JSON containing `window_days`, `avg_daily_cost_usd`, `daily_series`.

- [ ] **Step 5: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs
git commit -m "feat(cli): expose /api/burn_rate"
```

---

### Task 3: Frontend client + card

**Files:**
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx`

- [ ] **Step 1: Add the client method**

In `frontend/src/api-client.js`, near the other fetch helpers, add:

```javascript
export async function fetchBurnRate(windowDays = 7) {
  const r = await fetch(`/api/burn_rate?window_days=${windowDays}`);
  if (!r.ok) throw new Error(`burn_rate ${r.status}`);
  return r.json();
}
```

If the file uses a single `MOCK_DATA` aggregator, hook the call into the existing refresh path (search for `fetch('/api/overview')` and add a parallel `Promise.all` entry).

- [ ] **Step 2: Add `BurnRateCard` to overview**

In `frontend/src/routes/overview.jsx`, add:

```jsx
function BurnRateCard({ data }) {
  if (!data) return null;
  const { avg_daily_cost_usd, days_remaining, projected_exhaustion_date, daily_series, budget_usd } = data;
  const tone = days_remaining == null ? 'gull'
    : days_remaining < 3 ? 'bad'
    : days_remaining < 7 ? 'warn' : 'good';
  return (
    <div className="a-card">
      <div className="a-card-head">Burn rate · 7-day</div>
      <div className="a-kpi-row">
        <div className="a-kpi"><div className="a-kpi-label">Avg / day</div>
          <div className="a-kpi-value">${avg_daily_cost_usd.toFixed(2)}</div></div>
        <div className="a-kpi"><div className="a-kpi-label">Days left</div>
          <div className={`a-kpi-value tone-${tone}`}>
            {days_remaining == null ? '—' : days_remaining.toFixed(1)}
          </div></div>
        <div className="a-kpi"><div className="a-kpi-label">Hits zero</div>
          <div className="a-kpi-value">{projected_exhaustion_date ?? '—'}</div></div>
      </div>
      <Sparkline points={daily_series.map(d => d.cost_usd)} />
      {budget_usd == null && <div className="a-hint">Set a budget in Settings to enable projection.</div>}
    </div>
  );
}
```

If a `Sparkline` component does not exist, create one inline:

```jsx
function Sparkline({ points }) {
  if (!points || points.length === 0) return null;
  const max = Math.max(...points, 0.0001);
  const w = 200, h = 40, step = w / Math.max(points.length - 1, 1);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p / max) * h).toFixed(1)}`).join(' ');
  return <svg width={w} height={h} className="a-sparkline"><path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5"/></svg>;
}
```

- [ ] **Step 3: Wire data into `Overview`**

In the `Overview` root component, add the fetch and render:

```jsx
const [burn, setBurn] = useState(null);
useEffect(() => { fetchBurnRate(7).then(setBurn).catch(() => {}); }, []);
// ...inside the JSX, after <KpiRow ... />:
<BurnRateCard data={burn} />
```

- [ ] **Step 4: Verify in the browser**

Run:
```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

Confirm the card appears on Overview and shows real numbers. If days-left is `—`, set a budget in Settings and refresh.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api-client.js frontend/src/routes/overview.jsx
git commit -m "feat(ui): burn-rate card on Overview"
```

---

## Self-Review Notes

- Field name `prefs.budget_usd` is a guess — inspect `preferences.rs` and rename if the actual field differs.
- If `pricing::cost_for` is private or missing, expose a thin pub helper rather than duplicating cost math inside `burn_rate.rs`.
- `chrono` is already a workspace dep (used by scanner/queries) — no Cargo edits required.
