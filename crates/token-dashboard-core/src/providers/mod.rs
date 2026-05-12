//! Provider abstraction for multi-AI ingest.
//!
//! Each provider (Claude Code, OpenAI Codex CLI, Ollama, …) implements
//! [`Provider`] and writes rows into the shared `messages` / `tool_calls` /
//! `files` tables with its own `provider` discriminator. The query layer
//! filters/aggregates across providers via the `?provider=` URL parameter.
//!
//! See [`docs/MULTI_PROVIDER_PLAN.md`] for the rollout plan and schema
//! invariants. v4.1 ships [`claude::Claude`] only; Codex and Ollama land in
//! v4.2 / v4.3 with their own files in this module.

use std::path::PathBuf;

pub mod claude;

/// Options passed to [`Provider::scan`].
///
/// `root_override` lets callers point a provider at a non-default location
/// (used by tests and by `CLAUDE_PROJECTS_DIR` for the Claude provider).
/// `db_path` is always required — every provider writes through the same
/// SQLite database the rest of the workspace owns.
#[derive(Debug, Clone)]
pub struct ScanOpts {
    pub db_path: PathBuf,
    pub root_override: Option<PathBuf>,
}

/// Aggregate counters returned by a single provider scan. Mirrors
/// [`crate::scanner::ScanStats`] field-for-field so the existing API surface
/// keeps the same JSON shape — callers building a multi-provider response
/// merge several `ScanReport` values.
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct ScanReport {
    pub provider: &'static str,
    pub messages: u64,
    pub tools: u64,
    pub files: u64,
    pub sessions: Vec<String>,
    pub projects: Vec<String>,
    pub days: Vec<String>,
    pub models: Vec<String>,
    pub min_ts: Option<String>,
    pub max_ts: Option<String>,
}

/// One AI provider's ingest path. Implementations live in sibling modules
/// (`claude`, future `codex`, `ollama`).
///
/// The trait is intentionally narrow — discovery + scan only. Pricing,
/// queries, and limits stay in their own modules and dispatch on the
/// `provider` column at query time.
pub trait Provider: Send + Sync {
    /// Stable identifier written to the `provider` column. Lower-case ASCII;
    /// must match the `DEFAULT` baked into the schema for Claude.
    fn id(&self) -> &'static str;

    /// Human-readable label for UI surfaces (topbar dropdown, table cells).
    fn label(&self) -> &'static str;

    /// Default on-disk location to scan when [`ScanOpts::root_override`] is
    /// `None`. Returning `None` means "no on-disk root" (e.g. Ollama proxy
    /// reads from its own log directory under the DB parent).
    fn default_root(&self) -> Option<PathBuf>;

    /// Run an incremental scan. Implementations must honor the same
    /// watermark contract as [`crate::scanner::scan_dir`]: each file's
    /// `(mtime, bytes_read)` in the `files` table is the resume point.
    fn scan(&self, opts: &ScanOpts) -> rusqlite::Result<ScanReport>;
}

/// Return every provider compiled into this build. v4.1 ships only Claude;
/// v4.2 appends `codex::Codex`, v4.3 appends `ollama::Ollama`.
///
/// The registry is a function (not a static) so call sites pay nothing
/// until a scan is actually requested, and tests can construct ad-hoc
/// providers without touching global state.
pub fn registered() -> Vec<Box<dyn Provider>> {
    vec![Box::new(claude::Claude)]
}

/// Run every registered provider's scan against the same DB, merging
/// reports. Failures from one provider are surfaced immediately — partial
/// progress from earlier providers is already committed by their own
/// transactions, which matches the single-provider behaviour today.
pub fn scan_all(opts: &ScanOpts) -> rusqlite::Result<Vec<ScanReport>> {
    let mut out = Vec::new();
    for p in registered() {
        out.push(p.scan(opts)?);
    }
    Ok(out)
}
