# Tool Call Cost Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which tools (Read, Bash, MCP servers, etc.) burn the most tokens. Each tool's "cost" = its share of `result_tokens` (the input the model paid for) plus an apportioned share of the assistant turn that called it.

**Architecture:** `core::tool_costs` joins `tool_calls` with parent `messages`. For each call, attribute `result_tokens * input_price` directly to the tool; apportion the parent message's `output_tokens` cost evenly across the tools it called. Group by `tool_name`, and (when the tool is an MCP tool) by the parsed server prefix. Endpoint: `/api/tool_costs?days=N`. Frontend: enhance the existing `api.jsx`/tools view to display the new cost column and an MCP server roll-up card.

**Tech Stack:** Rust core, axum, React 18.

---

## File Structure

- Create: `crates/token-dashboard-core/src/tool_costs.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/routes/api.jsx` (tools view) and `frontend/src/api-client.js`

---

### Task 1: Core attribution

**Files:**
- Create: `crates/token-dashboard-core/src/tool_costs.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [ ] **Step 1: Module**

```rust
pub mod tool_costs;
```

- [ ] **Step 2: Failing test**

```rust
use rusqlite::Connection;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq)]
pub struct ToolCost {
    pub tool_name: String,
    pub mcp_server: Option<String>,
    pub calls: u64,
    pub errors: u64,
    pub result_tokens: u64,
    pub attributed_cost_usd: f64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ToolCostReport {
    pub tools: Vec<ToolCost>,
    pub mcp_servers: Vec<(String, f64)>, // (server, total cost)
}

pub fn report(conn: &Connection, days: u32) -> rusqlite::Result<ToolCostReport> { unimplemented!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(c: &Connection) {
        crate::db::migrate(c).unwrap();
        // One message m with 1000 output_tokens, two tool calls: Read (200 result), Bash (800 result)
        c.execute("INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) VALUES ('m','s','p','assistant','2026-05-20T10:00:00Z','claude-opus-4-7',0,1000,0,0,0)", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m','Read','a.rs','t1',200,0,'2026-05-20T10:00:01Z')", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m','Bash','ls','t2',800,0,'2026-05-20T10:00:02Z')", []).unwrap();
        c.execute("INSERT INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) VALUES ('m','mcp__github__search_code','q','t3',50,0,'2026-05-20T10:00:03Z')", []).unwrap();
    }

    #[test]
    fn attributes_and_parses_mcp_server() {
        let c = Connection::open_in_memory().unwrap();
        seed(&c);
        let r = report(&c, 30).unwrap();
        let read_row = r.tools.iter().find(|t| t.tool_name == "Read").unwrap();
        assert_eq!(read_row.calls, 1);
        assert_eq!(read_row.result_tokens, 200);
        let mcp = r.tools.iter().find(|t| t.tool_name.starts_with("mcp__")).unwrap();
        assert_eq!(mcp.mcp_server.as_deref(), Some("github"));
    }
}
```

- [ ] **Step 3: Confirm failure**

Run: `cargo test -p token-dashboard-core tool_costs`
Expected: FAIL.

- [ ] **Step 4: Implement**

```rust
fn parse_mcp_server(tool_name: &str) -> Option<String> {
    let stripped = tool_name.strip_prefix("mcp__")?;
    let (server, _) = stripped.split_once("__")?;
    Some(server.to_string())
}

pub fn report(conn: &Connection, days: u32) -> rusqlite::Result<ToolCostReport> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days as i64);
    let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let pricing = crate::pricing::load_default();

    // For each tool call, compute attributed cost = parent's output_cost / parent_tool_count + result_tokens_input_cost
    let mut stmt = conn.prepare(
        "SELECT tc.tool_name, tc.is_error, tc.result_tokens, m.model, m.output_tokens, \
                (SELECT COUNT(*) FROM tool_calls WHERE message_uuid = m.uuid) AS sibling_count \
         FROM tool_calls tc \
         JOIN messages m ON m.uuid = tc.message_uuid \
         WHERE m.timestamp >= ?1"
    )?;
    let mut tool_map: std::collections::HashMap<String, ToolCost> = Default::default();
    for row in stmt.query_map(rusqlite::params![cutoff_iso], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64,
            r.get::<_, Option<String>>(3)?, r.get::<_, i64>(4)? as u64, r.get::<_, i64>(5)? as u64))
    })? {
        let (tool_name, is_error, result_tokens, model, parent_output, siblings) = row?;
        let parent_share = pricing.cost_for(model.as_deref(), 0, parent_output, 0, 0, 0) / siblings.max(1) as f64;
        let result_share = pricing.cost_for(model.as_deref(), result_tokens, 0, 0, 0, 0);
        let entry = tool_map.entry(tool_name.clone()).or_insert(ToolCost {
            tool_name: tool_name.clone(),
            mcp_server: parse_mcp_server(&tool_name),
            calls: 0, errors: 0, result_tokens: 0, attributed_cost_usd: 0.0,
        });
        entry.calls += 1;
        entry.errors += is_error;
        entry.result_tokens += result_tokens;
        entry.attributed_cost_usd += parent_share + result_share;
    }
    let mut tools: Vec<_> = tool_map.into_values().collect();
    tools.sort_by(|a, b| b.attributed_cost_usd.partial_cmp(&a.attributed_cost_usd).unwrap());

    // MCP server rollup
    let mut servers: std::collections::HashMap<String, f64> = Default::default();
    for t in &tools {
        if let Some(s) = &t.mcp_server {
            *servers.entry(s.clone()).or_insert(0.0) += t.attributed_cost_usd;
        }
    }
    let mut mcp_servers: Vec<_> = servers.into_iter().collect();
    mcp_servers.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

    Ok(ToolCostReport { tools, mcp_servers })
}
```

- [ ] **Step 5: Run**

`cargo test -p token-dashboard-core tool_costs` → PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,tool_costs}.rs
git commit -m "feat(core): tool/MCP cost attribution"
```

---

### Task 2: API + UI

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`
- Modify: `frontend/src/api-client.js`
- Modify: `frontend/src/routes/api.jsx`

- [ ] **Step 1: Handler**

```rust
async fn get_tool_costs(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(q): axum::extract::Query<DaysOnly>,
) -> axum::response::Json<token_dashboard_core::tool_costs::ToolCostReport> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    axum::response::Json(
        token_dashboard_core::tool_costs::report(&state.conn(), days).unwrap_or(
            token_dashboard_core::tool_costs::ToolCostReport { tools: vec![], mcp_servers: vec![] }
        )
    )
}

#[derive(serde::Deserialize, Default)]
struct DaysOnly { days: Option<u32> }
```

Register `.route("/api/tool_costs", axum::routing::get(get_tool_costs))`.

- [ ] **Step 2: Frontend**

In `api.jsx`, fetch `/api/tool_costs` and add columns `Calls`, `Errors`, `Cost ($)`. Add an "MCP servers" panel above the table that lists `mcp_servers` sorted by cost.

```jsx
function McpServersStrip({ servers }) {
  return (
    <div className="a-strip">
      {servers.map(([name, cost]) => (
        <div key={name} className="a-chip">{name} <strong>${cost.toFixed(2)}</strong></div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add crates/token-dashboard-cli/src/lib.rs frontend/src/{api-client.js,routes/api.jsx}
git commit -m "feat: tool/MCP cost attribution UI"
```

---

## Self-Review Notes

- Evenly-split apportionment is the simplest fair model; weighted-by-result-tokens is an alternative that should be a follow-up if calls vary wildly in result size.
- The pricing helper is called twice per row — fine for tens of thousands of tool calls, slow for millions. Cache per-model cost coefficients if benchmarks show it matters.
