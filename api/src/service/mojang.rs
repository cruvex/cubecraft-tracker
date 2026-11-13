use crate::app::error::{AppError, Result};
use reqwest::StatusCode;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tracing::warn;
use uuid::Uuid;

const UNAVAILABLE: AppError = AppError::ServiceUnavailable("Mojang session server unavailable");

/// The server half of the session-server handshake: asks Mojang whether a player joined with a server id.
#[derive(Clone)]
pub struct MojangSessionClient {
    http: reqwest::Client,
    has_joined_url: Arc<str>,
}

#[derive(Deserialize)]
struct HasJoinedResponse {
    id: Option<String>,
}

impl MojangSessionClient {
    pub fn new(has_joined_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("Failed to build HTTP client");

        Self {
            http,
            has_joined_url: has_joined_url.into(),
        }
    }

    /// The profile that joined with `server_id` as `username`, or None if Mojang has no such join.
    ///
    /// Never sends `ip`: it needs Mojang's view of the client's address to match ours, which NAT,
    /// CGNAT and IPv6 break routinely.
    pub async fn has_joined(&self, username: &str, server_id: &str) -> Result<Option<Uuid>> {
        let res = self
            .http
            .get(&*self.has_joined_url)
            .query(&[("username", username), ("serverId", server_id)])
            .send()
            .await
            .map_err(|err| {
                warn!("hasJoined request failed: {err}");
                UNAVAILABLE
            })?;

        match res.status() {
            // Mojang's "no such join".
            StatusCode::NO_CONTENT => Ok(None),
            StatusCode::OK => {
                let body: HasJoinedResponse = res.json().await.map_err(|err| {
                    warn!("hasJoined answered with an unreadable body: {err}");
                    UNAVAILABLE
                })?;
                // A body without an id is a rejection, same as a 204.
                Ok(body.id.as_deref().and_then(|id| Uuid::parse_str(id).ok()))
            }
            status => {
                warn!("hasJoined answered {status}");
                Err(UNAVAILABLE)
            }
        }
    }
}
