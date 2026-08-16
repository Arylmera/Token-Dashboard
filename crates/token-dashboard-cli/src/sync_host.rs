//! "Share this machine" — host side of the multi-machine sync, GUI path.
//!
//! The main embedded server stays loopback-only. When the user enables
//! sharing in Settings, we bind a SECOND listener on `0.0.0.0:<port>`
//! whose router exposes exactly one route: `/api/sync/snapshot`
//! (bearer-gated). Nothing else from the /api surface is reachable from
//! the LAN. Disabling the toggle aborts the listener task.
//!
//! The headless CLI's `HOST=0.0.0.0` + `TOKEN_DASHBOARD_SYNC_TOKEN`
//! path is unchanged and accepted in parallel — see
//! `routes::sync_snapshot_handler` for the token dispatch.

use axum::routing::get;
use axum::Router;
use token_dashboard_core::preferences;

use crate::routes::sync_snapshot_handler;
use crate::state::AppState;

/// Re-read the share preference and reconcile the listener: abort any
/// running one, then bind a fresh one when enabled. Returns the bound
/// port when sharing is active, `None` when disabled. `Err` carries a
/// user-facing message (missing token, bind failure).
pub async fn apply_share_config(state: &AppState) -> Result<Option<u16>, String> {
    let db = state.db_path.clone();
    let (enabled, port, token) = tokio::task::spawn_blocking(move || {
        let enabled = preferences::get_sync_share_enabled(db.as_ref())?;
        let port = preferences::get_sync_share_port(db.as_ref())?;
        let token = preferences::get_sync_share_token(db.as_ref())?;
        Ok::<_, rusqlite::Error>((enabled, port, token))
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("db: {e}"))?;

    let mut guard = state.share.lock().await;
    if let Some(handle) = guard.take() {
        handle.abort();
    }
    if !enabled {
        return Ok(None);
    }
    if token.is_none() {
        return Err("a token is required to share this machine".into());
    }
    let port = u16::try_from(port).map_err(|_| format!("invalid port {port}"))?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .map_err(|e| format!("bind 0.0.0.0:{port}: {e}"))?;
    let router = Router::new()
        .route("/api/sync/snapshot", get(sync_snapshot_handler))
        .with_state(state.clone());
    *guard = Some(tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::warn!(error = %e, "share listener stopped");
        }
    }));
    tracing::info!(port, "sharing this machine on 0.0.0.0");
    Ok(Some(port))
}

/// Fire-and-forget startup reconcile: bind the share listener when the
/// preference was left enabled. Bind errors are logged, not fatal — the
/// Settings card surfaces the state on next open.
pub fn spawn_share_if_enabled(state: AppState) {
    tokio::spawn(async move {
        if let Err(e) = apply_share_config(&state).await {
            tracing::warn!(error = %e, "share listener not started");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use token_dashboard_core::{init_db, Pricing};

    fn fresh_state() -> (TempDir, AppState) {
        let tmp = TempDir::new().unwrap();
        let db = tmp.path().join("t.db");
        init_db(&db).unwrap();
        let state = AppState::new(db.clone(), Pricing::embedded(), tmp.path().to_path_buf());
        (tmp, state)
    }

    /// Enable sharing on a free port, then hit the share listener from
    /// outside with the stored token: only the snapshot route exists,
    /// auth is enforced, and disabling tears the listener down.
    #[tokio::test]
    async fn share_listener_serves_snapshot_only() {
        let (_tmp, state) = fresh_state();
        let db = state.db_path.clone();

        // Disabled → no listener.
        assert_eq!(apply_share_config(&state).await.unwrap(), None);

        // Enabled without token → error.
        preferences::set_sync_share_enabled(db.as_ref(), true).unwrap();
        // Pick a free port by binding :0 first, then releasing it.
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        preferences::set_sync_share_port(db.as_ref(), port as i64).unwrap();
        assert!(apply_share_config(&state).await.is_err(), "token required");

        preferences::set_sync_share_token(db.as_ref(), Some("share-tok")).unwrap();
        assert_eq!(apply_share_config(&state).await.unwrap(), Some(port));

        fn status_of(res: Result<ureq::Response, ureq::Error>) -> u16 {
            match res {
                Ok(r) => r.status(),
                Err(ureq::Error::Status(code, _)) => code,
                Err(e) => panic!("transport error: {e}"),
            }
        }
        let base = format!("http://127.0.0.1:{port}");
        let (snap, unauth, hidden) = tokio::task::spawn_blocking({
            let base = base.clone();
            move || {
                let snap = ureq::get(&format!("{base}/api/sync/snapshot"))
                    .set("Authorization", "Bearer share-tok")
                    .call()
                    .expect("authorized snapshot")
                    .into_json::<serde_json::Value>()
                    .unwrap();
                let unauth = status_of(
                    ureq::get(&format!("{base}/api/sync/snapshot"))
                        .set("Authorization", "Bearer wrong")
                        .call(),
                );
                let hidden = status_of(ureq::get(&format!("{base}/api/overview")).call());
                (snap, unauth, hidden)
            }
        })
        .await
        .unwrap();
        assert!(snap.get("messages").is_some(), "snapshot shape");
        assert_eq!(unauth, 401, "wrong token must 401");
        assert_eq!(hidden, 404, "rest of /api must not be exposed");

        // Disable → listener gone.
        preferences::set_sync_share_enabled(db.as_ref(), false).unwrap();
        assert_eq!(apply_share_config(&state).await.unwrap(), None);
        let refused = tokio::task::spawn_blocking(move || {
            ureq::get(&format!("{base}/api/sync/snapshot"))
                .set("Authorization", "Bearer share-tok")
                .timeout(std::time::Duration::from_secs(5))
                .call()
                .is_err()
        })
        .await
        .unwrap();
        assert!(refused, "listener must be down after disable");
    }
}
