# Multi-Machine Sync (Read-Only Aggregation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user works across multiple machines (laptop + desktop, etc.) they should see consolidated analytics. This plan implements a read-only "remote source" model: each machine exposes a snapshot endpoint; one designated "viewer" machine pulls and merges snapshots into a virtual aggregate view.

**Architecture:** A snapshot is a versioned, deduplicated bundle of `messages` + `tool_calls` rows, fetched over HTTP (Bearer token shared by the user). The existing `sources` model in core is extended with a `RemoteSource` variant. On scan, the viewer fetches each enabled remote source's `/api/sync/snapshot?since=…` and merges rows by `(session_id, message_id)` — the same dedup key the scanner already uses. Privacy: snapshots can be configured to omit `prompt_text`.

**Tech Stack:** Rust (reqwest, serde), token shared via Bearer auth, existing sources infrastructure.

---

## File Structure

- Modify: `crates/token-dashboard-core/src/sources.rs` — add `RemoteSource` variant
- Create: `crates/token-dashboard-core/src/remote_sync.rs` — pull + merge logic
- Modify: `crates/token-dashboard-core/src/lib.rs`
- Modify: `crates/token-dashboard-cli/src/lib.rs` — `/api/sync/snapshot` (host) and `/api/sources/remote/test` (viewer)
- Modify: `frontend/src/routes/settings/sources-card.jsx` — add "Remote machine" form
- Modify: `crates/token-dashboard-tauri/src/main.rs` — call remote sync after local scan

Security: a per-source `bearer_token`, mandatory; HTTP listen address binds to `0.0.0.0` only when remote-sharing is enabled.

---

### Task 1: Host-side snapshot endpoint

**Files:**
- Modify: `crates/token-dashboard-cli/src/lib.rs`

- [x] **Step 1: Snapshot payload struct**

In a new module file `crates/token-dashboard-cli/src/snapshot.rs`:

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct Snapshot {
    pub host_id: String,
    pub generated_at: String,
    pub messages: Vec<SnapshotMessage>,
    pub tool_calls: Vec<SnapshotToolCall>,
}

#[derive(Serialize)]
pub struct SnapshotMessage {
    pub uuid: String,
    pub session_id: String,
    pub message_id: Option<String>,
    pub project_slug: Option<String>,
    pub timestamp: String,
    pub r#type: String,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_create_5m_tokens: u64,
    pub cache_create_1h_tokens: u64,
    pub is_sidechain: u8,
    pub agent_id: Option<String>,
    pub parent_uuid: Option<String>,
    pub prompt_chars: Option<u64>,
    // prompt_text deliberately omitted from snapshot for privacy
}

#[derive(Serialize)]
pub struct SnapshotToolCall {
    pub message_uuid: String,
    pub tool_name: String,
    pub target: Option<String>,
    pub use_id: Option<String>,
    pub result_tokens: u64,
    pub is_error: u8,
    pub timestamp: String,
}

pub fn build(conn: &rusqlite::Connection, since: Option<&str>) -> rusqlite::Result<Snapshot> {
    let cutoff = since.unwrap_or("1970-01-01T00:00:00Z");
    let mut m = conn.prepare(
        "SELECT uuid, session_id, message_id, project_slug, timestamp, type, model, \
                input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, \
                is_sidechain, agent_id, parent_uuid, prompt_chars \
         FROM messages WHERE timestamp > ?1 ORDER BY timestamp"
    )?;
    let messages = m.query_map(rusqlite::params![cutoff], |r| {
        Ok(SnapshotMessage {
            uuid: r.get(0)?, session_id: r.get(1)?, message_id: r.get(2)?,
            project_slug: r.get(3)?, timestamp: r.get(4)?, r#type: r.get(5)?,
            model: r.get(6)?,
            input_tokens: r.get::<_, i64>(7)? as u64, output_tokens: r.get::<_, i64>(8)? as u64,
            cache_read_tokens: r.get::<_, i64>(9)? as u64,
            cache_create_5m_tokens: r.get::<_, i64>(10)? as u64,
            cache_create_1h_tokens: r.get::<_, i64>(11)? as u64,
            is_sidechain: r.get::<_, i64>(12)? as u8,
            agent_id: r.get(13)?, parent_uuid: r.get(14)?,
            prompt_chars: r.get::<_, Option<i64>>(15)?.map(|v| v as u64),
        })
    })?.collect::<rusqlite::Result<Vec<_>>>()?;

    let mut t = conn.prepare(
        "SELECT message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp \
         FROM tool_calls WHERE timestamp > ?1 ORDER BY timestamp"
    )?;
    let tool_calls = t.query_map(rusqlite::params![cutoff], |r| {
        Ok(SnapshotToolCall {
            message_uuid: r.get(0)?, tool_name: r.get(1)?, target: r.get(2)?,
            use_id: r.get(3)?, result_tokens: r.get::<_, i64>(4)? as u64,
            is_error: r.get::<_, i64>(5)? as u8, timestamp: r.get(6)?,
        })
    })?.collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Snapshot {
        host_id: gethostname::gethostname().to_string_lossy().to_string(),
        generated_at: chrono::Utc::now().to_rfc3339(),
        messages, tool_calls,
    })
}
```

Add `gethostname = "0.5"` to `crates/token-dashboard-cli/Cargo.toml`.

- [x] **Step 2: Auth middleware + route**

```rust
async fn snapshot_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::http::HeaderMap(headers): axum::http::HeaderMap,
    axum::extract::Query(q): axum::extract::Query<SnapshotQuery>,
) -> axum::response::Response {
    let expected = std::env::var("TOKEN_DASHBOARD_SYNC_TOKEN").ok();
    let provided = headers.get("authorization").and_then(|h| h.to_str().ok()).and_then(|s| s.strip_prefix("Bearer "));
    if expected.is_none() {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, "sync disabled — set TOKEN_DASHBOARD_SYNC_TOKEN").into_response();
    }
    if provided != expected.as_deref() {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    match crate::snapshot::build(&state.conn(), q.since.as_deref()) {
        Ok(snap) => axum::response::Json(snap).into_response(),
        Err(e) => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct SnapshotQuery { since: Option<String> }
```

Register `.route("/api/sync/snapshot", axum::routing::get(snapshot_handler))`.

- [x] **Step 3: Smoke test**

```bash
TOKEN_DASHBOARD_SYNC_TOKEN=secret cargo run -p token-dashboard-cli
curl -H 'authorization: Bearer secret' http://127.0.0.1:8080/api/sync/snapshot | head -c 200
```

Expected: JSON with `host_id`, `messages`, `tool_calls`.

- [x] **Step 4: Commit**

```bash
git add crates/token-dashboard-cli/{src/lib.rs,src/snapshot.rs,Cargo.toml}
git commit -m "feat(sync): host-side snapshot endpoint"
```

---

### Task 2: Viewer-side remote source + merge

**Files:**
- Modify: `crates/token-dashboard-core/src/sources.rs`
- Create: `crates/token-dashboard-core/src/remote_sync.rs`
- Modify: `crates/token-dashboard-core/src/lib.rs`

- [x] **Step 1: Extend Sources**

In `sources.rs`, find the `Source` enum (or struct). Add fields:

```rust
pub struct Source {
    pub id: String,
    pub kind: SourceKind, // Local { path: PathBuf } | Remote { base_url, bearer_token }
    pub enabled: bool,
    pub last_sync_ts: Option<String>, // ISO timestamp of last merge cursor
}
```

(Adapt to existing shape.)

- [x] **Step 2: Pull + merge**

In `remote_sync.rs`:

```rust
use rusqlite::Connection;

pub async fn pull_and_merge(conn: &Connection, base_url: &str, token: &str, since: Option<&str>) -> anyhow::Result<MergeStats> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()?;
    let mut req = client.get(format!("{}/api/sync/snapshot", base_url.trim_end_matches('/')))
        .bearer_auth(token);
    if let Some(s) = since { req = req.query(&[("since", s)]); }
    let body: serde_json::Value = req.send().await?.error_for_status()?.json().await?;
    merge(conn, &body)
}

#[derive(Debug, Default)]
pub struct MergeStats { pub messages_inserted: usize, pub tool_calls_inserted: usize, pub latest_ts: Option<String> }

fn merge(conn: &Connection, body: &serde_json::Value) -> anyhow::Result<MergeStats> {
    let tx = conn.unchecked_transaction()?;
    let mut stats = MergeStats::default();

    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for msg in messages {
            // Dedup: (session_id, message_id) — use INSERT OR IGNORE on the same uniqueness the scanner relies on.
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO messages \
                 (uuid, session_id, message_id, project_slug, type, timestamp, model, \
                  input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, cache_create_1h_tokens, \
                  is_sidechain, agent_id, parent_uuid, prompt_chars) \
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rusqlite::params![
                    msg["uuid"].as_str(), msg["session_id"].as_str(), msg["message_id"].as_str(),
                    msg["project_slug"].as_str(), msg["type"].as_str(), msg["timestamp"].as_str(),
                    msg["model"].as_str(),
                    msg["input_tokens"].as_u64().unwrap_or(0) as i64,
                    msg["output_tokens"].as_u64().unwrap_or(0) as i64,
                    msg["cache_read_tokens"].as_u64().unwrap_or(0) as i64,
                    msg["cache_create_5m_tokens"].as_u64().unwrap_or(0) as i64,
                    msg["cache_create_1h_tokens"].as_u64().unwrap_or(0) as i64,
                    msg["is_sidechain"].as_u64().unwrap_or(0) as i64,
                    msg["agent_id"].as_str(), msg["parent_uuid"].as_str(),
                    msg["prompt_chars"].as_u64().map(|v| v as i64),
                ],
            )?;
            stats.messages_inserted += inserted;
            if let Some(ts) = msg["timestamp"].as_str() {
                if stats.latest_ts.as_deref().map_or(true, |cur| ts > cur) {
                    stats.latest_ts = Some(ts.to_string());
                }
            }
        }
    }
    if let Some(tcs) = body.get("tool_calls").and_then(|m| m.as_array()) {
        for tc in tcs {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO tool_calls (message_uuid, tool_name, target, use_id, result_tokens, is_error, timestamp) \
                 VALUES (?,?,?,?,?,?,?)",
                rusqlite::params![
                    tc["message_uuid"].as_str(), tc["tool_name"].as_str(), tc["target"].as_str(),
                    tc["use_id"].as_str(), tc["result_tokens"].as_u64().unwrap_or(0) as i64,
                    tc["is_error"].as_u64().unwrap_or(0) as i64, tc["timestamp"].as_str(),
                ],
            )?;
            stats.tool_calls_inserted += inserted;
        }
    }
    tx.commit()?;
    Ok(stats)
}
```

The `INSERT OR IGNORE` requires that the `messages` table has a UNIQUE constraint over `(session_id, message_id)`. Check the existing schema and add this constraint via a new migration if absent.

- [x] **Step 3: Failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    #[test]
    fn merge_inserts_new_and_dedups_existing() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrate(&c).unwrap();
        let body = serde_json::json!({
            "messages": [{
                "uuid":"u1","session_id":"s","message_id":"m1","project_slug":"p","type":"assistant",
                "timestamp":"2026-05-20T10:00:00Z","model":"x","input_tokens":1,"output_tokens":2,
                "cache_read_tokens":0,"cache_create_5m_tokens":0,"cache_create_1h_tokens":0,
                "is_sidechain":0
            }],
            "tool_calls":[]
        });
        let s1 = merge(&c, &body).unwrap();
        assert_eq!(s1.messages_inserted, 1);
        let s2 = merge(&c, &body).unwrap();
        assert_eq!(s2.messages_inserted, 0, "second merge should dedup");
    }
}
```

Run: `cargo test -p token-dashboard-core remote_sync` → expect PASS after migration is in place.

- [x] **Step 4: Commit**

```bash
git add crates/token-dashboard-core/src/{lib,remote_sync,sources,db}.rs
git commit -m "feat(sync): viewer-side pull + merge"
```

---

### Task 3: Settings UI + scheduled pull

**Files:**
- Modify: `frontend/src/routes/settings/sources-card.jsx`
- Modify: `crates/token-dashboard-tauri/src/main.rs`

- [x] **Step 1: UI form**

Inside `sources-card.jsx`, add fields for remote sources:

```jsx
function AddRemote({ onAdd }) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  return (
    <div className="a-card">
      <input placeholder="https://other-machine:8080" value={url} onChange={e=>setUrl(e.target.value)} />
      <input placeholder="bearer token" type="password" value={token} onChange={e=>setToken(e.target.value)} />
      <button onClick={() => onAdd({ kind: 'remote', base_url: url, bearer_token: token })}>Add</button>
    </div>
  );
}
```

Hook into the existing `/api/sources/add` route (extend its payload to accept `kind: "remote"`).

- [x] **Step 2: Schedule sync**

In the Tauri shell's post-scan hook, iterate enabled remote sources and call `remote_sync::pull_and_merge`. Use `tokio::spawn` so the UI does not block.

- [x] **Step 3: Manual test**

Run two instances on the same machine on different ports, configure one as a remote source of the other, confirm rows appear after a scan.

- [x] **Step 4: Commit**

```bash
git add frontend/src/routes/settings/sources-card.jsx crates/token-dashboard-tauri/src/main.rs
git commit -m "feat(sync): UI + scheduled remote pull"
```

---

## Self-Review Notes

- The Bearer token lives in the OS keyring (use `keyring` crate) — never in plaintext config. If the keyring crate isn't yet wired, store under `.claude/token-dashboard-secrets.json` with 0600 perms and document the upgrade.
- This plan does **not** push from viewer to host. One-direction only. Bidirectional sync raises conflict-resolution questions we don't need to solve yet.
- For users behind NAT, document the Tailscale/SSH-tunnel workaround in README.
