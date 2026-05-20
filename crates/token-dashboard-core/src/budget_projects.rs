//! Per-project month-to-date spend, joined with optional per-project caps.
//!
//! Aggregates assistant messages grouped by `project_slug + model` for the
//! current month, computes USD cost via `pricing::cost_for`, and overlays
//! the user's `set_project_budget` caps so the UI can show progress bars
//! and percentage utilisation.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use crate::preferences;
use crate::pricing::{cost_for, Pricing, Usage};
use crate::queries::open_ro;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectAllocation {
    pub project_slug: String,
    pub mtd_cost_usd: f64,
    pub mtd_tokens: i64,
    pub cap_usd: Option<f64>,
    /// `None` when no cap is configured for the project. `0.0` is possible
    /// when a cap exists but spend is zero.
    pub percent: Option<f64>,
}

/// MTD allocations sorted by descending cost. Projects with a cap but no
/// spend this month are still included so the UI can render the empty bar.
pub fn allocations<P: AsRef<Path>>(db: P) -> rusqlite::Result<Vec<ProjectAllocation>> {
    let db = db.as_ref();
    let conn = open_ro(db)?;
    let pricing = Pricing::embedded();
    let caps: HashMap<String, f64> = preferences::list_project_budgets(db)?.into_iter().collect();

    let mut stmt = conn.prepare(
        "SELECT COALESCE(project_slug, '(none)') AS slug, model, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(cache_read_tokens), 0), \
                COALESCE(SUM(cache_create_5m_tokens), 0), \
                COALESCE(SUM(cache_create_1h_tokens), 0) \
         FROM messages \
         WHERE type = 'assistant' \
           AND substr(timestamp, 1, 10) >= strftime('%Y-%m-01', 'now') \
         GROUP BY slug, model",
    )?;

    let mut by_project: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    for row in rows {
        let (slug, model, inp, out, cr, c5, c1) = row?;
        let tokens = inp + out + cr + c5 + c1;
        let usage = Usage {
            input_tokens: inp,
            output_tokens: out,
            cache_read_tokens: cr,
            cache_create_5m_tokens: c5,
            cache_create_1h_tokens: c1,
        };
        let cost = match model.as_deref() {
            Some(m) => cost_for(m, &usage, &pricing).usd.unwrap_or(0.0),
            None => 0.0,
        };
        let entry = by_project.entry(slug).or_insert((0.0, 0));
        entry.0 += cost;
        entry.1 += tokens;
    }

    // Include projects that have a cap but no MTD spend so the UI shows them.
    for slug in caps.keys() {
        by_project.entry(slug.clone()).or_insert((0.0, 0));
    }

    let mut out: Vec<ProjectAllocation> = by_project
        .into_iter()
        .map(|(slug, (cost, tokens))| {
            let cap = caps.get(&slug).copied();
            let percent = cap.map(|c| if c > 0.0 { (cost / c) * 100.0 } else { 0.0 });
            ProjectAllocation {
                project_slug: slug,
                mtd_cost_usd: cost,
                mtd_tokens: tokens,
                cap_usd: cap,
                percent,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.mtd_cost_usd
            .partial_cmp(&a.mtd_cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
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

    fn today() -> String {
        let c = Connection::open_in_memory().unwrap();
        c.query_row("SELECT date('now')", [], |r| r.get::<_, String>(0))
            .unwrap()
    }

    fn insert_assistant(conn: &Connection, uuid: &str, project: &str, model: &str, output: i64) {
        conn.execute(
            "INSERT INTO messages \
             (uuid, session_id, project_slug, type, timestamp, model, \
              input_tokens, output_tokens, cache_read_tokens, \
              cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?1, 's', ?2, 'assistant', ?3, ?4, 0, ?5, 0, 0, 0)",
            params![
                uuid,
                project,
                format!("{}T12:00:00Z", today()),
                model,
                output
            ],
        )
        .unwrap();
    }

    #[test]
    fn groups_by_project_and_sorts_by_cost() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(&conn, "a", "alpha", "claude-opus-4-7", 1_000_000);
        insert_assistant(&conn, "b1", "beta", "claude-opus-4-7", 2_000_000);
        insert_assistant(&conn, "b2", "beta", "claude-opus-4-7", 1_000_000);
        drop(conn);
        let rows = allocations(f.path()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].project_slug, "beta", "highest spend first");
        assert!(rows[0].mtd_cost_usd > rows[1].mtd_cost_usd);
    }

    #[test]
    fn caps_drive_percent_calculation() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(&conn, "a", "alpha", "claude-opus-4-7", 1_000_000);
        drop(conn);
        let per_m = cost_for(
            "claude-opus-4-7",
            &Usage {
                output_tokens: 1_000_000,
                ..Default::default()
            },
            &Pricing::embedded(),
        )
        .usd
        .unwrap();
        preferences::set_project_budget(f.path(), "alpha", Some(per_m * 4.0)).unwrap();
        let rows = allocations(f.path()).unwrap();
        let alpha = rows.iter().find(|r| r.project_slug == "alpha").unwrap();
        assert!(alpha.cap_usd.is_some());
        let pct = alpha.percent.unwrap();
        assert!(
            (pct - 25.0).abs() < 0.1,
            "expected ~25% utilisation, got {pct}"
        );
    }

    #[test]
    fn capped_project_with_zero_spend_is_included() {
        let f = fresh_db();
        preferences::set_project_budget(f.path(), "ghost", Some(50.0)).unwrap();
        let rows = allocations(f.path()).unwrap();
        let ghost = rows.iter().find(|r| r.project_slug == "ghost").unwrap();
        assert_eq!(ghost.mtd_cost_usd, 0.0);
        assert_eq!(ghost.percent, Some(0.0));
    }
}
