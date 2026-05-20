# Cache Hit Rate Trend Sparkline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show daily cache-read-hit-rate as a sparkline on the Overview, plus a 7-/30-day average KPI. Hit rate = `cache_read / (cache_read + input)` per assistant message, weighted by tokens.

**Architecture:** A new `cache_stats::daily_hit_rate` core function aggregates per-day totals from the `messages` table. CLI exposes `/api/cache_stats?days=N`. Overview renders a `CacheTrendCard` with the sparkline + the two averages. The existing models card already shows aggregate cache numbers — this builds on that data without duplicating.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/cache_stats.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx` (add `CacheTrendCard`)

---

### Task 1: Core daily aggregation

**Files:**
- Create: `crates/token-dashboard-core/src/cache_stats.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Register module**

```rust
// lib.rs
pub mod cache_stats;
```

- [ ] **Step 2: Write the failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct DailyCache {
    pub date: String,
    pub input: u64,
    pub cache_read: u64,
    pub cache_create_5m: u64,
    pub cache_create_1h: u64,
    pub hit_rate: f64, // cache_read / (cache_read + input)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct CacheTrend {
    pub days: Vec<DailyCache>,
    pub avg_7d: f64,
    pub avg_30d: f64,
}

pub fn trend(conn: &Connection, days: u32) -> rusqlite::Result<CacheTrend> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(conn: &Connection) {
        crate::db::migrate(conn).unwrap();
        // Day 1: 100 input, 900 cache_read => hit_rate 0.9
        conn.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u1', 's1', 'p1', 'assistant', '2026-05-19T12:00:00Z', 'claude-opus-4-7', 100, 50, 900, 0, 0)", []).unwrap();
        // Day 2: 200 input, 200 cache_read => hit_rate 0.5
        conn.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('u2', 's1', 'p1', 'assistant', '2026-05-20T12:00:00Z', 'claude-opus-4-7', 200, 50, 200, 0, 0)", []).unwrap();
    }

    #[test]
    fn computes_per_day_hit_rate() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let t = trend(&c, 30).unwrap();
        let d1 = t.days.iter().find(|d| d.date == "2026-05-19").unwrap();
        assert!((d1.hit_rate - 0.9).abs() < 1e-6);
        let d2 = t.days.iter().find(|d| d.date == "2026-05-20").unwrap();
        assert!((d2.hit_rate - 0.5).abs() < 1e-6);
    }

    #[test]
    fn averages_weighted_by_tokens() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let t = trend(&c, 30).unwrap();
        // total cache_read = 1100, total (input+cache_read) = 1400; 1100/1400 ~ 0.7857
        assert!((t.avg_30d - 1100.0/1400.0).abs() < 1e-6);
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core cache_stats`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn trend(conn: &Connection, days: u32) -> rusqlite::Result<CacheTrend> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut stmt = conn.prepare(
        "SELECT substr(timestamp, 1, 10) AS day, \
                SUM(input_tokens), SUM(cache_read_tokens), \
                SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens) \
         FROM messages WHERE type='assistant' AND timestamp >= ?1 \
         GROUP BY day ORDER BY day"
    )?;
    let rows = stmt.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64, r.get::<_, i64>(4)? as u64))
    })?;
    let mut day_rows = Vec::new();
    for row in rows {
        let (day, input, cache_read, c5, c1) = row?;
        let denom = (cache_read + input) as f64;
        let hit_rate = if denom > 0.0 { cache_read as f64 / denom } else { 0.0 };
        day_rows.push(DailyCache { date: day, input, cache_read, cache_create_5m: c5, cache_create_1h: c1, hit_rate });
    }
    let avg = |window: usize| -> f64 {
        let slice: Vec<_> = day_rows.iter().rev().take(window).collect();
        let (cr, denom) = slice.iter().fold((0u64, 0u64), |acc, d| (acc.0 + d.cache_read, acc.1 + d.cache_read + d.input));
        if denom > 0 { cr as f64 / denom as f64 } else { 0.0 }
    };
    Ok(CacheTrend { avg_7d: avg(7), avg_30d: avg(30), days: day_rows })
}
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p token-dashboard-core cache_stats`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,cache_stats}.rs
git commit -m "feat(core): cache hit-rate trend"
```

---

### Task 2: API endpoint

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [ ] **Step 1: Handler + route**

```rust
#[derive(serde::Deserialize, Default)]
struct CacheQuery { days: Option<u32> }

async fn get_cache_stats(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<CacheQuery>,
) -> axum::response::Json<token_dashboard_core::cache_stats::CacheTrend> {
    let days = q.days.unwrap_or(30).clamp(1, 180);
    axum::response::Json(
        token_dashboard_core::cache_stats::trend(&state.conn(), days).unwrap_or(
            token_dashboard_core::cache_stats::CacheTrend { days: vec![], avg_7d: 0.0, avg_30d: 0.0 }
        )
    )
}
```

Register: `.route("/api/cache_stats", axum::routing::get(get_cache_stats))`

- [ ] **Step 2: Smoke**

`curl http://127.0.0.1:8080/api/cache_stats?days=30`

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs
git commit -m "feat(cli): /api/cache_stats"
```

---

### Task 3: Frontend card

**Files:**
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx`

- [ ] **Step 1: Client**

```javascript
export async function fetchCacheStats(days = 30) {
  const r = await fetch(`/api/cache_stats?days=${days}`);
  return r.ok ? r.json() : null;
}
```

- [ ] **Step 2: Card**

Reuse the `Sparkline` from the burn-rate plan (or inline if it's missing):

```jsx
function CacheTrendCard({ data }) {
  if (!data) return null;
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  return (
    <div className="a-card">
      <div className="a-card-head">Cache hit rate</div>
      <div className="a-kpi-row">
        <div className="a-kpi"><div className="a-kpi-label">7d</div>
          <div className="a-kpi-value">{pct(data.avg_7d)}</div></div>
        <div className="a-kpi"><div className="a-kpi-label">30d</div>
          <div className="a-kpi-value">{pct(data.avg_30d)}</div></div>
      </div>
      <Sparkline points={data.days.map(d => d.hit_rate)} />
    </div>
  );
}
```

Wire it into the `Overview` root next to `ModelsCard`:

```jsx
const [cache, setCache] = useState(null);
useEffect(() => { fetchCacheStats(30).then(setCache); }, []);
// ...
<CacheTrendCard data={cache} />
```

- [ ] **Step 3: Build + verify**

```bash
cd frontend && npm run build && cd ..
cargo run -p token-dashboard-tauri
```

Confirm the card renders with both averages and the sparkline.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api-client.js frontend/src/routes/overview.jsx
git commit -m "feat(ui): cache hit-rate trend card"
```

---

## Self-Review Notes

- "Hit rate" denominator excludes `cache_create_*` deliberately — those are misses being seeded. If we change the definition later, all three values land in the same struct anyway.
- For long-running users (>180 days history), document the 180-day clamp; longer windows need progressive aggregation.
