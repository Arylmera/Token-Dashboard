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
    cost_for, list_sources, preferences,
    queries::{
        add_session_tag, all_tags, daily_token_breakdown, dismiss_tip, expensive_prompts, get_plan,
        hourly_breakdown, model_breakdown, normalise_tag, overview_totals, phase_split,
        project_summary, recent_sessions, remove_session_tag, session_model_usage, session_tags,
        session_turns, set_plan, skill_breakdown, tool_token_breakdown, DailyRow,
        ExpensivePromptRow, HourlyRow, ModelRow, OverviewTotals, ProjectRow, SessionRow,
        SessionTurn, SkillRow, TagRow, ToolRow,
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
    let totals =
        blocking(move || overview_totals(path.as_ref(), q.since.as_deref(), q.until.as_deref()))
            .await?
            .0;
    let models = blocking(move || {
        model_breakdown(
            path_for_models.as_ref(),
            q_for_models.since.as_deref(),
            q_for_models.until.as_deref(),
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
    blocking(move || project_summary(path.as_ref(), q.since.as_deref(), q.until.as_deref())).await
}

async fn tools(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<ToolRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || tool_token_breakdown(path.as_ref(), q.since.as_deref(), q.until.as_deref()))
        .await
}

async fn daily(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<DailyRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || daily_token_breakdown(path.as_ref(), q.since.as_deref(), q.until.as_deref()))
        .await
}

async fn by_model(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<ModelRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || model_breakdown(path.as_ref(), q.since.as_deref(), q.until.as_deref())).await
}

async fn tags(State(s): State<AppState>) -> Result<Json<Vec<TagRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || all_tags(path.as_ref())).await
}

#[derive(Deserialize, Default)]
struct HourlyQs {
    #[serde(default)]
    hours: Option<i64>,
}

async fn hourly(
    State(s): State<AppState>,
    Query(q): Query<HourlyQs>,
) -> Result<Json<Vec<HourlyRow>>, ApiError> {
    let path = s.db_path.clone();
    let hours = q.hours.unwrap_or(24);
    blocking(move || hourly_breakdown(path.as_ref(), hours)).await
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
    let rows = blocking(move || phase_split(path.as_ref(), q.since.as_deref(), q.until.as_deref()))
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
    let db = s.db_path.clone();
    let proj = s.projects_dir.clone();
    let stats = tokio::task::spawn_blocking(move || scan_dir(proj.as_ref(), db.as_ref()))
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
        .map_err(|e| ApiError::internal(format!("scan: {e}")))?;
    // Notify SSE subscribers — the frontend uses this to refetch tabs
    // automatically. Best-effort: failure means no listeners attached.
    let _ = s.events.send(serde_json::json!({
        "type": "scan_complete",
        "messages": stats.messages,
        "tools": stats.tools,
        "files": stats.files,
    }));
    Ok(Json(stats.into()))
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
    glass_enabled: bool,
    glass_opacity: i64,
    anthropic_api_key: Option<String>,
    limits_five_hour_reset_at: Option<String>,
    limits_weekly_reset_at: Option<String>,
    limits_5h_cap_override: Option<i64>,
    limits_weekly_cap_override: Option<i64>,
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
            glass_enabled: preferences::get_glass_enabled(p)?,
            glass_opacity: preferences::get_glass_opacity(p)?,
            anthropic_api_key: preferences::get_anthropic_api_key(p)?,
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
        })
    })
    .await?;
    Ok(resp)
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
    limits_five_hour_reset_at: Option<String>,
    #[serde(default)]
    limits_weekly_reset_at: Option<String>,
    #[serde(default)]
    limits_5h_cap_override: Option<i64>,
    #[serde(default)]
    limits_weekly_cap_override: Option<i64>,
    #[serde(default)]
    anthropic_api_key: Option<String>,
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
        for (k, v) in [
            ("limits_five_hour_reset_at", body.limits_five_hour_reset_at),
            ("limits_weekly_reset_at", body.limits_weekly_reset_at),
        ] {
            if let Some(s) = v {
                let stored = preferences::set_limit_reset_at(p, k, Some(&s))?;
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
            if let Some(n) = v {
                let stored = preferences::set_limit_cap_override(p, k, Some(n))?;
                let _ = events.send(serde_json::json!({"type": "preferences", k: stored}));
                out.insert(
                    k.into(),
                    stored
                        .map(serde_json::Value::from)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }
        if let Some(v) = body.anthropic_api_key {
            // Empty string means clear; that's how the frontend signals
            // a deletion via the same key.
            let raw = if v.is_empty() { None } else { Some(v.as_str()) };
            preferences::set_anthropic_api_key(p, raw)?;
            // Don't echo the key back — keep it out of the response shape.
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
    has_api_key: bool,
}

async fn limits_get(State(s): State<AppState>) -> Result<Json<LimitsResponse>, ApiError> {
    let path = s.db_path.clone();
    let resp = blocking(move || -> rusqlite::Result<LimitsResponse> {
        let p = path.as_ref();
        let meta = preferences::get_limits_sync_meta(p)?;
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
            has_api_key: preferences::get_anthropic_api_key(p)?.is_some(),
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
}

#[derive(Serialize)]
struct PromptResponse {
    #[serde(flatten)]
    row: ExpensivePromptRow,
    /// Cost estimate for the assistant turn that follows this prompt,
    /// keyed by `cache_read_tokens` only (matches python data.prompts).
    estimated_cost_usd: Option<f64>,
}

async fn prompts(
    State(s): State<AppState>,
    Query(q): Query<PromptsQs>,
) -> Result<Json<Vec<PromptResponse>>, ApiError> {
    let path = s.db_path.clone();
    let limit = clamp_limit(q.limit.unwrap_or(50), 50);
    let sort = q.sort.unwrap_or_else(|| "tokens".into());
    let rows = blocking(move || expensive_prompts(path.as_ref(), limit, &sort))
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
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: row.cache_read_tokens,
                        cache_create_5m_tokens: 0,
                        cache_create_1h_tokens: 0,
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

async fn skills(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<SkillRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || skill_breakdown(path.as_ref(), q.since.as_deref(), q.until.as_deref())).await
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
    let path_for_query = path.clone();
    let since_q = since.clone();
    let until_q = until.clone();
    let tag_q = tag.clone();
    let rows: Vec<SessionRow> = blocking(move || {
        recent_sessions(
            path_for_query.as_ref(),
            limit,
            since_q.as_deref(),
            until_q.as_deref(),
            tag_q.as_deref(),
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

    let mut out: Vec<SessionsResponse> = Vec::with_capacity(rows.len());
    for row in rows {
        let sid = row.session_id.clone();
        out.push(SessionsResponse {
            cost_usd: round6(cost.remove(&sid).unwrap_or(0.0)),
            cost_estimated: estimated.remove(&sid).unwrap_or(false),
            model: top.remove(&sid).and_then(|(m, _)| m),
            tags: tag_map.remove(&sid).unwrap_or_default(),
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
        .route("/api/sources", get(sources))
        .route("/api/overview", get(overview))
        .route("/api/projects", get(projects))
        .route("/api/tools", get(tools))
        .route("/api/daily", get(daily))
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
        .route("/api/limits", get(limits_get))
        // POST endpoints
        .route("/api/plan", post(set_plan_handler))
        .route("/api/tips/dismiss", post(tips_dismiss_handler))
        .route("/api/sessions/:sid/tags", post(session_tags_post))
        .route("/api/sources/:name/toggle", post(sources_toggle))
        .route("/api/sources/:name/delete", post(sources_delete))
        .route("/api/pricing", get(pricing_get))
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
