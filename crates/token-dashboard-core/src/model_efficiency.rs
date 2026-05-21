//! Per-model "cost per accepted edit" leaderboard.
//!
//! An "accepted edit" is approximated as a successful invocation of one of
//! the file-mutating tools (`Edit`, `Write`, `NotebookEdit`) where
//! `tool_calls.is_error = 0`. Each row aggregates, per model, the assistant
//! token cost over the lookback window alongside the count of accepted
//! edits, yielding a cost-per-edit ratio that surfaces which model gives
//! the best edit-throughput per dollar on this user's actual work.
//!
//! The full assistant-message cost is attributed to whichever edit it
//! produced — a message that runs 5 Reads and 1 Edit pays the same for
//! that Edit as a message that only ran an Edit. This is intentionally
//! coarse; see TODO 05 self-review notes.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::pricing::{cost_for, Pricing, Usage};

/// One leaderboard row per model. `cost_per_edit_usd` is `None` when
/// the model produced zero accepted edits in the window.
#[derive(Debug, Serialize, PartialEq)]
pub struct ModelRow {
    pub model: String,
    pub cost_usd: f64,
    pub edits: u64,
    pub cost_per_edit_usd: Option<f64>,
    pub tokens: u64,
    pub messages: u64,
}

/// Tool names treated as "accepted edits". Kept in sync with the
/// hand-rolled `IN` clause in [`leaderboard_with_pricing`] — if you
/// change one, change the other.
pub const EDIT_TOOLS: &[&str] = &["Edit", "Write", "NotebookEdit"];

/// Compute the leaderboard from an open connection. `days` is the
/// lookback window (clamped by the caller — the SQL uses
/// `datetime('now', ?)` so any value is accepted).
pub fn leaderboard(conn: &Connection, days: u32) -> rusqlite::Result<Vec<ModelRow>> {
    leaderboard_with_pricing(conn, days, &Pricing::embedded())
}

/// Same as [`leaderboard`] but with a caller-supplied pricing table so
/// tests can pin rates and downstream callers can layer overrides.
pub fn leaderboard_with_pricing(
    conn: &Connection,
    days: u32,
    pricing: &Pricing,
) -> rusqlite::Result<Vec<ModelRow>> {
    let cutoff: String = conn.query_row(
        "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', ?1))",
        params![format!("-{days} days")],
        |r| r.get(0),
    )?;

    // Per-model accepted-edit counts. `tool_calls` doesn't carry the
    // assistant message's model, so we join back through `messages`.
    let mut stmt = conn.prepare(
        "SELECT m.model, COUNT(*) AS edits \
         FROM messages m \
         JOIN tool_calls tc ON tc.message_uuid = m.uuid \
         WHERE m.type = 'assistant' AND m.timestamp >= ?1 \
           AND tc.is_error = 0 \
           AND tc.tool_name IN ('Edit','Write','NotebookEdit') \
         GROUP BY m.model",
    )?;
    let mut edits_map: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for row in stmt.query_map(params![cutoff], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            r.get::<_, i64>(1)? as u64,
        ))
    })? {
        let (model, edits) = row?;
        edits_map.insert(model, edits);
    }
    // Per-model token totals and cost, computed via the pricing table so
    // model fallbacks and overrides behave identically to other endpoints.
    let mut stmt = conn.prepare(
        "SELECT model, \
                COUNT(*) AS messages, \
                COALESCE(SUM(input_tokens), 0)           AS inp, \
                COALESCE(SUM(output_tokens), 0)          AS outp, \
                COALESCE(SUM(cache_read_tokens), 0)      AS cr, \
                COALESCE(SUM(cache_create_5m_tokens), 0) AS c5, \
                COALESCE(SUM(cache_create_1h_tokens), 0) AS c1 \
         FROM messages \
         WHERE type = 'assistant' AND timestamp >= ?1 \
         GROUP BY model",
    )?;
    let mut rows: Vec<ModelRow> = Vec::new();
    for row in stmt.query_map(params![cutoff], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64,
            r.get::<_, i64>(4)? as u64,
            r.get::<_, i64>(5)? as u64,
            r.get::<_, i64>(6)? as u64,
        ))
    })? {
        let (model_opt, messages, inp, outp, cr, c5, c1) = row?;
        let model = model_opt.clone().unwrap_or_default();
        let usage = Usage {
            input_tokens: inp as i64,
            output_tokens: outp as i64,
            cache_read_tokens: cr as i64,
            cache_create_5m_tokens: c5 as i64,
            cache_create_1h_tokens: c1 as i64,
        };
        let cost = cost_for(model_opt.as_deref().unwrap_or(""), &usage, pricing)
            .usd
            .unwrap_or(0.0);
        let edits = edits_map.get(&model).copied().unwrap_or(0);
        let cost_per_edit_usd = if edits > 0 {
            Some(round6(cost / edits as f64))
        } else {
            None
        };
        rows.push(ModelRow {
            model,
            cost_usd: round6(cost),
            edits,
            cost_per_edit_usd,
            tokens: inp + outp + cr + c5 + c1,
            messages,
        });
    }

    // Sort by cost-per-edit ascending (cheapest model first); models with
    // zero accepted edits sink to the bottom so the leaderboard's top rows
    // are always actionable.
    rows.sort_by(|a, b| {
        let av = a.cost_per_edit_usd.unwrap_or(f64::INFINITY);
        let bv = b.cost_per_edit_usd.unwrap_or(f64::INFINITY);
        av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(rows)
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use rusqlite::params;
    use tempfile::NamedTempFile;

    fn fresh_db() -> NamedTempFile {
        let f = NamedTempFile::new().expect("tempfile");
        init_db(f.path()).expect("init");
        f
    }

    fn recent_iso(c: &Connection) -> String {
        c.query_row(
            "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', '-1 days'))",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn insert_assistant(c: &Connection, uuid: &str, model: &str, ts: &str, output: i64) {
        c.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', 'p', 'assistant', ?2, ?3, 0, ?4, 0, 0, 0)",
            params![uuid, ts, model, output],
        )
        .unwrap();
    }

    fn insert_tool(
        c: &Connection,
        msg_uuid: &str,
        tool: &str,
        target: &str,
        is_error: i64,
        ts: &str,
    ) {
        c.execute(
            "INSERT INTO tool_calls \
             (message_uuid, session_id, project_slug, tool_name, target, use_id, \
              result_tokens, is_error, timestamp) \
             VALUES (?1, 's', 'p', ?2, ?3, ?4, 0, ?5, ?6)",
            params![
                msg_uuid,
                tool,
                target,
                format!("t-{msg_uuid}-{tool}"),
                is_error,
                ts
            ],
        )
        .unwrap();
    }

    #[test]
    fn counts_only_successful_edits() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        let ts = recent_iso(&c);

        // m1: opus, 1 successful Edit + 1 successful Write = 2 accepted
        insert_assistant(&c, "m1", "claude-opus-4-7", &ts, 0);
        insert_tool(&c, "m1", "Edit", "a.rs", 0, &ts);
        insert_tool(&c, "m1", "Write", "b.rs", 0, &ts);

        // m2: sonnet, 1 failed Edit = 0 accepted
        insert_assistant(&c, "m2", "claude-sonnet-4-6", &ts, 0);
        insert_tool(&c, "m2", "Edit", "c.rs", 1, &ts);

        let rows = leaderboard(&c, 30).unwrap();
        let opus = rows
            .iter()
            .find(|r| r.model == "claude-opus-4-7")
            .expect("opus row present");
        assert_eq!(opus.edits, 2);
        let sonnet = rows
            .iter()
            .find(|r| r.model == "claude-sonnet-4-6")
            .expect("sonnet row present");
        assert_eq!(sonnet.edits, 0);
        assert!(sonnet.cost_per_edit_usd.is_none());
    }

    #[test]
    fn cost_per_edit_uses_pricing_table() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        let ts = recent_iso(&c);

        // 1M output tokens on opus-4-7 -> pricing-table cost. 3 accepted
        // edits attributed to the same message -> cost / 3 per edit. We
        // recompute the expected via the pricing helper so the test
        // doesn't ossify a specific rate.
        insert_assistant(&c, "m1", "claude-opus-4-7", &ts, 1_000_000);
        insert_tool(&c, "m1", "Edit", "a.rs", 0, &ts);
        insert_tool(&c, "m1", "Write", "b.rs", 0, &ts);
        insert_tool(&c, "m1", "NotebookEdit", "c.ipynb", 0, &ts);

        let pricing = Pricing::embedded();
        let expected_cost = cost_for(
            "claude-opus-4-7",
            &Usage {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            &pricing,
        )
        .usd
        .unwrap();
        let expected_per_edit = round6(expected_cost / 3.0);

        let rows = leaderboard(&c, 30).unwrap();
        let opus = rows.iter().find(|r| r.model == "claude-opus-4-7").unwrap();
        assert_eq!(opus.edits, 3);
        let cpe = opus.cost_per_edit_usd.expect("cost-per-edit set");
        assert!(
            (cpe - expected_per_edit).abs() < 1e-6,
            "got {cpe}, expected {expected_per_edit}"
        );
    }

    #[test]
    fn excludes_rows_outside_window() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        let old: String = c
            .query_row(
                "SELECT strftime('%Y-%m-%dT%H:%M:%fZ', datetime('now', '-365 days'))",
                [],
                |r| r.get(0),
            )
            .unwrap();
        insert_assistant(&c, "m_old", "claude-opus-4-7", &old, 1_000_000);
        insert_tool(&c, "m_old", "Edit", "a.rs", 0, &old);

        let rows = leaderboard(&c, 30).unwrap();
        assert!(rows.iter().all(|r| r.model != "claude-opus-4-7"));
    }

    #[test]
    fn cheapest_model_sorts_first() {
        let f = fresh_db();
        let c = Connection::open(f.path()).unwrap();
        let ts = recent_iso(&c);

        // Opus: 1M output ($75), 1 edit -> $75/edit
        insert_assistant(&c, "mo", "claude-opus-4-7", &ts, 1_000_000);
        insert_tool(&c, "mo", "Edit", "a.rs", 0, &ts);

        // Haiku: 1M output ($4 on haiku-4-5 tier), 1 edit -> much cheaper
        insert_assistant(&c, "mh", "claude-haiku-4-5", &ts, 1_000_000);
        insert_tool(&c, "mh", "Edit", "b.rs", 0, &ts);

        let rows = leaderboard(&c, 30).unwrap();
        let positions: Vec<&str> = rows.iter().map(|r| r.model.as_str()).collect();
        let opus_pos = positions
            .iter()
            .position(|m| *m == "claude-opus-4-7")
            .unwrap();
        let haiku_pos = positions
            .iter()
            .position(|m| *m == "claude-haiku-4-5")
            .unwrap();
        assert!(
            haiku_pos < opus_pos,
            "haiku should rank above opus: {positions:?}"
        );
    }
}
