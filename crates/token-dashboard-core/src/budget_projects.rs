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
    /// Canonical key used for cap storage and grouping. Lowercased, with
    /// worktree suffixes and OS-specific path prefixes stripped.
    pub project_slug: String,
    /// Human-readable name preserving the original folder casing (e.g.
    /// `Token-Dashboard`). Falls back to `project_slug` when no member slug
    /// preserves casing.
    pub display_name: String,
    pub mtd_cost_usd: f64,
    pub mtd_tokens: i64,
    pub cap_usd: Option<f64>,
    /// `None` when no cap is configured for the project. `0.0` is possible
    /// when a cap exists but spend is zero.
    pub percent: Option<f64>,
    /// How many raw slugs (worktrees, machines, casing variants) collapsed
    /// into this row. Always `>= 1`.
    pub member_count: usize,
}

/// Extract the project name segment from a raw Claude Code project slug.
///
/// Strips `--claude-worktrees-...` suffixes and walks past the last `-git-`
/// or `-Github-` path marker, so worktrees and clones on different
/// machines collapse to the same key.
pub fn project_name_segment(slug: &str) -> &str {
    let base = slug.split("--claude-worktrees-").next().unwrap_or(slug);
    if let Some(idx) = base.rfind("-git-") {
        return &base[idx + 5..];
    }
    if let Some(idx) = base.rfind("-Github-") {
        return &base[idx + 8..];
    }
    if let Some(idx) = base.rfind("-GitHub-") {
        return &base[idx + 8..];
    }
    base
}

/// Lowercased canonical key for grouping and cap storage.
pub fn canonical_project_key(slug: &str) -> String {
    project_name_segment(slug).to_lowercase()
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

    // Group raw (slug, cost, tokens) records by canonical key.
    struct Group {
        cost: f64,
        tokens: i64,
        member_count: usize,
        display_name: String,
        // Prefer non-worktree slugs as the display source.
        display_is_worktree: bool,
    }
    let mut by_canonical: BTreeMap<String, Group> = BTreeMap::new();

    fn merge_display(group: &mut Group, slug: &str) {
        let is_worktree = slug.contains("--claude-worktrees-");
        let candidate = project_name_segment(slug).to_string();
        if group.display_name.is_empty()
            || (group.display_is_worktree && !is_worktree)
            || (group.display_is_worktree == is_worktree
                && candidate.len() > group.display_name.len())
        {
            group.display_name = candidate;
            group.display_is_worktree = is_worktree;
        }
    }

    fn touch<'a>(map: &'a mut BTreeMap<String, Group>, slug: &str) -> &'a mut Group {
        let key = canonical_project_key(slug);
        let entry = map.entry(key).or_insert_with(|| Group {
            cost: 0.0,
            tokens: 0,
            member_count: 0,
            display_name: String::new(),
            display_is_worktree: true,
        });
        entry.member_count += 1;
        merge_display(entry, slug);
        entry
    }

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
        let group = touch(&mut by_canonical, &slug);
        group.cost += cost;
        group.tokens += tokens;
    }

    // Include projects that have a cap but no MTD spend so the UI shows them.
    for slug in caps.keys() {
        let _ = touch(&mut by_canonical, slug);
    }

    let mut out: Vec<ProjectAllocation> = by_canonical
        .into_iter()
        .map(|(key, g)| {
            // Honor caps written under either the canonical key (new
            // format) or any legacy raw slug that maps to this key.
            let cap = caps.get(&key).copied().or_else(|| {
                caps.iter()
                    .find(|(s, _)| canonical_project_key(s) == key)
                    .map(|(_, v)| *v)
            });
            let percent = cap.map(|c| if c > 0.0 { (g.cost / c) * 100.0 } else { 0.0 });
            let display_name = if g.display_name.is_empty() {
                key.clone()
            } else {
                g.display_name
            };
            ProjectAllocation {
                project_slug: key,
                display_name,
                mtd_cost_usd: g.cost,
                mtd_tokens: g.tokens,
                cap_usd: cap,
                percent,
                member_count: g.member_count,
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

    #[test]
    fn worktrees_and_clones_collapse_under_one_project() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "main",
            "C--Users-guill-Documents-git-Token-Dashboard",
            "claude-opus-4-7",
            1_000_000,
        );
        insert_assistant(
            &conn,
            "wt1",
            "C--Users-guill-Documents-git-Token-Dashboard--claude-worktrees-focused-morse-965a37",
            "claude-opus-4-7",
            500_000,
        );
        insert_assistant(
            &conn,
            "wt2",
            "C--Users-guill-Documents-git-token-dashboard",
            "claude-opus-4-7",
            500_000,
        );
        insert_assistant(
            &conn,
            "mac",
            "-Users-guillaume-git-Token-Dashboard",
            "claude-opus-4-7",
            1_000_000,
        );
        drop(conn);
        let rows = allocations(f.path()).unwrap();
        let td = rows
            .iter()
            .find(|r| r.project_slug == "token-dashboard")
            .expect("canonical key should be the lowercased project name");
        assert_eq!(td.member_count, 4, "all four slugs should collapse");
        assert_eq!(
            td.display_name, "Token-Dashboard",
            "display name should prefer non-worktree casing"
        );
    }

    #[test]
    fn legacy_caps_against_raw_slugs_still_apply() {
        let f = fresh_db();
        let conn = Connection::open(f.path()).unwrap();
        insert_assistant(
            &conn,
            "x",
            "C--Users-guill-Documents-git-Token-Dashboard",
            "claude-opus-4-7",
            1_000_000,
        );
        drop(conn);
        preferences::set_project_budget(
            f.path(),
            "C--Users-guill-Documents-git-Token-Dashboard",
            Some(1000.0),
        )
        .unwrap();
        let rows = allocations(f.path()).unwrap();
        let td = rows
            .iter()
            .find(|r| r.project_slug == "token-dashboard")
            .unwrap();
        assert_eq!(td.cap_usd, Some(1000.0));
        assert!(td.percent.is_some());
    }

    #[test]
    fn canonical_key_helpers() {
        assert_eq!(
            canonical_project_key("C--Users-guill-Documents-git-Token-Dashboard"),
            "token-dashboard"
        );
        assert_eq!(
            canonical_project_key(
                "C--Users-guill-Documents-git-Token-Dashboard--claude-worktrees-focused-morse-965a37"
            ),
            "token-dashboard"
        );
        assert_eq!(
            canonical_project_key("-Users-guillaume-git-Token-Dashboard"),
            "token-dashboard"
        );
        assert_eq!(canonical_project_key("alpha"), "alpha");
        assert_eq!(
            project_name_segment("C--Users-guill-Documents-git-HomeDashboard"),
            "HomeDashboard"
        );
    }
}
