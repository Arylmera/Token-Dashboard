//! Library surface of the cli crate. Exposes the axum router so
//! integration tests can hit handlers without binding a port.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use token_dashboard_core::{
    cost_for, list_sources,
    queries::{
        all_tags, daily_token_breakdown, expensive_prompts, get_plan, hourly_breakdown,
        model_breakdown, overview_totals, phase_split, project_summary, recent_sessions,
        session_model_usage, session_tags, session_turns, skill_breakdown, tool_token_breakdown,
        DailyRow, ExpensivePromptRow, HourlyRow, ModelRow, OverviewTotals, ProjectRow, SessionRow,
        SessionTurn, SkillRow, TagRow, ToolRow,
    },
    scan_dir, Pricing, ScanStats, Source, Usage,
};

#[derive(Clone)]
pub struct AppState {
    pub db_path: Arc<PathBuf>,
    pub pricing: Arc<Pricing>,
    /// Path passed to `scan_dir` when `/api/scan` fires. Defaults to
    /// `~/.claude/projects` in `main.rs` but tests override it.
    pub projects_dir: Arc<PathBuf>,
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
    Ok(Json(stats.into()))
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
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "error": self.msg });
        (self.status, Json(body)).into_response()
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
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
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
}
