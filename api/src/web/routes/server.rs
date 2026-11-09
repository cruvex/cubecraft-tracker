use crate::app::error::Result;
use crate::app::state::AppState;
use crate::model::population::{ActiveHours, ServerPopulation};
use crate::model::server::ServerStatus;
use crate::service::ServerService;
use crate::web::params::Params;
use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/server/status", get(status))
        .route("/api/server/population", get(population))
        .route("/api/server/active-hours", get(active_hours))
}

async fn status(State(server): State<ServerService>) -> Result<Json<ServerStatus>> {
    Ok(Json(server.status().await?))
}

async fn population(
    Query(params): Query<Params>,
    State(server): State<ServerService>,
) -> Result<Json<ServerPopulation>> {
    let hours = params.clamped("hours", 24.0, 1.0, 8760.0);
    let bucket = params.clamped("bucket", 300.0, 60.0, 86400.0);

    Ok(Json(
        server
            .population(hours, bucket, &params.time_zone())
            .await?,
    ))
}

async fn active_hours(
    Query(params): Query<Params>,
    State(server): State<ServerService>,
) -> Result<Json<ActiveHours>> {
    let days = params.clamped("days", 30.0, 1.0, 365.0);

    Ok(Json(server.active_hours(days, params.time_zone()).await?))
}
