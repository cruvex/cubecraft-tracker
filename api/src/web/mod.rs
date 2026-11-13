use crate::app::state::AppState;
use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;

pub mod auth;
pub mod middleware;
pub mod params;
pub mod routes;

pub fn app_router(state: AppState) -> Router {
    Router::new()
        .merge(routes::auth::routes())
        .merge(routes::game::routes())
        .merge(routes::player::routes())
        .merge(routes::server::routes())
        .route("/api/healthz", get(|| async { "OK" }))
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
        .layer(axum::middleware::from_fn(
            middleware::mw_req_log::mw_req_log,
        ))
        .with_state(state)
}
