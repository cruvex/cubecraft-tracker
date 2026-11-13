use crate::app::error::Result;
use crate::app::state::AppState;
use crate::model::auth::{Challenge, ChallengeRequest, Me, MintedToken, VerifyRequest};
use crate::service::AuthService;
use crate::web::auth::ModAuth;
use crate::web::params::iso;
use axum::extract::State;
use axum::http::{HeaderMap, header};
use axum::routing::{get, post};
use axum::{Json, Router};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/challenge", post(challenge))
        .route("/api/auth/verify", post(verify))
        .route("/api/auth/me", get(me))
}

async fn challenge(
    State(auth): State<AuthService>,
    Json(body): Json<ChallengeRequest>,
) -> Result<Json<Challenge>> {
    Ok(Json(auth.challenge(&body.username).await?))
}

async fn verify(
    State(auth): State<AuthService>,
    headers: HeaderMap,
    Json(body): Json<VerifyRequest>,
) -> Result<Json<MintedToken>> {
    // Shown in the signed-in-devices list, e.g. "CubeCraftPlus/1.4.0 (MC 26.2)".
    let client = headers
        .get(header::USER_AGENT)
        .and_then(|ua| ua.to_str().ok())
        .map(|ua| truncate(ua, 200));

    Ok(Json(
        auth.verify(&body.server_id, &body.verifier, client).await?,
    ))
}

async fn me(auth: ModAuth) -> Json<Me> {
    Json(Me {
        uuid: auth.player_uuid,
        expires_at: iso(auth.expires_at),
    })
}

fn truncate(value: &str, max_chars: usize) -> &str {
    value
        .char_indices()
        .nth(max_chars)
        .map_or(value, |(end, _)| &value[..end])
}
