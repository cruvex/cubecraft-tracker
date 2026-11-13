use crate::app::error::AppError;
use crate::service::{AuthService, KIND_MOD};
use axum::extract::FromRef;
use axum::extract::FromRequestParts;
use axum::http::header;
use axum::http::request::Parts;
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// A request carrying a live mod token. Its own type, so a handler cannot forget to check the kind:
/// a browser session is refused here even though it lives in the same table.
pub struct ModAuth {
    pub player_uuid: Uuid,
    pub expires_at: DateTime<Utc>,
}

impl<S> FromRequestParts<S> for ModAuth
where
    S: Send + Sync,
    AuthService: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let token = bearer(parts).ok_or(AppError::Unauthorized("Missing bearer token"))?;

        let auth = AuthService::from_ref(state)
            .authenticate(token, KIND_MOD)
            .await?
            .ok_or(AppError::Unauthorized("Invalid or expired token"))?;

        Ok(Self {
            player_uuid: auth.player_uuid,
            expires_at: auth.expires_at,
        })
    }
}

fn bearer(parts: &Parts) -> Option<&str> {
    let value = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}
