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
    pub last_active: Option<String>,
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

/// Per-(tag, model) aggregation row used by `/api/tags-summary`. The CLI
/// layer composes cost from these via `pricing::cost_for` so this stays a
/// pure SQL aggregation with no pricing dep — same split used by
/// `model_breakdown`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagAggregateRow {
    pub tag: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
    pub first_seen: Option<String>,
    pub last_seen: Option<String>,
}

/// Per-tag distinct-session count, returned alongside [`TagAggregateRow`]
/// so callers don't double-count sessions that span multiple models.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagSessionCount {
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

/// Build a `WHERE provider` clause + parameter list. `None` or the sentinel
/// `"all"` returns `("", [])` so existing call sites are no-ops — useful
/// during the v4.1 rollout when only Claude data exists.
///
/// Multi-provider lookups (`"claude,codex"`) split on commas; whitespace is
/// trimmed and empty segments are dropped.
fn provider_clause(filter: Option<&str>) -> (String, Vec<String>) {
    provider_clause_on("provider", filter)
}

/// Same as [`provider_clause`] but accepts a qualified column reference
/// (e.g. `"m.provider"` or `"tc.provider"`). Used when a query joins
/// multiple tables that both carry a `provider` column.
fn provider_clause_on(col: &str, filter: Option<&str>) -> (String, Vec<String>) {
    let raw = match filter {
        Some(s) if !s.is_empty() && !s.eq_ignore_ascii_case("all") => s,
        _ => return (String::new(), Vec::new()),
    };
    let ids: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.is_empty() {
        return (String::new(), Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let clause = format!(" AND {col} IN ({placeholders})");
    (clause, ids)
}

pub(crate) fn open_ro<P: AsRef<Path>>(db: P) -> rusqlite::Result<Connection> {
    let c = Connection::open(db.as_ref())?;
    c.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(c)
}

pub fn overview_totals<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<OverviewTotals> {
    let (rng, mut args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause(provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT COUNT(DISTINCT session_id) AS sessions, \
                SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages WHERE 1=1 {rng}{prov}"
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
    provider: Option<&str>,
) -> rusqlite::Result<Vec<ModelRow>> {
    let (rng, mut args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause(provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT COALESCE(model, 'unknown') AS model, \
                COUNT(*) AS turns, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages \
         WHERE type='assistant' {rng}{prov} \
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
    provider: Option<&str>,
) -> rusqlite::Result<Vec<ProjectRow>> {
    let (rng, mut args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause(provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT project_slug, \
                COUNT(DISTINCT session_id) AS sessions, \
                SUM(CASE WHEN type='user' THEN 1 ELSE 0 END) AS turns, \
                COALESCE(SUM(input_tokens), 0)  AS input_tokens, \
                COALESCE(SUM(output_tokens), 0) AS output_tokens, \
                COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) \
                  +COALESCE(SUM(cache_create_5m_tokens),0)+COALESCE(SUM(cache_create_1h_tokens),0) AS billable_tokens, \
                COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, \
                MAX(timestamp) AS last_active \
         FROM messages \
         WHERE 1=1 {rng}{prov} \
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
            last_active: r.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn tool_token_breakdown<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<ToolRow>> {
    let (rng, mut args) = range_clause(since, until, "tc.timestamp");
    let (prov, prov_args) = provider_clause_on("tc.provider", provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT tc.tool_name AS tool_name, \
                COUNT(*) AS calls, \
                COALESCE(SUM(tr.result_tokens),0) AS result_tokens \
         FROM tool_calls tc \
         LEFT JOIN tool_calls tr \
                ON tr.tool_name = '_tool_result' \
               AND tr.session_id = tc.session_id \
               AND tr.use_id = tc.use_id \
         WHERE tc.tool_name != '_tool_result' {rng}{prov} \
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
    provider: Option<&str>,
) -> rusqlite::Result<Vec<DailyRow>> {
    let (rng, mut args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause(provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT substr(timestamp, 1, 10) AS day, \
                COALESCE(SUM(input_tokens),0)      AS input_tokens, \
                COALESCE(SUM(output_tokens),0)     AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0) \
                  + COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_tokens \
         FROM messages \
         WHERE timestamp IS NOT NULL {rng}{prov} \
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HourlyRow {
    pub hour_ago: i64,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

pub fn hourly_breakdown<P: AsRef<Path>>(
    db: P,
    hours: i64,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<HourlyRow>> {
    let c = open_ro(db)?;
    let cutoff = format!("-{} hours", hours.max(1));
    let (prov, prov_args) = provider_clause(provider);
    let sql = format!(
        "SELECT CAST((strftime('%s','now') - strftime('%s', timestamp)) / 3600 AS INT) AS hour_ago, \
                COALESCE(model, 'unknown') AS model, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages \
         WHERE type='assistant' AND timestamp IS NOT NULL \
           AND timestamp >= datetime('now', ?){prov} \
         GROUP BY hour_ago, model"
    );
    let mut stmt = c.prepare(&sql)?;
    let mut args: Vec<String> = vec![cutoff];
    args.extend(prov_args);
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(HourlyRow {
            hour_ago: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// One (weekday, hour) bucket of the activity heatmap. `dow` follows
/// SQLite's `strftime('%w')` convention (0 = Sunday … 6 = Saturday) and
/// `hour` is 0–23. Both are computed in the machine's local timezone so
/// the heatmap matches the user's wall clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeatmapCell {
    pub dow: i64,
    pub hour: i64,
    pub turns: i64,
}

/// User-prompt ("turn") counts bucketed by local weekday and hour over the
/// last `days` days. A turn is one `type='user'` message — the same unit
/// `recent_sessions` reports. Aggregated entirely in SQL with no row cap so
/// the heatmap reflects the whole window, not just the most recent sessions.
pub fn activity_heatmap<P: AsRef<Path>>(
    db: P,
    days: i64,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<HeatmapCell>> {
    let c = open_ro(db)?;
    let cutoff = format!("-{} days", days.max(1));
    let (prov, prov_args) = provider_clause(provider);
    let sql = format!(
        "SELECT CAST(strftime('%w', timestamp, 'localtime') AS INTEGER) AS dow, \
                CAST(strftime('%H', timestamp, 'localtime') AS INTEGER) AS hour, \
                COUNT(*) AS turns \
         FROM messages \
         WHERE type='user' AND timestamp IS NOT NULL \
           AND timestamp >= datetime('now', ?){prov} \
         GROUP BY dow, hour"
    );
    let mut stmt = c.prepare(&sql)?;
    let mut args: Vec<String> = vec![cutoff];
    args.extend(prov_args);
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(HeatmapCell {
            dow: r.get(0)?,
            hour: r.get(1)?,
            turns: r.get(2)?,
        })
    })?;
    rows.collect()
}

pub const PLAN_TOOLS: &[&str] = &[
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "Task",
    "Skill",
];
pub const EXECUTE_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhaseSplitRow {
    pub uuid: String,
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
    pub plan_n: i64,
    pub exec_n: i64,
    pub other_n: i64,
}

pub fn phase_split<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<PhaseSplitRow>> {
    let (rng, mut args) = range_clause(since, until, "m.timestamp");
    let (prov, prov_args) = provider_clause_on("m.provider", provider);
    args.extend(prov_args);
    let plan_in = vec!["?"; PLAN_TOOLS.len()].join(",");
    let exec_in = vec!["?"; EXECUTE_TOOLS.len()].join(",");
    let sql = format!(
        "SELECT m.uuid, m.model, \
                COALESCE(m.input_tokens,0) AS input_tokens, \
                COALESCE(m.output_tokens,0) AS output_tokens, \
                COALESCE(m.cache_read_tokens,0) AS cache_read_tokens, \
                COALESCE(m.cache_create_5m_tokens,0) AS cache_create_5m_tokens, \
                COALESCE(m.cache_create_1h_tokens,0) AS cache_create_1h_tokens, \
                SUM(CASE WHEN tc.tool_name IN ({plan_in}) THEN 1 ELSE 0 END) AS plan_n, \
                SUM(CASE WHEN tc.tool_name IN ({exec_in}) THEN 1 ELSE 0 END) AS exec_n, \
                SUM(CASE WHEN tc.tool_name IS NOT NULL \
                          AND tc.tool_name != '_tool_result' \
                          AND tc.tool_name NOT IN ({plan_in}) \
                          AND tc.tool_name NOT IN ({exec_in}) \
                         THEN 1 ELSE 0 END) AS other_n \
         FROM messages m \
         LEFT JOIN tool_calls tc \
                ON tc.message_uuid = m.uuid AND tc.tool_name != '_tool_result' \
         WHERE m.type='assistant' AND m.is_sidechain = 0 {rng}{prov} \
         GROUP BY m.uuid"
    );

    // Param order: PLAN_TOOLS, EXECUTE_TOOLS, PLAN_TOOLS, EXECUTE_TOOLS, then range args.
    let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for s in PLAN_TOOLS {
        params.push(s);
    }
    for s in EXECUTE_TOOLS {
        params.push(s);
    }
    for s in PLAN_TOOLS {
        params.push(s);
    }
    for s in EXECUTE_TOOLS {
        params.push(s);
    }
    let arg_refs: Vec<&dyn rusqlite::ToSql> =
        args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    params.extend(arg_refs);

    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(params.as_slice(), |r| {
        Ok(PhaseSplitRow {
            uuid: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
            plan_n: nullable_i64(r, 7)?,
            exec_n: nullable_i64(r, 8)?,
            other_n: nullable_i64(r, 9)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpensivePromptRow {
    pub user_uuid: String,
    pub session_id: String,
    pub project_slug: String,
    pub timestamp: String,
    pub prompt_text: Option<String>,
    pub prompt_chars: Option<i64>,
    pub assistant_uuid: String,
    pub model: Option<String>,
    pub billable_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
    pub cache_read_tokens: i64,
}

/// User prompt joined with the immediately-following assistant turn's
/// tokens. `sort` is "tokens" (default — largest billable first) or
/// "recent" (newest first). `q` is an optional FTS5 MATCH expression that
/// restricts results to user prompts whose `prompt_text` matches.
/// Mirrors python `expensive_prompts`.
pub fn expensive_prompts<P: AsRef<Path>>(
    db: P,
    limit: i64,
    sort: &str,
    since: Option<&str>,
    until: Option<&str>,
    q: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<ExpensivePromptRow>> {
    let order = if sort == "recent" {
        "u.timestamp DESC"
    } else {
        "billable_tokens DESC"
    };
    let (rng, mut args) = range_clause(since, until, "u.timestamp");
    // Filter on the assistant turn's provider — that's where the cost
    // lands. Filtering the user prompt's provider would also work in
    // practice (a session is single-provider today) but pinning to the
    // assistant turn matches how the cost columns are computed below.
    let (prov, prov_args) = provider_clause_on("a.provider", provider);
    let fts_clause = if q.map(|s| !s.trim().is_empty()).unwrap_or(false) {
        args.push(q.unwrap().trim().to_string());
        " AND u.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?) "
    } else {
        ""
    };
    args.extend(prov_args);
    // Pair each user prompt with the *first* assistant turn after it in the
    // same session and sidechain. The earlier `a.parent_uuid = u.uuid` join
    // is unreliable because streaming-snapshot dedup evicts uuids that later
    // messages still reference (see CLAUDE.md note on dedup keys).
    let sql = format!(
        "SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp, \
                u.prompt_text, u.prompt_chars, \
                a.uuid AS assistant_uuid, a.model, \
                COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0) \
                  +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens, \
                COALESCE(a.input_tokens,0) AS input_tokens, \
                COALESCE(a.output_tokens,0) AS output_tokens, \
                COALESCE(a.cache_create_5m_tokens,0) AS cache_create_5m_tokens, \
                COALESCE(a.cache_create_1h_tokens,0) AS cache_create_1h_tokens, \
                COALESCE(a.cache_read_tokens,0) AS cache_read_tokens \
           FROM messages u \
           JOIN messages a \
             ON a.session_id = u.session_id \
            AND a.type = 'assistant' \
            AND a.is_sidechain = u.is_sidechain \
            AND a.timestamp = ( \
                  SELECT MIN(a2.timestamp) FROM messages a2 \
                   WHERE a2.session_id = u.session_id \
                     AND a2.type = 'assistant' \
                     AND a2.is_sidechain = u.is_sidechain \
                     AND a2.timestamp > u.timestamp \
                ) \
          WHERE u.type='user' AND u.prompt_text IS NOT NULL {rng} {fts_clause}{prov} \
          ORDER BY {order} \
          LIMIT {limit}"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(ExpensivePromptRow {
            user_uuid: r.get(0)?,
            session_id: r.get(1)?,
            project_slug: r.get(2)?,
            timestamp: r.get(3)?,
            prompt_text: r.get(4)?,
            prompt_chars: r.get(5)?,
            assistant_uuid: r.get(6)?,
            model: r.get(7)?,
            billable_tokens: r.get(8)?,
            input_tokens: r.get(9)?,
            output_tokens: r.get(10)?,
            cache_create_5m_tokens: r.get(11)?,
            cache_create_1h_tokens: r.get(12)?,
            cache_read_tokens: r.get(13)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillRow {
    pub skill: String,
    pub invocations: i64,
    pub sessions: i64,
    pub last_used: Option<String>,
}

pub fn skill_breakdown<P: AsRef<Path>>(
    db: P,
    since: Option<&str>,
    until: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<SkillRow>> {
    let (rng, mut args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause(provider);
    args.extend(prov_args);
    let sql = format!(
        "SELECT target AS skill, \
                COUNT(*) AS invocations, \
                COUNT(DISTINCT session_id) AS sessions, \
                MAX(timestamp) AS last_used \
         FROM tool_calls \
         WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng}{prov} \
         GROUP BY target \
         ORDER BY invocations DESC"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        Ok(SkillRow {
            skill: r.get(0)?,
            invocations: r.get(1)?,
            sessions: r.get(2)?,
            last_used: r.get(3)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionTurn {
    pub uuid: String,
    pub parent_uuid: Option<String>,
    #[serde(rename = "type")]
    pub type_: String,
    pub timestamp: String,
    pub model: Option<String>,
    pub is_sidechain: i64,
    pub agent_id: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
    pub prompt_text: Option<String>,
    pub prompt_chars: Option<i64>,
    pub tool_calls_json: Option<String>,
    pub project_slug: String,
    pub cwd: Option<String>,
}

pub fn session_turns<P: AsRef<Path>>(
    db: P,
    session_id: &str,
) -> rusqlite::Result<Vec<SessionTurn>> {
    let c = open_ro(db)?;
    let mut stmt = c.prepare(
        "SELECT uuid, parent_uuid, type, timestamp, model, is_sidechain, agent_id, \
                input_tokens, output_tokens, cache_read_tokens, \
                cache_create_5m_tokens, cache_create_1h_tokens, \
                prompt_text, prompt_chars, tool_calls_json, project_slug, cwd \
         FROM messages \
         WHERE session_id = ? \
         ORDER BY timestamp ASC",
    )?;
    let rows = stmt.query_map([session_id], |r| {
        Ok(SessionTurn {
            uuid: r.get(0)?,
            parent_uuid: r.get(1)?,
            type_: r.get(2)?,
            timestamp: r.get(3)?,
            model: r.get(4)?,
            is_sidechain: r.get(5)?,
            agent_id: r.get(6)?,
            input_tokens: r.get(7)?,
            output_tokens: r.get(8)?,
            cache_read_tokens: r.get(9)?,
            cache_create_5m_tokens: r.get(10)?,
            cache_create_1h_tokens: r.get(11)?,
            prompt_text: r.get(12)?,
            prompt_chars: r.get(13)?,
            tool_calls_json: r.get(14)?,
            project_slug: r.get(15)?,
            cwd: r.get(16)?,
        })
    })?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub session_id: String,
    pub project_slug: String,
    pub project_name: String,
    pub started: Option<String>,
    pub ended: Option<String>,
    pub turns: i64,
    pub tokens: i64,
}

/// Recent sessions ordered by latest activity.
///
/// Mirrors python `recent_sessions(order_by="recent")`. Cost, tags, and
/// `first_prompt` are filled in by the caller (the cli endpoint) using
/// pricing + session_tags lookups; this query stays narrow on purpose so
/// it works without the pricing crate dependency.
pub fn recent_sessions<P: AsRef<Path>>(
    db: P,
    limit: i64,
    since: Option<&str>,
    until: Option<&str>,
    tag: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<SessionRow>> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let (prov, prov_args) = provider_clause_on("m.provider", provider);
    let (tag_join, tag_filter) = if tag.is_some() {
        (
            "JOIN session_tags st ON st.session_id = m.session_id",
            "AND st.tag = ?",
        )
    } else {
        ("", "")
    };
    // `m.timestamp` referenced via `m.` because of the optional join — the
    // base WHERE uses unprefixed `timestamp` to mirror the python query.
    let sql = format!(
        "SELECT m.session_id AS session_id, m.project_slug AS project_slug, \
                MIN(m.timestamp) AS started, MAX(m.timestamp) AS ended, \
                SUM(CASE WHEN m.type='user' THEN 1 ELSE 0 END) AS turns, \
                COALESCE(SUM(m.input_tokens),0)+COALESCE(SUM(m.output_tokens),0) AS tokens \
         FROM messages m \
         {tag_join} \
         WHERE 1=1 {rng} {tag_filter}{prov} \
         GROUP BY m.session_id \
         ORDER BY ended DESC \
         LIMIT ?"
    );

    // Build a single owned-string param vector. The trailing `limit`
    // gets stringified for ergonomics — SQLite coerces text to int for
    // numeric columns and `LIMIT` accepts that.
    let mut all_args: Vec<String> = args;
    if let Some(t) = tag {
        all_args.push(t.to_string());
    }
    all_args.extend(prov_args);
    all_args.push(limit.to_string());

    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(all_args.iter()), |r| {
        let slug: String = r.get(1)?;
        Ok(SessionRow {
            session_id: r.get(0)?,
            // best_project_name is deferred (Phase 2 follow-up); the slug
            // is a usable display value until then.
            project_name: slug.clone(),
            project_slug: slug,
            started: r.get(2)?,
            ended: r.get(3)?,
            turns: nullable_i64(r, 4)?,
            tokens: r.get(5)?,
        })
    })?;
    rows.collect()
}

/// Per-session per-model token sums — the input the cli endpoint uses to
/// compute per-session cost via the pricing table. Returned as a flat
/// list keyed by (session_id, model).
#[derive(Debug, Clone)]
pub struct SessionModelUsage {
    pub session_id: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_create_5m_tokens: i64,
    pub cache_create_1h_tokens: i64,
}

pub fn session_model_usage<P: AsRef<Path>>(
    db: P,
    session_ids: &[&str],
) -> rusqlite::Result<Vec<SessionModelUsage>> {
    if session_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, model, \
                COALESCE(SUM(input_tokens),0)           AS input_tokens, \
                COALESCE(SUM(output_tokens),0)          AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)      AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0) AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0) AS cache_create_1h_tokens \
         FROM messages \
         WHERE session_id IN ({placeholders}) AND model IS NOT NULL \
         GROUP BY session_id, model"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(session_ids), |r| {
        Ok(SessionModelUsage {
            session_id: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
        })
    })?;
    rows.collect()
}

/// `{session_id: first_prompt}` — earliest non-empty user `prompt_text`
/// per session. Used to populate the "first prompt" column in the
/// sessions list and CSV export.
pub fn first_prompts<P: AsRef<Path>>(
    db: P,
    session_ids: &[&str],
) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    if session_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, prompt_text FROM ( \
             SELECT session_id, prompt_text, timestamp, \
                    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp ASC) AS rn \
             FROM messages \
             WHERE type='user' AND prompt_text IS NOT NULL AND TRIM(prompt_text) <> '' \
               AND session_id IN ({placeholders}) \
         ) WHERE rn = 1"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let mut out: std::collections::HashMap<String, String> =
        std::collections::HashMap::with_capacity(session_ids.len());
    let mut rows = stmt.query(rusqlite::params_from_iter(session_ids))?;
    while let Some(r) = rows.next()? {
        let sid: String = r.get(0)?;
        let txt: String = r.get(1)?;
        out.insert(sid, txt);
    }
    Ok(out)
}

/// `{session_id: [tag, ...]}` lookup. Mirrors python `session_tags`.
pub fn session_tags<P: AsRef<Path>>(
    db: P,
    session_ids: &[&str],
) -> rusqlite::Result<std::collections::HashMap<String, Vec<String>>> {
    if session_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, tag FROM session_tags \
         WHERE session_id IN ({placeholders}) ORDER BY tag"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let mut out: std::collections::HashMap<String, Vec<String>> = session_ids
        .iter()
        .map(|s| (s.to_string(), Vec::new()))
        .collect();
    let mut rows = stmt.query(rusqlite::params_from_iter(session_ids))?;
    while let Some(r) = rows.next()? {
        let sid: String = r.get(0)?;
        let tag: String = r.get(1)?;
        out.entry(sid).or_default().push(tag);
    }
    Ok(out)
}

/// Read the saved plan label (`api`, `pro`, `max`, `max-20x`).
/// Mirrors `pricing.get_plan` — defaults to `api` when nothing is set.
pub fn get_plan<P: AsRef<Path>>(db: P) -> rusqlite::Result<String> {
    let c = open_ro(db)?;
    let v: rusqlite::Result<String> =
        c.query_row("SELECT v FROM plan WHERE k='plan'", [], |r| r.get(0));
    match v {
        Ok(s) => Ok(s),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok("api".to_string()),
        Err(e) => Err(e),
    }
}

/// Persist the plan label. Mirrors `pricing.set_plan`.
pub fn set_plan<P: AsRef<Path>>(db: P, plan: &str) -> rusqlite::Result<()> {
    let c = Connection::open(db.as_ref())?;
    c.execute(
        "INSERT OR REPLACE INTO plan (k, v) VALUES ('plan', ?)",
        [plan],
    )?;
    Ok(())
}

/// Mark a tip as dismissed. Mirrors `tips.dismiss_tip`.
pub fn dismiss_tip<P: AsRef<Path>>(db: P, key: &str) -> rusqlite::Result<()> {
    let c = Connection::open(db.as_ref())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    c.execute(
        "INSERT OR REPLACE INTO dismissed_tips (tip_key, dismissed_at) VALUES (?, ?)",
        rusqlite::params![key, now],
    )?;
    Ok(())
}

/// Add a tag to a session. Idempotent — `INSERT OR IGNORE` on the
/// composite primary key. Mirrors `db.add_session_tag`.
pub fn add_session_tag<P: AsRef<Path>>(db: P, session_id: &str, tag: &str) -> rusqlite::Result<()> {
    let c = Connection::open(db.as_ref())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    c.execute(
        "INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) VALUES (?, ?, ?)",
        rusqlite::params![session_id, tag, now],
    )?;
    Ok(())
}

/// Remove a tag from a session. Mirrors `db.remove_session_tag`.
pub fn remove_session_tag<P: AsRef<Path>>(
    db: P,
    session_id: &str,
    tag: &str,
) -> rusqlite::Result<()> {
    let c = Connection::open(db.as_ref())?;
    c.execute(
        "DELETE FROM session_tags WHERE session_id=? AND tag=?",
        rusqlite::params![session_id, tag],
    )?;
    Ok(())
}

/// Strip whitespace, collapse internal spaces, cap at 64 chars. Mirrors
/// the python `_normalise_tag` in routes.py.
pub fn normalise_tag(raw: &str) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(64).collect()
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

/// Per-(tag, model) token aggregation across every assistant message in a
/// tagged session. The caller pairs these with [`tag_session_counts`] to
/// avoid double-counting sessions, and folds in pricing to compute cost.
pub fn tag_aggregates<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<TagAggregateRow>> {
    let c = open_ro(db)?;
    let mut stmt = c.prepare(
        "SELECT st.tag, m.model, \
                COALESCE(SUM(m.input_tokens), 0)            AS input_tokens, \
                COALESCE(SUM(m.output_tokens), 0)           AS output_tokens, \
                COALESCE(SUM(m.cache_read_tokens), 0)       AS cache_read_tokens, \
                COALESCE(SUM(m.cache_create_5m_tokens), 0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(m.cache_create_1h_tokens), 0)  AS cache_create_1h_tokens, \
                MIN(m.timestamp)                            AS first_seen, \
                MAX(m.timestamp)                            AS last_seen \
         FROM session_tags st \
         JOIN messages m ON m.session_id = st.session_id \
         WHERE m.type = 'assistant' \
         GROUP BY st.tag, m.model \
         ORDER BY st.tag ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagAggregateRow {
            tag: r.get(0)?,
            model: r.get(1)?,
            input_tokens: r.get(2)?,
            output_tokens: r.get(3)?,
            cache_read_tokens: r.get(4)?,
            cache_create_5m_tokens: r.get(5)?,
            cache_create_1h_tokens: r.get(6)?,
            first_seen: r.get(7)?,
            last_seen: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Distinct sessions per tag. Separate from [`tag_aggregates`] because
/// `COUNT(DISTINCT session_id)` inside a `GROUP BY (tag, model)` would
/// count each session per-model, inflating totals for sessions that used
/// more than one model.
pub fn tag_session_counts<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<TagSessionCount>> {
    let c = open_ro(db)?;
    let mut stmt = c.prepare(
        "SELECT tag, COUNT(DISTINCT session_id) AS sessions \
         FROM session_tags \
         GROUP BY tag",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagSessionCount {
            tag: r.get(0)?,
            sessions: r.get(1)?,
        })
    })?;
    rows.collect()
}
