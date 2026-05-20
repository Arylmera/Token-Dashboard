# Subagent ROI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quantify whether subagent delegation saves tokens overall. For each subagent invocation: measure cost spent inside the sidechain vs the tokens the parent would have consumed had it inlined the work (proxied by subagent's final report size).

**Architecture:** Sidechain messages are flagged via `is_sidechain = 1`. `core::subagent_roi` groups them by their root `parent_uuid` (the assistant message in the main thread that spawned them), sums sidechain cost, and compares to a "main-thread equivalent" cost computed from the report-back size (the final assistant message inside the sidechain). Endpoint: `/api/subagent_roi?days=N`. UI: a card on Overview showing aggregate savings/loss, plus per-agent breakdown.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/subagent_roi.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx`

---

### Task 1: Core ROI computation

**Files:**
- Create: `crates/token-dashboard-core/src/subagent_roi.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Register module**

```rust
pub mod subagent_roi;
```

- [ ] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct AgentRow {
    pub agent_id: String,
    pub invocations: u64,
    pub sidechain_cost_usd: f64,
    pub report_tokens: u64,
    pub estimated_inline_cost_usd: f64,
    pub net_savings_usd: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct RoiReport {
    pub total_sidechain_cost_usd: f64,
    pub total_estimated_inline_cost_usd: f64,
    pub total_net_savings_usd: f64,
    pub agents: Vec<AgentRow>,
}

pub fn report(conn: &Connection, days: u32, main_model: &str) -> rusqlite::Result<RoiReport> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // Sidechain: agent 'Explore', 1000 output tokens, lots of cache
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, is_sidechain, agent_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('s1','sess','p',1,1,'Explore','2026-05-20T10:00:00Z','claude-sonnet-4-6',500,200,0,0,0)", []).unwrap();
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, is_sidechain, agent_id, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('s2','sess','p',1,1,'Explore','2026-05-20T10:00:30Z','claude-sonnet-4-6',300,800,0,0,0)", []).unwrap();
    }

    #[test]
    fn aggregates_per_agent_and_estimates_savings() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let r = report(&c, 30, "claude-opus-4-7").unwrap();
        assert_eq!(r.agents.len(), 1);
        let row = &r.agents[0];
        assert_eq!(row.agent_id, "Explore");
        assert_eq!(row.invocations, 1); // grouped by trailing report
        assert!(row.report_tokens > 0);
        // inline-equivalent uses opus pricing on the report-back; sidechain used sonnet
        assert!(row.estimated_inline_cost_usd > 0.0);
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core subagent_roi`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn report(conn: &Connection, days: u32, main_model: &str) -> rusqlite::Result<RoiReport> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let pricing = crate::pricing::load_default();

    // Per-agent sidechain totals
    let mut sc = conn.prepare(
        "SELECT COALESCE(agent_id, '(unknown)'), \
                SUM(input_tokens), SUM(output_tokens), \
                SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens), \
                COUNT(DISTINCT session_id || '|' || COALESCE(agent_id, '')), \
                model \
         FROM messages \
         WHERE type='assistant' AND is_sidechain = 1 AND timestamp >= ?1 \
         GROUP BY COALESCE(agent_id, '(unknown)'), model"
    )?;
    let mut agg: std::collections::HashMap<String, AgentRow> = Default::default();
    for row in sc.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64, r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64,
            r.get::<_, i64>(6)? as u64, r.get::<_, Option<String>>(7)?))
    })? {
        let (agent, inp, out, cr, c5, c1, invocations, model) = row?;
        let cost = pricing.cost_for(model.as_deref(), inp, out, cr, c5, c1);
        let entry = agg.entry(agent.clone()).or_insert(AgentRow {
            agent_id: agent, invocations: 0, sidechain_cost_usd: 0.0, report_tokens: 0,
            estimated_inline_cost_usd: 0.0, net_savings_usd: 0.0,
        });
        entry.sidechain_cost_usd += cost;
        entry.invocations += invocations;
    }

    // Estimate inline-equivalent: take the trailing (last) sidechain assistant message per (session, agent)
    // — that's the "report" the parent would have had to produce.
    let mut tails = conn.prepare(
        "SELECT COALESCE(agent_id, '(unknown)'), MAX(timestamp) FROM messages \
         WHERE type='assistant' AND is_sidechain=1 AND timestamp >= ?1 \
         GROUP BY session_id, COALESCE(agent_id, '')"
    )?;
    let mut tail_rows: Vec<(String, String)> = Vec::new();
    for row in tails.query_map(rusqlite::params![cutoff_iso], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        tail_rows.push(row?);
    }
    let mut tail_lookup = conn.prepare(
        "SELECT output_tokens FROM messages \
         WHERE type='assistant' AND is_sidechain=1 AND COALESCE(agent_id, '(unknown)')=?1 AND timestamp=?2 LIMIT 1"
    )?;
    for (agent, ts) in tail_rows {
        let output: u64 = tail_lookup.query_row(rusqlite::params![agent, ts], |r| Ok(r.get::<_, i64>(0)? as u64)).unwrap_or(0);
        if let Some(entry) = agg.get_mut(&agent) {
            entry.report_tokens += output;
            // Inline equivalent: charge the user's main model for those output tokens as if it had produced them itself
            let inline = pricing.cost_for(Some(main_model), 0, output, 0, 0, 0);
            entry.estimated_inline_cost_usd += inline;
        }
    }

    let mut total_sc = 0.0; let mut total_inline = 0.0;
    for row in agg.values_mut() {
        row.net_savings_usd = row.estimated_inline_cost_usd - row.sidechain_cost_usd;
        total_sc += row.sidechain_cost_usd;
        total_inline += row.estimated_inline_cost_usd;
    }
    let mut agents: Vec<_> = agg.into_values().collect();
    agents.sort_by(|a, b| b.net_savings_usd.partial_cmp(&a.net_savings_usd).unwrap());

    Ok(RoiReport {
        total_sidechain_cost_usd: total_sc,
        total_estimated_inline_cost_usd: total_inline,
        total_net_savings_usd: total_inline - total_sc,
        agents,
    })
}
```

- [ ] **Step 5: Run**

`cargo test -p token-dashboard-core subagent_roi` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,subagent_roi}.rs
git commit -m "feat(core): subagent ROI report"
```

---

### Task 2: API + Overview card

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx`

- [ ] **Step 1: Endpoint**

```rust
#[derive(serde::Deserialize, Default)]
struct RoiQuery { days: Option<u32>, main_model: Option<String> }

async fn get_subagent_roi(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<RoiQuery>,
) -> axum::response::Json<token_dashboard_core::subagent_roi::RoiReport> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let main = q.main_model.unwrap_or_else(|| "claude-opus-4-7".to_string());
    axum::response::Json(
        token_dashboard_core::subagent_roi::report(&state.conn(), days, &main).unwrap_or(
            token_dashboard_core::subagent_roi::RoiReport {
                total_sidechain_cost_usd: 0.0, total_estimated_inline_cost_usd: 0.0,
                total_net_savings_usd: 0.0, agents: vec![],
            }
        )
    )
}
```

Register `.route("/api/subagent_roi", axum::routing::get(get_subagent_roi))`.

- [ ] **Step 2: Card**

```jsx
function SubagentRoiCard() {
  const [data, setData] = useState(null);
  useEffect(() => { fetch('/api/subagent_roi?days=30').then(r=>r.json()).then(setData); }, []);
  if (!data) return null;
  const tone = data.total_net_savings_usd >= 0 ? 'good' : 'bad';
  return (
    <div className="a-card">
      <div className="a-card-head">Subagent ROI · 30d</div>
      <div className="a-kpi-row">
        <div className="a-kpi"><div className="a-kpi-label">Spent on agents</div>
          <div className="a-kpi-value">${data.total_sidechain_cost_usd.toFixed(2)}</div></div>
        <div className="a-kpi"><div className="a-kpi-label">Inline equivalent</div>
          <div className="a-kpi-value">${data.total_estimated_inline_cost_usd.toFixed(2)}</div></div>
        <div className="a-kpi"><div className="a-kpi-label">Net</div>
          <div className={`a-kpi-value tone-${tone}`}>
            {data.total_net_savings_usd >= 0 ? '+' : ''}${data.total_net_savings_usd.toFixed(2)}
          </div></div>
      </div>
      <table className="a-table">
        <thead><tr><th>Agent</th><th>Invocations</th><th>Spent</th><th>Net</th></tr></thead>
        <tbody>
          {data.agents.map(a => (
            <tr key={a.agent_id}>
              <td>{a.agent_id}</td>
              <td>{a.invocations}</td>
              <td>${a.sidechain_cost_usd.toFixed(2)}</td>
              <td>${a.net_savings_usd.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Render in `Overview`.

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/api-client.js frontend/src/routes/overview.jsx
git commit -m "feat: subagent ROI endpoint + Overview card"
```

---

## Self-Review Notes

- The "inline equivalent" is a deliberate under-estimate — it charges only the report-back, not the exploration cost the parent would have done. Document this in the card's tooltip so users don't read the number as exact.
- If the scanner stores agent identity differently (e.g. on a different column than `agent_id`), adjust the GROUP BY.
