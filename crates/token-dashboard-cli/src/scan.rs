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
use crate::state::{AppState, RangeQs};
use crate::util::{
    clamp_limit, current_iso_z, days_to_ymd, deserialize_double_option, pragma_columns,
    pragma_columns_attached, push_csv_row, round4, round6, tempfile_path, unix_compact_stamp,
    MAX_UPLOAD_BYTES,
};

use crate::oauth::maybe_activity_oauth_sync;

#[derive(Serialize)]
pub(crate) struct ScanResponse {
    pub(crate) messages: u64,
    pub(crate) tools: u64,
    pub(crate) files: u64,
    pub(crate) sessions: Vec<String>,
    pub(crate) projects: Vec<String>,
    pub(crate) days: Vec<String>,
    pub(crate) models: Vec<String>,
    pub(crate) min_ts: Option<String>,
    pub(crate) max_ts: Option<String>,
}

impl From<ScanStats> for ScanResponse {
    fn from(s: ScanStats) -> Self {
        Self {
            messages: s.messages,
            tools: s.tools,
            files: s.files,
            sessions: s.sessions,
            projects: s.projects,
            days: s.days,
            models: s.models,
            min_ts: s.min_ts,
            max_ts: s.max_ts,
        }
    }
}

pub(crate) async fn scan(State(s): State<AppState>) -> Result<Json<ScanResponse>, ApiError> {
    let stats = run_scan_and_broadcast(s)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(stats.into()))
}

/// Track whether scanning is healthy and publish the transitions, so a
/// failing scan reaches the user instead of only the log. Scans are
/// unattended: without this the dashboard keeps serving whatever it
/// ingested last, looking merely quiet rather than broken. Only edges
/// are published (`message` set on breakage, `null` on recovery) — a
/// scan that keeps failing every tick shouldn't spam the bus.
async fn publish_scan_health(
    s: &AppState,
    outcome: Result<ScanStats, String>,
) -> Result<ScanStats, String> {
    let mut last = s.scan_error.lock().await;
    match &outcome {
        Ok(_) => {
            if last.take().is_some() {
                let _ = s
                    .events
                    .send(serde_json::json!({"type": "scan_error", "message": null}));
            }
        }
        Err(e) => {
            if last.as_deref() != Some(e.as_str()) {
                *last = Some(e.clone());
                let _ = s
                    .events
                    .send(serde_json::json!({"type": "scan_error", "message": e}));
            }
        }
    }
    outcome
}

/// Run `scan_dir` once and publish a `scan_complete` SSE event with the
/// rich hint (sessions/projects/days/models) the frontend dispatcher
/// uses to decide which endpoints to refetch. Shared between the
/// `/api/scan` route and the periodic background loop so both code paths
/// emit identical events.
pub(crate) async fn run_scan_and_broadcast(s: AppState) -> Result<ScanStats, String> {
    let db = s.db_path.clone();
    let proj = s.projects_dir.clone();
    let lock = s.scan_lock.clone();
    let outcome = {
        // One scan at a time, whichever path asked for it.
        let _guard = lock.lock().await;
        tokio::task::spawn_blocking(move || scan_dir(proj.as_ref(), db.as_ref()))
            .await
            .map_err(|e| format!("join: {e}"))
            .and_then(|r| r.map_err(|e| format!("scan: {e}")))
    };
    let stats = publish_scan_health(&s, outcome).await?;
    // Only announce when the scan actually ingested rows. The background
    // loop ticks every 10s; emitting unconditionally made every connected
    // frontend refetch its entire endpoint registry every tick even when the
    // user generated no new transcripts. SSE liveness is held up by the
    // server's 15s keep-alive ping (see sse.rs), not this event, and when
    // idle neither usage nor limits change (countdowns tick client-side), so
    // skipping the refetch is safe. Best-effort: failure means no listeners.
    if stats.messages > 0 || stats.tools > 0 {
        let _ = s.events.send(serde_json::json!({
            "type": "scan_complete",
            "messages": stats.messages,
            "tools": stats.tools,
            "files": stats.files,
            "sessions": stats.sessions,
            "projects": stats.projects,
            "days": stats.days,
            "models": stats.models,
        }));
    }
    // Best-effort budget-threshold check. Failure must not abort the scan path.
    // `check` persists the fired state internally so subsequent calls won't re-fire
    // already-crossed thresholds within the same month.
    if let Ok(result) = token_dashboard_core::budget_alerts::check(s.db_path.as_ref()) {
        if !result.newly_crossed.is_empty() {
            let _ = s.events.send(serde_json::json!({
                "type": "budget_alert",
                "window": "monthly",
                "mtd_cost_usd": result.mtd_cost_usd,
                "monthly_budget_usd": result.monthly_budget_usd,
                "percent": result.percent,
                "newly_crossed": result.newly_crossed,
                "month": result.month,
            }));
        }
        if !result.newly_crossed_weekly.is_empty() {
            let _ = s.events.send(serde_json::json!({
                "type": "budget_alert",
                "window": "weekly",
                "plan": result.plan,
                "percent": result.weekly_percent,
                "resets_at": result.weekly_resets_at,
                "newly_crossed": result.newly_crossed_weekly,
            }));
        }
        if !result.newly_crossed_5h.is_empty() {
            let _ = s.events.send(serde_json::json!({
                "type": "budget_alert",
                "window": "five_hour",
                "plan": result.plan,
                "percent": result.five_hour_percent,
                "resets_at": result.five_hour_resets_at,
                "newly_crossed": result.newly_crossed_5h,
            }));
        }
    }
    // When the OAuth limits source is active, piggy-back on the
    // activity signal from the scan to refresh the rate-limit headers
    // — but throttle so a chatty session doesn't burn a Haiku token
    // per message. Runs detached; failures stay quiet (see helper).
    let stats_for_hook = stats.clone();
    let state_for_hook = s.clone();
    tokio::spawn(async move {
        maybe_activity_oauth_sync(state_for_hook, stats_for_hook).await;
    });
    Ok(stats)
}

/// Run one scan at startup, before anything can serve `/api/*`.
/// Without it the first frontend load reads a database that stops at
/// the previous run's last scan — the dashboard opens on $0 and only
/// self-corrects on the next scan that ingests rows (which never comes
/// while the user is idle, since `run_scan_and_broadcast` stays silent
/// on an empty delta).
///
/// Waited on rather than spawned, so the initial fetch can't win the
/// race — but only up to `budget`. A warm database finishes in well
/// under a second; a cold one (first launch, months of transcripts) can
/// take minutes, and holding the window back that long is worse than
/// the stale numbers this fixes. On timeout the scan keeps running and
/// its `scan_complete` refreshes the page in place.
pub async fn scan_once(state: AppState, budget: Duration) {
    let task = tokio::spawn(async move {
        if let Err(e) = run_scan_and_broadcast(state).await {
            tracing::warn!(error = %e, "startup scan failed");
        }
    });
    // `timeout` drops its own future only — the spawned task runs on.
    if tokio::time::timeout(budget, task).await.is_err() {
        tracing::info!("startup scan exceeded its budget; continuing in background");
    }
}

/// Spawn a tokio task that runs `scan_dir` every `interval` and
/// broadcasts the result so both the embedded backend and any connected
/// frontend stay live without manual refresh. Both binaries (headless
/// cli and tauri shell) call this once at startup.
pub fn spawn_scan_loop(state: AppState, interval: Duration) {
    tokio::spawn(async move {
        // First tick fires immediately — skip it so we don't race the
        // initial frontend load that already triggers a fetch.
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = run_scan_and_broadcast(state.clone()).await {
                tracing::warn!(error = %e, "background scan failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use token_dashboard_core::Pricing;

    fn state() -> AppState {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = tmp.path().join("t.db");
        token_dashboard_core::init_db(&db).unwrap();
        AppState::new(db, Pricing::embedded(), tmp.path().to_path_buf())
    }

    /// Only edges reach the bus: first failure, then recovery. A scan
    /// that keeps failing must not republish on every tick.
    #[tokio::test]
    async fn scan_health_publishes_edges_only() {
        let s = state();
        let mut rx = s.events.subscribe();

        let _ = publish_scan_health(&s, Err("scan: disk on fire".into())).await;
        let ev = rx.try_recv().expect("failure announced");
        assert_eq!(ev["type"], "scan_error");
        assert_eq!(ev["message"], "scan: disk on fire");

        let _ = publish_scan_health(&s, Err("scan: disk on fire".into())).await;
        assert!(rx.try_recv().is_err(), "same failure must stay quiet");

        let _ = publish_scan_health(&s, Ok(ScanStats::default())).await;
        let ev = rx.try_recv().expect("recovery announced");
        assert_eq!(ev["type"], "scan_error");
        assert!(ev["message"].is_null(), "null clears the banner");

        let _ = publish_scan_health(&s, Ok(ScanStats::default())).await;
        assert!(rx.try_recv().is_err(), "healthy scans stay quiet");
    }
}
