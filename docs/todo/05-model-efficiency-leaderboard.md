# Model Efficiency Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank models by "cost per accepted edit" — a productivity metric beyond raw token count. Surface which model gives the best edit-throughput-per-dollar on this user's actual work.

**Architecture:** "Accepted edit" is approximated by counting successful `Edit` and `Write` tool calls (`tool_calls.is_error = 0`) attributed to a given assistant message. The `core::model_efficiency` module joins `messages` and `tool_calls`, groups by model, and emits cost-per-edit alongside raw cost and edit count. Endpoint: `/api/model_efficiency?days=N`. Frontend: a sortable leaderboard table next to the existing models card on Overview.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/model_efficiency.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx` — render `ModelLeaderboard`

---

### Task 1: Core query

**Files:**
- Create: `crates/token-dashboard-core/src/model_efficiency.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Register module**

```rust
pub mod model_efficiency;
```

- [ ] **Step 2: Write the failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct ModelRow {
    pub model: String,
    pub cost_usd: f64,
    pub edits: u64,
    pub cost_per_edit_usd: Option<f64>,
    pub tokens: u64,
    pub messages: u64,
}

pub fn leaderboard(conn: &Connection, days: u32) -> rusqlite::Result<Vec<ModelRow>> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // Message m1, model A, with 2 successful Edit calls
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('m1','s','p','assistant','2026-05-20T10:00:00Z','claude-opus-4-7',100,200,0,0,0)", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m1','Edit','a.rs','t1',0,0,'2026-05-20T10:00:01Z')", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m1','Write','b.rs','t2',0,0,'2026-05-20T10:00:02Z')", []).unwrap();
        // Message m2, model B, 1 failed Edit (should not count)
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('m2','s','p','assistant','2026-05-20T11:00:00Z','claude-sonnet-4-6',50,75,0,0,0)", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m2','Edit','c.rs','t3',0,1,'2026-05-20T11:00:01Z')", []).unwrap();
    }

    #[test]
    fn counts_only_successful_edits() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let rows = leaderboard(&c, 30).unwrap();
        let opus = rows.iter().find(|r| r.model == "claude-opus-4-7").unwrap();
        assert_eq!(opus.edits, 2);
        let sonnet = rows.iter().find(|r| r.model == "claude-sonnet-4-6").unwrap();
        assert_eq!(sonnet.edits, 0);
        assert!(sonnet.cost_per_edit_usd.is_none());
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core model_efficiency`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
pub fn leaderboard(conn: &Connection, days: u32) -> rusqlite::Result<Vec<ModelRow>> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let pricing = crate::pricing::load_default();

    let mut by_model_msgs = conn.prepare(
        "SELECT model, COUNT(*), SUM(input_tokens), SUM(output_tokens), \
                SUM(cache_read_tokens), SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens) \
         FROM messages WHERE type='assistant' AND timestamp >= ?1 GROUP BY model"
    )?;
    let mut by_model_edits = conn.prepare(
        "SELECT m.model, COUNT(*) FROM messages m \
         JOIN tool_calls tc ON tc.message_uuid = m.uuid \
         WHERE m.type='assistant' AND m.timestamp >= ?1 \
           AND tc.tool_name IN ('Edit','Write','NotebookEdit') AND tc.is_error = 0 \
         GROUP BY m.model"
    )?;
    let mut edits_map: std::collections::HashMap<String, u64> = Default::default();
    for row in by_model_edits.query_map(rusqlite::params![cutoff_iso], |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get::<_, i64>(1)? as u64)))? {
        let (m, e) = row?;
        edits_map.insert(m, e);
    }

    let mut out = Vec::new();
    for row in by_model_msgs.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64, r.get::<_, i64>(3)? as u64,
            r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64, r.get::<_, i64>(6)? as u64))
    })? {
        let (model, msgs, inp, out_tok, cr, c5, c1) = row?;
        let model_s = model.clone().unwrap_or_default();
        let cost = pricing.cost_for(model.as_deref(), inp, out_tok, cr, c5, c1);
        let edits = *edits_map.get(&model_s).unwrap_or(&0);
        let cost_per_edit = if edits > 0 { Some(cost / edits as f64) } else { None };
        out.push(ModelRow {
            model: model_s, cost_usd: cost, edits, cost_per_edit_usd: cost_per_edit,
            tokens: inp + out_tok + cr + c5 + c1, messages: msgs,
        });
    }
    out.sort_by(|a, b| a.cost_per_edit_usd.unwrap_or(f64::INFINITY).partial_cmp(&b.cost_per_edit_usd.unwrap_or(f64::INFINITY)).unwrap());
    Ok(out)
}
```

- [ ] **Step 5: Run**

Run: `cargo test -p token-dashboard-core model_efficiency`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,model_efficiency}.rs
git commit -m "feat(core): model efficiency leaderboard"
```

---

### Task 2: API + UI

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/overview.jsx`

- [ ] **Step 1: Endpoint**

```rust
#[derive(serde::Deserialize, Default)]
struct EfficiencyQuery { days: Option<u32> }

async fn get_model_efficiency(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<EfficiencyQuery>,
) -> axum::response::Json<Vec<token_dashboard_core::model_efficiency::ModelRow>> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    axum::response::Json(
        token_dashboard_core::model_efficiency::leaderboard(&state.conn(), days).unwrap_or_default()
    )
}
```

Register `.route("/api/model_efficiency", axum::routing::get(get_model_efficiency))`.

- [ ] **Step 2: Frontend table**

```jsx
function ModelLeaderboard({ days = 30 }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { fetch(`/api/model_efficiency?days=${days}`).then(r=>r.json()).then(setRows); }, [days]);
  return (
    <div className="a-card">
      <div className="a-card-head">Model efficiency · {days}d</div>
      <table className="a-table">
        <thead><tr><th>Model</th><th>Cost ($)</th><th>Edits</th><th>$/edit</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.model}>
              <td>{r.model || '—'}</td>
              <td>${r.cost_usd.toFixed(2)}</td>
              <td>{r.edits}</td>
              <td>{r.cost_per_edit_usd != null ? `$${r.cost_per_edit_usd.toFixed(3)}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Render next to `ModelsCard`.

- [ ] **Step 3: Smoke / commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/routes/overview.jsx frontend/src/api-client.js
git commit -m "feat: model efficiency leaderboard endpoint + card"
```

---

## Self-Review Notes

- "Cost per edit" attributes the full assistant-message cost to whichever edit it produced. A message that runs 5 Reads and 1 Edit pays the same for that Edit as a message that only ran an Edit. Acceptable approximation; revisit if it misleads.
- Add `NotebookEdit` to the success list if the user actually uses notebooks; harmless otherwise.
