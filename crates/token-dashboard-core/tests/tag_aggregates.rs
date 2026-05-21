//! Verifies that `queries::tag_aggregates` and `queries::tag_session_counts`
//! produce the inputs the `/api/tags-summary` handler needs to fold into a
//! per-tag cost summary.

use rusqlite::Connection;
use tempfile::TempDir;
use token_dashboard_core::init_db;
use token_dashboard_core::queries::{
    add_session_tag, tag_aggregates, tag_session_counts, TagAggregateRow,
};

#[allow(clippy::too_many_arguments)]
fn seed_message(
    c: &Connection,
    uuid: &str,
    session_id: &str,
    project: &str,
    ts: &str,
    model: &str,
    input: i64,
    output: i64,
) {
    c.execute(
        "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
          input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
         VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, 0, 0, 0)",
        rusqlite::params![uuid, session_id, project, ts, model, input, output],
    )
    .unwrap();
}

fn setup() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("td.db");
    init_db(&db).unwrap();
    let c = Connection::open(&db).unwrap();
    // Two sessions; s1 used opus, s2 used both opus and sonnet across two
    // messages — exercises the per-(tag, model) grouping.
    seed_message(
        &c,
        "u1",
        "s1",
        "p1",
        "2026-05-10T10:00:00Z",
        "claude-opus-4-7",
        1_000_000,
        0,
    );
    seed_message(
        &c,
        "u2",
        "s2",
        "p1",
        "2026-05-11T10:00:00Z",
        "claude-opus-4-7",
        500_000,
        0,
    );
    seed_message(
        &c,
        "u3",
        "s2",
        "p1",
        "2026-05-12T10:00:00Z",
        "claude-sonnet-4-6",
        200_000,
        100_000,
    );
    (tmp, db)
}

#[test]
fn tag_aggregates_groups_by_tag_and_model() {
    let (_tmp, db) = setup();
    add_session_tag(&db, "s1", "auth").unwrap();
    add_session_tag(&db, "s2", "auth").unwrap();
    add_session_tag(&db, "s2", "mobile").unwrap();

    let mut rows = tag_aggregates(&db).unwrap();
    rows.sort_by(|a, b| a.tag.cmp(&b.tag).then_with(|| a.model.cmp(&b.model)));

    // auth: two model rows (opus from s1+s2, sonnet from s2)
    let auth_opus = rows
        .iter()
        .find(|r| r.tag == "auth" && r.model.as_deref() == Some("claude-opus-4-7"))
        .expect("auth/opus row");
    assert_eq!(auth_opus.input_tokens, 1_500_000);
    assert_eq!(
        auth_opus.first_seen.as_deref(),
        Some("2026-05-10T10:00:00Z")
    );
    assert_eq!(auth_opus.last_seen.as_deref(), Some("2026-05-11T10:00:00Z"));

    let auth_sonnet = rows
        .iter()
        .find(|r| r.tag == "auth" && r.model.as_deref() == Some("claude-sonnet-4-6"))
        .expect("auth/sonnet row");
    assert_eq!(auth_sonnet.input_tokens, 200_000);
    assert_eq!(auth_sonnet.output_tokens, 100_000);

    // mobile: only s2, so opus + sonnet rows but no s1 contribution
    let mobile_opus: &TagAggregateRow = rows
        .iter()
        .find(|r| r.tag == "mobile" && r.model.as_deref() == Some("claude-opus-4-7"))
        .expect("mobile/opus row");
    assert_eq!(mobile_opus.input_tokens, 500_000);
}

#[test]
fn tag_session_counts_is_distinct_per_tag() {
    let (_tmp, db) = setup();
    add_session_tag(&db, "s1", "auth").unwrap();
    add_session_tag(&db, "s2", "auth").unwrap();
    add_session_tag(&db, "s2", "mobile").unwrap();

    let mut counts = tag_session_counts(&db).unwrap();
    counts.sort_by(|a, b| a.tag.cmp(&b.tag));
    let auth = counts.iter().find(|c| c.tag == "auth").unwrap();
    let mobile = counts.iter().find(|c| c.tag == "mobile").unwrap();
    // s2 has two assistant messages on different models — must still
    // count as one session.
    assert_eq!(auth.sessions, 2);
    assert_eq!(mobile.sessions, 1);
}

#[test]
fn tag_aggregates_ignores_user_messages() {
    let (_tmp, db) = setup();
    let c = Connection::open(&db).unwrap();
    // Insert a user-type message — should be filtered out by the WHERE
    // type='assistant' clause.
    c.execute(
        "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, model, \
          input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens) \
         VALUES ('uuser', 's1', 'p1', 'user', '2026-05-10T09:00:00Z', NULL, 0, 0, 0, 0, 0)",
        [],
    )
    .unwrap();
    add_session_tag(&db, "s1", "auth").unwrap();

    let rows = tag_aggregates(&db).unwrap();
    // Should not produce a row with model=NULL from the user message —
    // only the assistant opus row from setup() survives.
    assert!(rows.iter().all(|r| r.model.is_some()));
    assert_eq!(rows.len(), 1);
}

#[test]
fn tag_aggregates_empty_when_no_tags() {
    let (_tmp, db) = setup();
    assert!(tag_aggregates(&db).unwrap().is_empty());
    assert!(tag_session_counts(&db).unwrap().is_empty());
}
