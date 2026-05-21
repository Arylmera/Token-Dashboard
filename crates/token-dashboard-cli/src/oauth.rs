#![allow(unused_imports)]
// Auto-split from lib.rs during Phase 3 refactor.
#![allow(clippy::module_inception)]

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json,
    },
    routing::{get, post},
    Router,
};
use futures::stream::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use token_dashboard_core::sources as src;
use token_dashboard_core::tips::{all_tips, Tip};
use token_dashboard_core::{
    compute_limits, cost_for,
    limits::LimitsSnapshot,
    list_sources, preferences,
    queries::{
        add_session_tag, all_tags, daily_token_breakdown, dismiss_tip, expensive_prompts,
        first_prompts, get_plan, hourly_breakdown, model_breakdown, normalise_tag, overview_totals,
        phase_split, project_summary, recent_sessions, remove_session_tag, session_model_usage,
        session_tags, session_turns, set_plan, skill_breakdown, tag_aggregates, tag_session_counts,
        tool_token_breakdown, DailyRow, ExpensivePromptRow, ModelRow, OverviewTotals, ProjectRow,
        SessionRow, SessionTurn, SkillRow, TagRow, ToolRow,
    },
    scan_dir, Pricing, ScanStats, Source, Usage,
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::errors::{blocking, blocking_unit, ApiError};
use crate::routes::LimitsSyncResponse;
use crate::state::{AppState, RangeQs};
use crate::util::{
    clamp_limit, current_iso_z, days_to_ymd, deserialize_double_option, pragma_columns,
    pragma_columns_attached, push_csv_row, round4, round6, tempfile_path, unix_compact_stamp,
    MAX_UPLOAD_BYTES,
};

pub(crate) async fn limits_sync_oauth(
    State(s): State<AppState>,
) -> Result<Json<LimitsSyncResponse>, ApiError> {
    let outcome = run_oauth_sync(s.db_path.clone(), s.events.clone())
        .await
        .map_err(|e| match e {
            OAuthSyncError::Credential(msg) => ApiError::bad_request(msg),
            OAuthSyncError::Persist(e) => ApiError::internal(format!("persist: {e}")),
            OAuthSyncError::Join(e) => ApiError::internal(format!("join: {e}")),
        })?;
    Ok(Json(outcome.response))
}

#[derive(Serialize)]
pub(crate) struct OAuthStatusResponse {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
}

/// Cheap probe used by the Settings card to decide whether the limits
/// toggle should be offered. Reads the Claude Code credential blob; on
/// macOS this can prompt the Keychain the first time, so we only call
/// it from Settings (not from the dashboard's static reload path).
/// Never returns the token — only whether it could be read.
pub(crate) async fn limits_oauth_status() -> Json<OAuthStatusResponse> {
    // `has_usable_oauth` checks for either a fresh access token OR a
    // refresh token we could use — so an expired-but-refreshable
    // login still reports as available. The probe stays cheap (no
    // network call) because the actual refresh happens lazily inside
    // the sync path.
    let result =
        tokio::task::spawn_blocking(token_dashboard_core::credentials::has_usable_oauth).await;
    let resp = match result {
        Ok(Ok(true)) => OAuthStatusResponse {
            available: true,
            reason: None,
        },
        Ok(Ok(false)) => OAuthStatusResponse {
            available: false,
            reason: Some("no refresh token in credential store — run `claude` to log in".into()),
        },
        Ok(Err(e)) => OAuthStatusResponse {
            available: false,
            reason: Some(e.user_message()),
        },
        Err(e) => OAuthStatusResponse {
            available: false,
            reason: Some(format!("join: {e}")),
        },
    };
    Json(resp)
}

#[derive(Debug)]
pub(crate) enum OAuthSyncError {
    Credential(String),
    Persist(String),
    Join(String),
}

pub(crate) struct OAuthSyncOutcome {
    pub(crate) response: LimitsSyncResponse,
}

/// Shared OAuth-sync pipeline used by both the `/api/limits/sync_oauth`
/// route and the activity-triggered scanner hook. Reads the credential,
/// hits Anthropic, persists the snapshot, and broadcasts a
/// `limits_refreshed` SSE event on success so the frontend can refetch
/// the Overview card without waiting for the next scan tick.
pub(crate) async fn run_oauth_sync(
    db_path: std::sync::Arc<std::path::PathBuf>,
    events: tokio::sync::broadcast::Sender<serde_json::Value>,
) -> Result<OAuthSyncOutcome, OAuthSyncError> {
    let token_result =
        tokio::task::spawn_blocking(token_dashboard_core::credentials::read_oauth_token)
            .await
            .map_err(|e| OAuthSyncError::Join(e.to_string()))?;
    let token = token_result.map_err(|e| OAuthSyncError::Credential(e.user_message()))?;

    let result = tokio::task::spawn_blocking(move || {
        token_dashboard_core::anthropic_sync::sync_limits_oauth(&token)
    })
    .await
    .map_err(|e| OAuthSyncError::Join(e.to_string()))?;

    let path = db_path.clone();
    let now_iso = current_iso_z();
    let status_clone = result.status.clone();
    let persisted = status_clone == "ok";
    let response = tokio::task::spawn_blocking(move || -> rusqlite::Result<LimitsSyncResponse> {
        let p = path.as_ref();
        let conn = rusqlite::Connection::open(p)?;
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_last_sync_at', ?)",
            [&now_iso],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO plan (k, v) VALUES ('limits_last_sync_status', ?)",
            [&status_clone],
        )?;
        if persisted {
            preferences::set_limits_server_snapshot(
                p,
                &preferences::LimitsServerSnapshot {
                    five_hour_utilization: result.five_hour_utilization,
                    five_hour_status: result.five_hour_status.clone(),
                    weekly_utilization: result.weekly_utilization,
                    weekly_status: result.weekly_status.clone(),
                    synced_at: Some(now_iso.clone()),
                },
            )?;
            // Mirror None: a missing reset header must clear any prior
            // (now-stale) timestamp, otherwise the dashboard keeps
            // counting down to a window that has already elapsed.
            preferences::set_limit_reset_at(
                p,
                "limits_five_hour_reset_at",
                result.five_hour_reset_at.as_deref(),
            )?;
            preferences::set_limit_reset_at(
                p,
                "limits_weekly_reset_at",
                result.weekly_reset_at.as_deref(),
            )?;
        }
        let meta = preferences::get_limits_sync_meta(p)?;
        Ok(LimitsSyncResponse {
            status: status_clone,
            limits_five_hour_reset_at: preferences::get_limit_reset_at(
                p,
                "limits_five_hour_reset_at",
            )?,
            limits_weekly_reset_at: preferences::get_limit_reset_at(p, "limits_weekly_reset_at")?,
            limits_last_sync_at: meta.last_sync_at,
            limits_last_sync_status: meta.last_sync_status,
        })
    })
    .await
    .map_err(|e| OAuthSyncError::Join(e.to_string()))?
    .map_err(|e| OAuthSyncError::Persist(e.to_string()))?;

    if persisted {
        let _ = events.send(serde_json::json!({
            "type": "limits_refreshed",
            "source": "oauth",
        }));
    }

    Ok(OAuthSyncOutcome { response })
}

/// Activity-triggered throttle: aligned with the 10s scan tick so an
/// active prompt-cycle yields one fresh sync per response — Claude
/// Code rarely emits more than one message group in a 10s window,
/// and chatty bursts cost a few extra Haiku tokens off the user's
/// own quota (negligible).
pub(crate) const ACTIVITY_SYNC_THROTTLE_SECONDS: i64 = 10;

/// Startup-refresh threshold: at app launch, if the last successful
/// snapshot is older than this — or there's no snapshot — fire one
/// sync so the Overview shows current values without waiting for the
/// next activity tick.
pub(crate) const STARTUP_SYNC_STALE_SECONDS: i64 = 300;

/// Single source of truth for "should we run an OAuth limits sync right
/// now?" — returns false when the user isn't on the OAuth source, true
/// when there's no successful snapshot yet, otherwise compares the last
/// snapshot's `synced_at` to `threshold_secs`. Uses SQLite's `datetime()`
/// so callers don't need a Rust ISO parser, and reads the *snapshot's*
/// timestamp (not `last_sync_at`) so failed attempts don't suppress the
/// next retry.
pub(crate) fn oauth_sync_due(db: &std::path::Path, threshold_secs: i64) -> rusqlite::Result<bool> {
    if preferences::get_limits_source(db)? != "oauth" {
        return Ok(false);
    }
    let snap = preferences::get_limits_server_snapshot(db)?;
    let Some(synced) = snap.synced_at.as_deref() else {
        return Ok(true);
    };
    let conn = rusqlite::Connection::open(db)?;
    let stale: i64 = conn.query_row(
        "SELECT CASE WHEN datetime(?) <= datetime('now', ?) THEN 1 ELSE 0 END",
        rusqlite::params![synced, format!("-{threshold_secs} seconds")],
        |r| r.get(0),
    )?;
    Ok(stale == 1)
}

/// Run `run_oauth_sync` only when `oauth_sync_due` says yes. Failures
/// are swallowed (logged at debug) — the user will see the stale
/// "synced X min ago" timestamp and can sync manually to get the
/// explicit error. `label` shows up in the failure log line.
pub(crate) async fn run_oauth_sync_if_due(
    state: AppState,
    threshold_secs: i64,
    label: &'static str,
) {
    let path = state.db_path.clone();
    let gate =
        tokio::task::spawn_blocking(move || oauth_sync_due(path.as_ref(), threshold_secs)).await;
    if !matches!(gate, Ok(Ok(true))) {
        return;
    }
    if let Err(e) = run_oauth_sync(state.db_path, state.events).await {
        tracing::debug!(?e, "{label} oauth sync failed (background)");
    }
}

/// Activity-triggered sync hook. Called by `run_scan_and_broadcast`
/// after a successful scan; only meaningful when the scan ingested new
/// messages (otherwise we'd burn Haiku tokens on an idle dashboard).
pub(crate) async fn maybe_activity_oauth_sync(state: AppState, stats: ScanStats) {
    if stats.messages == 0 {
        return;
    }
    run_oauth_sync_if_due(state, ACTIVITY_SYNC_THROTTLE_SECONDS, "activity-triggered").await;
}

/// Spawn a one-shot OAuth sync at app startup. Skipped silently when
/// the source isn't OAuth or the snapshot is fresh enough, so users on
/// the manual path pay nothing.
pub fn spawn_startup_oauth_sync(state: AppState) {
    tokio::spawn(async move {
        run_oauth_sync_if_due(state, STARTUP_SYNC_STALE_SECONDS, "startup").await;
    });
}
