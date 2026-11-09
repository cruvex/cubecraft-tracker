use crate::web::params::iso;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
pub struct PlayerMatch {
    pub uuid: String,
    pub ign: String,
}

impl From<&Row> for PlayerMatch {
    fn from(row: &Row) -> Self {
        Self {
            uuid: row.get("player_uuid"),
            ign: row.get("player_ign"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerGame {
    pub game_id: i32,
    pub score: i32,
    pub position: i32,
    pub timestamp: Option<String>,
}

impl From<&Row> for PlayerGame {
    fn from(row: &Row) -> Self {
        Self {
            game_id: row.get("game_id"),
            score: row.get("score"),
            position: row.get("position"),
            timestamp: row.get::<_, Option<DateTime<Utc>>>("timestamp").map(iso),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLeaderboards {
    pub player: String,
    pub ign: String,
    pub games: Vec<PlayerGame>,
    pub matched_ign: String,
}
