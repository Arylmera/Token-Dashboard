//! Tool / MCP cost attribution.
//!
//! For each `tool_calls` row in the window, attributes a USD cost share to
//! the tool that produced it:
//!
//! 1. **Parent share** — every assistant turn pays for its output tokens
//!    regardless of how many tool calls it spawned. We split that cost
//!    evenly across the siblings (rounded to call count), so a turn that
//!    fires 5 tools attributes 1/5 of its output cost to each.
//! 2. **Result share** — the tool's `result_tokens` come back as input on
//!    the next turn, so we price them at the same model's input rate.
//!
//! Both halves use the parent assistant message's model so we stay aligned
//! with `pricing::cost_for`. MCP tool names parse out of the
//! `mcp__<server>__<tool>` convention so the UI can roll up by server.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ToolCost {
    pub tool_name: String,
    pub mcp_server: Option<String>,
    pub calls: u64,
    pub errors: u64,
    pub result_tokens: u64,
    pub attributed_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct McpServerCost {
    pub server: String,
    pub calls: u64,
    pub attributed_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ToolCostReport {
    pub days: u32,
    pub tools: Vec<ToolCost>,
    pub mcp_servers: Vec<McpServerCost>,
    pub total_cost_usd: f64,
}

/// Pull every tool_call joined with its parent assistant message in the
/// window, split each parent's output cost evenly across siblings, add the
/// result-tokens cost priced at the same model's input rate, and sum into
/// per-tool + per-MCP-server totals.
pub fn report<P: AsRef<Path>>(db: P, days: u32) -> rusqlite::Result<ToolCostReport> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let days = days.max(1);
    let offset = format!("-{} days", days as i64);

    let mut stmt = conn.prepare(
        "SELECT tc.tool_name, \
                COALESCE(tc.is_error, 0), \
                COALESCE(tc.result_tokens, 0), \
                m.model, \
                COALESCE(m.output_tokens, 0), \
                (SELECT COUNT(*) FROM tool_calls WHERE message_uuid = m.uuid) AS sibling_count \
         FROM tool_calls tc \
         JOIN messages m ON m.uuid = tc.message_uuid \
         WHERE substr(tc.timestamp, 1, 10) >= date('now', ?1)",
    )?;
    let rows = stmt.query_map(rusqlite::params![offset], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)? as i64,
            r.get::<_, i64>(5)? as i64,
        ))
    })?;

    let mut tool_map: HashMap<String, ToolCost> = HashMap::new();
    for row in rows {
        let (tool_name, is_error, result_tokens, model, parent_output, sibling_count) = row?;
        let siblings = sibling_count.max(1) as f64;
        let parent_cost = match model.as_deref() {
            Some(m) => cost_for(
                m,
                &Usage {
                    output_tokens: parent_output,
                    ..Default::default()
                },
                &pricing,
            )
            .usd
            .unwrap_or(0.0),
            None => 0.0,
        };
        let parent_share = parent_cost / siblings;

        let result_share = match model.as_deref() {
            Some(m) if result_tokens > 0 => cost_for(
                m,
                &Usage {
                    input_tokens: result_tokens as i64,
                    ..Default::default()
                },
                &pricing,
            )
            .usd
            .unwrap_or(0.0),
            _ => 0.0,
        };

        let entry = tool_map.entry(tool_name.clone()).or_insert(ToolCost {
            tool_name: tool_name.clone(),
            mcp_server: parse_mcp_server(&tool_name),
            calls: 0,
            errors: 0,
            result_tokens: 0,
            attributed_cost_usd: 0.0,
        });
        entry.calls += 1;
        entry.errors += is_error.min(1);
        entry.result_tokens += result_tokens;
        entry.attributed_cost_usd += parent_share + result_share;
    }

    let mut tools: Vec<ToolCost> = tool_map.into_values().collect();
    tools.sort_by(|a, b| {
        b.attributed_cost_usd
            .partial_cmp(&a.attributed_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // MCP server rollup
    let mut server_map: HashMap<String, McpServerCost> = HashMap::new();
    for t in &tools {
        let Some(server) = &t.mcp_server else {
            continue;
        };
        let entry = server_map.entry(server.clone()).or_insert(McpServerCost {
            server: server.clone(),
            calls: 0,
            attributed_cost_usd: 0.0,
        });
        entry.calls += t.calls;
        entry.attributed_cost_usd += t.attributed_cost_usd;
    }
    let mut mcp_servers: Vec<McpServerCost> = server_map.into_values().collect();
    mcp_servers.sort_by(|a, b| {
        b.attributed_cost_usd
            .partial_cmp(&a.attributed_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_cost_usd = tools.iter().map(|t| t.attributed_cost_usd).sum();

    Ok(ToolCostReport {
        days,
        tools,
        mcp_servers,
        total_cost_usd,
    })
}

/// Parse `mcp__<server>__<rest>` → `Some("<server>")`. Returns `None` for
/// every non-MCP tool name (Read, Bash, Edit, etc.).
fn parse_mcp_server(tool_name: &str) -> Option<String> {
    let stripped = tool_name.strip_prefix("mcp__")?;
    let (server, _) = stripped.split_once("__")?;
    Some(server.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::{params, Connection};
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().expect("tempfile");
        init_db(f.path()).expect("init");
        f
    }

    fn today_ts() -> String {
        let c = Connection::open_in_memory().unwrap();
        let today: String = c.query_row("SELECT date('now')", [], |r| r.get(0)).unwrap();
        format!("{today}T12:00:00Z")
    }

    fn insert_assistant(conn: &Connection, uuid: &str, model: &str, output: i64) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', 'p', 'assistant', ?2, ?3, 0, ?4, 0, 0, 0)",
            params![uuid, today_ts(), model, output],
        )
        .unwrap();
    }

    fn insert_tool(
        conn: &Connection,
        message_uuid: &str,
        tool_name: &str,
        result_tokens: i64,
        is_error: i64,
    ) {
        conn.execute(
            "INSERT INTO tool_calls \
             (message_uuid, session_id, project_slug, tool_name, target, use_id, \
              result_tokens, is_error, timestamp) \
             VALUES (?1, 's', 'p', ?2, NULL, NULL, ?3, ?4, ?5)",
            params![message_uuid, tool_name, result_tokens, is_error, today_ts()],
        )
        .unwrap();
    }

    #[test]
    fn splits_parent_cost_evenly_across_siblings() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        // One message, 1M output tokens, two tool calls. Each tool should
        // receive 1/2 of the parent's output cost.
        insert_assistant(&c, "m", "claude-opus-4-7", 1_000_000);
        insert_tool(&c, "m", "Read", 0, 0);
        insert_tool(&c, "m", "Bash", 0, 0);
        drop(c);
        let r = report(f.path(), 30).unwrap();
        assert_eq!(r.tools.len(), 2);
        let parent_cost = cost_for(
            "claude-opus-4-7",
            &Usage {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            &Pricing::embedded(),
        )
        .usd
        .unwrap();
        let expected = parent_cost / 2.0;
        for t in &r.tools {
            assert!((t.attributed_cost_usd - expected).abs() < 1e-6, "{:?}", t);
        }
        assert!((r.total_cost_usd - parent_cost).abs() < 1e-6);
    }

    #[test]
    fn result_tokens_add_to_attribution() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        insert_assistant(&c, "m", "claude-opus-4-7", 0);
        insert_tool(&c, "m", "Read", 1_000_000, 0);
        drop(c);
        let r = report(f.path(), 30).unwrap();
        let row = &r.tools[0];
        let expected = cost_for(
            "claude-opus-4-7",
            &Usage {
                input_tokens: 1_000_000,
                ..Default::default()
            },
            &Pricing::embedded(),
        )
        .usd
        .unwrap();
        assert!((row.attributed_cost_usd - expected).abs() < 1e-6);
        assert_eq!(row.result_tokens, 1_000_000);
    }

    #[test]
    fn mcp_server_parses_and_rolls_up() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        insert_assistant(&c, "m", "claude-opus-4-7", 1_000_000);
        insert_tool(&c, "m", "mcp__github__search_code", 0, 0);
        insert_tool(&c, "m", "mcp__github__list_issues", 0, 0);
        insert_tool(&c, "m", "Read", 0, 0);
        drop(c);
        let r = report(f.path(), 30).unwrap();
        let github = r
            .tools
            .iter()
            .find(|t| t.tool_name.contains("github"))
            .unwrap();
        assert_eq!(github.mcp_server.as_deref(), Some("github"));
        assert_eq!(r.mcp_servers.len(), 1);
        assert_eq!(r.mcp_servers[0].server, "github");
        assert_eq!(r.mcp_servers[0].calls, 2);
    }

    #[test]
    fn errors_counted_and_capped_at_one_per_call() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        insert_assistant(&c, "m", "claude-opus-4-7", 1000);
        insert_tool(&c, "m", "Bash", 0, 1);
        insert_tool(&c, "m", "Bash", 0, 1);
        insert_tool(&c, "m", "Bash", 0, 0);
        drop(c);
        let r = report(f.path(), 30).unwrap();
        assert_eq!(r.tools.len(), 1);
        assert_eq!(r.tools[0].calls, 3);
        assert_eq!(r.tools[0].errors, 2);
    }
}
