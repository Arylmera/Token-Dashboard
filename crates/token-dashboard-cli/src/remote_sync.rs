//! Viewer-side remote-source pull driver.
//!
//! Lives in the cli crate because it owns the HTTP call (ureq) and the
//! tokio scheduler that fans out every `interval` to all enabled remote
//! sources. The core crate just defines the snapshot wire format and
//! the rusqlite merge.
//!
//! The network call here is between two user-owned machines (laptop ↔
//! desktop) — no telemetry, no third-party endpoint. The token sent
//! over `Authorization: Bearer …` round-trips only to the host the user
//! configured. See `docs/todo/11-multi-machine-sync.md`.

use std::path::Path;
use std::time::Duration;

use token_dashboard_core::remote_sources;
use token_dashboard_core::sync_snapshot::{merge, MergeStats, Snapshot};

use crate::state::AppState;

/// Pull a single remote source (by id) and merge its snapshot into the
/// local DB. Stamps `last_sync_at` / `last_error` on the row either
/// way so the settings UI can render "ok" / error chips.
///
/// Returns `Ok(MergeStats)` on success. The `String` error mirrors the
/// inner ureq message so callers (route handler, scheduler) can surface
/// it verbatim.
pub fn pull_remote_once(db: &Path, id: i64) -> Result<MergeStats, String> {
    let row = remote_sources::get_with_bearer(db, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown remote source".to_string())?;
    if !row.enabled {
        return Err("remote source disabled".to_string());
    }
    let url = format!("{}/api/sync/snapshot", row.base_url.trim_end_matches('/'));
    let mut req = ureq::get(&url).timeout(Duration::from_secs(60));
    if let Some(bearer) = row.bearer.as_deref() {
        req = req.set("Authorization", &format!("Bearer {}", bearer));
    }
    let snap: Snapshot = match req.call() {
        Ok(resp) => resp.into_json().map_err(|e| e.to_string())?,
        Err(e) => {
            let msg = e.to_string();
            let _ = remote_sources::stamp_sync(db, id, Some(&msg));
            return Err(msg);
        }
    };
    let stats = merge(db, &snap).map_err(|e| e.to_string())?;
    let _ = remote_sources::stamp_sync(db, id, None);
    Ok(stats)
}

/// Pull every enabled remote source once. Errors on individual sources
/// are stamped into the `remote_sources` table by `pull_remote_once`
/// and **not** propagated — one flaky host must not abort the rest of
/// the fan-out.
pub fn pull_all_enabled(db: &Path) -> Vec<(i64, Result<MergeStats, String>)> {
    let rows = match remote_sources::list(db) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "remote_sources list failed");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for row in rows {
        if !row.enabled {
            continue;
        }
        let res = pull_remote_once(db, row.id);
        if let Err(ref msg) = res {
            tracing::warn!(remote_id = row.id, label = %row.label, error = %msg, "remote pull failed");
        }
        out.push((row.id, res));
    }
    out
}

/// Spawn a tokio task that calls [`pull_all_enabled`] every `interval`
/// and broadcasts a `remote_sync_complete` SSE event when at least one
/// row was inserted, so the frontend can refresh its panels the same
/// way it reacts to a local scan.
///
/// Skips the first tick — the periodic loop is a follow-up to the
/// manual "Sync now" button and the initial frontend load, not a
/// startup pull.
pub fn spawn_remote_sync_loop(state: AppState, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let db = state.db_path.clone();
            let events = state.events.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let results = pull_all_enabled(db.as_ref());
                let mut inserted_msgs = 0usize;
                let mut inserted_tcs = 0usize;
                let mut errors = 0usize;
                for (_id, res) in &results {
                    match res {
                        Ok(stats) => {
                            inserted_msgs += stats.messages_inserted;
                            inserted_tcs += stats.tool_calls_inserted;
                        }
                        Err(_) => errors += 1,
                    }
                }
                if inserted_msgs + inserted_tcs > 0 || errors > 0 {
                    let _ = events.send(serde_json::json!({
                        "type": "remote_sync_complete",
                        "messages_inserted": inserted_msgs,
                        "tool_calls_inserted": inserted_tcs,
                        "errors": errors,
                    }));
                }
            })
            .await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tempfile::TempDir;
    use token_dashboard_core::init_db;

    fn fresh_db() -> (TempDir, std::path::PathBuf) {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("t.db");
        init_db(&db).unwrap();
        (tmp, db)
    }

    fn seed_msg(db: &Path, uuid: &str, ts: &str) {
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute(
            "INSERT INTO messages (uuid, session_id, project_slug, type, timestamp, \
              input_tokens, output_tokens, cache_read_tokens, cache_create_5m_tokens, \
              cache_create_1h_tokens) VALUES (?1, 's-host', 'p', 'assistant', ?2, 0, 100, 0, 0, 0)",
            params![uuid, ts],
        )
        .unwrap();
    }

    /// Stand up the cli `app()` on a real loopback port, register it
    /// as a remote source on a separate viewer DB, then exercise
    /// `pull_remote_once` end-to-end. Validates auth + merge.
    #[tokio::test]
    async fn pull_remote_once_round_trips() {
        // Host
        let (_host_tmp, host_db) = fresh_db();
        seed_msg(&host_db, "h-1", "2026-05-22T10:00:00Z");
        // SAFETY: tests run single-threaded by default for env mutation;
        // worst case a sibling test races and gets 401, which is fine.
        // The route reads this var lazily on every request.
        // SAFETY note: env mutation; isolate via a unique key per test? The
        // route hard-codes TOKEN_DASHBOARD_SYNC_TOKEN so we accept the
        // race risk. See README.
        std::env::set_var("TOKEN_DASHBOARD_SYNC_TOKEN", "test-token");

        let state = AppState::new(
            host_db.clone(),
            token_dashboard_core::Pricing::embedded(),
            host_db.parent().unwrap().to_path_buf(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host_addr: SocketAddr = listener.local_addr().unwrap();
        let host_url = format!("http://{}", host_addr);
        let app = crate::routes::app(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        // Viewer
        let (_view_tmp, view_db) = fresh_db();
        let row = remote_sources::add(&view_db, "host-under-test", &host_url, Some("test-token"))
            .unwrap();
        let stats = tokio::task::spawn_blocking({
            let view_db = view_db.clone();
            move || pull_remote_once(&view_db, row.id)
        })
        .await
        .unwrap()
        .expect("pull ok");
        assert_eq!(stats.messages_inserted, 1, "host's row imported");

        // Idempotent second pull
        let stats2 = tokio::task::spawn_blocking({
            let view_db = view_db.clone();
            move || pull_remote_once(&view_db, row.id)
        })
        .await
        .unwrap()
        .expect("pull ok");
        assert_eq!(stats2.messages_inserted, 0, "re-pull dedups");

        // Wrong bearer fails and stamps last_error.
        let bad = remote_sources::add(&view_db, "wrong", &host_url, Some("nope")).unwrap();
        let err = tokio::task::spawn_blocking({
            let view_db = view_db.clone();
            move || pull_remote_once(&view_db, bad.id)
        })
        .await
        .unwrap()
        .unwrap_err();
        assert!(
            err.contains("401") || err.to_lowercase().contains("unauthor"),
            "expected 401, got: {err}"
        );
        let stamped = remote_sources::get(&view_db, bad.id).unwrap().unwrap();
        assert!(stamped.last_error.is_some(), "error must be stamped");

        std::env::remove_var("TOKEN_DASHBOARD_SYNC_TOKEN");
        let _ = Arc::new(()); // suppress unused warning if added later
    }

    /// `pull_all_enabled` aggregates every enabled source. A disabled
    /// row is skipped, a broken url stamps an error without taking
    /// down the loop.
    #[tokio::test]
    async fn pull_all_enabled_fans_out_and_isolates_errors() {
        let (_view_tmp, view_db) = fresh_db();
        // Bad url — connection refused
        let bad = remote_sources::add(&view_db, "down", "http://127.0.0.1:1", Some("t")).unwrap();
        // Disabled row — must be skipped
        let disabled =
            remote_sources::add(&view_db, "off", "http://127.0.0.1:2", Some("t")).unwrap();
        remote_sources::set_enabled(&view_db, disabled.id, false).unwrap();

        let results = tokio::task::spawn_blocking({
            let view_db = view_db.clone();
            move || pull_all_enabled(&view_db)
        })
        .await
        .unwrap();
        assert_eq!(results.len(), 1, "disabled row skipped");
        assert_eq!(results[0].0, bad.id);
        assert!(results[0].1.is_err(), "bad url errored");
    }
}
