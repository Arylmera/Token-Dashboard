//! Library surface of the cli crate. Exposes the axum router so
//! integration tests can hit handlers without binding a port.

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use token_dashboard_core::{
    cost_for, list_sources,
    queries::{
        all_tags, daily_token_breakdown, model_breakdown, overview_totals, project_summary,
        tool_token_breakdown, DailyRow, ModelRow, OverviewTotals, ProjectRow, TagRow, ToolRow,
    },
    Pricing, Source, Usage,
};

#[derive(Clone)]
pub struct AppState {
    pub db_path: Arc<PathBuf>,
    pub pricing: Arc<Pricing>,
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
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http())
}
