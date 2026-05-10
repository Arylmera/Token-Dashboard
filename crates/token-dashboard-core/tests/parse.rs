//! Port of `tests/test_scanner_parse.py`.
//!
//! The Python tests call `parse_record(rec, slug)` directly. The Rust
//! scanner's parse step is private (DB-bound `ingest_record`); we exercise
//! the same surface integration-style: write a single JSONL record, run
//! `scan_dir`, then SELECT the resulting rows.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};
use tempfile::TempDir;
use token_dashboard_core::{init_db, scan_dir};

struct Fixture {
    _tmp: TempDir,
    db: PathBuf,
    proj_root: PathBuf,
    proj_dir: PathBuf,
}

fn setup(slug: &str) -> Fixture {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    let proj_root = tmp.path().join("projects");
    let proj_dir = proj_root.join(slug);
    fs::create_dir_all(&proj_dir).unwrap();
    init_db(&db).unwrap();
    Fixture {
        _tmp: tmp,
        db,
        proj_root,
        proj_dir,
    }
}

fn write_jsonl(path: &PathBuf, recs: &[Value]) {
    let mut f = fs::File::create(path).unwrap();
    for r in recs {
        writeln!(f, "{}", serde_json::to_string(r).unwrap()).unwrap();
    }
}

fn simple_assistant() -> Value {
    json!({
        "type": "assistant",
        "uuid": "msg-1",
        "parentUuid": "user-1",
        "sessionId": "sess-1",
        "cwd": "C:/work",
        "gitBranch": "main",
        "version": "2.1.98",
        "entrypoint": "cli",
        "isSidechain": false,
        "timestamp": "2026-04-10T12:00:00.000Z",
        "requestId": "req-1",
        "userType": "external",
        "message": {
            "id": "msg_x",
            "role": "assistant",
            "model": "claude-opus-4-7",
            "stop_reason": "end_turn",
            "content": [{ "type": "text", "text": "ok" }],
            "usage": {
                "input_tokens": 10,
                "output_tokens": 5,
                "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 50,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 30,
                    "ephemeral_1h_input_tokens": 20
                }
            }
        }
    })
}

fn tool_use_assistant() -> Value {
    json!({
        "type": "assistant",
        "uuid": "msg-2",
        "sessionId": "sess-1",
        "timestamp": "2026-04-10T12:00:01.000Z",
        "isSidechain": false,
        "message": {
            "model": "claude-sonnet-4-6",
            "content": [
                { "type": "text", "text": "checking" },
                { "type": "tool_use", "id": "tu1", "name": "Read",
                  "input": { "file_path": "C:/proj/foo.py" } },
                { "type": "tool_use", "id": "tu2", "name": "Bash",
                  "input": { "command": "npm run lint" } }
            ],
            "usage": { "input_tokens": 1, "output_tokens": 1 }
        }
    })
}

#[test]
fn parses_assistant_usage() {
    let fx = setup("proj-x");
    write_jsonl(&fx.proj_dir.join("s.jsonl"), &[simple_assistant()]);
    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let c = Connection::open(&fx.db).unwrap();
    let (uuid, session, slug, model): (String, String, String, String) = c
        .query_row(
            "SELECT uuid, session_id, project_slug, model FROM messages WHERE uuid='msg-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(uuid, "msg-1");
    assert_eq!(session, "sess-1");
    assert_eq!(slug, "proj-x");
    assert_eq!(model, "claude-opus-4-7");

    let (inp, out, cr, c5, c1): (i64, i64, i64, i64, i64) = c
        .query_row(
            "SELECT input_tokens, output_tokens, cache_read_tokens, \
             cache_create_5m_tokens, cache_create_1h_tokens \
             FROM messages WHERE uuid='msg-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(inp, 10);
    assert_eq!(out, 5);
    assert_eq!(cr, 100);
    assert_eq!(c5, 30);
    assert_eq!(c1, 20);

    let (sc, agent): (i64, Option<String>) = c
        .query_row(
            "SELECT is_sidechain, agent_id FROM messages WHERE uuid='msg-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(sc, 0);
    assert!(agent.is_none());

    // No tool_use blocks → no tool_calls rows.
    let n: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM tool_calls WHERE message_uuid='msg-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn extracts_tool_uses() {
    let fx = setup("p");
    write_jsonl(&fx.proj_dir.join("s.jsonl"), &[tool_use_assistant()]);
    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let c = Connection::open(&fx.db).unwrap();
    let mut stmt = c
        .prepare(
            "SELECT tool_name, target FROM tool_calls \
             WHERE message_uuid='msg-2' ORDER BY id",
        )
        .unwrap();
    let tools: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].0, "Read");
    assert_eq!(tools[0].1.as_deref(), Some("C:/proj/foo.py"));
    assert_eq!(tools[1].0, "Bash");
    assert_eq!(tools[1].1.as_deref(), Some("npm run lint"));

    // tool_calls_json column on messages summarises tool_use blocks only.
    let raw: String = c
        .query_row(
            "SELECT tool_calls_json FROM messages WHERE uuid='msg-2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let parsed: Vec<Value> = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].get("name").and_then(|v| v.as_str()), Some("Read"));
    assert_eq!(
        parsed[1].get("target").and_then(|v| v.as_str()),
        Some("npm run lint")
    );
}

#[test]
fn is_sidechain_flag_propagates() {
    let fx = setup("p");
    let rec = json!({
        "type": "assistant", "uuid": "u", "sessionId": "s",
        "timestamp": "2026-04-10T12:00:00Z", "isSidechain": true,
        "agentId": "agent-explore-1",
        "message": {
            "model": "claude-sonnet-4-6",
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }
    });
    write_jsonl(&fx.proj_dir.join("s.jsonl"), &[rec]);
    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let c = Connection::open(&fx.db).unwrap();
    let (sc, agent): (i64, Option<String>) = c
        .query_row(
            "SELECT is_sidechain, agent_id FROM messages WHERE uuid='u'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(sc, 1);
    assert_eq!(agent.as_deref(), Some("agent-explore-1"));
}

#[test]
fn tool_result_estimates_tokens() {
    let fx = setup("p");
    let body = "x".repeat(4000);
    let rec = json!({
        "type": "user", "uuid": "u2", "sessionId": "s",
        "timestamp": "2026-04-10T12:00:00Z", "isSidechain": false,
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "tu1", "content": body, "is_error": false}
        ]}
    });
    write_jsonl(&fx.proj_dir.join("s.jsonl"), &[rec]);
    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let c = Connection::open(&fx.db).unwrap();
    let (name, tokens): (String, i64) = c
        .query_row(
            "SELECT tool_name, result_tokens FROM tool_calls WHERE message_uuid='u2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "_tool_result");
    // Python uses `assertAlmostEqual(..., 1000, delta=10)`; our integer math
    // gives 4000/4 = 1000 exactly.
    assert!((tokens - 1000).abs() <= 10, "tokens out of range: {tokens}");
}
