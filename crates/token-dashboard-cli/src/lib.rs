//! Library surface of the cli crate. Exposes the axum router so
//! integration tests can hit handlers without binding a port.
//!
//! Implementation split into submodules during Phase 3 refactor; this
//! file intentionally contains only module declarations and re-exports.

mod errors;
mod oauth;
pub mod remote_sync;
mod routes;
mod scan;
mod sse;
mod state;
mod util;

pub use oauth::spawn_startup_oauth_sync;
pub use remote_sync::{pull_all_enabled, pull_remote_once, spawn_remote_sync_loop};
pub use routes::app;
pub use scan::spawn_scan_loop;
pub use state::AppState;
