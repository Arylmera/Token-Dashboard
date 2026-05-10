//! Token Dashboard 4.0 headless HTTP server.
//!
//! Phase 2 surface lands incrementally on this binary. Routes live in
//! `lib.rs::app`; this file owns process lifecycle (env, shutdown).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use token_dashboard_cli::{app, AppState};
use token_dashboard_core::{default_db_path, Pricing};

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

    token_dashboard_core::init_db(&db_path)?;

    let pricing = match std::env::var_os("TOKEN_DASHBOARD_PRICING") {
        Some(p) => Pricing::from_file(p).unwrap_or_else(|e| {
            tracing::warn!(error=%e, "could not load TOKEN_DASHBOARD_PRICING; using embedded");
            Pricing::embedded()
        }),
        None => Pricing::embedded(),
    };

    let projects_dir: PathBuf = std::env::var_os("CLAUDE_PROJECTS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Same default as the python __main__: ~/.claude/projects.
            let mut p = token_dashboard_core::default_db_path();
            p.pop(); // drop "token-dashboard.db"
            p.join("projects")
        });

    let state = AppState {
        db_path: Arc::new(db_path),
        pricing: Arc::new(pricing),
        projects_dir: Arc::new(projects_dir),
    };

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}");

    axum::serve(listener, app(state))
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
