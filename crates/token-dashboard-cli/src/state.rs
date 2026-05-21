// Auto-split from lib.rs — AppState + shared query types.
use std::path::PathBuf;
use std::sync::Arc;

use serde::Deserialize;
use token_dashboard_core::Pricing;
use tokio::sync::broadcast;

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

#[derive(Deserialize, Default, Clone)]
pub(crate) struct RangeQs {
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    /// Optional provider filter for multi-AI support. Accepts a single id
    /// (`"claude"`, `"codex"`, `"ollama"`), a comma-separated list
    /// (`"claude,codex"`), `"all"`, or omitted — all four behave as
    /// no-filter on v4.0.x data where every row is `'claude'`. Threaded
    /// through queries that join `messages` / `tool_calls`.
    #[serde(default)]
    pub(crate) provider: Option<String>,
}
