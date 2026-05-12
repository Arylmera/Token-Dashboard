//! End-to-end check for the Codex provider: a synthetic rollout JSONL
//! lands rows tagged `provider='codex'`, usage is attached to the
//! assistant message, and tool calls round-trip.

use rusqlite::Connection;
use std::fs;
use tempfile::TempDir;
use token_dashboard_core::init_db;
use token_dashboard_core::providers::{codex::Codex, Provider, ScanOpts};

fn write_rollout(dir: &std::path::Path) {
    let day = dir.join("2026").join("05").join("12");
    fs::create_dir_all(&day).unwrap();
    let path = day.join("rollout-2026-05-12T20-48-47-test-session-uuid.jsonl");
    let lines = [
        r#"{"timestamp":"2026-05-12T18:48:53Z","type":"session_meta","payload":{"id":"sess1","cwd":"C:\\Users\\g\\proj","cli_version":"0.119.0","git":{"branch":"main"}}}"#,
        r#"{"timestamp":"2026-05-12T18:48:54Z","type":"turn_context","payload":{"turn_id":"t1","model":"gpt-5-codex","cwd":"C:\\Users\\g\\proj"}}"#,
        r#"{"timestamp":"2026-05-12T18:48:55Z","type":"event_msg","payload":{"type":"user_message","turn_id":"t1","message":"hello"}}"#,
        r#"{"timestamp":"2026-05-12T18:48:56Z","type":"event_msg","payload":{"type":"token_count","turn_id":"t1","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":125}}}}"#,
        r#"{"timestamp":"2026-05-12T18:48:57Z","type":"event_msg","payload":{"type":"agent_message","turn_id":"t1","message":"hi","phase":"final_answer"}}"#,
        r#"{"timestamp":"2026-05-12T18:48:58Z","type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"c1","arguments":"{\"command\":\"ls -la\"}"}}"#,
        r#"{"timestamp":"2026-05-12T18:48:59Z","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"total 0\n"}}"#,
    ];
    fs::write(&path, format!("{}\n", lines.join("\n"))).unwrap();
}

#[test]
fn codex_provider_ingests_rollout_with_usage_and_tools() {
    let tmp = TempDir::new().unwrap();
    let sessions_root = tmp.path().join("sessions");
    fs::create_dir_all(&sessions_root).unwrap();
    write_rollout(&sessions_root);

    let db_path = tmp.path().join("td.db");
    init_db(&db_path).unwrap();

    let opts = ScanOpts {
        db_path: db_path.clone(),
        root_override: Some(sessions_root),
    };
    let report = Codex.scan(&opts).unwrap();
    assert_eq!(report.provider, "codex");
    assert_eq!(report.messages, 2, "user + assistant; got {report:?}");
    assert_eq!(report.tools, 2, "call + result; got {report:?}");

    let c = Connection::open(&db_path).unwrap();

    let (input, output, cache, model, provider): (i64, i64, i64, String, String) = c
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, model, provider \
             FROM messages WHERE type='assistant' AND session_id='sess1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(input, 100);
    assert_eq!(output, 25, "output + reasoning folded");
    assert_eq!(cache, 40);
    assert_eq!(model, "gpt-5-codex");
    assert_eq!(provider, "codex");

    let slug: String = c
        .query_row(
            "SELECT project_slug FROM messages WHERE type='assistant' AND session_id='sess1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(slug, "C--Users-g-proj");

    let (call_target, result_is_error): (String, i64) = c
        .query_row(
            "SELECT t.target, r.is_error FROM tool_calls t \
             JOIN tool_calls r ON r.use_id = t.use_id AND r.tool_name = '_tool_result' \
             WHERE t.tool_name = 'shell'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(call_target, "ls -la");
    assert_eq!(result_is_error, 0);
}

/// Smoke check against the developer's real `~/.codex/sessions/` tree.
/// Ignored by default — opt in with `cargo test -- --ignored
/// codex_provider_live_smoke`. Skips gracefully if the directory is
/// absent so CI doesn't fail on clean machines.
#[test]
#[ignore]
fn codex_provider_live_smoke() {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .expect("HOME or USERPROFILE must be set");
    let sessions = home.join(".codex").join("sessions");
    if !sessions.is_dir() {
        eprintln!("skipping: no {}", sessions.display());
        return;
    }

    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("td.db");
    init_db(&db_path).unwrap();

    let opts = ScanOpts {
        db_path: db_path.clone(),
        root_override: Some(sessions.clone()),
    };
    let report = Codex.scan(&opts).expect("codex scan must not fail on live data");
    eprintln!(
        "codex live: files={} messages={} tools={} sessions={} projects={} models={:?}",
        report.files,
        report.messages,
        report.tools,
        report.sessions.len(),
        report.projects.len(),
        report.models,
    );
    assert_eq!(report.provider, "codex");
    assert!(report.files >= 1, "expected at least one rollout under {}", sessions.display());
    assert!(report.messages >= 1, "expected ingested messages, got {report:?}");

    // Every row must be tagged `codex`.
    let c = Connection::open(&db_path).unwrap();
    let bad: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE provider!='codex'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(bad, 0, "non-codex rows leaked into the DB");
}

#[test]
fn codex_provider_skips_non_codex_jsonl() {
    // A JSONL file without `session_meta` (e.g. a Claude transcript stuck
    // under a misconfigured override) must not produce codex rows or
    // pollute the `files` table.
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().join("sessions");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("not-codex.jsonl"),
        "{\"type\":\"assistant\",\"uuid\":\"x\"}\n",
    )
    .unwrap();

    let db_path = tmp.path().join("td.db");
    init_db(&db_path).unwrap();
    let opts = ScanOpts {
        db_path: db_path.clone(),
        root_override: Some(root),
    };
    let report = Codex.scan(&opts).unwrap();
    assert_eq!(report.messages, 0);
    assert_eq!(report.files, 0);

    let c = Connection::open(&db_path).unwrap();
    let codex_files: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM files WHERE provider='codex'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(codex_files, 0);
}
