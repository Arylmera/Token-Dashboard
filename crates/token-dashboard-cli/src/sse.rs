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

/// `/api/stream` — server-sent events.
///
/// Wraps the AppState broadcast channel into an SSE response. axum
/// drives a 15s keep-alive ping (matches the python heartbeat cadence
/// in `server/sse.py`) so webkit2gtk doesn't drop the connection
/// (plan §R1 trip wire). Initial `hello` event is emitted on connect
/// so the client can confirm the stream is alive before any real
/// publish lands.
pub(crate) async fn stream(
    State(s): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
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
