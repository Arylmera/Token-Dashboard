//! Token Dashboard 4.0 core.
//!
//! Phase 1 surface: SQLite schema + migrations and the JSONL transcript
//! scanner. Endpoints, tips, and HTTP wiring land in later phases.

pub mod db;
pub mod preferences;
pub mod pricing;
pub mod queries;
pub mod scanner;
pub mod sources;

pub use db::{default_db_path, init_db, open};
pub use pricing::{cost_for, CostResult, Pricing, Usage};
pub use scanner::{scan_dir, scan_file, ScanStats};
pub use sources::{list_sources, Source};
