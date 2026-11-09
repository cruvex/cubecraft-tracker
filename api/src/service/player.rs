use crate::app::error::Result;
use crate::model::player::{PlayerGame, PlayerMatch};
use deadpool_postgres::Pool;
use std::collections::HashMap;

/// A looked-up player: their uuid, and the name as stored if the lookup was by name.
pub struct ResolvedPlayer {
    pub uuid: String,
    pub ign: Option<String>,
}

#[derive(Clone)]
pub struct PlayerService {
    db_pool: Pool,
}

impl PlayerService {
    pub fn new(db_pool: Pool) -> Self {
        Self { db_pool }
    }

    /// Resolve an id which could be a uuid or an ign.
    pub async fn resolve(&self, id: &str) -> Result<Option<ResolvedPlayer>> {
        let length = id.encode_utf16().count();

        if length >= 32 && (id.contains('-') || length == 32) {
            return Ok(Some(ResolvedPlayer {
                uuid: id.to_string(),
                ign: None,
            }));
        }

        let owner = self.ign_owner(id).await?;
        Ok(owner.map(|owner| ResolvedPlayer {
            uuid: owner.uuid,
            ign: Some(owner.ign),
        }))
    }

    /// Batch ign to uuid (case-insensitive, latest wins), keyed by lowercased ign; misses are absent.
    pub async fn uuids_by_igns(&self, igns: &[String]) -> Result<HashMap<String, String>> {
        if igns.is_empty() {
            return Ok(HashMap::new());
        }

        let con = self.db_pool.get().await?;

        let lowered: Vec<String> = igns.iter().map(|ign| ign.to_lowercase()).collect();

        let stmt = con
            .prepare_cached(
                "SELECT DISTINCT ON (LOWER(player_ign))
                   LOWER(player_ign) AS ign,
                   player_uuid::text AS player_uuid
                 FROM ign_history
                 WHERE LOWER(player_ign) = ANY($1::text[])
                 ORDER BY LOWER(player_ign), id DESC",
            )
            .await?;

        Ok(con
            .query(&stmt, &[&lowered])
            .await?
            .iter()
            .map(|row| (row.get("ign"), row.get("player_uuid")))
            .collect())
    }

    /// The newest owner of a name, with the name spelled as stored.
    async fn ign_owner(&self, ign: &str) -> Result<Option<PlayerMatch>> {
        let con = self.db_pool.get().await?;

        // Escaped because `_` is an ILIKE wildcard and common in names.
        let pattern = ign
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");

        let stmt = con
            .prepare_cached(
                "SELECT player_uuid::text AS player_uuid, player_ign
                 FROM ign_history
                 WHERE player_ign ILIKE $1::text
                 ORDER BY id DESC
                 LIMIT 1",
            )
            .await?;

        Ok(con
            .query_opt(&stmt, &[&pattern])
            .await?
            .as_ref()
            .map(PlayerMatch::from))
    }

    pub async fn ign_by_uuid(&self, uuid: &str) -> Result<Option<String>> {
        let con = self.db_pool.get().await?;

        let stmt = con
            .prepare_cached(
                "SELECT player_ign
                 FROM ign_history
                 WHERE player_uuid = $1::text::uuid
                 ORDER BY id DESC
                 LIMIT 1",
            )
            .await?;

        Ok(con
            .query_opt(&stmt, &[&uuid])
            .await?
            .map(|row| row.get("player_ign")))
    }

    /// The player's spot on each game's most recent leaderboard; games they're not on are left out.
    pub async fn leaderboards(&self, uuid: &str) -> Result<Vec<PlayerGame>> {
        let con = self.db_pool.get().await?;

        let stmt = con
            .prepare_cached(
                "SELECT p.game_id, games.last_read_at AS timestamp, p.score, p.position
                 FROM player_scores p
                 JOIN games ON games.id = p.game_id
                 WHERE p.player = $1::text::uuid AND p.last_seen IS NULL
                 ORDER BY p.position",
            )
            .await?;

        Ok(con
            .query(&stmt, &[&uuid])
            .await?
            .iter()
            .map(PlayerGame::from)
            .collect())
    }

    pub async fn search(&self, query: &str) -> Result<Vec<PlayerMatch>> {
        let con = self.db_pool.get().await?;

        let contains = format!("%{query}%");
        let starts = format!("{query}%");

        let stmt = con
            .prepare_cached(
                "SELECT player_uuid::text AS player_uuid, player_ign FROM (
                   SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
                   FROM public.ign_history
                   WHERE player_ign ILIKE $1::text
                   ORDER BY player_uuid, id DESC
                 ) sub
                 ORDER BY
                   CASE WHEN player_ign ILIKE $2::text THEN 0 ELSE 1 END,
                   player_ign
                 LIMIT 10",
            )
            .await?;

        Ok(con
            .query(&stmt, &[&contains, &starts])
            .await?
            .iter()
            .map(PlayerMatch::from)
            .collect())
    }
}
