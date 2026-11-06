use crate::app::error::Result;
use crate::app::state::AppState;
use crate::model::game::Game;
use crate::service::GameService;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/games", get(games))
}

async fn games(State(game): State<GameService>) -> Result<Json<Vec<Game>>> {
    Ok(Json(game.games().await?))
}
