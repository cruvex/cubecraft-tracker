use crate::app::state::AppState;
use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;

pub mod middleware;

pub fn app_router(state: AppState) -> Router {
    Router::new()
        .route("/api/healthz", get(|| async { "OK" }))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
        .layer(axum::middleware::from_fn(middleware::mw_req_log::mw_req_log))
        .with_state(state)
}
