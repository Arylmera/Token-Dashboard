//! Library surface of the cli crate. Exposes the axum router so
//! integration tests can hit handlers without binding a port.

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
        session_tags, session_turns, set_plan, skill_breakdown, tool_token_breakdown, DailyRow,
        ExpensivePromptRow, ModelRow, OverviewTotals, ProjectRow, SessionRow, SessionTurn,
        SkillRow, TagRow, ToolRow,
    },
    scan_dir, Pricing, ScanStats, Source, Usage,
};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

#[derive(Clone)]
pub struct AppState {
    pub db_path: Arc<PathBuf>,
    pub pricing: Arc<Pricing>,
    /// Path passed to `scan_dir` when `/api/scan` fires. Defaults to
    /// `~/.claude/projects` in `main.rs` but tests override it.
    pub projects_dir: Arc<PathBuf>,
    /// Broadcast bus for SSE — clients subscribe through `/api/stream`.
    /// Mirrors the python `sse.EVENTS.publish({"type": "..."})` pattern;
    /// publishers (scan loop, settings POSTs) push JSON values onto this
    /// channel and every connected client gets one fan-out copy.
    pub events: broadcast::Sender<serde_json::Value>,
}

impl AppState {
    /// Construct an `AppState` for tests/binaries with a fresh broadcast
    /// channel. Capacity 64 is the same default the python EventBus uses.
    pub fn new(db_path: PathBuf, pricing: Pricing, projects_dir: PathBuf) -> Self {
        let (tx, _rx) = broadcast::channel(64);
        Self {
            db_path: Arc::new(db_path),
            pricing: Arc::new(pricing),
            projects_dir: Arc::new(projects_dir),
            events: tx,
        }
    }
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

#[derive(Deserialize, Default, Clone)]
struct RangeQs {
    since: Option<String>,
    until: Option<String>,
    /// Optional provider filter for multi-AI support. Accepts a single id
    /// (`"claude"`, `"codex"`, `"ollama"`), a comma-separated list
    /// (`"claude,codex"`), `"all"`, or omitted — all four behave as
    /// no-filter on v4.0.x data where every row is `'claude'`. Threaded
    /// through queries that join `messages` / `tool_calls`.
    #[serde(default)]
    provider: Option<String>,
}

/// `/api/overview` JSON adds a `cost_usd` placeholder (0.0 until the
/// pricing.json port lands). Field is present so the frontend KPI strip
/// renders without conditional logic.
#[derive(Serialize)]
struct OverviewResponse {
    #[serde(flatten)]
    totals: OverviewTotals,
    cost_usd: f64,
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// OpenAPI 3.1 spec for the entire HTTP surface.
///
/// Embedded at compile time so a binary release ships the spec
/// without a runtime FS dependency. The frontend's API tab fetches
/// this and renders it via Swagger UI.
const OPENAPI_JSON: &str = include_str!("../openapi.json");

async fn openapi() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        OPENAPI_JSON,
    )
}

async fn sources(State(s): State<AppState>) -> Result<Json<Vec<Source>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || list_sources(path.as_ref())).await
}

async fn overview(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<OverviewResponse>, ApiError> {
    let path = s.db_path.clone();
    let path_for_models = path.clone();
    let q_for_models = q.clone();
    let totals = blocking(move || {
        overview_totals(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let models = blocking(move || {
        model_breakdown(
            path_for_models.as_ref(),
            q_for_models.since.as_deref(),
            q_for_models.until.as_deref(),
            q_for_models.provider.as_deref(),
        )
    })
    .await?
    .0;
    let mut cost_usd = 0.0;
    for m in models {
        let r = cost_for(
            &m.model,
            &Usage {
                input_tokens: m.input_tokens,
                output_tokens: m.output_tokens,
                cache_read_tokens: m.cache_read_tokens,
                cache_create_5m_tokens: m.cache_create_5m_tokens,
                cache_create_1h_tokens: m.cache_create_1h_tokens,
            },
            &s.pricing,
        );
        if let Some(usd) = r.usd {
            cost_usd += usd;
        }
    }
    Ok(Json(OverviewResponse {
        totals,
        cost_usd: round4(cost_usd),
    }))
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

async fn projects(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<ProjectRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || {
        project_summary(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await
}

async fn tools(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<ToolRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || {
        tool_token_breakdown(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await
}

async fn daily(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<DailyRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || {
        daily_token_breakdown(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await
}

#[derive(Deserialize, Default)]
struct CacheStatsQuery {
    days: Option<u32>,
}

async fn cache_stats_handler(
    State(s): State<AppState>,
    Query(q): Query<CacheStatsQuery>,
) -> Result<Json<token_dashboard_core::cache_stats::CacheTrend>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::cache_stats::cache_trend(path.as_ref(), days)).await
}

#[derive(Deserialize, Default)]
struct BurnRateQuery {
    window_days: Option<u32>,
}

async fn burn_rate_handler(
    State(s): State<AppState>,
    Query(q): Query<BurnRateQuery>,
) -> Result<Json<token_dashboard_core::burn_rate::BurnRate>, ApiError> {
    let window = q.window_days.unwrap_or(7).clamp(1, 90);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::burn_rate::burn_rate(path.as_ref(), window)).await
}

#[derive(Serialize)]
struct ModelRowWithCost {
    #[serde(flatten)]
    row: ModelRow,
    cost_usd: f64,
}

async fn by_model(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<ModelRowWithCost>>, ApiError> {
    let path = s.db_path.clone();
    let rows = blocking(move || {
        model_breakdown(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let pricing = s.pricing.clone();
    let out = rows
        .into_iter()
        .map(|m| {
            let cost_usd = cost_for(
                &m.model,
                &Usage {
                    input_tokens: m.input_tokens,
                    output_tokens: m.output_tokens,
                    cache_read_tokens: m.cache_read_tokens,
                    cache_create_5m_tokens: m.cache_create_5m_tokens,
                    cache_create_1h_tokens: m.cache_create_1h_tokens,
                },
                &pricing,
            )
            .usd
            .map(round4)
            .unwrap_or(0.0);
            ModelRowWithCost { row: m, cost_usd }
        })
        .collect();
    Ok(Json(out))
}

async fn tags(State(s): State<AppState>) -> Result<Json<Vec<TagRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || all_tags(path.as_ref())).await
}

#[derive(Deserialize, Default)]
struct HourlyQs {
    #[serde(default)]
    hours: Option<i64>,
    #[serde(default)]
    provider: Option<String>,
}

/// One slot in the hourly response — fields the frontend's
/// `buildHourly` / `buildBurn` consume. The slot at index
/// `hours - 1 - hour_ago` represents activity that ended N hours ago,
/// so `arr[arr.length - 1]` is the current hour.
#[derive(Serialize, Default)]
struct HourlySlot {
    hour_ago: i64,
    cost_usd: f64,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_create_5m_tokens: i64,
    cache_create_1h_tokens: i64,
}

async fn hourly(
    State(s): State<AppState>,
    Query(q): Query<HourlyQs>,
) -> Result<Json<Vec<HourlySlot>>, ApiError> {
    let path = s.db_path.clone();
    let hours = q.hours.unwrap_or(24).max(1);
    let provider = q.provider.clone();
    let rows = blocking(move || hourly_breakdown(path.as_ref(), hours, provider.as_deref()))
        .await?
        .0;
    // Bucket the (hour_ago, model) rows into per-hour slots, summing
    // tokens across models and computing cost via the embedded
    // pricing table. The frontend treats the array as oldest-first:
    // index i → (hours - 1 - i) hours ago, so arr[arr.length - 1] is
    // the current hour (what buildBurn keys on as "rate").
    let pricing = s.pricing.clone();
    let n = hours as usize;
    let mut slots: Vec<HourlySlot> = (0..n)
        .map(|i| HourlySlot {
            hour_ago: (n as i64) - 1 - (i as i64),
            ..HourlySlot::default()
        })
        .collect();
    for r in rows {
        if r.hour_ago < 0 || r.hour_ago >= hours {
            continue;
        }
        let idx = (n as i64) - 1 - r.hour_ago;
        if idx < 0 || idx as usize >= n {
            continue;
        }
        let slot = &mut slots[idx as usize];
        slot.input_tokens += r.input_tokens;
        slot.output_tokens += r.output_tokens;
        slot.cache_read_tokens += r.cache_read_tokens;
        slot.cache_create_5m_tokens += r.cache_create_5m_tokens;
        slot.cache_create_1h_tokens += r.cache_create_1h_tokens;
        let cr = cost_for(
            &r.model,
            &Usage {
                input_tokens: r.input_tokens,
                output_tokens: r.output_tokens,
                cache_read_tokens: r.cache_read_tokens,
                cache_create_5m_tokens: r.cache_create_5m_tokens,
                cache_create_1h_tokens: r.cache_create_1h_tokens,
            },
            &pricing,
        );
        if let Some(usd) = cr.usd {
            slot.cost_usd += usd;
        }
    }
    for s in &mut slots {
        s.cost_usd = round6(s.cost_usd);
    }
    Ok(Json(slots))
}

#[derive(Serialize, Default, Clone, Copy)]
struct PhaseBin {
    turns: i64,
    billable_tokens: i64,
    cache_read_tokens: i64,
    cost_usd: f64,
    cost_estimated: bool,
}

#[derive(Serialize)]
struct PhaseSplitResponse {
    plan: PhaseBin,
    execute: PhaseBin,
    other: PhaseBin,
}

async fn phase_split_endpoint(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<PhaseSplitResponse>, ApiError> {
    let path = s.db_path.clone();
    let rows = blocking(move || {
        phase_split(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let pricing = s.pricing.clone();
    let mut plan = PhaseBin::default();
    let mut execute = PhaseBin::default();
    let mut other = PhaseBin::default();
    for r in rows {
        // Apportionment rule (mirrors python data.phase_split_endpoint):
        // ties between plan and execute fall to plan; turns with no
        // recognised tools drop into 'other'.
        let bin = if r.plan_n == 0 && r.exec_n == 0 && r.other_n == 0 {
            &mut other
        } else if r.plan_n >= r.exec_n && r.plan_n >= r.other_n {
            &mut plan
        } else if r.exec_n >= r.other_n {
            &mut execute
        } else {
            &mut other
        };
        let billable =
            r.input_tokens + r.output_tokens + r.cache_create_5m_tokens + r.cache_create_1h_tokens;
        bin.turns += 1;
        bin.billable_tokens += billable;
        bin.cache_read_tokens += r.cache_read_tokens;
        if let Some(model) = r.model.as_deref() {
            let cr = cost_for(
                model,
                &Usage {
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    cache_read_tokens: r.cache_read_tokens,
                    cache_create_5m_tokens: r.cache_create_5m_tokens,
                    cache_create_1h_tokens: r.cache_create_1h_tokens,
                },
                &pricing,
            );
            if let Some(usd) = cr.usd {
                bin.cost_usd += usd;
            }
            if cr.estimated {
                bin.cost_estimated = true;
            }
        }
    }
    plan.cost_usd = round6(plan.cost_usd);
    execute.cost_usd = round6(execute.cost_usd);
    other.cost_usd = round6(other.cost_usd);
    Ok(Json(PhaseSplitResponse {
        plan,
        execute,
        other,
    }))
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

#[derive(Serialize)]
struct ScanResponse {
    messages: u64,
    tools: u64,
    files: u64,
    sessions: Vec<String>,
    projects: Vec<String>,
    days: Vec<String>,
    models: Vec<String>,
    min_ts: Option<String>,
    max_ts: Option<String>,
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

async fn scan(State(s): State<AppState>) -> Result<Json<ScanResponse>, ApiError> {
    let stats = run_scan_and_broadcast(s)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(stats.into()))
}

/// Run `scan_dir` once and publish a `scan_complete` SSE event with the
/// rich hint (sessions/projects/days/models) the frontend dispatcher
/// uses to decide which endpoints to refetch. Shared between the
/// `/api/scan` route and the periodic background loop so both code paths
/// emit identical events.
async fn run_scan_and_broadcast(s: AppState) -> Result<ScanStats, String> {
    let db = s.db_path.clone();
    let proj = s.projects_dir.clone();
    let stats = tokio::task::spawn_blocking(move || scan_dir(proj.as_ref(), db.as_ref()))
        .await
        .map_err(|e| format!("join: {e}"))?
        .map_err(|e| format!("scan: {e}"))?;
    // Best-effort: failure means no listeners attached.
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

#[derive(Deserialize)]
struct PlanBody {
    plan: Option<String>,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

async fn set_plan_handler(
    State(s): State<AppState>,
    Json(body): Json<PlanBody>,
) -> Result<Json<OkResponse>, ApiError> {
    let path = s.db_path.clone();
    let plan = body.plan.unwrap_or_else(|| "api".into());
    blocking_unit(move || set_plan(path.as_ref(), &plan)).await?;
    Ok(Json(OkResponse { ok: true }))
}

#[derive(Deserialize)]
struct TipDismissBody {
    key: Option<String>,
}

async fn tips_dismiss_handler(
    State(s): State<AppState>,
    Json(body): Json<TipDismissBody>,
) -> Result<Json<OkResponse>, ApiError> {
    let key = match body.key {
        Some(k) if !k.is_empty() => k,
        _ => return Err(ApiError::bad_request("missing tip key")),
    };
    let path = s.db_path.clone();
    blocking_unit(move || dismiss_tip(path.as_ref(), &key)).await?;
    Ok(Json(OkResponse { ok: true }))
}

#[derive(Deserialize, Default)]
struct SessionTagsBody {
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Serialize)]
struct SessionTagsResponse {
    ok: bool,
    added: Vec<String>,
    removed: Vec<String>,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct PreferencesResponse {
    badge_metric: String,
    badge_window_mode: String,
    badge_dock_enabled: bool,
    badge_menubar_enabled: bool,
    limits_enabled: bool,
    advanced_mode: bool,
    multi_provider_enabled: bool,
    theme: Option<String>,
    glass_enabled: bool,
    glass_opacity: i64,
    limits_five_hour_reset_at: Option<String>,
    limits_weekly_reset_at: Option<String>,
    limits_5h_cap_override: Option<i64>,
    limits_weekly_cap_override: Option<i64>,
    limits_source: String,
    widget_metrics: Vec<String>,
    widget_open: bool,
}

async fn preferences_get(State(s): State<AppState>) -> Result<Json<PreferencesResponse>, ApiError> {
    let path = s.db_path.clone();
    let resp = blocking(move || -> rusqlite::Result<PreferencesResponse> {
        let p = path.as_ref();
        Ok(PreferencesResponse {
            badge_metric: preferences::get_badge_metric(p)?,
            badge_window_mode: preferences::get_badge_window_mode(p)?,
            badge_dock_enabled: preferences::get_badge_dock_enabled(p)?,
            badge_menubar_enabled: preferences::get_badge_menubar_enabled(p)?,
            limits_enabled: preferences::get_limits_enabled(p)?,
            advanced_mode: preferences::get_advanced_mode(p)?,
            multi_provider_enabled: preferences::get_multi_provider_enabled(p)?,
            theme: preferences::get_theme(p)?,
            glass_enabled: preferences::get_glass_enabled(p)?,
            glass_opacity: preferences::get_glass_opacity(p)?,
            limits_five_hour_reset_at: preferences::get_limit_reset_at(
                p,
                "limits_five_hour_reset_at",
            )?,
            limits_weekly_reset_at: preferences::get_limit_reset_at(p, "limits_weekly_reset_at")?,
            limits_5h_cap_override: preferences::get_limit_cap_override(
                p,
                "limits_5h_cap_override",
            )?,
            limits_weekly_cap_override: preferences::get_limit_cap_override(
                p,
                "limits_weekly_cap_override",
            )?,
            limits_source: preferences::get_limits_source(p)?,
            widget_metrics: preferences::get_widget_metrics(p)?,
            widget_open: preferences::get_widget_open(p)?,
        })
    })
    .await?;
    Ok(resp)
}

// Distinguish "field absent" from "field: null". Plain Option<T> collapses
// both to None, so we need an outer Option to mark presence and an inner
// Option to carry the value-or-null.
fn deserialize_double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(de).map(Some)
}

#[derive(Deserialize, Default)]
struct PreferencesBody {
    #[serde(default)]
    badge_metric: Option<String>,
    #[serde(default)]
    badge_window_mode: Option<String>,
    #[serde(default)]
    glass_enabled: Option<bool>,
    #[serde(default)]
    glass_opacity: Option<i64>,
    #[serde(default)]
    badge_dock_enabled: Option<bool>,
    #[serde(default)]
    badge_menubar_enabled: Option<bool>,
    #[serde(default)]
    limits_enabled: Option<bool>,
    #[serde(default)]
    advanced_mode: Option<bool>,
    #[serde(default)]
    multi_provider_enabled: Option<bool>,
    #[serde(default)]
    theme: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    limits_five_hour_reset_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    limits_weekly_reset_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    limits_5h_cap_override: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    limits_weekly_cap_override: Option<Option<i64>>,
    #[serde(default)]
    limits_source: Option<String>,
    #[serde(default)]
    widget_metrics: Option<Vec<String>>,
    #[serde(default)]
    widget_open: Option<bool>,
}

async fn preferences_post(
    State(s): State<AppState>,
    Json(body): Json<PreferencesBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = s.db_path.clone();
    let events = s.events.clone();
    let resp = blocking(move || -> rusqlite::Result<serde_json::Value> {
        let p = path.as_ref();
        let mut out = serde_json::Map::new();
        out.insert("ok".into(), serde_json::Value::Bool(true));

        if let Some(v) = body.badge_metric {
            let stored = preferences::set_badge_metric(p, &v)?;
            let _ = events.send(serde_json::json!({"type": "preferences", "badge_metric": stored}));
            out.insert("badge_metric".into(), serde_json::Value::String(stored));
        }
        if let Some(v) = body.badge_window_mode {
            let stored = preferences::set_badge_window_mode(p, &v)?;
            let _ = events
                .send(serde_json::json!({"type": "preferences", "badge_window_mode": stored}));
            out.insert(
                "badge_window_mode".into(),
                serde_json::Value::String(stored),
            );
        }
        if let Some(v) = body.glass_enabled {
            let stored = preferences::set_glass_enabled(p, v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "glass_enabled": stored}));
            out.insert("glass_enabled".into(), serde_json::Value::Bool(stored));
        }
        if let Some(v) = body.glass_opacity {
            let stored = preferences::set_glass_opacity(p, v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "glass_opacity": stored}));
            out.insert("glass_opacity".into(), serde_json::Value::from(stored));
        }
        if let Some(v) = body.badge_dock_enabled {
            let stored = preferences::set_badge_dock_enabled(p, v)?;
            let _ = events
                .send(serde_json::json!({"type": "preferences", "badge_dock_enabled": stored}));
            out.insert("badge_dock_enabled".into(), serde_json::Value::Bool(stored));
        }
        if let Some(v) = body.badge_menubar_enabled {
            let stored = preferences::set_badge_menubar_enabled(p, v)?;
            let _ = events
                .send(serde_json::json!({"type": "preferences", "badge_menubar_enabled": stored}));
            out.insert(
                "badge_menubar_enabled".into(),
                serde_json::Value::Bool(stored),
            );
        }
        if let Some(v) = body.limits_enabled {
            let stored = preferences::set_limits_enabled(p, v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "limits_enabled": stored}));
            out.insert("limits_enabled".into(), serde_json::Value::Bool(stored));
        }
        if let Some(v) = body.advanced_mode {
            let stored = preferences::set_advanced_mode(p, v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "advanced_mode": stored}));
            out.insert("advanced_mode".into(), serde_json::Value::Bool(stored));
        }
        if let Some(v) = body.multi_provider_enabled {
            let stored = preferences::set_multi_provider_enabled(p, v)?;
            let _ = events
                .send(serde_json::json!({"type": "preferences", "multi_provider_enabled": stored}));
            out.insert(
                "multi_provider_enabled".into(),
                serde_json::Value::Bool(stored),
            );
        }
        if let Some(v) = body.theme {
            let stored = preferences::set_theme(p, &v)?;
            let echo = stored
                .clone()
                .map(serde_json::Value::String)
                .unwrap_or(serde_json::Value::Null);
            let _ = events.send(serde_json::json!({"type": "preferences", "theme": echo.clone()}));
            out.insert("theme".into(), echo);
        }
        for (k, v) in [
            ("limits_five_hour_reset_at", body.limits_five_hour_reset_at),
            ("limits_weekly_reset_at", body.limits_weekly_reset_at),
        ] {
            if let Some(next) = v {
                let stored = preferences::set_limit_reset_at(p, k, next.as_deref())?;
                out.insert(
                    k.into(),
                    stored
                        .map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }
        for (k, v) in [
            ("limits_5h_cap_override", body.limits_5h_cap_override),
            (
                "limits_weekly_cap_override",
                body.limits_weekly_cap_override,
            ),
        ] {
            if let Some(next) = v {
                let stored = preferences::set_limit_cap_override(p, k, next)?;
                let _ = events.send(serde_json::json!({"type": "preferences", k: stored}));
                out.insert(
                    k.into(),
                    stored
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }
        if let Some(v) = body.limits_source {
            let stored = preferences::set_limits_source(p, &v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "limits_source": stored}));
            out.insert("limits_source".into(), serde_json::Value::String(stored));
        }
        if let Some(v) = body.widget_metrics {
            let stored = preferences::set_widget_metrics(p, &v)?;
            let _ =
                events.send(serde_json::json!({"type": "preferences", "widget_metrics": stored}));
            out.insert(
                "widget_metrics".into(),
                serde_json::Value::Array(
                    stored.into_iter().map(serde_json::Value::String).collect(),
                ),
            );
        }
        if let Some(v) = body.widget_open {
            // Widget open/close requests are written here; the Tauri
            // shell reconciles the actual window state via its own poller.
            // For headless cli runs the flag is a no-op but persists for
            // the next launch.
            let stored = preferences::set_widget_open(p, v)?;
            let _ = events.send(serde_json::json!({"type": "preferences", "widget_open": stored}));
            out.insert("widget_open".into(), serde_json::Value::Bool(stored));
        }
        Ok(serde_json::Value::Object(out))
    })
    .await?;
    Ok(resp)
}

#[derive(Serialize)]
struct BudgetResponse {
    daily: Option<f64>,
    weekly: Option<f64>,
    monthly: Option<f64>,
}

async fn budget_alerts_handler(
    State(s): State<AppState>,
) -> Result<Json<token_dashboard_core::budget_alerts::AlertResult>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_alerts::check(path.as_ref())).await
}

async fn budget_alerts_config_get(
    State(s): State<AppState>,
) -> Result<Json<token_dashboard_core::budget_alerts::AlertsConfig>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_alerts::get_config(path.as_ref())).await
}

#[derive(Deserialize, Default)]
struct BudgetAlertsConfigBody {
    #[serde(default)]
    thresholds: Option<Vec<u32>>,
    #[serde(default)]
    muted: Option<Vec<u32>>,
}

async fn budget_alerts_config_post(
    State(s): State<AppState>,
    Json(body): Json<BudgetAlertsConfigBody>,
) -> Result<Json<token_dashboard_core::budget_alerts::AlertsConfig>, ApiError> {
    let path = s.db_path.clone();
    blocking(
        move || -> rusqlite::Result<token_dashboard_core::budget_alerts::AlertsConfig> {
            let mut cfg = token_dashboard_core::budget_alerts::get_config(path.as_ref())?;
            if let Some(t) = body.thresholds {
                cfg.thresholds = t;
                cfg.thresholds.sort();
                cfg.thresholds.dedup();
            }
            if let Some(m) = body.muted {
                cfg.muted = m;
                cfg.muted.sort();
                cfg.muted.dedup();
            }
            token_dashboard_core::budget_alerts::set_config(path.as_ref(), &cfg)?;
            Ok(cfg)
        },
    )
    .await
}

async fn budget_projects_get(
    State(s): State<AppState>,
) -> Result<Json<Vec<token_dashboard_core::budget_projects::ProjectAllocation>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_projects::allocations(path.as_ref())).await
}

#[derive(Deserialize)]
struct ProjectBudgetBody {
    slug: String,
    #[serde(default)]
    amount: Option<f64>,
}

async fn budget_projects_post(
    State(s): State<AppState>,
    Json(body): Json<ProjectBudgetBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = s.db_path.clone();
    let amount = body.amount;
    let slug_for_save = body.slug.clone();
    blocking_unit(move || {
        token_dashboard_core::preferences::set_project_budget(path.as_ref(), &slug_for_save, amount)
            .map(|_| ())
    })
    .await?;
    Ok(Json(serde_json::json!({
        "ok": true,
        "slug": body.slug,
        "amount": body.amount,
    })))
}

async fn budget_get(State(s): State<AppState>) -> Result<Json<BudgetResponse>, ApiError> {
    let path = s.db_path.clone();
    let b = blocking(move || preferences::get_budgets(path.as_ref()))
        .await?
        .0;
    Ok(Json(BudgetResponse {
        daily: b.daily,
        weekly: b.weekly,
        monthly: b.monthly,
    }))
}

#[derive(Deserialize, Default)]
struct BudgetBody {
    #[serde(default)]
    daily: Option<f64>,
    #[serde(default)]
    weekly: Option<f64>,
    #[serde(default)]
    monthly: Option<f64>,
}

async fn budget_post(
    State(s): State<AppState>,
    Json(body): Json<BudgetBody>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let path = s.db_path.clone();
    let resp = blocking(move || -> rusqlite::Result<serde_json::Value> {
        let p = path.as_ref();
        let mut out = serde_json::Map::new();
        out.insert("ok".into(), serde_json::Value::Bool(true));
        for (short, long) in [
            ("daily", "budget_daily_usd"),
            ("weekly", "budget_weekly_usd"),
            ("monthly", "budget_monthly_usd"),
        ] {
            let v = match short {
                "daily" => body.daily,
                "weekly" => body.weekly,
                "monthly" => body.monthly,
                _ => None,
            };
            // Only honour keys explicitly present in the body; matches python
            // by checking `in body`.
            if v.is_some() {
                let stored = preferences::set_budget(p, long, v)?;
                out.insert(
                    short.into(),
                    stored
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }
        Ok(serde_json::Value::Object(out))
    })
    .await?;
    Ok(resp)
}

#[derive(Serialize)]
struct LimitsResponse {
    enabled: bool,
    limits_five_hour_reset_at: Option<String>,
    limits_weekly_reset_at: Option<String>,
    limits_5h_cap_override: Option<i64>,
    limits_weekly_cap_override: Option<i64>,
    last_sync_at: Option<String>,
    last_sync_status: Option<String>,
    // Live snapshot consumed by the Overview "Plan limits remaining" card
    // and the Settings calibrator (which reads `five_hour.used`).
    #[serde(flatten)]
    snapshot: LimitsSnapshot,
}

#[derive(Serialize)]
struct LimitsSyncResponse {
    status: String,
    limits_five_hour_reset_at: Option<String>,
    limits_weekly_reset_at: Option<String>,
    limits_last_sync_at: Option<String>,
    limits_last_sync_status: Option<String>,
}

async fn limits_sync_oauth(
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
struct OAuthStatusResponse {
    available: bool,
    reason: Option<String>,
}

/// Cheap probe used by the Settings card to decide whether the limits
/// toggle should be offered. Reads the Claude Code credential blob; on
/// macOS this can prompt the Keychain the first time, so we only call
/// it from Settings (not from the dashboard's static reload path).
/// Never returns the token — only whether it could be read.
async fn limits_oauth_status() -> Json<OAuthStatusResponse> {
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
enum OAuthSyncError {
    Credential(String),
    Persist(String),
    Join(String),
}

struct OAuthSyncOutcome {
    response: LimitsSyncResponse,
}

/// Shared OAuth-sync pipeline used by both the `/api/limits/sync_oauth`
/// route and the activity-triggered scanner hook. Reads the credential,
/// hits Anthropic, persists the snapshot, and broadcasts a
/// `limits_refreshed` SSE event on success so the frontend can refetch
/// the Overview card without waiting for the next scan tick.
async fn run_oauth_sync(
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
const ACTIVITY_SYNC_THROTTLE_SECONDS: i64 = 10;

/// Startup-refresh threshold: at app launch, if the last successful
/// snapshot is older than this — or there's no snapshot — fire one
/// sync so the Overview shows current values without waiting for the
/// next activity tick.
const STARTUP_SYNC_STALE_SECONDS: i64 = 300;

/// Single source of truth for "should we run an OAuth limits sync right
/// now?" — returns false when the user isn't on the OAuth source, true
/// when there's no successful snapshot yet, otherwise compares the last
/// snapshot's `synced_at` to `threshold_secs`. Uses SQLite's `datetime()`
/// so callers don't need a Rust ISO parser, and reads the *snapshot's*
/// timestamp (not `last_sync_at`) so failed attempts don't suppress the
/// next retry.
fn oauth_sync_due(db: &std::path::Path, threshold_secs: i64) -> rusqlite::Result<bool> {
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
async fn run_oauth_sync_if_due(state: AppState, threshold_secs: i64, label: &'static str) {
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
async fn maybe_activity_oauth_sync(state: AppState, stats: ScanStats) {
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

fn current_iso_z() -> String {
    use std::time::SystemTime;
    let secs = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let s = secs.rem_euclid(86_400);
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{sec:02}Z")
}

async fn limits_get(State(s): State<AppState>) -> Result<Json<LimitsResponse>, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let resp = blocking(move || -> rusqlite::Result<LimitsResponse> {
        let p = path.as_ref();
        let meta = preferences::get_limits_sync_meta(p)?;
        let snapshot = compute_limits(p, &pricing)?;
        Ok(LimitsResponse {
            enabled: preferences::get_limits_enabled(p)?,
            limits_five_hour_reset_at: preferences::get_limit_reset_at(
                p,
                "limits_five_hour_reset_at",
            )?,
            limits_weekly_reset_at: preferences::get_limit_reset_at(p, "limits_weekly_reset_at")?,
            limits_5h_cap_override: preferences::get_limit_cap_override(
                p,
                "limits_5h_cap_override",
            )?,
            limits_weekly_cap_override: preferences::get_limit_cap_override(
                p,
                "limits_weekly_cap_override",
            )?,
            last_sync_at: meta.last_sync_at,
            last_sync_status: meta.last_sync_status,
            snapshot,
        })
    })
    .await?;
    Ok(resp)
}

#[derive(Deserialize, Default)]
struct SourceToggleBody {
    #[serde(default)]
    enabled: bool,
}

#[derive(Serialize)]
struct SourceToggleResponse {
    ok: bool,
    name: String,
    enabled: bool,
}

async fn sources_toggle(
    State(s): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Json(body): Json<SourceToggleBody>,
) -> Result<Json<SourceToggleResponse>, ApiError> {
    if name.is_empty() {
        return Err(ApiError::bad_request("missing source name"));
    }
    let path = s.db_path.clone();
    let n_for_blocking = name.clone();
    let exists =
        blocking(move || src::set_source_enabled(path.as_ref(), &n_for_blocking, body.enabled))
            .await?
            .0;
    if !exists {
        return Err(ApiError::not_found("source not found"));
    }
    let _ = s.events.send(serde_json::json!({"type": "sources"}));
    Ok(Json(SourceToggleResponse {
        ok: true,
        name,
        enabled: body.enabled,
    }))
}

#[derive(Serialize)]
struct SourceDeleteResponse {
    ok: bool,
    name: String,
}

/// Max upload size for /api/sources/add and /api/import.db. Mirrors the
/// python `MAX_IMPORT_BYTES` (200 MiB) — sized to fit a year of typical
/// usage in one snapshot without allowing pathological uploads.
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

async fn sources_add(
    State(s): State<AppState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Source>, ApiError> {
    if body.is_empty() {
        return Err(ApiError::bad_request("empty body"));
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            msg: format!("upload too large (max {MAX_UPLOAD_BYTES} bytes)"),
        });
    }
    let filename = headers
        .get("X-Source-Filename")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("source-{secs}.db")
        });

    let path = s.db_path.clone();
    let bytes = body.to_vec();
    let row = tokio::task::spawn_blocking(move || {
        token_dashboard_core::sources::add_source(path.as_ref(), &filename, &bytes)
    })
    .await
    .map_err(|e| ApiError::internal(format!("join: {e}")))?;
    let row = match row {
        Ok(r) => r,
        Err(e) => return Err(ApiError::bad_request(e.to_string())),
    };
    let _ = s.events.send(serde_json::json!({"type": "sources"}));
    Ok(Json(row))
}

#[derive(Serialize)]
struct ImportResponse {
    ok: bool,
    messages_added: i64,
    tool_calls_imported: i64,
    tags_added: i64,
}

async fn import_db(
    State(s): State<AppState>,
    body: axum::body::Bytes,
) -> Result<Json<ImportResponse>, ApiError> {
    if body.is_empty() {
        return Err(ApiError::bad_request("empty body"));
    }
    if body.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            msg: format!("upload too large (max {MAX_UPLOAD_BYTES} bytes)"),
        });
    }
    if !body.starts_with(b"SQLite format 3\0") {
        return Err(ApiError::bad_request("not a SQLite database"));
    }

    let path = s.db_path.clone();
    let bytes = body.to_vec();
    let resp = tokio::task::spawn_blocking(move || -> Result<ImportResponse, String> {
        // Stage the upload to a tempfile so sqlite can ATTACH it.
        let tmp = {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let mut p = std::env::temp_dir();
            p.push(format!("td-import-{nanos}.db"));
            p
        };
        std::fs::write(&tmp, &bytes).map_err(|e| format!("io: {e}"))?;

        let result = (|| -> Result<ImportResponse, String> {
            let conn =
                rusqlite::Connection::open(path.as_ref()).map_err(|e| format!("open: {e}"))?;
            // ATTACH path is interpolated, not bound — sqlite forbids `?`.
            // Quote-escape any single quote in the temp path.
            let attach_path = tmp.to_string_lossy().replace('\'', "''");
            conn.execute(&format!("ATTACH DATABASE '{attach_path}' AS src"), [])
                .map_err(|e| format!("attach: {e}"))?;

            let detach = || {
                let _ = conn.execute("DETACH DATABASE src", []);
            };
            let inner = (|| -> Result<ImportResponse, String> {
                let mut stmt = conn
                    .prepare("SELECT name FROM src.sqlite_master WHERE type='table'")
                    .map_err(|e| format!("src tables: {e}"))?;
                let src_tables: std::collections::HashSet<String> = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| format!("src tables: {e}"))?
                    .filter_map(|r| r.ok())
                    .collect();
                drop(stmt);
                for required in ["messages", "tool_calls"] {
                    if !src_tables.contains(required) {
                        return Err(format!("source DB missing required table: {required}"));
                    }
                }

                conn.execute("BEGIN", [])
                    .map_err(|e| format!("begin: {e}"))?;

                // Stage the set of message uuids that don't exist locally yet.
                // We scope the tool_calls insert to this set so messages already
                // present (from a prior import or a local scan) keep their
                // existing tool_calls untouched.
                conn.execute(
                    "CREATE TEMP TABLE _td_new_msgs AS \
                     SELECT s.uuid AS uuid FROM src.messages s \
                     WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.uuid = s.uuid)",
                    [],
                )
                .map_err(|e| format!("stage new msgs: {e}"))?;
                let msg_added: i64 = conn
                    .query_row("SELECT COUNT(*) FROM _td_new_msgs", [], |r| r.get(0))
                    .map_err(|e| format!("count msgs: {e}"))?;

                // Build column intersection for messages.
                let messages_cols = pragma_columns(&conn, "messages")?;
                let src_messages_cols = pragma_columns_attached(&conn, "src", "messages")?;
                let shared: Vec<String> = messages_cols
                    .iter()
                    .filter(|c| src_messages_cols.contains(*c))
                    .cloned()
                    .collect();
                let col_list = shared.join(", ");
                conn.execute(
                    &format!(
                        "INSERT OR IGNORE INTO messages ({col_list}) \
                         SELECT {col_list} FROM src.messages"
                    ),
                    [],
                )
                .map_err(|e| format!("insert messages: {e}"))?;

                let tc_cols = pragma_columns(&conn, "tool_calls")?;
                let src_tc_cols = pragma_columns_attached(&conn, "src", "tool_calls")?;
                let shared_tc: Vec<String> = tc_cols
                    .iter()
                    .filter(|c| src_tc_cols.contains(*c) && c.as_str() != "id")
                    .cloned()
                    .collect();
                let tc_col_list = shared_tc.join(", ");
                conn.execute(
                    &format!(
                        "INSERT INTO tool_calls ({tc_col_list}) \
                         SELECT {tc_col_list} FROM src.tool_calls \
                         WHERE message_uuid IN (SELECT uuid FROM _td_new_msgs)"
                    ),
                    [],
                )
                .map_err(|e| format!("insert tool_calls: {e}"))?;
                let tc_added: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM src.tool_calls \
                         WHERE message_uuid IN (SELECT uuid FROM _td_new_msgs)",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("count tool_calls: {e}"))?;
                conn.execute("DROP TABLE _td_new_msgs", [])
                    .map_err(|e| format!("drop temp: {e}"))?;

                let mut tags_added: i64 = 0;
                if src_tables.contains("session_tags") {
                    tags_added = conn
                        .query_row(
                            "SELECT COUNT(*) FROM src.session_tags s \
                             WHERE NOT EXISTS (SELECT 1 FROM session_tags t \
                              WHERE t.session_id = s.session_id AND t.tag = s.tag)",
                            [],
                            |r| r.get(0),
                        )
                        .map_err(|e| format!("count tags: {e}"))?;
                    conn.execute(
                        "INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) \
                         SELECT session_id, tag, created_at FROM src.session_tags",
                        [],
                    )
                    .map_err(|e| format!("insert tags: {e}"))?;
                }

                conn.execute("COMMIT", [])
                    .map_err(|e| format!("commit: {e}"))?;

                Ok(ImportResponse {
                    ok: true,
                    messages_added: msg_added,
                    tool_calls_imported: tc_added,
                    tags_added,
                })
            })();

            detach();
            inner
        })();
        let _ = std::fs::remove_file(&tmp);
        result
    })
    .await
    .map_err(|e| ApiError::internal(format!("join: {e}")))?;

    let resp = match resp {
        Ok(r) => r,
        Err(msg) => return Err(ApiError::bad_request(msg)),
    };
    let _ = s.events.send(serde_json::json!({"type": "scan_complete"}));
    Ok(Json(resp))
}

fn pragma_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("pragma: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

fn pragma_columns_attached(
    conn: &rusqlite::Connection,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA {schema}.table_info({table})");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("pragma: {e}"))?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| format!("pragma: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

async fn sources_delete(
    State(s): State<AppState>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<SourceDeleteResponse>, ApiError> {
    if name.is_empty() {
        return Err(ApiError::bad_request("missing source name"));
    }
    let path = s.db_path.clone();
    let n_for_blocking = name.clone();
    let removed = blocking(move || src::remove_source(path.as_ref(), &n_for_blocking))
        .await?
        .0;
    if !removed {
        return Err(ApiError::not_found("source not found"));
    }
    let _ = s.events.send(serde_json::json!({"type": "sources"}));
    Ok(Json(SourceDeleteResponse { ok: true, name }))
}

#[derive(Serialize)]
struct PricingPayload {
    defaults: serde_json::Value,
    overrides: serde_json::Value,
    effective: serde_json::Value,
}

fn pricing_payload(defaults: &token_dashboard_core::Pricing) -> serde_json::Value {
    serde_json::to_value(&defaults.models).unwrap_or(serde_json::Value::Null)
}

fn build_pricing_payload(
    defaults: &token_dashboard_core::Pricing,
    overrides: &token_dashboard_core::pricing::Overrides,
) -> PricingPayload {
    let merged = token_dashboard_core::pricing::apply_overrides(defaults, overrides);
    PricingPayload {
        defaults: pricing_payload(defaults),
        overrides: serde_json::to_value(overrides).unwrap_or(serde_json::Value::Null),
        effective: serde_json::to_value(&merged.models).unwrap_or(serde_json::Value::Null),
    }
}

async fn pricing_get(State(s): State<AppState>) -> Result<Json<PricingPayload>, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let payload = blocking(move || -> rusqlite::Result<PricingPayload> {
        let overrides = token_dashboard_core::pricing::get_pricing_overrides(path.as_ref())?;
        Ok(build_pricing_payload(&pricing, &overrides))
    })
    .await?;
    Ok(payload)
}

async fn pricing_set(
    State(s): State<AppState>,
    AxumPath(model): AxumPath<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<PricingPayload>, ApiError> {
    if !s.pricing.models.contains_key(&model) {
        return Err(ApiError::not_found(format!("unknown model: {model}")));
    }
    // Validate the body against PRICING_FIELDS — python rejects negatives
    // and non-numeric values with 400.
    let obj = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("body must be a JSON object"))?;
    let mut cleaned: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for k in token_dashboard_core::pricing::PRICING_FIELDS {
        if let Some(v) = obj.get(*k) {
            let f = v
                .as_f64()
                .ok_or_else(|| ApiError::bad_request(format!("invalid value for {k}")))?;
            if f < 0.0 {
                return Err(ApiError::bad_request(format!("{k} must be >= 0")));
            }
            cleaned.insert((*k).into(), f);
        }
    }
    if cleaned.is_empty() {
        return Err(ApiError::bad_request("no pricing fields supplied"));
    }
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let payload = blocking(move || -> rusqlite::Result<PricingPayload> {
        token_dashboard_core::pricing::set_pricing_override(path.as_ref(), &model, &cleaned)?;
        let overrides = token_dashboard_core::pricing::get_pricing_overrides(path.as_ref())?;
        Ok(build_pricing_payload(&pricing, &overrides))
    })
    .await?;
    Ok(payload)
}

async fn pricing_clear(
    State(s): State<AppState>,
    AxumPath(model): AxumPath<String>,
) -> Result<Json<PricingPayload>, ApiError> {
    if !s.pricing.models.contains_key(&model) {
        return Err(ApiError::not_found(format!("unknown model: {model}")));
    }
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let payload = blocking(move || -> rusqlite::Result<PricingPayload> {
        token_dashboard_core::pricing::clear_pricing_override(path.as_ref(), &model)?;
        let overrides = token_dashboard_core::pricing::get_pricing_overrides(path.as_ref())?;
        Ok(build_pricing_payload(&pricing, &overrides))
    })
    .await?;
    Ok(payload)
}

#[derive(Serialize)]
struct SessionExportRow {
    session_id: String,
    project_slug: String,
    project_name: String,
    started: Option<String>,
    ended: Option<String>,
    turns: i64,
    tokens: i64,
    cost_usd: f64,
    model: Option<String>,
    tags: Vec<String>,
    first_prompt: Option<String>,
}

fn compute_session_export(
    path: &std::path::Path,
    pricing: &Pricing,
    since: Option<&str>,
    until: Option<&str>,
    tag: Option<&str>,
    provider: Option<&str>,
) -> rusqlite::Result<Vec<SessionExportRow>> {
    let rows = recent_sessions(path, 10_000, since, until, tag, provider)?;
    let ids: Vec<String> = rows.iter().map(|r| r.session_id.clone()).collect();
    let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let usage = session_model_usage(path, &id_refs)?;
    let tags_map = session_tags(path, &id_refs)?;
    let fp_map = first_prompts(path, &id_refs)?;

    use std::collections::HashMap;
    let mut cost: HashMap<String, f64> = ids.iter().map(|s| (s.clone(), 0.0)).collect();
    let mut top_model: HashMap<String, (Option<String>, i64)> =
        ids.iter().map(|s| (s.clone(), (None, -1))).collect();
    for u in &usage {
        let cr = cost_for(
            &u.model,
            &Usage {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_tokens: u.cache_read_tokens,
                cache_create_5m_tokens: u.cache_create_5m_tokens,
                cache_create_1h_tokens: u.cache_create_1h_tokens,
            },
            pricing,
        );
        if let Some(usd) = cr.usd {
            *cost.entry(u.session_id.clone()).or_default() += usd;
        }
        let billable =
            u.input_tokens + u.output_tokens + u.cache_create_5m_tokens + u.cache_create_1h_tokens;
        let entry = top_model.entry(u.session_id.clone()).or_insert((None, -1));
        if billable > entry.1 {
            *entry = (Some(u.model.clone()), billable);
        }
    }

    Ok(rows
        .into_iter()
        .map(|r| SessionExportRow {
            cost_usd: cost.get(&r.session_id).copied().unwrap_or(0.0),
            model: top_model.get(&r.session_id).and_then(|(m, _)| m.clone()),
            tags: tags_map.get(&r.session_id).cloned().unwrap_or_default(),
            first_prompt: fp_map.get(&r.session_id).cloned(),
            session_id: r.session_id,
            project_slug: r.project_slug,
            project_name: r.project_name,
            started: r.started,
            ended: r.ended,
            turns: r.turns,
            tokens: r.tokens,
        })
        .collect())
}

async fn export_csv(
    State(s): State<AppState>,
    Query(q): Query<SessionsQs>,
) -> Result<axum::response::Response, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let tag = q.tag.clone();
    let csv_text = blocking(move || -> rusqlite::Result<String> {
        let rows = compute_session_export(
            path.as_ref(),
            &pricing,
            q.since.as_deref(),
            q.until.as_deref(),
            tag.as_deref(),
            q.provider.as_deref(),
        )?;
        let mut buf = String::new();
        buf.push_str("session_id,project_slug,project_name,started,ended,turns,tokens,cost_usd,model,tags,first_prompt\n");
        for r in &rows {
            let cost_str = format!("{:.6}", r.cost_usd);
            let first_prompt = r
                .first_prompt
                .as_deref()
                .map(|s| s.replace(['\r', '\n'], " "))
                .unwrap_or_default();
            push_csv_row(
                &mut buf,
                &[
                    &r.session_id,
                    &r.project_slug,
                    &r.project_name,
                    r.started.as_deref().unwrap_or(""),
                    r.ended.as_deref().unwrap_or(""),
                    &r.turns.to_string(),
                    &r.tokens.to_string(),
                    &cost_str,
                    r.model.as_deref().unwrap_or(""),
                    &r.tags.join(","),
                    &first_prompt,
                ],
            );
        }
        Ok(buf)
    })
    .await?
    .0;

    let mut resp = axum::response::Response::new(axum::body::Body::from(csv_text));
    let headers = resp.headers_mut();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "text/csv; charset=utf-8".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        "attachment; filename=\"token-dashboard-sessions.csv\""
            .parse()
            .unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    Ok(resp)
}

async fn export_json(
    State(s): State<AppState>,
    Query(q): Query<SessionsQs>,
) -> Result<axum::response::Response, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let tag = q.tag.clone();
    let rows = blocking(move || {
        compute_session_export(
            path.as_ref(),
            &pricing,
            q.since.as_deref(),
            q.until.as_deref(),
            tag.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let body = serde_json::to_vec_pretty(&rows)
        .map_err(|e| ApiError::internal(format!("serialize: {e}")))?;
    let mut resp = axum::response::Response::new(axum::body::Body::from(body));
    let headers = resp.headers_mut();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/json; charset=utf-8".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        "attachment; filename=\"token-dashboard-sessions.json\""
            .parse()
            .unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    Ok(resp)
}

/// Append one CSV row using RFC 4180 minimal quoting. Mirrors python's
/// `csv.QUOTE_MINIMAL` — fields containing comma, quote, or newline get
/// quoted; embedded quotes are doubled.
fn push_csv_row(buf: &mut String, fields: &[&str]) {
    for (i, f) in fields.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        let needs_quote = f.contains(',') || f.contains('"') || f.contains('\n');
        if needs_quote {
            buf.push('"');
            for c in f.chars() {
                if c == '"' {
                    buf.push_str("\"\"");
                } else {
                    buf.push(c);
                }
            }
            buf.push('"');
        } else {
            buf.push_str(f);
        }
    }
    buf.push('\n');
}

async fn export_db(State(s): State<AppState>) -> Result<axum::response::Response, ApiError> {
    let path = s.db_path.clone();
    let body = tokio::task::spawn_blocking(move || -> rusqlite::Result<Vec<u8>> {
        // Backup to a tempfile (sqlite handles locking cleanly that way),
        // read into memory, then return. Mirrors the python helper.
        let tmp = tempfile_path()?;
        {
            let src = rusqlite::Connection::open(path.as_ref())?;
            let mut dst = rusqlite::Connection::open(&tmp)?;
            let backup = rusqlite::backup::Backup::new(&src, &mut dst)?;
            backup.run_to_completion(64, std::time::Duration::from_millis(0), None)?;
        }
        let bytes = std::fs::read(&tmp)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let _ = std::fs::remove_file(&tmp);
        Ok(bytes)
    })
    .await
    .map_err(|e| ApiError::internal(format!("join: {e}")))?
    .map_err(|e| ApiError::internal(format!("backup: {e}")))?;

    let stamp = unix_compact_stamp();
    let mut resp = axum::response::Response::new(axum::body::Body::from(body));
    let headers = resp.headers_mut();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "application/x-sqlite3".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"token-dashboard-{stamp}.db\"")
            .parse()
            .unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    Ok(resp)
}

fn tempfile_path() -> rusqlite::Result<std::path::PathBuf> {
    use std::time::SystemTime;
    let nanos = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("td-export-{nanos}.db"));
    Ok(p)
}

fn unix_compact_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs / 86_400;
    let s = secs % 86_400;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    let sec = s % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{sec:02}")
}

fn days_to_ymd(mut days: i64) -> (i64, i64, i64) {
    days += 719_468;
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

async fn pricing_clear_all(State(s): State<AppState>) -> Result<Json<PricingPayload>, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let payload = blocking(move || -> rusqlite::Result<PricingPayload> {
        token_dashboard_core::pricing::clear_all_pricing_overrides(path.as_ref())?;
        Ok(build_pricing_payload(
            &pricing,
            &std::collections::HashMap::new(),
        ))
    })
    .await?;
    Ok(payload)
}

async fn tips_handler(State(s): State<AppState>) -> Result<Json<Vec<Tip>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || all_tips(path.as_ref(), None)).await
}

async fn session_tags_post(
    State(s): State<AppState>,
    AxumPath(sid): AxumPath<String>,
    Json(body): Json<SessionTagsBody>,
) -> Result<Json<SessionTagsResponse>, ApiError> {
    if sid.is_empty() {
        return Err(ApiError::bad_request("missing session id"));
    }
    let path = s.db_path.clone();
    let sid_for_writes = sid.clone();
    let body_for_writes = body;
    let (added, removed) = blocking(move || -> rusqlite::Result<(Vec<String>, Vec<String>)> {
        let mut added = Vec::new();
        let mut removed = Vec::new();
        for raw in &body_for_writes.add {
            let t = normalise_tag(raw);
            if t.is_empty() {
                continue;
            }
            add_session_tag(path.as_ref(), &sid_for_writes, &t)?;
            added.push(t);
        }
        for raw in &body_for_writes.remove {
            let t = normalise_tag(raw);
            if t.is_empty() {
                continue;
            }
            remove_session_tag(path.as_ref(), &sid_for_writes, &t)?;
            removed.push(t);
        }
        Ok((added, removed))
    })
    .await?
    .0;

    let path_for_read = s.db_path.clone();
    let sid_for_read = sid.clone();
    let mut tag_map =
        blocking(move || session_tags(path_for_read.as_ref(), &[sid_for_read.as_str()]))
            .await?
            .0;
    let tags = tag_map.remove(&sid).unwrap_or_default();

    let _ = s
        .events
        .send(serde_json::json!({"type": "tags", "session_id": sid}));

    Ok(Json(SessionTagsResponse {
        ok: true,
        added,
        removed,
        tags,
    }))
}

/// `/api/stream` — server-sent events.
///
/// Wraps the AppState broadcast channel into an SSE response. axum
/// drives a 15s keep-alive ping (matches the python heartbeat cadence
/// in `server/sse.py`) so webkit2gtk doesn't drop the connection
/// (plan §R1 trip wire). Initial `hello` event is emitted on connect
/// so the client can confirm the stream is alive before any real
/// publish lands.
async fn stream(State(s): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = s.events.subscribe();
    let hello = futures::stream::once(async { Ok(Event::default().event("hello").data("{}")) });
    let live = BroadcastStream::new(rx).filter_map(|res| async move {
        match res {
            Ok(payload) => Some(Ok(Event::default()
                .event(
                    payload
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("message"),
                )
                .data(payload.to_string()))),
            // Lagged receiver — surface as a typed event so the client
            // can refetch state instead of silently missing updates.
            Err(_) => Some(Ok(Event::default().event("lagged").data("{}"))),
        }
    });
    Sse::new(hello.chain(live)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[derive(Deserialize, Default)]
struct PromptsQs {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    sort: Option<String>,
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

#[derive(Serialize)]
struct PromptResponse {
    #[serde(flatten)]
    row: ExpensivePromptRow,
    /// Full priced cost for the assistant turn that follows this prompt:
    /// input + output + cache-create + cache-read at the model's rates.
    estimated_cost_usd: Option<f64>,
}

async fn prompts(
    State(s): State<AppState>,
    Query(q): Query<PromptsQs>,
) -> Result<Json<Vec<PromptResponse>>, ApiError> {
    let path = s.db_path.clone();
    let limit = clamp_limit(q.limit.unwrap_or(50), 50);
    let sort = q.sort.unwrap_or_else(|| "tokens".into());
    let since = q.since.clone();
    let until = q.until.clone();
    let search = q.q.clone();
    let provider = q.provider.clone();
    let rows = blocking(move || {
        expensive_prompts(
            path.as_ref(),
            limit,
            &sort,
            since.as_deref(),
            until.as_deref(),
            search.as_deref(),
            provider.as_deref(),
        )
    })
    .await?
    .0;
    let pricing = s.pricing.clone();
    let mut out: Vec<PromptResponse> = Vec::with_capacity(rows.len());
    for row in rows {
        let estimated_cost_usd = match row.model.as_deref() {
            Some(model) => {
                cost_for(
                    model,
                    &Usage {
                        input_tokens: row.input_tokens,
                        output_tokens: row.output_tokens,
                        cache_read_tokens: row.cache_read_tokens,
                        cache_create_5m_tokens: row.cache_create_5m_tokens,
                        cache_create_1h_tokens: row.cache_create_1h_tokens,
                    },
                    &pricing,
                )
                .usd
            }
            None => None,
        };
        out.push(PromptResponse {
            row,
            estimated_cost_usd,
        });
    }
    Ok(Json(out))
}

/// Mirrors python `clamp_limit`: bound 1..=max_default*10 and fall back
/// on parse errors. Caller may pass any user-supplied value.
fn clamp_limit(raw: i64, default: i64) -> i64 {
    let upper = default * 10;
    raw.clamp(1, upper)
}

#[derive(Serialize)]
struct EnrichedSkillRow {
    #[serde(flatten)]
    base: SkillRow,
    tokens_per_call: Option<i64>,
    /// `invocations × tokens_per_call`. None when the catalog has no
    /// entry for this slug (project-local or subagent-dispatched
    /// skills — see KNOWN_LIMITATIONS.md).
    est_tokens: Option<i64>,
    /// Sonnet-priced cost estimate. Models the typical loading
    /// pattern: first load per session at cache-write rate, subsequent
    /// loads at cache-read.
    est_cost_usd: Option<f64>,
    /// Always true when `est_tokens` is populated — the values are
    /// derived (not billing-truthy).
    estimated: bool,
}

async fn skills(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<EnrichedSkillRow>>, ApiError> {
    let path = s.db_path.clone();
    let rows = blocking(move || {
        skill_breakdown(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let catalog = tokio::task::spawn_blocking(token_dashboard_core::skills_catalog::cached_catalog)
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?;
    let sonnet = s.pricing.tier_fallback.get("sonnet").cloned().unwrap_or(
        token_dashboard_core::pricing::TierRates {
            input: 3.0,
            output: 15.0,
            cache_read: 0.30,
            cache_create_5m: 3.75,
            cache_create_1h: 6.0,
        },
    );
    let enriched: Vec<EnrichedSkillRow> = rows
        .into_iter()
        .map(|r| {
            let tokens_per_call =
                token_dashboard_core::skills_catalog::tokens_for(&r.skill, &catalog);
            let (est_tokens, est_cost_usd, estimated) = match tokens_per_call {
                Some(tpc) if tpc > 0 => {
                    let est = tpc * r.invocations.max(0);
                    // Help text on the Skills tab: first load per session
                    // is cache-write, subsequent loads are cache-read.
                    let first_loads = r.sessions.clamp(0, r.invocations);
                    let subsequent = (r.invocations - first_loads).max(0);
                    let cost = (first_loads as f64 * tpc as f64 * sonnet.cache_create_5m
                        + subsequent as f64 * tpc as f64 * sonnet.cache_read)
                        / 1_000_000.0;
                    (Some(est), Some(round6(cost)), true)
                }
                _ => (None, None, false),
            };
            EnrichedSkillRow {
                base: r,
                tokens_per_call,
                est_tokens,
                est_cost_usd,
                estimated,
            }
        })
        .collect();
    Ok(Json(enriched))
}

#[derive(Serialize)]
struct PlanResponse {
    plan: String,
}

async fn plan(State(s): State<AppState>) -> Result<Json<PlanResponse>, ApiError> {
    let path = s.db_path.clone();
    let plan = blocking(move || get_plan(path.as_ref())).await?.0;
    Ok(Json(PlanResponse { plan }))
}

async fn session(
    State(s): State<AppState>,
    AxumPath(sid): AxumPath<String>,
) -> Result<Json<Vec<SessionTurn>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || session_turns(path.as_ref(), &sid)).await
}

#[derive(Deserialize, Default)]
struct SessionsQs {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    since: Option<String>,
    #[serde(default)]
    until: Option<String>,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

#[derive(Serialize)]
struct SessionsResponse {
    #[serde(flatten)]
    base: SessionRow,
    cost_usd: f64,
    cost_estimated: bool,
    /// Top-billable model in this session (or null if no assistant turns).
    model: Option<String>,
    tags: Vec<String>,
    /// First non-empty user prompt in the session — populates the "first
    /// prompt" column in the sessions list.
    first_prompt: Option<String>,
}

async fn sessions(
    State(s): State<AppState>,
    Query(q): Query<SessionsQs>,
) -> Result<Json<Vec<SessionsResponse>>, ApiError> {
    let path = s.db_path.clone();
    let limit = clamp_limit(q.limit.unwrap_or(20), 20);
    let since = q.since;
    let until = q.until;
    let tag = q.tag;
    let provider = q.provider;
    let path_for_query = path.clone();
    let since_q = since.clone();
    let until_q = until.clone();
    let tag_q = tag.clone();
    let provider_q = provider.clone();
    let rows: Vec<SessionRow> = blocking(move || {
        recent_sessions(
            path_for_query.as_ref(),
            limit,
            since_q.as_deref(),
            until_q.as_deref(),
            tag_q.as_deref(),
            provider_q.as_deref(),
        )
    })
    .await?
    .0;

    let ids: Vec<String> = rows.iter().map(|r| r.session_id.clone()).collect();

    // Per-session cost: sum cost_for() across each (session, model) row,
    // tracking the top-billable model per session for display.
    let pricing = s.pricing.clone();
    let path_for_usage = path.clone();
    let ids_for_usage = ids.clone();
    let usage = blocking(move || {
        let refs: Vec<&str> = ids_for_usage.iter().map(String::as_str).collect();
        session_model_usage(path_for_usage.as_ref(), &refs)
    })
    .await?
    .0;

    use std::collections::HashMap;
    let mut cost: HashMap<String, f64> = ids.iter().map(|s| (s.clone(), 0.0)).collect();
    let mut estimated: HashMap<String, bool> = ids.iter().map(|s| (s.clone(), false)).collect();
    // (model, billable_tokens) — winner has the most billable.
    let mut top: HashMap<String, (Option<String>, i64)> =
        ids.iter().map(|s| (s.clone(), (None, -1))).collect();
    for u in &usage {
        let cr = cost_for(
            &u.model,
            &Usage {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_tokens: u.cache_read_tokens,
                cache_create_5m_tokens: u.cache_create_5m_tokens,
                cache_create_1h_tokens: u.cache_create_1h_tokens,
            },
            &pricing,
        );
        if let Some(usd) = cr.usd {
            *cost.entry(u.session_id.clone()).or_default() += usd;
        }
        if cr.estimated {
            estimated.insert(u.session_id.clone(), true);
        }
        let billable =
            u.input_tokens + u.output_tokens + u.cache_create_5m_tokens + u.cache_create_1h_tokens;
        let entry = top.entry(u.session_id.clone()).or_insert((None, -1));
        if billable > entry.1 {
            *entry = (Some(u.model.clone()), billable);
        }
    }

    // Tags lookup.
    let path_for_tags = path.clone();
    let ids_for_tags = ids.clone();
    let mut tag_map = blocking(move || {
        let refs: Vec<&str> = ids_for_tags.iter().map(String::as_str).collect();
        session_tags(path_for_tags.as_ref(), &refs)
    })
    .await?
    .0;

    // First prompt per session (earliest non-empty user prompt_text).
    let path_for_fp = path.clone();
    let ids_for_fp = ids.clone();
    let mut first_prompt_map = blocking(move || {
        let refs: Vec<&str> = ids_for_fp.iter().map(String::as_str).collect();
        first_prompts(path_for_fp.as_ref(), &refs)
    })
    .await?
    .0;

    let mut out: Vec<SessionsResponse> = Vec::with_capacity(rows.len());
    for row in rows {
        let sid = row.session_id.clone();
        out.push(SessionsResponse {
            cost_usd: round6(cost.remove(&sid).unwrap_or(0.0)),
            cost_estimated: estimated.remove(&sid).unwrap_or(false),
            model: top.remove(&sid).and_then(|(m, _)| m),
            tags: tag_map.remove(&sid).unwrap_or_default(),
            first_prompt: first_prompt_map.remove(&sid),
            base: row,
        });
    }
    Ok(Json(out))
}

/// Run a blocking rusqlite call on tokio's blocking pool and wrap the
/// result/error in a `Json<T>` response. The closure is `Send + 'static`
/// because spawn_blocking runs it on a worker thread.
async fn blocking<F, T, E>(f: F) -> Result<Json<T>, ApiError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let v = tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
        .map_err(|e| ApiError::internal(format!("db: {e}")))?;
    Ok(Json(v))
}

/// Same as `blocking` but for write paths that don't return a body —
/// the caller emits its own response (typically `Json(OkResponse)`).
async fn blocking_unit<F, E>(f: F) -> Result<(), ApiError>
where
    F: FnOnce() -> Result<(), E> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
        .map_err(|e| ApiError::internal(format!("db: {e}")))
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    msg: String,
}

impl ApiError {
    fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            msg: msg.into(),
        }
    }
    fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            msg: msg.into(),
        }
    }
    fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            msg: msg.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "error": self.msg });
        (self.status, Json(body)).into_response()
    }
}

/// Build the axum router. `static_dir` is the optional path to a
/// frontend bundle (e.g. `frontend/dist`) — when present it's mounted
/// at `/web/` and `/` so the Tauri shell can boot the same routes the
/// 3.x server serves.
pub fn app(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/openapi.json", get(openapi))
        .route("/api/sources", get(sources))
        .route("/api/overview", get(overview))
        .route("/api/projects", get(projects))
        .route("/api/tools", get(tools))
        .route("/api/daily", get(daily))
        .route("/api/cache-stats", get(cache_stats_handler))
        .route("/api/burn-rate", get(burn_rate_handler))
        .route("/api/by-model", get(by_model))
        .route("/api/tags", get(tags))
        .route("/api/hourly", get(hourly))
        .route("/api/phase-split", get(phase_split_endpoint))
        .route("/api/prompts", get(prompts))
        .route("/api/skills", get(skills))
        .route("/api/plan", get(plan))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/:sid", get(session))
        // The 3.x server accepts both GET and POST for /api/scan; we keep
        // GET for parity with `routes.py` (where it's wired in
        // `if path == "/api/scan"`).
        .route("/api/scan", get(scan))
        .route("/api/stream", get(stream))
        .route("/api/tips", get(tips_handler))
        .route(
            "/api/preferences",
            get(preferences_get).post(preferences_post),
        )
        .route("/api/budget", get(budget_get).post(budget_post))
        .route(
            "/api/budget/projects",
            get(budget_projects_get).post(budget_projects_post),
        )
        .route("/api/budget-alerts", get(budget_alerts_handler))
        .route(
            "/api/budget-alerts/config",
            get(budget_alerts_config_get).post(budget_alerts_config_post),
        )
        .route("/api/limits", get(limits_get))
        .route("/api/limits/sync_oauth", post(limits_sync_oauth))
        .route("/api/limits/oauth_status", get(limits_oauth_status))
        // POST endpoints
        .route("/api/plan", post(set_plan_handler))
        .route("/api/tips/dismiss", post(tips_dismiss_handler))
        .route("/api/sessions/:sid/tags", post(session_tags_post))
        .route("/api/sources/add", post(sources_add))
        .route("/api/sources/:name/toggle", post(sources_toggle))
        .route("/api/sources/:name/delete", post(sources_delete))
        .route("/api/import.db", post(import_db))
        .route("/api/pricing", get(pricing_get))
        .route("/api/export.csv", get(export_csv))
        .route("/api/export.json", get(export_json))
        .route("/api/export.db", get(export_db))
        .route("/api/pricing/clear-all", post(pricing_clear_all))
        .route("/api/pricing/:model", post(pricing_set))
        .route("/api/pricing/:model/clear", post(pricing_clear))
        .with_state(state);

    // Static bundle is opt-in via TOKEN_DASHBOARD_STATIC env var so the
    // headless server keeps booting without a frontend build present.
    if let Some(dir) = std::env::var_os("TOKEN_DASHBOARD_STATIC") {
        let path = std::path::PathBuf::from(dir);
        if path.is_dir() {
            let serve = tower_http::services::ServeDir::new(path.clone())
                .append_index_html_on_directories(true);
            router = router
                .nest_service("/web", serve.clone())
                .route_service("/", serve);
        }
    }

    router.layer(tower_http::trace::TraceLayer::new_for_http())
}
