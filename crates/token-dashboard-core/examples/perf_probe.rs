//! Performance probe for the analytics read path.
//!
//! Times the hot queries behind the slow views against a real database and
//! dumps `EXPLAIN QUERY PLAN` for the worst offenders, so each tier of the
//! performance roadmap (docs/superpowers/specs/2026-05-31-app-performance-roadmap-design.md)
//! has a before/after number rather than a vibe.
//!
//! Run:
//!   $env:TOKEN_DASHBOARD_DB="$env:USERPROFILE\.claude\token-dashboard.db"
//!   cargo run -p token-dashboard-core --example perf_probe --release

use std::time::Instant;

use rusqlite::Connection;
use token_dashboard_core::{day, queries};

const RUNS: u32 = 5;

fn median_ms<F: FnMut()>(mut f: F) -> f64 {
    f(); // warmup (prime page cache / pool)
    let mut samples: Vec<f64> = (0..RUNS)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn explain(conn: &Connection, label: &str, sql: &str, bind_date: bool) {
    println!("\n  EXPLAIN QUERY PLAN — {label}");
    let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let collect = |stmt: &mut rusqlite::Statement, params: &[&dyn rusqlite::ToSql]| {
        let rows: Vec<String> = stmt
            .query_map(params, |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    };
    let lines = if bind_date {
        collect(&mut stmt, &[&"1970-01-01"])
    } else {
        collect(&mut stmt, &[])
    };
    for line in lines {
        println!("    {line}");
    }
}

fn main() {
    let db = std::env::var("TOKEN_DASHBOARD_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| token_dashboard_core::default_db_path());
    println!("DB: {}", db.display());

    // Apply schema/migrations exactly as the app does on launch, so any new
    // index (e.g. the Tier 2 expression index) is built before we measure.
    token_dashboard_core::init_db(&db).unwrap();

    let conn = Connection::open(&db).unwrap();

    // Pick the busiest UTC date so timings reflect a heavy day-click.
    let busy_date: String = conn
        .query_row(
            "SELECT substr(timestamp,1,10) d FROM messages \
             GROUP BY d ORDER BY COUNT(*) DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "2026-01-01".to_string());
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
        .unwrap_or(0);
    println!("messages rows: {total}   busiest date: {busy_date}\n");

    // --- /api/day: the six queries the day handler fires ---
    let day_ms = median_ms(|| {
        let p = &db;
        let _ = day::day_totals(p, &busy_date);
        let _ = day::day_by_model(p, &busy_date);
        let _ = day::day_by_project(p, &busy_date);
        let _ = day::day_by_hour(p, &busy_date);
        let _ = day::day_by_session(p, &busy_date);
        let _ = day::day_session_turns(p, &busy_date);
    });

    // --- /api/tags-summary ---
    let tag_ms = median_ms(|| {
        let _ = queries::tag_aggregates(&db);
        let _ = queries::tag_session_counts(&db);
    });

    // --- /api/daily (all-time, the heaviest range) ---
    let daily_ms = median_ms(|| {
        let _ = queries::daily_token_breakdown(&db, None, None, None);
    });

    println!("RESULTS (median of {RUNS} warm runs, ms):");
    println!("  /api/day (6 queries)   {day_ms:8.1}");
    println!("  tags-summary (2 q)     {tag_ms:8.1}");
    println!("  daily (all-time)       {daily_ms:8.1}");

    explain(
        &conn,
        "day_by_model",
        "SELECT model FROM messages WHERE type='assistant' AND substr(timestamp,1,10)=?1 GROUP BY model",
        true,
    );
    explain(
        &conn,
        "tag_aggregates",
        "SELECT st.tag,m.model FROM session_tags st JOIN messages m ON m.session_id=st.session_id WHERE m.type='assistant' GROUP BY st.tag,m.model",
        false,
    );
}
