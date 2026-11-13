use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub username: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    /// Passed to Mojang's join as the server id.
    pub server_id: String,
    /// Sent back to verify, and never to Mojang.
    pub verifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub server_id: String,
    pub verifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MintedToken {
    pub token: String,
    /// The uuid Mojang vouched for. The mod discards the token if it isn't the one it started for.
    pub uuid: Uuid,
    pub expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub uuid: Uuid,
    pub expires_at: String,
}
