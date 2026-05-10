//! Aggregation queries that power the dashboard tabs.
//!
//! Phase 2 port of the read paths in `token_dashboard/db/queries.py`. The
//! python module reads from `messages_all` / `tool_calls_all` UNION-ALL
//! views; we read directly from `messages` / `tool_calls` for now —
//! identical output when no attached sources are present (the python view
//! is a passthrough in that case). The ATTACH layer ports in a follow-up
//! commit.
//!
//! Pricing-derived fields (cost_usd) are emitted as 0.0 placeholders here
//! and filled in by the caller once the `pricing.json` port lands.

use std::path::Path;

use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OverviewTotals {
    pub sessions: i64,
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRow {
    pub project_slug: String,
    pub project_name: String,
    pub sessions: i64,
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub billable_tokens: i64,
    pub cache_read_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRow {
    pub tool_name: String,
    pub calls: i64,
    pub result_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyRow {
    pub day: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRow {
    pub model: String,
    pub turns: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagRow {
    pub tag: String,
    pub sessions: i64,
}

/// Build a `WHERE timestamp` clause + parameter list from optional
/// since/until ISO strings. Mirrors python `_range_clause`.
fn range_clause(since: Option<&str>, until: Option<&str>, col: &str) -> (String, Vec<String>) {
    let mut parts: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    if let Some(s) = since {
        parts.push(format!("{col} >= ?"));
        args.push(s.to_string());
    }
    if let Some(u) = until {
        parts.push(format!("{col} < ?"));
        args.push(u.to_string());
    }
    let clause = if parts.is_empty() {
        String::new()
    } else {
        format!(" AND {}", parts.join(" AND "))
    };
    (clause, args)
}

fn open_ro<P: AsRef<Path>>(db: P) -> rusqlite::Result<Connection> {
    let c = Connection::open(db.as_ref())?;
    c.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(c)
}

pub fn overview_totals<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
) -> rusqlite::Result<OverviewTotals> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let sql = format!(
        "SELECT COUNT(DISTINCT session_id) AS sessions, \
                SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages WHERE 1=1 {rng}"
    );
    let c = open_ro(db)?;
    let totals = c.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| {
        Ok(OverviewTotals {
            sessions: nullable_i64(r, 0)?,
            turns: nullable_i64(r, 1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    Ok(totals)
}

fn nullable_i64(r: &Row, idx: usize) -> rusqlite::Result<i64> {
    let v: Option<i64> = r.get(idx)?;
    Ok(v.unwrap_or(0))
}

pub fn model_breakdown<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
) -> rusqlite::Result<Vec<ModelRow>> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let sql = format!(
        "SELECT COALESCE(model, 'unknown') AS model, \
                COUNT(*) AS turns, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages \
         WHERE type='assistant' {rng} \
         GROUP BY model \
         ORDER BY (input_tokens + output_tokens + cache_create_5m_tokens + cache_create_1h_tokens) DESC"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(ModelRow {
            model: r.get(0)?,
            turns: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn project_summary<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
) -> rusqlite::Result<Vec<ProjectRow>> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let sql = format!(
        "SELECT project_slug, \
                COUNT(DISTINCT session_id) AS sessions, \
                SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns, \
                COALESCE(SUM(input_tokens), 0)  AS input_tokens, \
                COALESCE(SUM(output_tokens), 0) AS output_tokens, \
                COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) \
                  +COALESCE(SUM(cache_create_5m_tokens),0)+COALESCE(SUM(cache_create_1h_tokens),0) AS billable_tokens, \
                COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens \
         FROM messages \
         WHERE 1=1 {rng} \
         GROUP BY project_slug \
         ORDER BY billable_tokens DESC"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        let slug: String = r.get(0)?;
        Ok(ProjectRow {
            // best_project_name port lives with the cwd-resolution work in
            // Phase 2 follow-up. Until then, surface the slug verbatim.
            project_name: slug.clone(),
            project_slug: slug,
            sessions: nullable_i64(r, 1)?,
            turns: nullable_i64(r, 2)?,
            input_tokens: r.get(3)?,
            output_tokens: r.get(4)?,
            billable_tokens: r.get(5)?,
            cache_read_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn tool_token_breakdown<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
) -> rusqlite::Result<Vec<ToolRow>> {
    let (rng, args) = range_clause(since, until, "tc.timestamp");
    let sql = format!(
        "SELECT tc.tool_name AS tool_name, \
                COUNT(*) AS calls, \
                COALESCE(SUM(tr.result_tokens),0) AS result_tokens \
         FROM tool_calls tc \
         LEFT JOIN tool_calls tr \
                ON tr.tool_name = '_tool_result' \
               AND tr.session_id = tc.session_id \
               AND tr.use_id = tc.use_id \
         WHERE tc.tool_name != '_tool_result' {rng} \
         GROUP BY tc.tool_name \
         ORDER BY calls DESC"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(ToolRow {
            tool_name: r.get(0)?,
            calls: r.get(1)?,
            result_tokens: r.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn daily_token_breakdown<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
) -> rusqlite::Result<Vec<DailyRow>> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let sql = format!(
        "SELECT substr(timestamp, 1, 10) AS day, \
                COALESCE(SUM(input_tokens),0)      AS input_tokens, \
                COALESCE(SUM(output_tokens),0)     AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0) \
                  + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens \
         FROM messages \
         WHERE timestamp IS NOT NULL {rng} \
         GROUP BY day \
         ORDER BY day ASC"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(DailyRow {
            day: r.get(0)?,
            input_tokens: r.get(1)?,
            output_tokens: r.get(2)?,
            cache_read_tokens: r.get(3)?,
            cache_create_tokens: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn all_tags<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<TagRow>> {
    let c = open_ro(db)?;
    let mut stmt = c.prepare(
        "SELECT tag, COUNT(*) AS sessions \
         FROM session_tags \
         GROUP BY tag \
         ORDER BY sessions DESC, tag ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagRow {
            tag: r.get(0)?,
            sessions: r.get(1)?,
        })
    })?;
    rows.collect()
}
