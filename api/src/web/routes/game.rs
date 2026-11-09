use crate::app::error::{AppError, Result};
use crate::app::state::AppState;
use crate::model::game::Game;
use crate::model::leaderboard::Leaderboard;
use crate::model::population::GamePopulation;
use crate::model::score::{PlayerHistory, PlayerScores, TopGainer, TopGainerMonth};
use crate::service::{Bounds, GameService, PlayerService, ScoreService};
use crate::web::params::{Params, game_id};
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/games", get(games))
        .route("/api/games/{game_id}/leaderboard", get(leaderboard))
        .route("/api/games/{game_id}/population", get(population))
        .route("/api/games/{game_id}/top-gainers", get(top_gainers))
        .route(
            "/api/games/{game_id}/top-gainers/history",
            get(top_gainers_history),
        )
        .route(
            "/api/games/{game_id}/top-gainers/months",
            get(top_gainer_months),
        )
        .route("/api/games/{game_id}/players/history", get(players_history))
        .route("/api/games/{game_id}/player/{id}", get(player_scores))
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

fn bounds(period: Option<&str>, days: f64) -> Bounds {
    period.map_or_else(|| Bounds::last_days(days), Bounds::period)
}

async fn top_gainers(
    Path(id): Path<String>,
    Query(params): Query<Params>,
    State(score): State<ScoreService>,
) -> Result<Json<Vec<TopGainer>>> {
    let period = params.period();
    let id = game_id(&id)?;
    let period = period?;

    let bounds = bounds(period.as_deref(), params.number("days", 30.0));

    Ok(Json(score.top_gainers(bounds, id).await?))
}

async fn top_gainers_history(
    Path(id): Path<String>,
    Query(params): Query<Params>,
    State(score): State<ScoreService>,
) -> Result<Json<Vec<PlayerHistory>>> {
    let id = game_id(&id)?;
    let days = params.number("days", 30.0);
    let limit = params.number("limit", 10.0);

    Ok(Json(score.top_gainers_history(days, id, limit).await?))
}

async fn top_gainer_months(
    Path(id): Path<String>,
    State(score): State<ScoreService>,
) -> Result<Json<Vec<TopGainerMonth>>> {
    let id = game_id(&id)?;

    Ok(Json(score.top_gainer_months(id).await?))
}

// Generic batch history for an explicit player set (uuids or igns via ?ids=a,b,c).
async fn players_history(
    Path(id): Path<String>,
    Query(params): Query<Params>,
    State(player): State<PlayerService>,
    State(score): State<ScoreService>,
) -> Result<Json<Vec<PlayerHistory>>> {
    let id = game_id(&id)?;

    let is_ign = |value: &str| value.encode_utf16().count() < 32;
    let ids: Vec<&str> = params
        .get("ids")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();

    // Accept either uuids or igns; unresolved igns are dropped.
    let igns: Vec<String> = ids
        .iter()
        .filter(|value| is_ign(value))
        .map(|value| value.to_string())
        .collect();
    let uuid_by_ign = player.uuids_by_igns(&igns).await?;
    let uuids: Vec<String> = ids
        .iter()
        .filter_map(|value| {
            if is_ign(value) {
                uuid_by_ign.get(&value.to_lowercase()).cloned()
            } else {
                Some(value.to_string())
            }
        })
        .collect();

    Ok(Json(
        score
            .players_history(&uuids, params.number("days", 30.0), id)
            .await?,
    ))
}

async fn player_scores(
    Path((id, player_id)): Path<(String, String)>,
    Query(params): Query<Params>,
    State(player): State<PlayerService>,
    State(score): State<ScoreService>,
) -> Result<Json<PlayerScores>> {
    const NOT_FOUND: AppError = AppError::NotFound("Player scores not found");

    let resolved = player
        .resolve(&player_id)
        .await?
        .ok_or(AppError::NotFound("Player not found"))?;

    let period = params.period();
    let id = game_id(&id)?;
    let period = period?;

    let ign = player.ign_by_uuid(&resolved.uuid).await?.ok_or(NOT_FOUND)?;
    let bounds = bounds(period.as_deref(), params.number("days", 30.0));
    let mut scores = score.player_scores(&resolved.uuid, ign, bounds, id).await?;

    // A period reads back even with nothing in it, but the last days need a player on this board.
    if period.is_none() && scores.current.is_none() {
        return Err(NOT_FOUND);
    }

    scores.period = period;
    Ok(Json(scores))
}
