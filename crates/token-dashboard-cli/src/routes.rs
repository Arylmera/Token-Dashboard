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
use token_dashboard_core::day::{
    day_by_hour, day_by_model, day_by_project, day_by_session, day_session_turns, day_totals,
};
use token_dashboard_core::sources as src;
use token_dashboard_core::tips::{all_tips, Tip};
use token_dashboard_core::{
    compute_limits, cost_for,
    limits::LimitsSnapshot,
    list_sources, preferences,
    queries::{
        activity_heatmap, add_session_tag, all_tags, daily_model_breakdown, daily_token_breakdown,
        dismiss_tip, expensive_prompts, first_prompts, get_plan, hourly_breakdown, model_breakdown,
        normalise_tag, overview_totals, phase_split, project_summary, recent_sessions,
        remove_session_tag, session_model_usage, session_tags, session_turns, set_plan,
        skill_breakdown, tag_aggregates, tag_session_counts, tool_token_breakdown, DailyRow,
        ExpensivePromptRow, HeatmapCell, ModelRow, OverviewTotals, ProjectRow, SessionRow,
        SessionTurn, SkillRow, TagRow, ToolRow,
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

use crate::oauth::{limits_oauth_status, limits_sync_oauth};
use crate::scan::scan;
use crate::sse::stream;

#[derive(Serialize)]
pub(crate) struct Health {
    pub(crate) ok: bool,
    pub(crate) version: &'static str,
}

/// `/api/overview` JSON adds a `cost_usd` placeholder (0.0 until the
/// pricing.json port lands). Field is present so the frontend KPI strip
/// renders without conditional logic.
#[derive(Serialize)]
pub(crate) struct OverviewResponse {
    #[serde(flatten)]
    pub(crate) totals: OverviewTotals,
    pub(crate) cost_usd: f64,
}

pub(crate) async fn health() -> Json<Health> {
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
pub(crate) const OPENAPI_JSON: &str = include_str!("../openapi.json");

pub(crate) async fn openapi() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        OPENAPI_JSON,
    )
}

pub(crate) async fn sources(State(s): State<AppState>) -> Result<Json<Vec<Source>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || list_sources(path.as_ref())).await
}

pub(crate) async fn overview(
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

pub(crate) async fn projects(
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

pub(crate) async fn tools(
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

#[derive(Deserialize, Default)]
pub(crate) struct ToolCostsQuery {
    pub(crate) days: Option<u32>,
}

pub(crate) async fn tool_costs_handler(
    State(s): State<AppState>,
    Query(q): Query<ToolCostsQuery>,
) -> Result<Json<token_dashboard_core::tool_costs::ToolCostReport>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::tool_costs::report(path.as_ref(), days)).await
}

#[derive(Deserialize, Default)]
pub(crate) struct VerbosityQuery {
    pub(crate) min_chars: Option<u32>,
    pub(crate) top: Option<u32>,
}

pub(crate) async fn verbosity_handler(
    State(s): State<AppState>,
    Query(q): Query<VerbosityQuery>,
) -> Result<Json<Vec<token_dashboard_core::verbosity::WastedPrompt>>, ApiError> {
    let min_chars = q.min_chars.unwrap_or(200).clamp(1, 1_000_000);
    let top = q.top.unwrap_or(50).clamp(1, 500);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::verbosity::worst_at_path(path.as_ref(), min_chars, top))
        .await
}

#[derive(Serialize)]
pub(crate) struct DailyRowWithCost {
    pub(crate) day: String,
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) cache_read_tokens: i64,
    pub(crate) cache_create_tokens: i64,
    pub(crate) cost_usd: f64,
}

pub(crate) async fn daily(
    State(s): State<AppState>,
    Query(q): Query<RangeQs>,
) -> Result<Json<Vec<DailyRowWithCost>>, ApiError> {
    let path = s.db_path.clone();
    let q2 = q.clone();
    let token_rows = blocking(move || {
        daily_token_breakdown(
            path.as_ref(),
            q.since.as_deref(),
            q.until.as_deref(),
            q.provider.as_deref(),
        )
    })
    .await?
    .0;
    let path2 = s.db_path.clone();
    let priced = blocking(move || {
        daily_model_breakdown(
            path2.as_ref(),
            q2.since.as_deref(),
            q2.until.as_deref(),
            q2.provider.as_deref(),
        )
    })
    .await?
    .0;
    let pricing = s.pricing.clone();
    let mut cost_by_day: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for r in priced {
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
            *cost_by_day.entry(r.day).or_insert(0.0) += usd;
        }
    }
    let out = token_rows
        .into_iter()
        .map(|d| {
            let cost = cost_by_day.get(&d.day).copied().unwrap_or(0.0);
            DailyRowWithCost {
                day: d.day,
                input_tokens: d.input_tokens,
                output_tokens: d.output_tokens,
                cache_read_tokens: d.cache_read_tokens,
                cache_create_tokens: d.cache_create_tokens,
                cost_usd: round4(cost),
            }
        })
        .collect();
    Ok(Json(out))
}

#[derive(Serialize, Default)]
pub(crate) struct DayKpis {
    pub(crate) cost_usd: f64,
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) cache_read_tokens: i64,
    pub(crate) cache_create_tokens: i64,
    pub(crate) turns: i64,
    pub(crate) sessions: i64,
}

#[derive(Serialize)]
pub(crate) struct DayGroupCost {
    pub(crate) key: String,
    pub(crate) cost: f64,
    pub(crate) tokens: i64,
}

#[derive(Serialize)]
pub(crate) struct DayHourCost {
    pub(crate) hour: i64,
    pub(crate) cost: f64,
    pub(crate) tokens: i64,
}

#[derive(Serialize)]
pub(crate) struct DaySessionCost {
    pub(crate) id: String,
    pub(crate) project: String,
    pub(crate) started: String,
    pub(crate) turns: i64,
    pub(crate) tokens: i64,
    pub(crate) cost: f64,
}

#[derive(Serialize)]
pub(crate) struct DayResponse {
    pub(crate) date: String,
    pub(crate) kpis: DayKpis,
    pub(crate) sessions: Vec<DaySessionCost>,
    pub(crate) by_project: Vec<DayGroupCost>,
    pub(crate) by_model: Vec<DayGroupCost>,
    pub(crate) hourly: Vec<DayHourCost>,
}

#[derive(Deserialize)]
pub(crate) struct DayQuery {
    pub(crate) date: String,
}

// input + output + cache_create (cache_read deliberately excluded — matches
// the day KPI "tokens" column and the frontend's billable-token notion).
fn display_tokens(i: i64, o: i64, c5: i64, c1: i64) -> i64 {
    i + o + c5 + c1
}

fn is_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

pub(crate) async fn day(
    State(s): State<AppState>,
    Query(q): Query<DayQuery>,
) -> Result<Json<DayResponse>, ApiError> {
    if !is_ymd(&q.date) {
        return Err(ApiError::bad_request("date must be YYYY-MM-DD"));
    }
    let date = q.date.clone();
    let pricing = s.pricing.clone();
    let path = s.db_path.clone();
    let date_q = date.clone();
    let (totals, model_rows, proj_rows, hour_rows, sess_rows, turn_rows) = blocking(move || {
        let p = path.as_ref();
        Ok::<_, rusqlite::Error>((
            day_totals(p, &date_q)?,
            day_by_model(p, &date_q)?,
            day_by_project(p, &date_q)?,
            day_by_hour(p, &date_q)?,
            day_by_session(p, &date_q)?,
            day_session_turns(p, &date_q)?,
        ))
    })
    .await?
    .0;

    let usage = |i, o, cr, c5, c1| Usage {
        input_tokens: i,
        output_tokens: o,
        cache_read_tokens: cr,
        cache_create_5m_tokens: c5,
        cache_create_1h_tokens: c1,
    };
    let price = |model: &str, u: &Usage| cost_for(model, u, &pricing).usd.unwrap_or(0.0);

    let mut by_model: Vec<DayGroupCost> = Vec::new();
    let mut total_cost = 0.0;
    let (mut ti, mut to, mut tcr, mut tcc) = (0i64, 0i64, 0i64, 0i64);
    for m in &model_rows {
        let u = usage(
            m.input_tokens,
            m.output_tokens,
            m.cache_read_tokens,
            m.cache_create_5m_tokens,
            m.cache_create_1h_tokens,
        );
        let c = price(&m.model, &u);
        let tok = display_tokens(
            m.input_tokens,
            m.output_tokens,
            m.cache_create_5m_tokens,
            m.cache_create_1h_tokens,
        );
        total_cost += c;
        ti += m.input_tokens;
        to += m.output_tokens;
        tcr += m.cache_read_tokens;
        tcc += m.cache_create_5m_tokens + m.cache_create_1h_tokens;
        by_model.push(DayGroupCost {
            key: m.model.clone(),
            cost: round6(c),
            tokens: tok,
        });
    }
    by_model.sort_by(|a, b| {
        b.cost
            .partial_cmp(&a.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut proj_map: std::collections::HashMap<String, (f64, i64)> =
        std::collections::HashMap::new();
    for p in &proj_rows {
        let u = usage(
            p.input_tokens,
            p.output_tokens,
            p.cache_read_tokens,
            p.cache_create_5m_tokens,
            p.cache_create_1h_tokens,
        );
        let e = proj_map.entry(p.project_slug.clone()).or_insert((0.0, 0));
        e.0 += price(&p.model, &u);
        e.1 += display_tokens(
            p.input_tokens,
            p.output_tokens,
            p.cache_create_5m_tokens,
            p.cache_create_1h_tokens,
        );
    }
    let mut by_project: Vec<DayGroupCost> = proj_map
        .into_iter()
        .map(|(k, (cost, tokens))| DayGroupCost {
            key: k,
            cost: round6(cost),
            tokens,
        })
        .collect();
    by_project.sort_by(|a, b| {
        b.cost
            .partial_cmp(&a.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut hourly: Vec<DayHourCost> = (0..24)
        .map(|h| DayHourCost {
            hour: h,
            cost: 0.0,
            tokens: 0,
        })
        .collect();
    for r in &hour_rows {
        if !(0..24).contains(&r.hour) {
            continue;
        }
        let u = usage(
            r.input_tokens,
            r.output_tokens,
            r.cache_read_tokens,
            r.cache_create_5m_tokens,
            r.cache_create_1h_tokens,
        );
        let slot = &mut hourly[r.hour as usize];
        slot.cost += price(&r.model, &u);
        slot.tokens += display_tokens(
            r.input_tokens,
            r.output_tokens,
            r.cache_create_5m_tokens,
            r.cache_create_1h_tokens,
        );
    }
    for sl in &mut hourly {
        sl.cost = round6(sl.cost);
    }

    let turns_by_id: std::collections::HashMap<String, i64> = turn_rows
        .into_iter()
        .map(|t| (t.session_id, t.turns))
        .collect();
    let mut sess_map: std::collections::HashMap<String, DaySessionCost> =
        std::collections::HashMap::new();
    for r in &sess_rows {
        let u = usage(
            r.input_tokens,
            r.output_tokens,
            r.cache_read_tokens,
            r.cache_create_5m_tokens,
            r.cache_create_1h_tokens,
        );
        let c = price(&r.model, &u);
        let tok = display_tokens(
            r.input_tokens,
            r.output_tokens,
            r.cache_create_5m_tokens,
            r.cache_create_1h_tokens,
        );
        let entry = sess_map
            .entry(r.session_id.clone())
            .or_insert_with(|| DaySessionCost {
                id: r.session_id.clone(),
                project: r.project_slug.clone(),
                started: r.started.clone(),
                turns: *turns_by_id.get(&r.session_id).unwrap_or(&0),
                tokens: 0,
                cost: 0.0,
            });
        entry.cost += c;
        entry.tokens += tok;
        if r.started < entry.started {
            entry.started = r.started.clone();
        }
    }
    let mut sessions: Vec<DaySessionCost> = sess_map.into_values().collect();
    for se in &mut sessions {
        se.cost = round6(se.cost);
    }
    sessions.sort_by(|a, b| {
        b.cost
            .partial_cmp(&a.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(Json(DayResponse {
        date,
        kpis: DayKpis {
            cost_usd: round4(total_cost),
            input_tokens: ti,
            output_tokens: to,
            cache_read_tokens: tcr,
            cache_create_tokens: tcc,
            turns: totals.turns,
            sessions: totals.sessions,
        },
        sessions,
        by_project,
        by_model,
        hourly,
    }))
}

#[derive(Deserialize, Default)]
pub(crate) struct CacheStatsQuery {
    pub(crate) days: Option<u32>,
}

pub(crate) async fn cache_stats_handler(
    State(s): State<AppState>,
    Query(q): Query<CacheStatsQuery>,
) -> Result<Json<token_dashboard_core::cache_stats::CacheTrend>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::cache_stats::cache_trend(path.as_ref(), days)).await
}

#[derive(Deserialize)]
pub(crate) struct CacheSessionsQuery {
    pub(crate) date: String,
}

pub(crate) async fn cache_sessions_handler(
    State(s): State<AppState>,
    Query(q): Query<CacheSessionsQuery>,
) -> Result<Json<Vec<token_dashboard_core::cache_stats::SessionCacheRow>>, ApiError> {
    if q.date.len() != 10 {
        return Err(ApiError::bad_request("date must be YYYY-MM-DD"));
    }
    let path = s.db_path.clone();
    let date = q.date;
    blocking(move || token_dashboard_core::cache_stats::sessions_for_day(path.as_ref(), &date))
        .await
}

#[derive(Deserialize, Default)]
pub(crate) struct BurnRateQuery {
    pub(crate) window_days: Option<u32>,
}

pub(crate) async fn burn_rate_handler(
    State(s): State<AppState>,
    Query(q): Query<BurnRateQuery>,
) -> Result<Json<token_dashboard_core::burn_rate::BurnRate>, ApiError> {
    let window = q.window_days.unwrap_or(7).clamp(1, 90);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::burn_rate::burn_rate(path.as_ref(), window)).await
}

#[derive(Deserialize, Default)]
pub(crate) struct AnomalyQuery {
    pub(crate) days: Option<u32>,
    pub(crate) k: Option<f64>,
}

pub(crate) async fn anomalies_handler(
    State(s): State<AppState>,
    Query(q): Query<AnomalyQuery>,
) -> Result<Json<Vec<token_dashboard_core::anomaly::Anomaly>>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let k = q.k.unwrap_or(3.0).max(0.5);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::anomaly::detect_db(path.as_ref(), days, k)).await
}

#[derive(Serialize)]
pub(crate) struct ModelRowWithCost {
    #[serde(flatten)]
    pub(crate) row: ModelRow,
    pub(crate) cost_usd: f64,
}

pub(crate) async fn by_model(
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

#[derive(Deserialize, Default)]
pub(crate) struct ModelEfficiencyQuery {
    pub(crate) days: Option<u32>,
}

pub(crate) async fn model_efficiency_handler(
    State(s): State<AppState>,
    Query(q): Query<ModelEfficiencyQuery>,
) -> Result<Json<Vec<token_dashboard_core::model_efficiency::ModelRow>>, ApiError> {
    let days = q.days.unwrap_or(30).clamp(1, 365);
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    blocking(
        move || -> rusqlite::Result<Vec<token_dashboard_core::model_efficiency::ModelRow>> {
            let conn = rusqlite::Connection::open(path.as_ref())?;
            conn.busy_timeout(std::time::Duration::from_secs(30))?;
            token_dashboard_core::model_efficiency::leaderboard_with_pricing(&conn, days, &pricing)
        },
    )
    .await
}

pub(crate) async fn tags(State(s): State<AppState>) -> Result<Json<Vec<TagRow>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || all_tags(path.as_ref())).await
}

#[derive(Serialize)]
pub(crate) struct TagSummaryRow {
    pub(crate) tag: String,
    pub(crate) sessions: i64,
    pub(crate) total_tokens: i64,
    pub(crate) cost_usd: f64,
    pub(crate) first_seen: Option<String>,
    pub(crate) last_seen: Option<String>,
}

pub(crate) async fn tags_summary(
    State(s): State<AppState>,
) -> Result<Json<Vec<TagSummaryRow>>, ApiError> {
    let path_a = s.db_path.clone();
    let path_b = s.db_path.clone();
    let aggregates = blocking(move || tag_aggregates(path_a.as_ref())).await?.0;
    let counts = blocking(move || tag_session_counts(path_b.as_ref()))
        .await?
        .0;
    let pricing = s.pricing.clone();

    let mut by_tag: std::collections::BTreeMap<String, TagSummaryRow> = Default::default();
    for row in aggregates {
        let entry = by_tag
            .entry(row.tag.clone())
            .or_insert_with(|| TagSummaryRow {
                tag: row.tag.clone(),
                sessions: 0,
                total_tokens: 0,
                cost_usd: 0.0,
                first_seen: None,
                last_seen: None,
            });
        let cost = row
            .model
            .as_deref()
            .map(|m| {
                cost_for(
                    m,
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
                .unwrap_or(0.0)
            })
            .unwrap_or(0.0);
        entry.cost_usd += cost;
        entry.total_tokens += row.input_tokens
            + row.output_tokens
            + row.cache_read_tokens
            + row.cache_create_5m_tokens
            + row.cache_create_1h_tokens;
        entry.first_seen = match (entry.first_seen.take(), row.first_seen) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        entry.last_seen = match (entry.last_seen.take(), row.last_seen) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }

    for c in counts {
        if let Some(entry) = by_tag.get_mut(&c.tag) {
            entry.sessions = c.sessions;
        } else {
            // Tag exists with sessions but no assistant messages — still
            // surface it so users can prune empty tags from the UI.
            by_tag.insert(
                c.tag.clone(),
                TagSummaryRow {
                    tag: c.tag,
                    sessions: c.sessions,
                    total_tokens: 0,
                    cost_usd: 0.0,
                    first_seen: None,
                    last_seen: None,
                },
            );
        }
    }

    let mut out: Vec<TagSummaryRow> = by_tag
        .into_values()
        .map(|mut r| {
            r.cost_usd = round4(r.cost_usd);
            r
        })
        .collect();
    out.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.tag.cmp(&b.tag))
    });
    Ok(Json(out))
}

#[derive(Deserialize, Default)]
pub(crate) struct HourlyQs {
    #[serde(default)]
    pub(crate) hours: Option<i64>,
    #[serde(default)]
    pub(crate) provider: Option<String>,
}

/// One slot in the hourly response — fields the frontend's
/// `buildHourly` / `buildBurn` consume. The slot at index
/// `hours - 1 - hour_ago` represents activity that ended N hours ago,
/// so `arr[arr.length - 1]` is the current hour.
#[derive(Serialize, Default)]
pub(crate) struct HourlySlot {
    pub(crate) hour_ago: i64,
    pub(crate) cost_usd: f64,
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) cache_read_tokens: i64,
    pub(crate) cache_create_5m_tokens: i64,
    pub(crate) cache_create_1h_tokens: i64,
}

pub(crate) async fn hourly(
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

#[derive(Deserialize)]
pub(crate) struct ActivityQs {
    pub(crate) days: Option<i64>,
    pub(crate) provider: Option<String>,
}

/// Activity heatmap: turn counts bucketed by local weekday and hour over the
/// last `days` days (default 7). Aggregated in SQL with no session-row cap,
/// so it reflects the whole window rather than the most recent N sessions.
pub(crate) async fn activity(
    State(s): State<AppState>,
    Query(q): Query<ActivityQs>,
) -> Result<Json<Vec<HeatmapCell>>, ApiError> {
    let path = s.db_path.clone();
    let days = q.days.unwrap_or(7).max(1);
    let provider = q.provider.clone();
    let rows = blocking(move || activity_heatmap(path.as_ref(), days, provider.as_deref()))
        .await?
        .0;
    Ok(Json(rows))
}

#[derive(Serialize, Default, Clone, Copy)]
pub(crate) struct PhaseBin {
    pub(crate) turns: i64,
    pub(crate) billable_tokens: i64,
    pub(crate) cache_read_tokens: i64,
    pub(crate) cost_usd: f64,
    pub(crate) cost_estimated: bool,
}

#[derive(Serialize)]
pub(crate) struct PhaseSplitResponse {
    pub(crate) plan: PhaseBin,
    pub(crate) execute: PhaseBin,
    pub(crate) other: PhaseBin,
}

pub(crate) async fn phase_split_endpoint(
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

#[derive(Deserialize)]
pub(crate) struct PlanBody {
    pub(crate) plan: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct OkResponse {
    pub(crate) ok: bool,
}

pub(crate) async fn set_plan_handler(
    State(s): State<AppState>,
    Json(body): Json<PlanBody>,
) -> Result<Json<OkResponse>, ApiError> {
    let path = s.db_path.clone();
    let plan = body.plan.unwrap_or_else(|| "api".into());
    blocking_unit(move || -> rusqlite::Result<()> {
        set_plan(path.as_ref(), &plan)?;
        // Switching to a subscription plan: clear USD budgets so the
        // History card stops attributing stale "% of $X budget" to months
        // where the cap doesn't apply. The user can re-enter values after
        // switching back to API mode.
        if plan != "api" {
            for key in token_dashboard_core::preferences::BUDGET_KEYS {
                let _ = token_dashboard_core::preferences::set_budget(path.as_ref(), key, None);
            }
        }
        Ok(())
    })
    .await?;
    Ok(Json(OkResponse { ok: true }))
}

#[derive(Deserialize)]
pub(crate) struct TipDismissBody {
    pub(crate) key: Option<String>,
}

pub(crate) async fn tips_dismiss_handler(
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
pub(crate) struct SessionTagsBody {
    #[serde(default)]
    pub(crate) add: Vec<String>,
    #[serde(default)]
    pub(crate) remove: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct SessionTagsResponse {
    pub(crate) ok: bool,
    pub(crate) added: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) tags: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct PreferencesResponse {
    pub(crate) badge_metric: String,
    pub(crate) badge_window_mode: String,
    pub(crate) badge_dock_enabled: bool,
    pub(crate) badge_menubar_enabled: bool,
    pub(crate) limits_enabled: bool,
    pub(crate) advanced_mode: bool,
    pub(crate) multi_provider_enabled: bool,
    pub(crate) theme: Option<String>,
    pub(crate) glass_enabled: bool,
    pub(crate) glass_opacity: i64,
    pub(crate) limits_five_hour_reset_at: Option<String>,
    pub(crate) limits_weekly_reset_at: Option<String>,
    pub(crate) limits_5h_cap_override: Option<i64>,
    pub(crate) limits_weekly_cap_override: Option<i64>,
    pub(crate) limits_source: String,
    pub(crate) widget_metrics: Vec<String>,
    pub(crate) widget_open: bool,
}

pub(crate) async fn preferences_get(
    State(s): State<AppState>,
) -> Result<Json<PreferencesResponse>, ApiError> {
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

#[derive(Deserialize, Default)]
pub(crate) struct PreferencesBody {
    #[serde(default)]
    pub(crate) badge_metric: Option<String>,
    #[serde(default)]
    pub(crate) badge_window_mode: Option<String>,
    #[serde(default)]
    pub(crate) glass_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) glass_opacity: Option<i64>,
    #[serde(default)]
    pub(crate) badge_dock_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) badge_menubar_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) limits_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) advanced_mode: Option<bool>,
    #[serde(default)]
    pub(crate) multi_provider_enabled: Option<bool>,
    #[serde(default)]
    pub(crate) theme: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub(crate) limits_five_hour_reset_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub(crate) limits_weekly_reset_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub(crate) limits_5h_cap_override: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub(crate) limits_weekly_cap_override: Option<Option<i64>>,
    #[serde(default)]
    pub(crate) limits_source: Option<String>,
    #[serde(default)]
    pub(crate) widget_metrics: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) widget_open: Option<bool>,
}

pub(crate) async fn preferences_post(
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
pub(crate) struct BudgetResponse {
    pub(crate) daily: Option<f64>,
    pub(crate) weekly: Option<f64>,
    pub(crate) monthly: Option<f64>,
}

pub(crate) async fn budget_alerts_handler(
    State(s): State<AppState>,
) -> Result<Json<token_dashboard_core::budget_alerts::AlertResult>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_alerts::check(path.as_ref())).await
}

pub(crate) async fn budget_alerts_config_get(
    State(s): State<AppState>,
) -> Result<Json<token_dashboard_core::budget_alerts::AlertsConfig>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_alerts::get_config(path.as_ref())).await
}

#[derive(Deserialize, Default)]
pub(crate) struct BudgetAlertsConfigBody {
    #[serde(default)]
    pub(crate) thresholds: Option<Vec<u32>>,
    #[serde(default)]
    pub(crate) muted: Option<Vec<u32>>,
}

pub(crate) async fn budget_alerts_config_post(
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

pub(crate) async fn budget_projects_get(
    State(s): State<AppState>,
) -> Result<Json<Vec<token_dashboard_core::budget_projects::ProjectAllocation>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_projects::allocations(path.as_ref())).await
}

#[derive(Deserialize)]
pub(crate) struct ProjectBudgetBody {
    pub(crate) slug: String,
    #[serde(default)]
    pub(crate) amount: Option<f64>,
}

pub(crate) async fn budget_projects_post(
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

#[derive(Deserialize, Default)]
pub(crate) struct BudgetHistoryQuery {
    pub(crate) months: Option<u32>,
}

pub(crate) async fn budget_history_get(
    State(s): State<AppState>,
    Query(q): Query<BudgetHistoryQuery>,
) -> Result<Json<Vec<token_dashboard_core::budget_history::MonthRow>>, ApiError> {
    let months = q.months.unwrap_or(6).clamp(1, 36);
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::budget_history::history(path.as_ref(), months)).await
}

pub(crate) async fn budget_get(
    State(s): State<AppState>,
) -> Result<Json<BudgetResponse>, ApiError> {
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
pub(crate) struct BudgetBody {
    #[serde(default)]
    pub(crate) daily: Option<f64>,
    #[serde(default)]
    pub(crate) weekly: Option<f64>,
    #[serde(default)]
    pub(crate) monthly: Option<f64>,
}

pub(crate) async fn budget_post(
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
pub(crate) struct LimitsResponse {
    pub(crate) enabled: bool,
    pub(crate) limits_five_hour_reset_at: Option<String>,
    pub(crate) limits_weekly_reset_at: Option<String>,
    pub(crate) limits_5h_cap_override: Option<i64>,
    pub(crate) limits_weekly_cap_override: Option<i64>,
    pub(crate) last_sync_at: Option<String>,
    pub(crate) last_sync_status: Option<String>,
    // Live snapshot consumed by the Overview "Plan limits remaining" card
    // and the Settings calibrator (which reads `five_hour.used`).
    #[serde(flatten)]
    pub(crate) snapshot: LimitsSnapshot,
}

#[derive(Serialize)]
pub(crate) struct LimitsSyncResponse {
    pub(crate) status: String,
    pub(crate) limits_five_hour_reset_at: Option<String>,
    pub(crate) limits_weekly_reset_at: Option<String>,
    pub(crate) limits_last_sync_at: Option<String>,
    pub(crate) limits_last_sync_status: Option<String>,
}

pub(crate) async fn limits_get(
    State(s): State<AppState>,
) -> Result<Json<LimitsResponse>, ApiError> {
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
pub(crate) struct SourceToggleBody {
    #[serde(default)]
    pub(crate) enabled: bool,
}

#[derive(Serialize)]
pub(crate) struct SourceToggleResponse {
    pub(crate) ok: bool,
    pub(crate) name: String,
    pub(crate) enabled: bool,
}

pub(crate) async fn sources_toggle(
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
pub(crate) struct SourceDeleteResponse {
    pub(crate) ok: bool,
    pub(crate) name: String,
}

pub(crate) async fn sources_add(
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
pub(crate) struct ImportResponse {
    pub(crate) ok: bool,
    pub(crate) messages_added: i64,
    pub(crate) tool_calls_imported: i64,
    pub(crate) tags_added: i64,
}

pub(crate) async fn import_db(
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

pub(crate) async fn sources_delete(
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
pub(crate) struct PricingPayload {
    pub(crate) defaults: serde_json::Value,
    pub(crate) overrides: serde_json::Value,
    pub(crate) effective: serde_json::Value,
}

pub(crate) fn pricing_payload(defaults: &token_dashboard_core::Pricing) -> serde_json::Value {
    serde_json::to_value(&defaults.models).unwrap_or(serde_json::Value::Null)
}

pub(crate) fn build_pricing_payload(
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

pub(crate) async fn pricing_get(
    State(s): State<AppState>,
) -> Result<Json<PricingPayload>, ApiError> {
    let path = s.db_path.clone();
    let pricing = s.pricing.clone();
    let payload = blocking(move || -> rusqlite::Result<PricingPayload> {
        let overrides = token_dashboard_core::pricing::get_pricing_overrides(path.as_ref())?;
        Ok(build_pricing_payload(&pricing, &overrides))
    })
    .await?;
    Ok(payload)
}

pub(crate) async fn pricing_set(
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

pub(crate) async fn pricing_clear(
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
pub(crate) struct SessionExportRow {
    pub(crate) session_id: String,
    pub(crate) project_slug: String,
    pub(crate) project_name: String,
    pub(crate) started: Option<String>,
    pub(crate) ended: Option<String>,
    pub(crate) turns: i64,
    pub(crate) tokens: i64,
    pub(crate) cost_usd: f64,
    pub(crate) model: Option<String>,
    pub(crate) tags: Vec<String>,
    pub(crate) first_prompt: Option<String>,
}

pub(crate) fn compute_session_export(
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

pub(crate) async fn export_csv(
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
        axum::http::HeaderValue::from_static("text/csv; charset=utf-8"),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_static(
            "attachment; filename=\"token-dashboard-sessions.csv\"",
        ),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

pub(crate) async fn export_json(
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
        axum::http::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_static(
            "attachment; filename=\"token-dashboard-sessions.json\"",
        ),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

pub(crate) async fn export_db(
    State(s): State<AppState>,
) -> Result<axum::response::Response, ApiError> {
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
        axum::http::HeaderValue::from_static("application/x-sqlite3"),
    );
    headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"token-dashboard-{stamp}.db\"")
            .parse()
            .unwrap(),
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(resp)
}

pub(crate) async fn pricing_clear_all(
    State(s): State<AppState>,
) -> Result<Json<PricingPayload>, ApiError> {
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

pub(crate) async fn tips_handler(State(s): State<AppState>) -> Result<Json<Vec<Tip>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || all_tips(path.as_ref(), None)).await
}

#[derive(Deserialize, Default)]
pub(crate) struct LoopsQuery {
    pub(crate) min_run: Option<u32>,
    pub(crate) days: Option<u32>,
}

pub(crate) async fn loops_get(
    State(s): State<AppState>,
    Query(q): Query<LoopsQuery>,
) -> Result<Json<Vec<token_dashboard_core::loop_detector::StuckRun>>, ApiError> {
    let path = s.db_path.clone();
    let min_run = q.min_run.unwrap_or(3).clamp(2, 1000);
    let days = q.days.unwrap_or(30).clamp(1, 365);
    blocking(move || token_dashboard_core::loop_detector::detect_path(path.as_ref(), min_run, days))
        .await
}

pub(crate) async fn session_tags_post(
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

#[derive(Deserialize, Default)]
pub(crate) struct PromptsQs {
    #[serde(default)]
    pub(crate) limit: Option<i64>,
    #[serde(default)]
    pub(crate) sort: Option<String>,
    #[serde(default)]
    pub(crate) since: Option<String>,
    #[serde(default)]
    pub(crate) until: Option<String>,
    #[serde(default)]
    pub(crate) q: Option<String>,
    #[serde(default)]
    pub(crate) provider: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct PromptResponse {
    #[serde(flatten)]
    pub(crate) row: ExpensivePromptRow,
    /// Full priced cost for the assistant turn that follows this prompt:
    /// input + output + cache-create + cache-read at the model's rates.
    pub(crate) estimated_cost_usd: Option<f64>,
}

pub(crate) async fn prompts(
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

#[derive(Serialize)]
pub(crate) struct EnrichedSkillRow {
    #[serde(flatten)]
    pub(crate) base: SkillRow,
    pub(crate) tokens_per_call: Option<i64>,
    /// `invocations × tokens_per_call`. None when the catalog has no
    /// entry for this slug (project-local or subagent-dispatched
    /// skills — see KNOWN_LIMITATIONS.md).
    pub(crate) est_tokens: Option<i64>,
    /// Sonnet-priced cost estimate. Models the typical loading
    /// pattern: first load per session at cache-write rate, subsequent
    /// loads at cache-read.
    pub(crate) est_cost_usd: Option<f64>,
    /// Always true when `est_tokens` is populated — the values are
    /// derived (not billing-truthy).
    pub(crate) estimated: bool,
}

pub(crate) async fn skills(
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
pub(crate) struct PlanResponse {
    pub(crate) plan: String,
}

pub(crate) async fn plan(State(s): State<AppState>) -> Result<Json<PlanResponse>, ApiError> {
    let path = s.db_path.clone();
    let plan = blocking(move || get_plan(path.as_ref())).await?.0;
    Ok(Json(PlanResponse { plan }))
}

pub(crate) async fn session(
    State(s): State<AppState>,
    AxumPath(sid): AxumPath<String>,
) -> Result<Json<Vec<SessionTurn>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || session_turns(path.as_ref(), &sid)).await
}

#[derive(Deserialize, Default)]
pub(crate) struct SessionsQs {
    #[serde(default)]
    pub(crate) limit: Option<i64>,
    #[serde(default)]
    pub(crate) since: Option<String>,
    #[serde(default)]
    pub(crate) until: Option<String>,
    #[serde(default)]
    pub(crate) tag: Option<String>,
    #[serde(default)]
    pub(crate) provider: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct SessionsResponse {
    #[serde(flatten)]
    pub(crate) base: SessionRow,
    pub(crate) cost_usd: f64,
    pub(crate) cost_estimated: bool,
    /// Top-billable model in this session (or null if no assistant turns).
    pub(crate) model: Option<String>,
    pub(crate) tags: Vec<String>,
    /// First non-empty user prompt in the session — populates the "first
    /// prompt" column in the sessions list.
    pub(crate) first_prompt: Option<String>,
}

pub(crate) async fn sessions(
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

// --- multi-machine sync (plan 11) ---------------------------------------
//
// Host side: `/api/sync/snapshot` returns every message + tool_call newer
// than `?since=`, gated by a Bearer token from the env var
// `TOKEN_DASHBOARD_SYNC_TOKEN`. The endpoint is disabled (503) when the
// env var is unset so a careless `cargo run` doesn't expose data on a
// shared box. Tokens never round-trip through preferences — only the
// viewer that initiates the pull stores them.
//
// Viewer side: `/api/remote-sources` is a CRUD over the local
// `remote_sources` table. `POST /api/remote-sources/:id/sync` triggers
// a one-shot pull + merge for that source.

#[derive(Deserialize, Default)]
pub(crate) struct SnapshotQuery {
    pub(crate) since: Option<String>,
}

pub(crate) async fn sync_snapshot_handler(
    State(s): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<SnapshotQuery>,
) -> Result<Json<token_dashboard_core::sync_snapshot::Snapshot>, ApiError> {
    let expected = std::env::var("TOKEN_DASHBOARD_SYNC_TOKEN").ok();
    if expected.as_deref().unwrap_or("").is_empty() {
        return Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            msg: "sync disabled — set TOKEN_DASHBOARD_SYNC_TOKEN to share this DB".into(),
        });
    }
    let provided = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    if provided != expected.as_deref() {
        return Err(ApiError {
            status: StatusCode::UNAUTHORIZED,
            msg: "bearer token mismatch".into(),
        });
    }
    let path = s.db_path.clone();
    let since = q.since;
    blocking(move || token_dashboard_core::sync_snapshot::build(path.as_ref(), since.as_deref()))
        .await
}

#[derive(Deserialize)]
pub(crate) struct AddRemoteBody {
    pub(crate) label: String,
    pub(crate) base_url: String,
    pub(crate) bearer: Option<String>,
}

pub(crate) async fn remote_sources_list(
    State(s): State<AppState>,
) -> Result<Json<Vec<token_dashboard_core::remote_sources::RemoteSource>>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || token_dashboard_core::remote_sources::list(path.as_ref())).await
}

pub(crate) async fn remote_sources_add(
    State(s): State<AppState>,
    Json(body): Json<AddRemoteBody>,
) -> Result<Json<token_dashboard_core::remote_sources::RemoteSource>, ApiError> {
    let path = s.db_path.clone();
    blocking(move || {
        token_dashboard_core::remote_sources::add(
            path.as_ref(),
            &body.label,
            &body.base_url,
            body.bearer.as_deref().filter(|s| !s.is_empty()),
        )
    })
    .await
}

pub(crate) async fn remote_sources_delete(
    State(s): State<AppState>,
    AxumPath(id): AxumPath<i64>,
) -> Result<StatusCode, ApiError> {
    let path = s.db_path.clone();
    let ok = blocking_unit(move || {
        token_dashboard_core::remote_sources::delete(path.as_ref(), id).map(|_| ())
    })
    .await;
    ok?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
pub(crate) struct ToggleBody {
    pub(crate) enabled: Option<bool>,
}

pub(crate) async fn remote_sources_toggle(
    State(s): State<AppState>,
    AxumPath(id): AxumPath<i64>,
    Json(body): Json<ToggleBody>,
) -> Result<StatusCode, ApiError> {
    let want = body.enabled.unwrap_or(true);
    let path = s.db_path.clone();
    let ok = blocking_unit(move || {
        token_dashboard_core::remote_sources::set_enabled(path.as_ref(), id, want).map(|_| ())
    })
    .await;
    ok?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn remote_sources_sync(
    State(s): State<AppState>,
    AxumPath(id): AxumPath<i64>,
) -> Result<Json<token_dashboard_core::sync_snapshot::MergeStats>, ApiError> {
    let path = s.db_path.clone();
    let join_result = tokio::task::spawn_blocking(move || {
        crate::remote_sync::pull_remote_once(path.as_ref(), id)
    })
    .await;
    let stats = join_result
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
        .map_err(ApiError::internal)?;
    Ok(Json(stats))
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
        .route("/api/tool-costs", get(tool_costs_handler))
        .route("/api/verbosity", get(verbosity_handler))
        .route("/api/sync/snapshot", get(sync_snapshot_handler))
        .route(
            "/api/remote-sources",
            get(remote_sources_list).post(remote_sources_add),
        )
        .route(
            "/api/remote-sources/:id",
            axum::routing::delete(remote_sources_delete),
        )
        .route(
            "/api/remote-sources/:id/toggle",
            post(remote_sources_toggle),
        )
        .route("/api/remote-sources/:id/sync", post(remote_sources_sync))
        .route("/api/daily", get(daily))
        .route("/api/day", get(day))
        .route("/api/cache-stats", get(cache_stats_handler))
        .route("/api/cache-stats/sessions", get(cache_sessions_handler))
        .route("/api/burn-rate", get(burn_rate_handler))
        .route("/api/anomalies", get(anomalies_handler))
        .route("/api/by-model", get(by_model))
        .route("/api/model_efficiency", get(model_efficiency_handler))
        .route("/api/tags", get(tags))
        .route("/api/tags-summary", get(tags_summary))
        .route("/api/hourly", get(hourly))
        .route("/api/activity", get(activity))
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
        .route("/api/loops", get(loops_get))
        .route(
            "/api/preferences",
            get(preferences_get).post(preferences_post),
        )
        .route("/api/budget", get(budget_get).post(budget_post))
        .route(
            "/api/budget/projects",
            get(budget_projects_get).post(budget_projects_post),
        )
        .route("/api/budget/history", get(budget_history_get))
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
