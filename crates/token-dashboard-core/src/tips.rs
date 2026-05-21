//! Rule-based tips engine — produces actionable suggestions from SQLite.
//!
//! Direct port of `token_dashboard/tips.py`. Five rule families today:
//! cache discipline, repeated targets, right-size (Opus → Sonnet), outliers,
//! waste (retry storms + high-cost short turns). Each rule is keyed so the
//! frontend can dismiss individual entries; dismissal lasts 14 days,
//! matching the python `_is_dismissed` window.
//!
//! All SQL reads from `messages` / `tool_calls` directly (the
//! `messages_all` view passthrough lands with the ATTACH layer).

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tip {
    pub key: String,
    pub category: String,
    pub title: String,
    pub body: String,
    pub scope: String,
    pub project_slug: Option<String>,
    pub project_cwd: Option<String>,
    /// Per-category extra fields. Mirrors python's loose dict shape.
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty", flatten)]
    pub extras: serde_json::Map<String, serde_json::Value>,
}

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_unix(secs)
}

/// Crude UTC ISO formatter — same shape Claude Code emits.
fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Python `_iso_days_ago(today, n)`. Replaces trailing `Z`, then subtracts
/// n days. We accept the python-shaped input verbatim and re-format.
fn iso_days_ago(today_iso: &str, n: i64) -> String {
    // The python code parses then reformats with no `Z` suffix; we mirror.
    let trimmed = today_iso.trim_end_matches('Z');
    // Parse YYYY-MM-DD prefix only — we don't need sub-second precision.
    let mut parts = trimmed.split('T');
    let date = parts.next().unwrap_or("1970-01-01");
    let time = parts.next().unwrap_or("00:00:00");
    let mut iter = date.split('-');
    let y: i64 = iter.next().and_then(|s| s.parse().ok()).unwrap_or(1970);
    let mo: i64 = iter.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let d: i64 = iter.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let days = ymd_to_days(y, mo, d) - n;
    let prefix = iso_from_unix(days * 86_400);
    let date_part = prefix.split('T').next().unwrap_or(&prefix);
    format!("{date_part}T{time}")
}

fn ymd_to_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn key(category: &str, scope: &str) -> String {
    format!("{category}:{scope}")
}

fn is_dismissed(conn: &Connection, k: &str) -> rusqlite::Result<bool> {
    let r: Option<f64> = conn
        .query_row(
            "SELECT dismissed_at FROM dismissed_tips WHERE tip_key=?",
            [k],
            |r| r.get(0),
        )
        .ok();
    let Some(ts) = r else { return Ok(false) };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    Ok((now - ts) < 14.0 * 86_400.0)
}

fn open<P: AsRef<Path>>(db: P) -> rusqlite::Result<Connection> {
    let c = Connection::open(db.as_ref())?;
    c.busy_timeout(std::time::Duration::from_secs(30))?;
    Ok(c)
}

fn cache_discipline_tips<P: AsRef<Path>>(db: P, today: &str) -> rusqlite::Result<Vec<Tip>> {
    let since = iso_days_ago(today, 7);
    let conn = open(db)?;
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT project_slug, \
                SUM(cache_read_tokens) AS cr, \
                SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS rebuild \
         FROM messages \
         WHERE type='assistant' AND timestamp >= ? \
         GROUP BY project_slug \
         HAVING (cr + rebuild) > 100000",
    )?;
    let rows: Vec<(String, i64, i64)> = stmt
        .query_map([&since], |r| {
            let slug: String = r.get(0)?;
            let cr: Option<i64> = r.get(1)?;
            let rebuild: Option<i64> = r.get(2)?;
            Ok((slug, cr.unwrap_or(0), rebuild.unwrap_or(0)))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (slug, cr, rebuild) in rows {
        let total = cr + rebuild;
        let hit = if total > 0 {
            cr as f64 / total as f64
        } else {
            0.0
        };
        if hit >= 0.40 {
            continue;
        }
        let k = key("cache", &slug);
        if is_dismissed(&conn, &k)? {
            continue;
        }
        out.push(Tip {
            key: k,
            category: "cache".into(),
            title: format!("Low cache hit rate in {slug}"),
            body: format!(
                "Cache hit rate is {pct:.0}% over the last 7 days. Sessions that restart context frequently rebuild cache. Consider longer-lived sessions or fewer context resets.",
                pct = hit * 100.0
            ),
            scope: slug.clone(),
            project_slug: Some(slug),
            project_cwd: None,
            extras: serde_json::Map::new(),
        });
    }
    Ok(out)
}

fn repeated_target_tips<P: AsRef<Path>>(db: P, today: &str) -> rusqlite::Result<Vec<Tip>> {
    let since = iso_days_ago(today, 7);
    let conn = open(db)?;
    let mut out = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT project_slug, target, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions \
         FROM tool_calls \
         WHERE tool_name IN ('Read','Edit','Write') AND timestamp >= ? \
         GROUP BY project_slug, target HAVING n > 10 \
         ORDER BY n DESC LIMIT 10",
    )?;
    let reads: Vec<(Option<String>, Option<String>, i64, i64)> = stmt
        .query_map([&since], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (slug_o, target_o, n, sessions) in reads {
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let target = target_o.clone().unwrap_or_else(|| "?".into());
        let k = key("repeat-file", &format!("{slug}:{target}"));
        if is_dismissed(&conn, &k)? {
            continue;
        }
        let mut extras = serde_json::Map::new();
        extras.insert("target".into(), serde_json::Value::String(target.clone()));
        extras.insert("count".into(), serde_json::Value::from(n));
        extras.insert("sessions".into(), serde_json::Value::from(sessions));
        out.push(Tip {
            key: k,
            category: "repeat-file".into(),
            title: format!("{target} read {n} times in {slug}"),
            body: format!(
                "This file was opened {n} times across {sessions} sessions in the past 7 days. A summary in CLAUDE.md or one read per session would avoid repeats."
            ),
            scope: target,
            project_slug: slug_o,
            project_cwd: None,
            extras,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT project_slug, target, COUNT(*) AS n \
         FROM tool_calls \
         WHERE tool_name='Bash' AND timestamp >= ? \
         GROUP BY project_slug, target HAVING n > 15 \
         ORDER BY n DESC LIMIT 10",
    )?;
    let bashes: Vec<(Option<String>, Option<String>, i64)> = stmt
        .query_map([&since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (slug_o, target_o, n) in bashes {
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let target = target_o.clone().unwrap_or_else(|| "?".into());
        let k = key("repeat-bash", &format!("{slug}:{target}"));
        if is_dismissed(&conn, &k)? {
            continue;
        }
        let mut extras = serde_json::Map::new();
        extras.insert("target".into(), serde_json::Value::String(target.clone()));
        extras.insert("count".into(), serde_json::Value::from(n));
        out.push(Tip {
            key: k,
            category: "repeat-bash".into(),
            title: format!("`{target}` ran {n} times in {slug}"),
            body: format!("This bash command ran {n} times in the past 7 days. Consider a watch flag or shell alias."),
            scope: target,
            project_slug: slug_o,
            project_cwd: None,
            extras,
        });
    }
    Ok(out)
}

fn right_size_tips<P: AsRef<Path>>(db: P, today: &str) -> rusqlite::Result<Vec<Tip>> {
    let since = iso_days_ago(today, 7);
    let conn = open(db)?;
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT project_slug, \
                COUNT(*) AS n, \
                SUM(input_tokens+cache_create_5m_tokens+cache_create_1h_tokens) AS in_tok, \
                SUM(output_tokens) AS out_tok \
         FROM messages \
         WHERE type='assistant' AND model LIKE '%opus%' \
           AND output_tokens < 500 AND is_sidechain = 0 \
           AND timestamp >= ? \
         GROUP BY project_slug",
    )?;
    let rows: Vec<(Option<String>, i64, i64, i64)> = stmt
        .query_map([&since], |r| {
            let slug: Option<String> = r.get(0)?;
            let n: Option<i64> = r.get(1)?;
            let in_tok: Option<i64> = r.get(2)?;
            let out_tok: Option<i64> = r.get(3)?;
            Ok((
                slug,
                n.unwrap_or(0),
                in_tok.unwrap_or(0),
                out_tok.unwrap_or(0),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (slug_o, n, in_tok, out_tok) in rows {
        if n < 10 {
            continue;
        }
        let api_opus = (in_tok as f64 * 15.0 + out_tok as f64 * 75.0) / 1_000_000.0;
        let api_sonnet = (in_tok as f64 * 3.0 + out_tok as f64 * 15.0) / 1_000_000.0;
        let savings = api_opus - api_sonnet;
        if savings < 1.0 {
            continue;
        }
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let k = key("right-size", &format!("{slug}:opus-short-turns-7d"));
        if is_dismissed(&conn, &k)? {
            continue;
        }
        let mut extras = serde_json::Map::new();
        extras.insert("count".into(), serde_json::Value::from(n));
        extras.insert(
            "api_opus".into(),
            serde_json::Value::from((api_opus * 100.0).round() as i64),
        );
        extras.insert(
            "api_sonnet".into(),
            serde_json::Value::from((api_sonnet * 100.0).round() as i64),
        );
        extras.insert(
            "savings".into(),
            serde_json::Value::from((savings * 100.0).round() as i64),
        );
        out.push(Tip {
            key: k,
            category: "right-size".into(),
            title: format!("{n} short Opus turns in {slug} might fit on Sonnet"),
            body: format!(
                "Opus turns under 500 output tokens cost ~${api_opus:.2} in the last 7 days. Sonnet would have cost ~${api_sonnet:.2} (savings ~${savings:.2})."
            ),
            scope: format!("{slug}:opus-short-turns-7d"),
            project_slug: slug_o,
            project_cwd: None,
            extras,
        });
    }
    Ok(out)
}

fn outlier_tips<P: AsRef<Path>>(db: P, today: &str) -> rusqlite::Result<Vec<Tip>> {
    let since = iso_days_ago(today, 7);
    let conn = open(db)?;
    let mut out = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT project_slug, COUNT(*) AS n, AVG(result_tokens) AS avg_t \
         FROM tool_calls \
         WHERE tool_name='_tool_result' AND result_tokens > 50000 AND timestamp >= ? \
         GROUP BY project_slug",
    )?;
    let bigs: Vec<(Option<String>, i64, f64)> = stmt
        .query_map([&since], |r| {
            let slug: Option<String> = r.get(0)?;
            let n: i64 = r.get(1)?;
            let avg: Option<f64> = r.get(2)?;
            Ok((slug, n, avg.unwrap_or(0.0)))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (slug_o, n, avg) in bigs {
        if n < 5 {
            continue;
        }
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let k = key("tool-bloat", &format!("{slug}:result-50k+"));
        if is_dismissed(&conn, &k)? {
            continue;
        }
        out.push(Tip {
            key: k,
            category: "tool-bloat".into(),
            title: format!("{n} tool results over 50k tokens in {slug} this week"),
            body: format!(
                "Average size is {avg_int:} tokens. Pipe long Bash output to head/tail and ask for narrower file reads.",
                avg_int = avg as i64
            ),
            scope: format!("{slug}:result-50k+"),
            project_slug: slug_o,
            project_cwd: None,
            extras: serde_json::Map::new(),
        });
    }

    let mut stmt = conn.prepare(
        "SELECT agent_id, COUNT(*) AS n, \
                AVG(input_tokens+output_tokens) AS mean_t, \
                MAX(input_tokens+output_tokens) AS max_t \
         FROM messages \
         WHERE is_sidechain=1 AND agent_id IS NOT NULL AND timestamp >= ? \
         GROUP BY agent_id HAVING n >= 10",
    )?;
    let agents: Vec<(String, i64, f64, i64)> = stmt
        .query_map([&since], |r| {
            let agent: String = r.get(0)?;
            let n: i64 = r.get(1)?;
            let mean: Option<f64> = r.get(2)?;
            let max: Option<i64> = r.get(3)?;
            Ok((agent, n, mean.unwrap_or(0.0), max.unwrap_or(0)))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (agent, _n, mean, max_t) in agents {
        if (max_t as f64) > 6.0 * mean.max(1.0) && max_t > 50_000 {
            let k = key("subagent-outlier", &agent);
            if is_dismissed(&conn, &k)? {
                continue;
            }
            out.push(Tip {
                key: k,
                category: "subagent-outlier".into(),
                title: format!("Subagent {agent} has cost outliers"),
                body: format!(
                    "Largest invocation used {max_t:} tokens vs mean {mean_int:}. Worth checking what those did differently.",
                    mean_int = mean as i64
                ),
                scope: agent,
                project_slug: None,
                project_cwd: None,
                extras: serde_json::Map::new(),
            });
        }
    }
    Ok(out)
}

fn waste_tips<P: AsRef<Path>>(db: P, today: &str) -> rusqlite::Result<Vec<Tip>> {
    let since = iso_days_ago(today, 7);
    let conn = open(db)?;
    let mut out = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT a.session_id, a.project_slug, COUNT(*) AS n \
         FROM messages a \
         JOIN messages b \
           ON b.session_id = a.session_id \
          AND b.type = 'user' \
          AND b.uuid != a.uuid \
          AND b.prompt_text = a.prompt_text \
          AND b.timestamp > a.timestamp \
          AND (julianday(b.timestamp) - julianday(a.timestamp)) * 86400.0 <= 600 \
         WHERE a.type = 'user' \
           AND a.prompt_text IS NOT NULL \
           AND LENGTH(a.prompt_text) >= 8 \
           AND a.is_sidechain = 0 \
           AND a.timestamp >= ? \
         GROUP BY a.session_id \
         HAVING n >= 2",
    )?;
    let retries: Vec<(String, Option<String>, i64)> = stmt
        .query_map([&since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (sid, slug_o, n) in retries {
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let k = key("waste-retry", &format!("{slug}:{sid}"));
        if is_dismissed(&conn, &k)? {
            continue;
        }
        let mut extras = serde_json::Map::new();
        extras.insert("count".into(), serde_json::Value::from(n));
        out.push(Tip {
            key: k,
            category: "waste-retry".into(),
            title: format!("Retry storm in session {short} ({slug})", short = &sid[..sid.len().min(8)]),
            body: format!(
                "{n} duplicate prompts sent within 10 minutes — usually means the first attempts were interrupted or unsatisfactory. Each repeat re-pays for context."
            ),
            scope: sid,
            project_slug: slug_o,
            project_cwd: None,
            extras,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT project_slug, COUNT(*) AS n, \
                SUM(input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) AS in_tok \
         FROM messages \
         WHERE type='assistant' AND is_sidechain=0 \
           AND output_tokens < 100 \
           AND (input_tokens + cache_create_5m_tokens + cache_create_1h_tokens) > 5000 \
           AND timestamp >= ? \
         GROUP BY project_slug \
         HAVING n >= 5",
    )?;
    let shorts: Vec<(Option<String>, i64, i64)> = stmt
        .query_map([&since], |r| {
            let slug: Option<String> = r.get(0)?;
            let n: i64 = r.get(1)?;
            let in_tok: Option<i64> = r.get(2)?;
            Ok((slug, n, in_tok.unwrap_or(0)))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (slug_o, n, in_tok) in shorts {
        let slug = slug_o.clone().unwrap_or_else(|| "?".into());
        let k = key("waste-aborted", &slug);
        if is_dismissed(&conn, &k)? {
            continue;
        }
        let mut extras = serde_json::Map::new();
        extras.insert("count".into(), serde_json::Value::from(n));
        out.push(Tip {
            key: k,
            category: "waste-aborted".into(),
            title: format!("{n} high-cost short turns in {slug}"),
            body: format!(
                "{n} assistant turns this week paid for {in_tok:} input tokens but produced under 100 output tokens each. Usually a Stop key, a tool refusal, or a misfired slash command — context cost without any useful reply."
            ),
            scope: format!("{slug}:short-turns-7d"),
            project_slug: slug_o,
            project_cwd: None,
            extras,
        });
    }

    Ok(out)
}

fn project_cwds<P: AsRef<Path>>(db: P) -> rusqlite::Result<HashMap<String, String>> {
    let conn = open(db)?;
    let mut stmt = conn.prepare(
        "SELECT project_slug, MAX(timestamp) AS ts, cwd \
         FROM messages \
         WHERE cwd IS NOT NULL AND cwd != '' \
         GROUP BY project_slug",
    )?;
    let mut out = HashMap::new();
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let slug: String = r.get(0)?;
        let cwd: String = r.get(2)?;
        out.insert(slug, cwd);
    }
    Ok(out)
}

fn anomaly_tips<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<Tip>> {
    let conn = open(db.as_ref())?;
    let rows = crate::anomaly::detect(&conn, 30, 3.0)?;
    let Some(worst) = rows.into_iter().next() else {
        return Ok(Vec::new());
    };
    let k = key("anomaly", &worst.session_id);
    if is_dismissed(&conn, &k)? {
        return Ok(Vec::new());
    }
    let short_sid = &worst.session_id[..worst.session_id.len().min(8)];
    let mut extras = serde_json::Map::new();
    extras.insert(
        "session_id".into(),
        serde_json::Value::String(worst.session_id.clone()),
    );
    extras.insert("z_score".into(), serde_json::Value::from(worst.z_score));
    extras.insert("cost_usd".into(), serde_json::Value::from(worst.cost_usd));
    extras.insert(
        "baseline_mean".into(),
        serde_json::Value::from(worst.baseline_mean),
    );
    Ok(vec![Tip {
        key: k,
        category: "anomaly".into(),
        title: format!(
            "Cost outlier in session {short_sid} ({slug})",
            slug = worst.project_slug
        ),
        body: format!(
            "Session cost ${cost:.2} is {z:.1}σ above the {slug} 30-day baseline (${mean:.2}/session). Worth a look — usually means a long retry storm or an unusually expensive run.",
            cost = worst.cost_usd,
            z = worst.z_score,
            slug = worst.project_slug,
            mean = worst.baseline_mean,
        ),
        scope: worst.session_id.clone(),
        project_slug: Some(worst.project_slug),
        project_cwd: None,
        extras,
    }])
}

pub fn all_tips<P: AsRef<Path>>(db: P, today_iso: Option<&str>) -> rusqlite::Result<Vec<Tip>> {
    let owned;
    let today = match today_iso {
        Some(t) => t,
        None => {
            owned = now_iso();
            &owned
        }
    };
    let mut tips = Vec::new();
    tips.extend(cache_discipline_tips(db.as_ref(), today)?);
    tips.extend(repeated_target_tips(db.as_ref(), today)?);
    tips.extend(right_size_tips(db.as_ref(), today)?);
    tips.extend(outlier_tips(db.as_ref(), today)?);
    tips.extend(waste_tips(db.as_ref(), today)?);
    tips.extend(anomaly_tips(db.as_ref())?);
    let cwds = project_cwds(db.as_ref())?;
    for t in &mut tips {
        if let Some(slug) = &t.project_slug {
            t.project_cwd = cwds.get(slug).cloned();
        }
    }
    Ok(tips)
}
