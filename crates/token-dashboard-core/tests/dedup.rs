//! Streaming-snapshot dedup tests. Direct port of
//! `tests/test_scanner_dedup.py`. Tests are the spec (R2 mitigation).

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

fn setup() -> Fixture {
    let tmp = TempDir::new().expect("tempdir");
    let db = tmp.path().join("t.db");
    let proj_root = tmp.path().join("projects");
    let proj_dir = proj_root.join("C--work-sample");
    fs::create_dir_all(&proj_dir).unwrap();
    init_db(&db).expect("init_db");
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

fn write_jsonl(path: &PathBuf, lines: &[Value]) {
    let mut f = fs::File::create(path).unwrap();
    for v in lines {
        let line = serde_json::to_string(v).unwrap();
        writeln!(f, "{}", line).unwrap();
    }
}

fn append_jsonl(path: &PathBuf, lines: &[Value]) {
    let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
    for v in lines {
        let line = serde_json::to_string(v).unwrap();
        writeln!(f, "{}", line).unwrap();
    }
}

fn streaming_partial(
    uuid: &str,
    msg_id: &str,
    session: &str,
    ts: &str,
    output_tokens: i64,
) -> Value {
    json!({
        "type": "assistant",
        "uuid": uuid,
        "parentUuid": "u1",
        "sessionId": session,
        "timestamp": ts,
        "isSidechain": false,
        "message": {
            "id": msg_id,
            "model": "claude-opus-4-7",
            "content": [{"type": "text", "text": "streaming..."}],
            "usage": {
                "input_tokens": 100,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": 500,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 0,
                    "ephemeral_1h_input_tokens": 200
                }
            }
        }
    })
}

#[test]
fn within_file_streaming_dupes_collapse_to_final() {
    let fx = setup();
    let user = json!({
        "type": "user", "uuid": "u1", "sessionId": "s1",
        "timestamp": "2026-04-10T00:00:00Z", "isSidechain": false,
        "message": {"role": "user", "content": "hi"}
    });
    let p1 = streaming_partial("r1", "msg_X", "s1", "2026-04-10T00:00:01Z", 27);
    let p2 = streaming_partial("r2", "msg_X", "s1", "2026-04-10T00:00:02Z", 27);
    let p3 = streaming_partial("r3", "msg_X", "s1", "2026-04-10T00:00:03Z", 303);
    write_jsonl(&jsonl_path(&fx), &[user, p1, p2, p3]);

    scan_dir(&fx.proj_root, &fx.db).expect("scan_dir");

    let conn = Connection::open(&fx.db).unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT uuid, input_tokens, output_tokens, cache_read_tokens, cache_create_1h_tokens \
             FROM messages WHERE type='assistant'",
        )
        .unwrap();
    let rows: Vec<(String, i64, i64, i64, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "streaming duplicates must collapse to one row"
    );
    let (uuid, input, output, cache_read, cache_1h) = &rows[0];
    // Final snapshot wins — 303, not the sum (357) nor a partial (27).
    assert_eq!(*output, 303);
    assert_eq!(*input, 100);
    assert_eq!(*cache_read, 500);
    assert_eq!(*cache_1h, 200);
    assert_eq!(uuid, "r3");
}

#[test]
fn incremental_scan_final_replaces_partial() {
    let fx = setup();
    let user = json!({
        "type": "user", "uuid": "u1", "sessionId": "s1",
        "timestamp": "2026-04-10T00:00:00Z", "isSidechain": false,
        "message": {"role": "user", "content": "hi"}
    });
    let p1 = streaming_partial("r1", "msg_Y", "s1", "2026-04-10T00:00:01Z", 27);
    let p2 = streaming_partial("r2", "msg_Y", "s1", "2026-04-10T00:00:02Z", 27);
    write_jsonl(&jsonl_path(&fx), &[user, p1, p2]);

    scan_dir(&fx.proj_root, &fx.db).expect("scan_dir 1");

    // Bump mtime so scan_dir doesn't short-circuit on (mtime, size) match.
    // tempfile rounding can make a same-second append compare equal.
    std::thread::sleep(std::time::Duration::from_millis(10));
    let p3 = streaming_partial("r3", "msg_Y", "s1", "2026-04-10T00:00:03Z", 303);
    append_jsonl(&jsonl_path(&fx), &[p3]);

    scan_dir(&fx.proj_root, &fx.db).expect("scan_dir 2");

    let conn = Connection::open(&fx.db).unwrap();
    let mut stmt = conn
        .prepare("SELECT uuid, output_tokens FROM messages WHERE type='assistant'")
        .unwrap();
    let rows: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    assert_eq!(
        rows.len(),
        1,
        "final snapshot must replace earlier partial across scans"
    );
    assert_eq!(rows[0].1, 303);
    assert_eq!(rows[0].0, "r3");
}

#[test]
fn superseded_tool_calls_are_removed() {
    let fx = setup();
    let user = json!({
        "type": "user", "uuid": "u1", "sessionId": "s1",
        "timestamp": "2026-04-10T00:00:00Z", "isSidechain": false,
        "message": {"role": "user", "content": "hi"}
    });
    fn rec_with_tool(uuid: &str, ts: &str, out: i64) -> Value {
        json!({
            "type": "assistant", "uuid": uuid, "parentUuid": "u1",
            "sessionId": "s1", "timestamp": ts, "isSidechain": false,
            "message": {
                "id": "msg_Z", "model": "claude-opus-4-7",
                "content": [
                    {"type": "tool_use", "id": "tu1", "name": "Read",
                     "input": {"file_path": "foo.py"}}
                ],
                "usage": {"input_tokens": 1, "output_tokens": out}
            }
        })
    }
    write_jsonl(
        &jsonl_path(&fx),
        &[
            user,
            rec_with_tool("r1", "2026-04-10T00:00:01Z", 5),
            rec_with_tool("r2", "2026-04-10T00:00:02Z", 50),
        ],
    );

    scan_dir(&fx.proj_root, &fx.db).expect("scan_dir");

    let conn = Connection::open(&fx.db).unwrap();
    let mut stmt = conn
        .prepare("SELECT message_uuid, tool_name FROM tool_calls WHERE tool_name='Read'")
        .unwrap();
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    assert_eq!(rows.len(), 1, "only the winning record's tool_calls remain");
    assert_eq!(rows[0].0, "r2");
}

#[test]
fn assistant_without_message_id_falls_back_to_uuid() {
    let fx = setup();
    let recs = vec![
        json!({"type": "user", "uuid": "u1", "sessionId": "s1",
               "timestamp": "2026-04-10T00:00:00Z", "isSidechain": false,
               "message": {"role": "user", "content": "hi"}}),
        json!({"type": "assistant", "uuid": "a1", "parentUuid": "u1", "sessionId": "s1",
               "timestamp": "2026-04-10T00:00:01Z", "isSidechain": false,
               "message": {"model": "claude-opus-4-7",
                           "usage": {"input_tokens": 1, "output_tokens": 1}}}),
        json!({"type": "assistant", "uuid": "a2", "parentUuid": "u1", "sessionId": "s1",
               "timestamp": "2026-04-10T00:00:02Z", "isSidechain": false,
               "message": {"model": "claude-opus-4-7",
                           "usage": {"input_tokens": 2, "output_tokens": 2}}}),
    ];
    write_jsonl(&jsonl_path(&fx), &recs);

    scan_dir(&fx.proj_root, &fx.db).expect("scan_dir");

    let conn = Connection::open(&fx.db).unwrap();
    let mut stmt = conn
        .prepare("SELECT uuid FROM messages WHERE type='assistant' ORDER BY uuid")
        .unwrap();
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();

    assert_eq!(rows, vec!["a1".to_string(), "a2".to_string()]);
}
