use crate::web::params::iso;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i32,
    pub name: String,
    pub display_name: String,
    pub active: bool,
    pub score_type: String,
    pub last_snapshot: String,
}

impl From<&Row> for Game {
    fn from(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            name: row.get("name"),
            display_name: row.get("display_name"),
            active: row.get("active"),
            score_type: row.get("score_type"),
            last_snapshot: iso(row.get::<_, DateTime<Utc>>("last_read_at")),
        }
    }
}
