use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
pub struct TopGainer {
    pub player: String,
    pub ign: String,
    pub score_gain: i32,
}

impl From<&Row> for TopGainer {
    fn from(row: &Row) -> Self {
        Self {
            player: row.get("uuid"),
            ign: row
                .get::<_, Option<String>>("ign")
                .filter(|ign| !ign.is_empty())
                .unwrap_or_else(|| "Unknown".to_string()),
            score_gain: row.get("score_gain"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopGainerMonth {
    pub month: String,
    pub in_progress: bool,
    pub partial: bool,
    pub first_day: Option<i32>,
    pub last_day: Option<i32>,
}

impl From<&Row> for TopGainerMonth {
    fn from(row: &Row) -> Self {
        let in_progress: bool = row.get("in_progress");
        let tracked: bool = row.get("tracked");
        let covers_start = row.get::<_, Option<bool>>("covers_start").unwrap_or(false);
        let covers_end = row.get::<_, Option<bool>>("covers_end").unwrap_or(false);
        let covers_month = covers_start && (in_progress || covers_end);

        Self {
            month: row.get("month"),
            in_progress,
            partial: tracked && !covers_month,
            first_day: row.get("first_day"),
            last_day: row.get("last_day"),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Reading {
    pub timestamp: String,
    pub score: i32,
    pub position: i32,
}

#[derive(Serialize)]
pub struct PlayerHistory {
    pub player: String,
    pub ign: String,
    pub rows: Vec<Reading>,
}

#[derive(Serialize)]
pub struct CurrentScore {
    pub score: i32,
    pub position: i32,
}

impl From<&Row> for CurrentScore {
    fn from(row: &Row) -> Self {
        Self {
            score: row.get("score"),
            position: row.get("position"),
        }
    }
}

#[derive(Serialize)]
pub struct PlayerScores {
    pub player: String,
    pub ign: String,
    pub rows: Vec<Reading>,
    pub gain: i32,
    pub current: Option<CurrentScore>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period: Option<String>,
}
