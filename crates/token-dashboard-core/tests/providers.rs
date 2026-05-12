//! End-to-end check: the Claude provider, invoked through the [`Provider`]
//! trait + [`scan_all`] registry, ingests a JSONL fixture and writes rows
//! tagged with `provider='claude'`.

use rusqlite::Connection;
use serde_json::json;
use std::fs;
use tempfile::TempDir;
use token_dashboard_core::init_db;
use token_dashboard_core::providers::{scan_all, ScanOpts};

#[test]
fn claude_provider_scan_writes_rows_with_provider_claude() {
    let tmp = TempDir::new().unwrap();
    let projects_root = tmp.path().join("projects");
    let proj = projects_root.join("test-proj");
    fs::create_dir_all(&proj).unwrap();
    let rec = json!({
        "type": "assistant",
        "uuid": "u-prov-1",
        "parentUuid": null,
        "sessionId": "s-prov",
        "cwd": "/tmp",
        "isSidechain": false,
        "timestamp": "2026-04-01T00:00:00.000Z",
        "message": {
            "id": "msg_provider_1",
            "role": "assistant",
            "model": "claude-sonnet-4-6",
            "content": [{"type": "text", "text": "hello"}],
            "usage": {
                "input_tokens": 5,
                "output_tokens": 7,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0
            }
        }
    });
    fs::write(
        proj.join("s-prov.jsonl"),
        format!("{}\n", serde_json::to_string(&rec).unwrap()),
    )
    .unwrap();

    let db_path = tmp.path().join("td.db");
    init_db(&db_path).unwrap();

    let opts = ScanOpts {
        db_path: db_path.clone(),
        root_override: Some(projects_root.clone()),
    };
    let reports = scan_all(&opts).unwrap();
    assert!(
        reports.iter().any(|r| r.provider == "claude"),
        "claude provider must be registered, got {reports:?}"
    );
    let claude = reports
        .iter()
        .find(|r| r.provider == "claude")
        .expect("claude report");
    assert!(claude.messages >= 1, "expected ≥1 message, got {claude:?}");
    // Codex shares the registry; with a Claude-shaped root_override it
    // walks the same tree but skips files lacking `session_meta`, so it
    // ingests zero rows here.
    if let Some(codex) = reports.iter().find(|r| r.provider == "codex") {
        assert_eq!(codex.messages, 0, "codex must not claim claude rows");
        assert_eq!(codex.files, 0);
    }

    // Verify the stored row is tagged 'claude'.
    let c = Connection::open(&db_path).unwrap();
    let provider: String = c
        .query_row(
            "SELECT provider FROM messages WHERE session_id='s-prov' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(provider, "claude");
}
