//! Token Dashboard 4.0 core.
//!
//! Library for ingesting Claude Code session transcripts (JSONL files in
//! `~/.claude/projects/`) into a local SQLite store and querying them for
//! cost, usage, and session analytics.
//!
//! See the [`scanner`], [`db`], [`queries`], and [`pricing`] modules for the
//! main entry points.

#![warn(rustdoc::broken_intra_doc_links)]

pub mod anthropic_sync;
pub mod burn_rate;
pub mod cache_stats;
pub mod credentials;
pub mod db;
pub mod limits;
pub mod preferences;
pub mod pricing;
pub mod providers;
pub mod queries;
pub mod scanner;
pub mod skills_catalog;
pub mod sources;
pub mod tips;

pub use db::{default_db_path, init_db, open};
pub use limits::{compute_limits, LimitWindow, LimitsSnapshot};
pub use pricing::{cost_for, CostResult, Pricing, Usage};
pub use scanner::{scan_dir, scan_file, ScanStats};
pub use sources::{list_sources, Source};
