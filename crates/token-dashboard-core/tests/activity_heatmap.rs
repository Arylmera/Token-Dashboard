//! Verifies that `queries::activity_heatmap` aggregates user-turn counts by
//! local weekday/hour over the trailing window, counting only `type='user'`
//! messages and excluding anything older than the window. Timestamps are
//! seeded relative to `now` so the test is independent of the wall clock,
//! and assertions avoid pinning specific weekday/hour buckets (which shift
//! with the machine timezone) — they check totals and the type/window
//! filters instead.

use rusqlite::Connection;
use tempfile::TempDir;
use token_dashboard_core::init_db;
use token_dashboard_core::queries::activity_heatmap;

fn seed(c: &Connection, uuid: &str, mtype: &str, ts_expr: &str) {
    // ts_expr is a SQL datetime() expression so timestamps stay relative to
    // the test's "now" and always land inside (or outside) the window.
    c.execute(
        &format!(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, \
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
             VALUES (?, 's1', 'p1', ?, {ts_expr}, 0, 0, 0, 0, 0)"
        ),
        rusqlite::params![uuid, mtype],
    )
    .unwrap();
}

#[test]
fn counts_only_recent_user_turns() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("td.db");
    init_db(&db).unwrap();
    let c = Connection::open(&db).unwrap();

    // Three user turns inside the 7-day window, at two distinct moments.
    seed(&c, "u1", "user", "datetime('now','-2 days')");
    seed(&c, "u2", "user", "datetime('now','-2 days')");
    seed(&c, "u3", "user", "datetime('now','-5 days')");
    // Assistant message inside the window — must be ignored (not a turn).
    seed(&c, "a1", "assistant", "datetime('now','-1 days')");
    // User turn outside the window — must be excluded.
    seed(&c, "old", "user", "datetime('now','-10 days')");

    let cells = activity_heatmap(&db, 7, None).unwrap();
    let total: i64 = cells.iter().map(|c| c.turns).sum();
    assert_eq!(total, 3, "only the 3 in-window user turns count");

    for cell in &cells {
        assert!(
            (0..=6).contains(&cell.dow),
            "dow in 0..=6, got {}",
            cell.dow
        );
        assert!(
            (0..=23).contains(&cell.hour),
            "hour in 0..=23, got {}",
            cell.hour
        );
        assert!(cell.turns > 0, "no zero-count rows emitted");
    }
}

#[test]
fn empty_db_yields_no_cells() {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("td.db");
    init_db(&db).unwrap();
    let cells = activity_heatmap(&db, 7, None).unwrap();
    assert!(cells.is_empty());
}
