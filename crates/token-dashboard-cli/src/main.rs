//! Token Dashboard 4.0 headless HTTP server.
//!
//! Phase 2 scaffold per `docs/V4_RUST_TAURI_PLAN.md`. Two endpoints land
//! in this commit to prove the wiring; the rest of the surface (overview,
//! prompts, sessions, tools, daily, hourly, skills, by-model, tips, plan,
//! preferences, limits, tags, phase-split, budget, export.csv, export.db,
//! pricing, stream) ports incrementally on top of this scaffold.
//!
//! Env vars (match the 3.x server in `token_dashboard/__main__.py`):
//!   PORT                  default 8080
//!   HOST                  default 127.0.0.1
//!   TOKEN_DASHBOARD_DB    default ~/.claude/token-dashboard.db
//!   CLAUDE_PROJECTS_DIR   default ~/.claude/projects

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::Serialize;
use token_dashboard_core::{default_db_path, list_sources, Source};

#[derive(Clone)]
struct AppState {
    db_path: Arc<PathBuf>,
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        ok: true,
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn sources(State(s): State<AppState>) -> Result<Json<Vec<Source>>, ApiError> {
    let path = s.db_path.clone();
    let rows = tokio::task::spawn_blocking(move || list_sources(path.as_ref()))
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
        .map_err(|e| ApiError::internal(format!("db: {e}")))?;
    Ok(Json(rows))
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

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "token_dashboard=info,tower_http=info".into()),
        )
        .init();

    let host: String = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = env_or("PORT", 8080u16);
    let db_path: PathBuf = std::env::var_os("TOKEN_DASHBOARD_DB")
        .map(PathBuf::from)
        .unwrap_or_else(default_db_path);

    // Init the schema if the file is missing — matches the 3.x bootstrap
    // (`cli.py dashboard` calls `init_db` before the first scan).
    token_dashboard_core::init_db(&db_path)?;

    let state = AppState {
        db_path: Arc::new(db_path),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/sources", get(sources))
        .with_state(state)
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install ctrl-c handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutting down");
}
