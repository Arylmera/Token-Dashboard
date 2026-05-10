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

pub fn hourly_breakdown<P: AsRef<Path>>(db: P, hours: i64) -> rusqlite::Result<Vec<HourlyRow>> {
    let c = open_ro(db)?;
    let cutoff = format!("-{} hours", hours.max(1));
    let mut stmt = c.prepare(
        "SELECT CAST((strftime('%s','now') - strftime('%s', timestamp)) / 3600 AS INT) AS hour_ago, \
                COALESCE(model, 'unknown') AS model, \
                COALESCE(SUM(input_tokens),0)            AS input_tokens, \
                COALESCE(SUM(output_tokens),0)           AS output_tokens, \
                COALESCE(SUM(cache_read_tokens),0)       AS cache_read_tokens, \
                COALESCE(SUM(cache_create_5m_tokens),0)  AS cache_create_5m_tokens, \
                COALESCE(SUM(cache_create_1h_tokens),0)  AS cache_create_1h_tokens \
         FROM messages \
         WHERE type='assistant' AND timestamp IS NOT NULL \
           AND timestamp >= datetime('now', ?) \
         GROUP BY hour_ago, model",
    )?;
    let rows = stmt.query_map([cutoff], |r| {
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
) -> rusqlite::Result<Vec<PhaseSplitRow>> {
    let (rng, args) = range_clause(since, until, "m.timestamp");
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
         WHERE m.type='assistant' AND m.is_sidechain = 0 {rng} \
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
    pub cache_read_tokens: i64,
}

/// User prompt joined with the immediately-following assistant turn's
/// tokens. `sort` is "tokens" (default — largest billable first) or
/// "recent" (newest first). Mirrors python `expensive_prompts`.
pub fn expensive_prompts<P: AsRef<Path>>(
    db: P,
    limit: i64,
    sort: &str,
) -> rusqlite::Result<Vec<ExpensivePromptRow>> {
    let order = if sort == "recent" {
        "u.timestamp DESC"
    } else {
        "billable_tokens DESC"
    };
    let sql = format!(
        "SELECT u.uuid AS user_uuid, u.session_id, u.project_slug, u.timestamp, \
                u.prompt_text, u.prompt_chars, \
                a.uuid AS assistant_uuid, a.model, \
                COALESCE(a.input_tokens,0)+COALESCE(a.output_tokens,0) \
                  +COALESCE(a.cache_create_5m_tokens,0)+COALESCE(a.cache_create_1h_tokens,0) AS billable_tokens, \
                COALESCE(a.cache_read_tokens,0) AS cache_read_tokens \
           FROM messages u \
           JOIN messages a ON a.parent_uuid = u.uuid AND a.type='assistant' \
          WHERE u.type='user' AND u.prompt_text IS NOT NULL \
          ORDER BY {order} \
          LIMIT ?"
    );
    let c = open_ro(db)?;
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map([limit], |r| {
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
            cache_read_tokens: r.get(9)?,
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
) -> rusqlite::Result<Vec<SkillRow>> {
    let (rng, args) = range_clause(since, until, "timestamp");
    let sql = format!(
        "SELECT target AS skill, \
                COUNT(*) AS invocations, \
                COUNT(DISTINCT session_id) AS sessions, \
                MAX(timestamp) AS last_used \
         FROM tool_calls \
         WHERE tool_name = 'Skill' AND target IS NOT NULL AND target != '' {rng} \
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
