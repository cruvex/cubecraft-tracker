use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardRow {
    pub player: String,
    pub ign: Option<String>,
    pub score: i32,
    pub rank: i32,
    pub prev_rank: Option<i32>,
    pub rank_change: Option<i32>,
    pub is_new: bool,
}

impl From<&Row> for LeaderboardRow {
    fn from(row: &Row) -> Self {
        let rank: i32 = row.get("current_position");
        let prev_rank: Option<i32> = row.get("past_position");

        Self {
            player: row.get("player"),
            ign: row.get("ign"),
            score: row.get("current_score"),
            rank,
            prev_rank,
            rank_change: prev_rank.map(|prev| prev - rank),
            is_new: prev_rank.is_none(),
        }
    }
}

#[derive(Serialize)]
pub struct DepartedPlayer {
    pub player: String,
    pub ign: Option<String>,
    pub score: i32,
    pub rank: i32,
}

impl From<&Row> for DepartedPlayer {
    fn from(row: &Row) -> Self {
        Self {
            player: row.get("player"),
            ign: row.get("ign"),
            score: row.get("past_score"),
            rank: row.get("past_position"),
        }
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    pub rows: Vec<LeaderboardRow>,
    pub departed: Vec<DepartedPlayer>,
    pub timestamp: Option<String>,
    pub compare_timestamp: Option<String>,
}
