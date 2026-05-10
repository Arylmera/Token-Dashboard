//! Port of `tests/test_scanner_rescan.py`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

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

fn setup() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    let proj_root = tmp.path().join("projects");
    let proj_dir = proj_root.join("C--work-sample");
    fs::create_dir_all(&proj_dir).unwrap();
    init_db(&db).unwrap();
    Fixture {
        _tmp: tmp,
        db,
        proj_root,
        proj_dir,
    }
}

fn jsonl_path(fx: &Fixture) -> PathBuf {
    fx.proj_dir.join("s1.jsonl")
}

fn assistant_with_tool_use(uuid: &str, msg_id: &str, ts: &str, output_tokens: i64) -> Value {
    json!({
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": "u1",
        "sessionId": "s1",
        "timestamp": ts,
        "isSidechain": false,
        "message": {
            "id": msg_id,
            "model": "claude-opus-4-7",
            "content": [
                {"type": "tool_use", "id": "tu1", "name": "Read",
                 "input": {"file_path": "foo.py"}}
            ],
            "usage": {"input_tokens": 10, "output_tokens": output_tokens}
        }
    })
}

fn user_record() -> Value {
    json!({
        "type": "user", "uuid": "u1", "sessionId": "s1",
        "timestamp": "2026-04-10T00:00:00Z", "isSidechain": false,
        "message": {"role": "user", "content": "hi"}
    })
}

fn write_jsonl(path: &PathBuf, recs: &[Value]) {
    let mut f = fs::File::create(path).unwrap();
    for r in recs {
        writeln!(f, "{}", serde_json::to_string(r).unwrap()).unwrap();
    }
}

fn count_tool_reads(db: &PathBuf) -> i64 {
    let c = Connection::open(db).unwrap();
    c.query_row(
        "SELECT COUNT(*) FROM tool_calls WHERE tool_name='Read'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

/// Bump a file's mtime forward without changing content. Cross-platform
/// equivalent of Python's `os.utime(path, (future, future))`.
fn bump_mtime_forward(path: &PathBuf, secs: u64) {
    let when = SystemTime::now() + Duration::from_secs(secs);
    filetime::set_file_mtime(path, filetime::FileTime::from_system_time(when)).expect("set mtime");
}

#[test]
fn partial_line_at_eof_is_not_skipped_on_next_scan() {
    let fx = setup();
    let path = jsonl_path(&fx);

    let rec_a = assistant_with_tool_use("a1", "msg_A", "2026-04-10T00:00:01Z", 10);
    let partial_b = serde_json::to_string(&assistant_with_tool_use(
        "a2",
        "msg_B",
        "2026-04-10T00:00:02Z",
        20,
    ))
    .unwrap();
    let half = partial_b.len() / 2;

    {
        let mut f = fs::File::create(&path).unwrap();
        writeln!(f, "{}", serde_json::to_string(&user_record()).unwrap()).unwrap();
        writeln!(f, "{}", serde_json::to_string(&rec_a).unwrap()).unwrap();
        // Partial line — no trailing newline.
        f.write_all(&partial_b.as_bytes()[..half]).unwrap();
    }

    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let mut uuids_after_1: Vec<String> = {
        let c = Connection::open(&fx.db).unwrap();
        let mut stmt = c.prepare("SELECT uuid FROM messages").unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    uuids_after_1.sort();
    assert_eq!(
        uuids_after_1,
        vec!["a1".to_string(), "u1".to_string()],
        "partial line must be skipped on first scan (JSON decode fails)"
    );

    // Scan 2: complete record B's line, then append a new record C.
    let rec_c = assistant_with_tool_use("a3", "msg_C", "2026-04-10T00:00:03Z", 30);
    {
        let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(&partial_b.as_bytes()[half..]).unwrap();
        writeln!(f).unwrap();
        writeln!(f, "{}", serde_json::to_string(&rec_c).unwrap()).unwrap();
    }
    bump_mtime_forward(&path, 10);

    scan_dir(&fx.proj_root, &fx.db).unwrap();

    let mut uuids_after_2: Vec<String> = {
        let c = Connection::open(&fx.db).unwrap();
        let mut stmt = c.prepare("SELECT uuid FROM messages").unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    uuids_after_2.sort();
    assert_eq!(
        uuids_after_2,
        vec![
            "a1".to_string(),
            "a2".to_string(),
            "a3".to_string(),
            "u1".to_string()
        ],
        "record whose line was partial on scan 1 must be loaded on scan 2"
    );
}

#[test]
fn rescan_with_same_content_does_not_duplicate_tool_calls() {
    let fx = setup();
    write_jsonl(
        &jsonl_path(&fx),
        &[
            user_record(),
            assistant_with_tool_use("a1", "msg_X", "2026-04-10T00:00:01Z", 42),
        ],
    );

    scan_dir(&fx.proj_root, &fx.db).unwrap();
    assert_eq!(
        count_tool_reads(&fx.db),
        1,
        "first scan inserts one tool_call"
    );

    // Force mtime forward without changing content — full rescan from offset 0.
    bump_mtime_forward(&jsonl_path(&fx), 10);

    scan_dir(&fx.proj_root, &fx.db).unwrap();
    assert_eq!(
        count_tool_reads(&fx.db),
        1,
        "rescan must not duplicate tool_calls — INSERT needs to clear per-message first"
    );
}
