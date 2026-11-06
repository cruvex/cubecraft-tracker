use crate::app::error::Result;
use crate::app::state::AppState;
use crate::model::server::ServerStatus;
use crate::service::ServerService;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/server/status", get(status))
}

async fn status(State(server): State<ServerService>) -> Result<Json<ServerStatus>> {
    Ok(Json(server.status().await?))
}
