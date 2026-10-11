// Auto-split from lib.rs — ApiError + blocking helpers.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
};

/// Concurrent DB calls. A dashboard refresh fires ~25 requests at once;
/// uncapped, each took its own blocking thread and a burst briefly held
/// ~10 cores, competing with the Claude sessions the dashboard runs beside.
static DB_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// Run `f` on the blocking pool, holding a [`DB_SLOTS`] permit until it
/// returns (moved into the closure, so a dropped request can't free the
/// slot while its query still runs), at background thread priority.
pub(crate) async fn run_db<F, R>(f: F) -> Result<R, ApiError>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let permit = DB_SLOTS
        .acquire()
        .await
        .map_err(|e| ApiError::internal(format!("slots: {e}")))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        background_priority();
        f()
    })
    .await
    .map_err(|e| ApiError::internal(format!("join: {e}")))
}

/// Drop the calling thread below normal priority so query and scan work
/// yields to the user's foreground work under contention. Thread-level on
/// purpose: a lower process priority class would be inherited by the
/// WebView2 processes and slow the UI. No-op off Windows.
pub(crate) fn background_priority() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentThread() -> isize;
            fn SetThreadPriority(thread: isize, priority: i32) -> i32;
        }
        const THREAD_PRIORITY_BELOW_NORMAL: i32 = -1;
        // Safety: plain Win32 call on the current-thread pseudo-handle.
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

/// Run a blocking rusqlite call on tokio's blocking pool and wrap the
/// result/error in a `Json<T>` response. The closure is `Send + 'static`
/// because spawn_blocking runs it on a worker thread.
pub(crate) async fn blocking<F, T, E>(f: F) -> Result<Json<T>, ApiError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let v = run_db(f)
        .await?
        .map_err(|e| ApiError::internal(format!("db: {e}")))?;
    Ok(Json(v))
}

/// Same as `blocking` but for write paths that don't return a body —
/// the caller emits its own response (typically `Json(OkResponse)`).
pub(crate) async fn blocking_unit<F, E>(f: F) -> Result<(), ApiError>
where
    F: FnOnce() -> Result<(), E> + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    run_db(f)
        .await?
        .map_err(|e| ApiError::internal(format!("db: {e}")))
}

#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) status: StatusCode,
    pub(crate) msg: String,
}

impl ApiError {
    pub(crate) fn internal(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            msg: msg.into(),
        }
    }
    pub(crate) fn bad_request(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            msg: msg.into(),
        }
    }
    pub(crate) fn not_found(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
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
