use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::model::player::{PlayerLeaderboards, PlayerMatch};
use crate::service::PlayerService;
use crate::web::params::Params;
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/player/{id}", get(player_leaderboards))
        .route("/api/search/players", get(search_players))
}

async fn player_leaderboards(
    Path(id): Path<String>,
    State(player): State<PlayerService>,
) -> Result<Json<PlayerLeaderboards>> {
    const NOT_FOUND: AppError = AppError::NotFound("Player not found");

    let resolved = player.resolve(&id).await?.ok_or(NOT_FOUND)?;
    let ign = player.ign_by_uuid(&resolved.uuid).await?.ok_or(NOT_FOUND)?;
    let games = player.leaderboards(&resolved.uuid).await?;

    Ok(Json(PlayerLeaderboards {
        player: resolved.uuid,
        // The name that was looked up, which may be a past one; `ign` is always the current name.
        matched_ign: resolved.ign.unwrap_or_else(|| ign.clone()),
        ign,
        games,
    }))
}

async fn search_players(
    Query(params): Query<Params>,
    State(player): State<PlayerService>,
) -> Result<Json<Vec<PlayerMatch>>> {
    let query = params.get("q").unwrap_or_default().trim();

    if query.encode_utf16().count() < 2 {
        return Ok(Json(Vec::new()));
    }

    Ok(Json(player.search(query).await?))
}
