use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::model::game::Game;
use crate::model::leaderboard::Leaderboard;
use crate::model::population::GamePopulation;
use crate::service::GameService;
use crate::web::params::{Params, game_id};
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/games", get(games))
        .route("/api/games/{game_id}/leaderboard", get(leaderboard))
        .route("/api/games/{game_id}/population", get(population))
}

async fn games(State(game): State<GameService>) -> Result<Json<Vec<Game>>> {
    Ok(Json(game.games().await?))
}

// Unvalidated, unlike the other routes: anything that is not an id fails in the query.
async fn leaderboard(
    Path(id): Path<String>,
    Query(params): Query<Params>,
    State(game): State<GameService>,
) -> Result<Json<Leaderboard>> {
    let id = id.parse().map_err(|_| AppError::InternalServerError)?;

    Ok(Json(
        game.leaderboard(id, params.number("days", 30.0)).await?,
    ))
}

// Clamped, unlike other routes: this table grows by the minute and would scan the lot.
async fn population(
    Path(id): Path<String>,
    Query(params): Query<Params>,
    State(game): State<GameService>,
) -> Result<Json<GamePopulation>> {
    let id = game_id(&id)?;
    let hours = params.clamped("hours", 24.0, 1.0, 8760.0);
    let bucket = params.clamped("bucket", 300.0, 60.0, 86400.0);

    Ok(Json(game.population(id, hours, bucket).await?))
}
