//! Integration tests for the cli endpoints.
//!
//! Each test seeds a temp DB via the core scanner, builds the axum
//! `app()` Router, and exercises each handler with `tower::ServiceExt::oneshot`
//! — no port binding, no real HTTP. The body is read with
//! `http-body-util::BodyExt::collect`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

use token_dashboard_cli::{app, AppState};
use token_dashboard_core::{init_db, scan_dir, Pricing};

struct Fixture {
    _tmp: TempDir,
    state: AppState,
    proj_root: PathBuf,
    proj_dir: PathBuf,
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
        state: AppState::new(db, Pricing::embedded(), proj_root.clone()),
        proj_root,
        proj_dir,
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

async fn post_json(state: &AppState, path: &str, body: &Value) -> (StatusCode, Value) {
    let resp = app(state.clone())
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_string(body).unwrap()))
                .unwrap(),
        )
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

fn assistant_with_tool(
    uuid: &str,
    ts: &str,
    tool: &str,
    target_field: &str,
    target: &str,
) -> Value {
    json!({
        "type": "assistant", "uuid": uuid, "parentUuid": "u1",
        "sessionId": "s1", "timestamp": ts, "isSidechain": false,
        "message": {
            "id": format!("msg_{uuid}"),
            "model": "claude-opus-4-7",
            "content": [
                {"type": "tool_use", "id": format!("tu_{uuid}"),
                 "name": tool, "input": { target_field: target }}
            ],
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }
    })
}

#[tokio::test]
async fn phase_split_classifies_turns() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        // 1 plan turn (Read)
        assistant_with_tool("a1", "2026-04-10T00:00:01Z", "Read", "file_path", "x.py"),
        // 1 execute turn (Bash)
        assistant_with_tool("a2", "2026-04-10T00:00:02Z", "Bash", "command", "ls"),
        // 1 other turn (no tool)
        assistant("a3", "2026-04-10T00:00:03Z", "claude-opus-4-7", 5),
    ]);
    let (status, body) = get_json(&fx.state, "/api/phase-split").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["plan"]["turns"].as_i64(), Some(1));
    assert_eq!(body["execute"]["turns"].as_i64(), Some(1));
    assert_eq!(body["other"]["turns"].as_i64(), Some(1));
}

#[tokio::test]
async fn hourly_returns_assistant_rows() {
    // Cap at fresh data so SQLite's `datetime('now', '-N hours')` keeps
    // the row in scope.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let secs = now.as_secs() as i64;
    let ts = chrono_like_rfc3339(secs);
    let fx = setup_with_jsonl(&[
        user("u1", &ts, "hi"),
        assistant("a1", &ts, "claude-opus-4-7", 50),
    ]);
    let (status, body) = get_json(&fx.state, "/api/hourly?hours=1").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert!(!arr.is_empty(), "expected at least one hourly row");
    assert_eq!(arr[0]["model"].as_str(), Some("claude-opus-4-7"));
}

#[tokio::test]
async fn scan_endpoint_picks_up_new_jsonl() {
    let fx = setup_with_jsonl(&[]);
    // Append a record after fixture setup; /api/scan should see it.
    let path = fx.proj_dir.join("late.jsonl");
    let mut f = fs::File::create(&path).unwrap();
    writeln!(
        f,
        "{}",
        serde_json::to_string(&assistant(
            "a1",
            "2026-04-10T00:00:00Z",
            "claude-opus-4-7",
            5
        ))
        .unwrap()
    )
    .unwrap();
    drop(f);
    let _ = &fx.proj_root; // suppress unused warning when scan test is the only consumer

    let (status, body) = get_json(&fx.state, "/api/scan").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["messages"].as_i64(), Some(1));
    assert_eq!(body["files"].as_i64(), Some(1));
}

#[tokio::test]
async fn prompts_returns_user_assistant_pairs() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "what is 2+2?"),
        // a1 is the assistant turn that follows u1; expensive_prompts joins
        // a.parent_uuid = u.uuid, so the user's actual uuid must match.
        json!({
            "type": "assistant", "uuid": "a1", "parentUuid": "u1",
            "sessionId": "s1", "timestamp": "2026-04-10T00:00:01Z",
            "isSidechain": false,
            "message": {
                "id": "msg_a1", "model": "claude-opus-4-7",
                "content": [{"type": "text", "text": "4"}],
                "usage": {"input_tokens": 100, "output_tokens": 5}
            }
        }),
    ]);
    let (status, body) = get_json(&fx.state, "/api/prompts").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["user_uuid"].as_str(), Some("u1"));
    assert_eq!(arr[0]["assistant_uuid"].as_str(), Some("a1"));
    assert_eq!(arr[0]["billable_tokens"].as_i64(), Some(105));
    assert_eq!(arr[0]["prompt_text"].as_str(), Some("what is 2+2?"));
}

#[tokio::test]
async fn skills_counts_skill_tool_use() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant_with_tool(
            "a1",
            "2026-04-10T00:00:01Z",
            "Skill",
            "skill",
            "test-driven-development",
        ),
        assistant_with_tool(
            "a2",
            "2026-04-10T00:00:02Z",
            "Skill",
            "skill",
            "test-driven-development",
        ),
        assistant_with_tool(
            "a3",
            "2026-04-10T00:00:03Z",
            "Skill",
            "skill",
            "brainstorming",
        ),
    ]);
    let (status, body) = get_json(&fx.state, "/api/skills").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    let tdd = arr
        .iter()
        .find(|r| r["skill"] == "test-driven-development")
        .unwrap();
    assert_eq!(tdd["invocations"].as_i64(), Some(2));
}

#[tokio::test]
async fn plan_defaults_to_api() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/plan").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["plan"].as_str(), Some("api"));
}

#[tokio::test]
async fn sessions_list_returns_recent() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 50),
    ]);
    let (status, body) = get_json(&fx.state, "/api/sessions").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["session_id"].as_str(), Some("s1"));
    assert_eq!(arr[0]["turns"].as_i64(), Some(1));
    assert_eq!(arr[0]["model"].as_str(), Some("claude-opus-4-7"));
    // Cost is non-zero because the assistant turn used opus pricing.
    assert!(arr[0]["cost_usd"].as_f64().unwrap() > 0.0);
    assert_eq!(arr[0]["tags"].as_array().map(|a| a.len()), Some(0));
}

#[tokio::test]
async fn session_returns_turns_in_order() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 5),
        assistant("a2", "2026-04-10T00:00:02Z", "claude-opus-4-7", 7),
    ]);
    let (status, body) = get_json(&fx.state, "/api/sessions/s1").await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().expect("array");
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["uuid"].as_str(), Some("u1"));
    assert_eq!(arr[1]["uuid"].as_str(), Some("a1"));
    assert_eq!(arr[2]["uuid"].as_str(), Some("a2"));
    assert_eq!(arr[0]["type"].as_str(), Some("user"));
}

#[tokio::test]
async fn post_plan_persists() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = post_json(&fx.state, "/api/plan", &json!({"plan": "max"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"].as_bool(), Some(true));

    let (_, after) = get_json(&fx.state, "/api/plan").await;
    assert_eq!(after["plan"].as_str(), Some("max"));
}

#[tokio::test]
async fn post_tips_dismiss_writes_row() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = post_json(&fx.state, "/api/tips/dismiss", &json!({"key": "tip_x"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"].as_bool(), Some(true));

    let conn = rusqlite::Connection::open(fx.state.db_path.as_path()).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM dismissed_tips WHERE tip_key='tip_x'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn preferences_get_defaults() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/preferences").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["badge_metric"].as_str(), Some("tokens"));
    assert_eq!(body["badge_window_mode"].as_str(), Some("remaining"));
    assert_eq!(body["badge_dock_enabled"].as_bool(), Some(true));
    assert_eq!(body["limits_enabled"].as_bool(), Some(false));
    assert_eq!(body["glass_enabled"].as_bool(), Some(false));
    assert_eq!(body["glass_opacity"].as_i64(), Some(25));
    assert!(body["anthropic_api_key"].is_null());
}

#[tokio::test]
async fn preferences_post_round_trip() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = post_json(
        &fx.state,
        "/api/preferences",
        &json!({"badge_metric": "cost", "glass_opacity": 60, "limits_enabled": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["badge_metric"].as_str(), Some("cost"));
    assert_eq!(body["glass_opacity"].as_i64(), Some(60));
    assert_eq!(body["limits_enabled"].as_bool(), Some(true));

    let (_, after) = get_json(&fx.state, "/api/preferences").await;
    assert_eq!(after["badge_metric"].as_str(), Some("cost"));
    assert_eq!(after["glass_opacity"].as_i64(), Some(60));
    assert_eq!(after["limits_enabled"].as_bool(), Some(true));
}

#[tokio::test]
async fn budget_round_trip() {
    let fx = setup_with_jsonl(&[]);
    let (_, body) = post_json(
        &fx.state,
        "/api/budget",
        &json!({"daily": 5.0, "weekly": 35.0}),
    )
    .await;
    assert_eq!(body["daily"].as_f64(), Some(5.0));

    let (_, get_body) = get_json(&fx.state, "/api/budget").await;
    assert_eq!(get_body["daily"].as_f64(), Some(5.0));
    assert_eq!(get_body["weekly"].as_f64(), Some(35.0));
    assert!(get_body["monthly"].is_null());

    // Setting a budget to 0 clears it.
    let (_, _) = post_json(&fx.state, "/api/budget", &json!({"daily": 0})).await;
    let (_, after) = get_json(&fx.state, "/api/budget").await;
    assert!(after["daily"].is_null());
}

/// Insert a synthetic attached_sources row directly so toggle/delete
/// have something to act on. Skips the on-disk file (the python add
/// flow validates SQLite magic bytes and writes the blob; that path is
/// deferred to a later commit).
fn insert_synthetic_source(state: &AppState, name: &str) {
    let conn = rusqlite::Connection::open(state.db_path.as_path()).unwrap();
    conn.execute(
        "INSERT INTO attached_sources (name, path, enabled, added_at, size_bytes) \
         VALUES (?, ?, 1, 0, 0)",
        rusqlite::params![name, format!("/nonexistent/{name}.db")],
    )
    .unwrap();
}

#[tokio::test]
async fn pricing_round_trip() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/pricing").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["defaults"]["claude-opus-4-7"].is_object());
    assert_eq!(body["overrides"].as_object().map(|m| m.len()), Some(0));

    let (set_status, set_body) = post_json(
        &fx.state,
        "/api/pricing/claude-opus-4-7",
        &json!({"input": 4.5}),
    )
    .await;
    assert_eq!(set_status, StatusCode::OK);
    assert_eq!(
        set_body["overrides"]["claude-opus-4-7"]["input"].as_f64(),
        Some(4.5)
    );
    // Effective rates reflect the override.
    assert_eq!(
        set_body["effective"]["claude-opus-4-7"]["input"].as_f64(),
        Some(4.5)
    );

    let (_, cleared) = post_json(&fx.state, "/api/pricing/claude-opus-4-7/clear", &json!({})).await;
    assert!(cleared["overrides"]
        .as_object()
        .map(|m| !m.contains_key("claude-opus-4-7"))
        .unwrap_or(false));
}

#[tokio::test]
async fn pricing_unknown_model_404() {
    let fx = setup_with_jsonl(&[]);
    let (status, _) = post_json(&fx.state, "/api/pricing/gpt-9001", &json!({"input": 1.0})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn pricing_negative_value_400() {
    let fx = setup_with_jsonl(&[]);
    let (status, _) = post_json(
        &fx.state,
        "/api/pricing/claude-opus-4-7",
        &json!({"input": -1.0}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn sources_toggle_round_trip() {
    let fx = setup_with_jsonl(&[]);
    insert_synthetic_source(&fx.state, "extra.db");

    let (status, body) = post_json(
        &fx.state,
        "/api/sources/extra.db/toggle",
        &json!({"enabled": false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"].as_bool(), Some(false));

    let (_, after) = get_json(&fx.state, "/api/sources").await;
    let arr = after.as_array().unwrap();
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["enabled"].as_bool(), Some(false));
}

#[tokio::test]
async fn sources_toggle_404_for_unknown_source() {
    let fx = setup_with_jsonl(&[]);
    let (status, _) = post_json(
        &fx.state,
        "/api/sources/missing.db/toggle",
        &json!({"enabled": true}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sources_delete_removes_row() {
    let fx = setup_with_jsonl(&[]);
    insert_synthetic_source(&fx.state, "doomed.db");

    let (status, body) = post_json(&fx.state, "/api/sources/doomed.db/delete", &json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"].as_bool(), Some(true));

    let (_, after) = get_json(&fx.state, "/api/sources").await;
    assert_eq!(after.as_array().map(|a| a.len()), Some(0));
}

#[tokio::test]
async fn limits_get_returns_defaults() {
    let fx = setup_with_jsonl(&[]);
    let (status, body) = get_json(&fx.state, "/api/limits").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"].as_bool(), Some(false));
    assert_eq!(body["has_api_key"].as_bool(), Some(false));
    assert!(body["last_sync_at"].is_null());
}

#[tokio::test]
async fn post_session_tags_round_trip() {
    let fx = setup_with_jsonl(&[
        user("u1", "2026-04-10T00:00:00Z", "hi"),
        assistant("a1", "2026-04-10T00:00:01Z", "claude-opus-4-7", 5),
    ]);
    let (status, body) = post_json(
        &fx.state,
        "/api/sessions/s1/tags",
        &json!({"add": ["bug", "investigate"], "remove": []}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["added"].as_array().unwrap().len(), 2);
    assert_eq!(body["tags"].as_array().unwrap().len(), 2);

    // Remove one tag; verify the response reflects the new tag set.
    let (_, body2) = post_json(
        &fx.state,
        "/api/sessions/s1/tags",
        &json!({"add": [], "remove": ["bug"]}),
    )
    .await;
    let tags: Vec<&str> = body2["tags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(tags, vec!["investigate"]);
}

/// Format Unix seconds as the ISO8601 shape Claude Code writes
/// (UTC + trailing Z). Avoids pulling in the chrono crate just for tests.
fn chrono_like_rfc3339(secs: i64) -> String {
    let days_from_epoch = secs / 86_400;
    let seconds_today = secs - days_from_epoch * 86_400;
    let h = seconds_today / 3600;
    let m = (seconds_today % 3600) / 60;
    let s = seconds_today % 60;
    let (y, mo, d) = days_to_ymd(days_from_epoch);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    days += 719_468; // shift epoch to 0000-03-01
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
