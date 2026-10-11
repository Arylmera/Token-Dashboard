//! `scan_paths` ingests only the files it is handed, and agrees with a full
//! `scan_dir` afterwards (nothing left behind, nothing counted twice).

use std::fs;
use std::path::Path;

use serde_json::json;
use token_dashboard_core::{init_db, scan_dir, scan_paths};

fn write_session(path: &Path, session: &str, uuid: &str) {
    let line = json!({
        "type": "assistant",
        "uuid": uuid,
        "sessionId": session,
        "timestamp": "2026-10-10T08:00:00.000Z",
        "isSidechain": false,
        "message": {"id": format!("m-{uuid}"), "model": "claude-opus-4-7", "content": [],
                    "usage": {"input_tokens": 10, "output_tokens": 5}}
    });
    fs::write(path, format!("{line}\n")).unwrap();
}

fn message_count(db: &Path) -> i64 {
    rusqlite::Connection::open(db)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn scans_only_the_given_files() {
    let tmp = tempfile::TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    let root = tmp.path().join("projects");
    let proj = root.join("C--work-sample");
    fs::create_dir_all(&proj).unwrap();
    init_db(&db).unwrap();
    let a = proj.join("a.jsonl");
    let b = proj.join("b.jsonl");
    write_session(&a, "a", "ua");
    write_session(&b, "b", "ub");
    let outside = tmp.path().join("outside.jsonl");
    write_session(&outside, "o", "uo");

    let stats = scan_paths(&root, &db, &[a.clone(), outside, proj.join("gone.jsonl")]).unwrap();
    assert_eq!((stats.messages, stats.files), (1, 1));
    assert_eq!(stats.sessions, vec!["a".to_string()]);
    assert_eq!(message_count(&db), 1);

    // Same file again: already ingested, nothing new.
    assert_eq!(scan_paths(&root, &db, &[a]).unwrap().messages, 0);

    // The full walk picks up what the targeted scan was not given.
    assert_eq!(scan_dir(&root, &db).unwrap().messages, 1);
    assert_eq!(message_count(&db), 2);
}
