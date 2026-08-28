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
    /// Serializes `scan_dir`. Three paths trigger scans — the poll loop,
    /// the transcript watcher, and `/api/scan` — and on a large history a
    /// pass takes tens of seconds. Overlapping passes fight over the same
    /// sqlite writer and stack up on the blocking pool, so every scan
    /// takes this first.
    pub scan_lock: Arc<tokio::sync::Mutex<()>>,
    /// Last scan failure, if the most recent scan failed. Scans run
    /// unattended, so a persistent failure used to show up only as a
    /// `warn` line nobody reads while the dashboard quietly served
    /// older and older numbers. Transitions publish a `scan_error`
    /// event; see `scan::run_scan_and_broadcast`.
    pub scan_error: Arc<tokio::sync::Mutex<Option<String>>>,
    /// Running "share this machine" listener (0.0.0.0 sync host), if
    /// any. `sync_host::apply_share_config` aborts and replaces it when
    /// the preference changes.
    pub share: Arc<tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>,
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
            scan_lock: Arc::new(tokio::sync::Mutex::new(())),
            scan_error: Arc::new(tokio::sync::Mutex::new(None)),
            share: Arc::new(tokio::sync::Mutex::new(None)),
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
