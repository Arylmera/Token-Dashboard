//! `usage_hourly` must always equal a fresh GROUP BY over `messages`, and
//! the rollup-backed queries must match the raw-table ones.

use rusqlite::{params, Connection};
use token_dashboard_core::db::{init_db, open};
use token_dashboard_core::queries::{
    daily_model_breakdown, daily_token_breakdown, model_breakdown, overview_totals,
    project_summary, recent_sessions,
};

const FRESH: &str =
    "SELECT substr(timestamp,1,13), session_id, project_slug, IFNULL(model,''), type, \
     provider, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), \
     SUM(cache_create_5m_tokens), SUM(cache_create_1h_tokens), MAX(timestamp), MIN(timestamp) \
     FROM messages GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6";
const STORED: &str = "SELECT * FROM usage_hourly ORDER BY 1,2,3,4,5,6";

fn rows(c: &Connection, sql: &str) -> Vec<String> {
    let mut st = c.prepare(sql).unwrap();
    let n = st.column_count();
    st.query_map([], |r| {
        Ok((0..n)
            .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
            .collect::<Vec<_>>()
            .join("|"))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

#[allow(clippy::too_many_arguments)]
fn put(
    c: &Connection,
    uuid: &str,
    sess: &str,
    proj: &str,
    ty: &str,
    ts: &str,
    model: Option<&str>,
    tok: i64,
    prov: &str,
) {
    c.execute(
        "INSERT OR REPLACE INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
         input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, provider) \
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        params![uuid, sess, proj, ty, ts, model, tok, tok * 2, tok * 3, tok * 5, tok * 7, prov],
    )
    .unwrap();
}

fn seed(c: &Connection) {
    put(
        c,
        "u1",
        "s1",
        "pa",
        "user",
        "2026-10-09T21:10:00.000Z",
        None,
        0,
        "claude",
    );
    put(
        c,
        "a1",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T21:11:00.000Z",
        Some("opus"),
        10,
        "claude",
    );
    put(
        c,
        "a2",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T22:05:00.000Z",
        Some("opus"),
        20,
        "claude",
    );
    put(
        c,
        "a3",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T22:45:00.000Z",
        Some("sonnet"),
        30,
        "claude",
    );
    put(
        c,
        "u2",
        "s2",
        "pb",
        "user",
        "2026-10-10T08:00:00.000Z",
        None,
        0,
        "claude",
    );
    put(
        c,
        "a4",
        "s2",
        "pb",
        "assistant",
        "2026-10-10T08:30:00.000Z",
        None,
        40,
        "claude",
    );
    put(
        c,
        "a5",
        "s2",
        "pb",
        "assistant",
        "2026-10-10T08:31:00.000Z",
        Some("opus"),
        50,
        "codex",
    );
    put(
        c,
        "x1",
        "s2",
        "pb",
        "attachment",
        "2026-10-10T09:00:00.000Z",
        None,
        0,
        "claude",
    );
    c.execute(
        "INSERT INTO session_tags (session_id, tag, created_at) VALUES ('s1', 't1', 0)",
        [],
    )
    .unwrap();
}

#[test]
fn triggers_track_inserts_replaces_deletes_and_updates() {
    let tmp = tempfile::TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    init_db(&db).unwrap();
    let c = open(&db).unwrap();
    seed(&c);
    assert_eq!(rows(&c, STORED), rows(&c, FRESH));

    // Re-ingest with new tokens (scanner path): REPLACE must remove the old row.
    put(
        &c,
        "a2",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T22:05:00.000Z",
        Some("opus"),
        99,
        "claude",
    );
    // Same uuid moving to another bucket.
    put(
        &c,
        "a1",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T23:00:00.000Z",
        Some("opus"),
        1,
        "claude",
    );
    // Delete the row holding a bucket's max timestamp, and one emptying a bucket.
    c.execute("DELETE FROM messages WHERE uuid IN ('a5', 'x1')", [])
        .unwrap();
    put(
        &c,
        "a6",
        "s2",
        "pb",
        "assistant",
        "2026-10-10T08:59:00.000Z",
        None,
        5,
        "claude",
    );
    c.execute("DELETE FROM messages WHERE uuid = 'a6'", [])
        .unwrap();
    // Delete the row holding a bucket's min timestamp (first_ts recompute):
    // the bucket keeps a2 < a8 < a7, so MIN and MAX of the rest differ.
    put(
        &c,
        "a8",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T22:40:00.000Z",
        Some("opus"),
        2,
        "claude",
    );
    put(
        &c,
        "a7",
        "s1",
        "pa",
        "assistant",
        "2026-10-09T22:50:00.000Z",
        Some("opus"),
        3,
        "claude",
    );
    c.execute("DELETE FROM messages WHERE uuid = 'a2'", [])
        .unwrap();
    c.execute(
        "UPDATE messages SET output_tokens = 7, model = 'haiku' WHERE uuid = 'a3'",
        [],
    )
    .unwrap();
    assert_eq!(rows(&c, STORED), rows(&c, FRESH));
}

#[test]
fn backfill_matches_existing_history() {
    let tmp = tempfile::TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    init_db(&db).unwrap();
    let c = open(&db).unwrap();
    c.execute_batch(
        "DROP TRIGGER usage_hourly_ai; DROP TRIGGER usage_hourly_ad; \
         DROP TRIGGER usage_hourly_au; DROP TABLE usage_hourly;",
    )
    .unwrap();
    seed(&c);
    drop(c);
    init_db(&db).unwrap(); // pre-rollup DB upgrading
    let c = open(&db).unwrap();
    assert_eq!(rows(&c, STORED), rows(&c, FRESH));
    assert!(!rows(&c, STORED).is_empty());
}

/// (since, until) through the rollup, then the equivalent raw bounds.
type Bounds<'a> = (
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
    Option<&'a str>,
);

#[test]
fn rollup_queries_match_raw_queries() {
    let tmp = tempfile::TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    init_db(&db).unwrap();
    seed(&open(&db).unwrap());

    // (hour-aligned → rollup, equivalent unaligned → raw). No message lies
    // in the millisecond between the two forms of each bound.
    let cases: [Bounds; 4] = [
        (None, None, Some("2000-01-01T00:00:00.001Z"), None),
        (
            Some("2026-10-09T22:00:00.000Z"),
            None,
            Some("2026-10-09T21:59:59.999Z"),
            None,
        ),
        (
            Some("2026-10-09T22:00:00.000Z"),
            Some("2026-10-10T08:00:00.000Z"),
            Some("2026-10-09T21:59:59.999Z"),
            Some("2026-10-10T07:59:59.999Z"),
        ),
        (
            Some("2026-10-10"),
            None,
            Some("2026-10-09T23:59:59.999Z"),
            None,
        ),
    ];
    for prov in [None, Some("codex")] {
        for (s, u, rs, ru) in cases {
            let ctx = format!("{s:?}..{u:?} provider {prov:?}");
            let a = overview_totals(&db, s, u, prov).unwrap();
            let b = overview_totals(&db, rs, ru, prov).unwrap();
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "overview {ctx}");
            let a = model_breakdown(&db, s, u, prov).unwrap();
            let b = model_breakdown(&db, rs, ru, prov).unwrap();
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "models {ctx}");
            let a = project_summary(&db, s, u, prov).unwrap();
            let b = project_summary(&db, rs, ru, prov).unwrap();
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "projects {ctx}");
            let a = daily_token_breakdown(&db, s, u, prov).unwrap();
            let b = daily_token_breakdown(&db, rs, ru, prov).unwrap();
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "daily {ctx}");
            let a = daily_model_breakdown(&db, s, u, prov).unwrap();
            let b = daily_model_breakdown(&db, rs, ru, prov).unwrap();
            assert_eq!(format!("{a:?}"), format!("{b:?}"), "daily models {ctx}");
            for tag in [None, Some("t1")] {
                let a = recent_sessions(&db, 50, s, u, tag, prov).unwrap();
                let b = recent_sessions(&db, 50, rs, ru, tag, prov).unwrap();
                assert_eq!(format!("{a:?}"), format!("{b:?}"), "sessions {tag:?} {ctx}");
            }
        }
    }
}
