//! Integration tests for the cli endpoints.
//!
//! Each test seeds a temp DB via the core scanner, builds the axum
//! `app()` Router, and exercises each handler with `tower::ServiceExt::oneshot`
//! — no port binding, no real HTTP. The body is read with
//! `http-body-util::BodyExt::collect`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use token_dashboard_cli::{app, AppState};
use token_dashboard_core::{init_db, scan_dir, Pricing};

struct Fixture {
    _tmp: TempDir,
    state: AppState,
}

fn setup_with_jsonl(records: &[Value]) -> Fixture {
    let tmp = TempDir::new().unwrap();
    let db = tmp.path().join("t.db");
    let proj_root = tmp.path().join("projects");
    let proj_dir = proj_root.join("C--work-sample");
    fs::create_dir_all(&proj_dir).unwrap();
    init_db(&db).unwrap();

    let path: PathBuf = proj_dir.join("s1.jsonl");
    let mut f = fs::File::create(&path).unwrap();
    for r in records {
        writeln!(f, "{}", serde_json::to_string(r).unwrap()).unwrap();
    }
    drop(f);
    scan_dir(&proj_root, &db).unwrap();

    Fixture {
        _tmp: tmp,
        state: AppState {
            db_path: Arc::new(db),
            pricing: Arc::new(Pricing::embedded()),
        },
    }
}

async fn get_json(state: &AppState, path: &str) -> (StatusCode, Value) {
    let resp = app(state.clone())
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

fn user(uuid: &str, ts: &str, text: &str) -> Value {
    json!({
        "type": "user", "uuid": uuid, "sessionId": "s1",
        "timestamp": ts, "isSidechain": false,
        "message": {"role": "user", "content": text}
    })
}

fn assistant(uuid: &str, ts: &str, model: &str, output: i64) -> Value {
    json!({
        "type": "assistant", "uuid": uuid, "parentUuid": "u1",
        "sessionId": "s1", "timestamp": ts, "isSidechain": false,
        "message": {
            "id": format!("msg_{uuid}"),
            "model": model,
            "content": [{"type": "text", "text": "ok"}],
            "usage": {
                "input_tokens": 10,
                "output_tokens": output,
                "cache_read_input_tokens": 5,
                "cache_creation": {
                    "ephemeral_5m_input_tokens": 1,
                    "ephemeral_1h_input_tokens": 2
                }
            }
        }
    })
}

fn assistant_with_read(uuid: &str, ts: &str, file: &str) -> Value {
    json!({
        "type": "assistant", "uuid": uuid, "parentUuid": "u1",
        "sessionId": "s1", "timestamp": ts, "isSidechain": false,
        "message": {
            "id": format!("msg_{uuid}"),
            "model": "claude-opus-4-7",
            "content": [
                {"type": "tool_use", "id": format!("tu_{uuid}"),
                 "name": "Read", "input": {"file_path": file}}
            ],
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }
    })
}

#[tokio::test]
async fn health_returns_ok() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/health").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert!(body.get("version").and_then(|v| v.as_str()).is_some());
}

#[tokio::test]
async fn overview_aggregates_tokens() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
        assistant("a2", "2026-04-10T00:00:02Z", "claude-sonnet-4-6", 30),
    ]);
    let (status, body) = get_json(&fx.state, "/api/overview").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sessions"].as_i64(), Some(1));
    assert_eq!(body["turns"].as_i64(), Some(1)); // user message count
    assert_eq!(body["input_tokens"].as_i64(), Some(20)); // 10 + 10
    assert_eq!(body["output_tokens"].as_i64(), Some(80)); // 50 + 30
    assert_eq!(body["cache_read_tokens"].as_i64(), Some(10));
    // 50 output tokens on opus + 30 on sonnet, plus inputs and caches.
    // Just assert non-zero — exact value depends on pricing.json which
    // ships in this repo, but small drift in rates shouldn't fail tests.
    let cost = body["cost_usd"].as_f64().expect("cost_usd present");
    assert!(cost > 0.0, "expected non-zero cost, got {cost}");
}

#[tokio::test]
async fn overview_respects_since_until() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
        assistant("a2", "2026-04-12T00:00:00Z", "claude-opus-4-7", 100),
    ]);
    let (_, body) = get_json(&fx.state, "/api/overview?since=2026-04-11T00:00:00Z").await;
    // Only a2 falls in range; user u1 is excluded too (timestamp < since).
    assert_eq!(body["output_tokens"].as_i64(), Some(100));
}

#[tokio::test]
async fn projects_groups_by_slug() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
    ]);
    let (status, body) = get_json(&fx.state, "/api/projects").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["project_slug"].as_str(), Some("C--work-sample"));
    assert_eq!(arr[0]["sessions"].as_i64(), Some(1));
}

#[tokio::test]
async fn tools_returns_tool_use_rows() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant_with_read("a1", "2026-04-10T00:00:01Z", "foo.py"),
        assistant_with_read("a2", "2026-04-10T00:00:02Z", "bar.py"),
    ]);
    let (status, body) = get_json(&fx.state, "/api/tools").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    let read = arr
        .iter()
        .find(|r| r["tool_name"] == "Read")
        .expect("Read row");
    assert_eq!(read["calls"].as_i64(), Some(2));
}

#[tokio::test]
async fn daily_groups_by_day() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
        assistant("a2", "2026-04-11T00:00:00Z", "claude-opus-4-7", 30),
    ]);
    let (status, body) = get_json(&fx.state, "/api/daily").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["day"].as_str(), Some("2026-04-10"));
    assert_eq!(arr[1]["day"].as_str(), Some("2026-04-11"));
}

#[tokio::test]
async fn by_model_groups_by_model() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
        assistant("a2", "2026-04-10T00:00:02Z", "claude-sonnet-4-6", 30),
    ]);
    let (status, body) = get_json(&fx.state, "/api/by-model").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    let opus = arr
        .iter()
        .find(|r| r["model"] == "claude-opus-4-7")
        .unwrap();
    assert_eq!(opus["output_tokens"].as_i64(), Some(50));
}

#[tokio::test]
async fn tags_empty_for_untagged_db() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/tags").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().map(|a| a.len()), Some(0));
}

#[tokio::test]
async fn sources_empty_for_clean_db() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/sources").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().map(|a| a.len()), Some(0));
}
