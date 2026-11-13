use crate::app::error::{AppError, Result};
use crate::model::auth::{Challenge, MintedToken};
use crate::service::mojang::MojangSessionClient;
use crate::web::params::iso;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use sha2::{Digest, Sha256};
use std::fmt::Write;
use uuid::Uuid;

/// Prefixed so a leaked token is easy to grep for and for secret scanners to recognise.
const TOKEN_PREFIX: &str = "ccp_";

pub const KIND_MOD: &str = "mod";

/// Who a valid token belongs to.
pub struct Authenticated {
    pub player_uuid: Uuid,
    pub expires_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct AuthService {
    db_pool: Pool,
    mojang: MojangSessionClient,
}

impl AuthService {
    pub fn new(db_pool: Pool, mojang: MojangSessionClient) -> Self {
        Self { db_pool, mojang }
    }

    /// Step 1: a server id for the mod to join with, and the second secret it verifies with.
    pub async fn challenge(&self, username: &str) -> Result<Challenge> {
        if !is_username(username) {
            return Err(AppError::BadRequest("Invalid username"));
        }

        // 160 bits as hex: the same shape as vanilla's server ids, so Mojang has no reason to balk.
        let server_id =
            random_bytes::<20>()?
                .iter()
                .fold(String::with_capacity(40), |mut hex, byte| {
                    let _ = write!(hex, "{byte:02x}");
                    hex
                });
        let verifier = URL_SAFE_NO_PAD.encode(random_bytes::<32>()?);

        let con = self.db_pool.get().await?;
        let stmt = con
            .prepare_cached(
                "INSERT INTO auth_challenges (server_id, username, verifier_hash, expires_at)
                 VALUES ($1::text, $2::text, $3::bytea, now() + interval '60 seconds')",
            )
            .await?;
        con.execute(&stmt, &[&server_id, &username, &digest(&verifier)])
            .await?;

        Ok(Challenge {
            server_id,
            verifier,
        })
    }

    /// Steps 3 and 4: burn the challenge, ask Mojang who joined with it, and mint a mod token for them.
    pub async fn verify(
        &self,
        server_id: &str,
        verifier: &str,
        client: Option<&str>,
    ) -> Result<MintedToken> {
        let con = self.db_pool.get().await?;

        // DELETE ... RETURNING is the single use: a replay or a race cannot burn the row twice.
        let burn = con
            .prepare_cached(
                "DELETE FROM auth_challenges
                 WHERE server_id = $1::text AND verifier_hash = $2::bytea AND expires_at > now()
                 RETURNING username",
            )
            .await?;
        let username: String = con
            .query_opt(&burn, &[&server_id, &digest(verifier)])
            .await?
            .ok_or(AppError::Unauthorized("Unknown or expired challenge"))?
            .get("username");

        // Not holding the connection across the call to Mojang, which can take seconds.
        drop(con);

        // Usually the player reconnected, or another instance on the account joined mid-handshake.
        let player_uuid = self
            .mojang
            .has_joined(&username, server_id)
            .await?
            .ok_or(AppError::Unauthorized("Mojang did not confirm the join"))?;

        let token = format!(
            "{TOKEN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(random_bytes::<32>()?)
        );

        let con = self.db_pool.get().await?;
        // Mod tokens do not slide: the mod re-runs the handshake on launch.
        let mint = con
            .prepare_cached(
                "INSERT INTO auth_tokens
                   (id, token_hash, player_uuid, kind, origin, client, expires_at, hard_expires_at)
                 VALUES
                   ($1::uuid, $2::bytea, $3::uuid, 'mod', 'session_server', $4::text,
                    now() + interval '24 hours', now() + interval '24 hours')
                 RETURNING expires_at",
            )
            .await?;
        let expires_at: DateTime<Utc> = con
            .query_one(
                &mint,
                &[&Uuid::new_v4(), &digest(&token), &player_uuid, &client],
            )
            .await?
            .get("expires_at");

        Ok(MintedToken {
            token,
            uuid: player_uuid,
            expires_at: iso(expires_at),
        })
    }

    /// The token's holder if it is live and of `kind`, sliding a web session forward when past half its window.
    pub async fn authenticate(&self, token: &str, kind: &str) -> Result<Option<Authenticated>> {
        let con = self.db_pool.get().await?;

        // The half-life threshold keeps a returning browser from being refreshed on every request.
        let stmt = con
            .prepare_cached(
                "UPDATE auth_tokens
                 SET last_seen_at = now(),
                     expires_at = CASE
                       WHEN kind = 'web' AND expires_at < now() + interval '15 days'
                       THEN LEAST(now() + interval '30 days', hard_expires_at)
                       ELSE expires_at
                     END
                 WHERE token_hash = $1::bytea AND kind = $2::text AND expires_at > now()
                 RETURNING player_uuid, expires_at",
            )
            .await?;

        Ok(con
            .query_opt(&stmt, &[&digest(token), &kind])
            .await?
            .map(|row| Authenticated {
                player_uuid: row.get("player_uuid"),
                expires_at: row.get("expires_at"),
            }))
    }

    /// Drops expired challenges and tokens; returns how many of each.
    pub async fn sweep(&self) -> Result<(u64, u64)> {
        let con = self.db_pool.get().await?;

        let challenges = con
            .execute("DELETE FROM auth_challenges WHERE expires_at < now()", &[])
            .await?;
        let tokens = con
            .execute("DELETE FROM auth_tokens WHERE expires_at < now()", &[])
            .await?;

        Ok((challenges, tokens))
    }
}

/// A Minecraft username. From 1 rather than 3 characters, because a few legacy accounts predate the minimum.
fn is_username(value: &str) -> bool {
    (1..=16).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// A plain digest rather than bcrypt: every secret hashed here is high-entropy, so there is nothing to slow down.
fn digest(secret: &str) -> Vec<u8> {
    Sha256::digest(secret.as_bytes()).to_vec()
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|err| {
        tracing::error!("failed to read OS randomness: {err}");
        AppError::InternalServerError
    })?;
    Ok(bytes)
}
