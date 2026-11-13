use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

pub type Result<T> = core::result::Result<T, AppError>;

// Client facing errors
#[derive(Debug, Clone)]
pub enum AppError {
    NotFound(&'static str),
    BadRequest(&'static str),
    /// Missing or rejected credentials. The mod restarts the handshake on this.
    Unauthorized(&'static str),
    /// Something we depend on, Mojang in practice, is down. The mod retries later on this.
    ServiceUnavailable(&'static str),
    InternalServerError,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::NotFound(msg) => {
                (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
            }
            AppError::BadRequest(msg) => {
                (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
            AppError::Unauthorized(msg) => (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, "Bearer")],
                Json(json!({ "error": msg })),
            )
                .into_response(),
            AppError::ServiceUnavailable(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": msg })),
            )
                .into_response(),
            AppError::InternalServerError => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    }
}
