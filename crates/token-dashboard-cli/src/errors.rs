// Auto-split from lib.rs — ApiError + blocking helpers.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
};

/// Run a blocking rusqlite call on tokio's blocking pool and wrap the
/// result/error in a `Json<T>` response. The closure is `Send + 'static`
/// because spawn_blocking runs it on a worker thread.
pub(crate) async fn blocking<F, T, E>(f: F) -> Result<Json<T>, ApiError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let v = tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
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
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::internal(format!("join: {e}")))?
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
