use crate::web::params::iso;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
pub struct GameReading {
    pub timestamp: String,
    pub players: i32,
}

impl GameReading {
    pub fn from_bucket(row: &Row) -> Self {
        Self {
            timestamp: iso(row.get::<_, DateTime<Utc>>("bucket")),
            players: row.get("players"),
        }
    }

    pub fn from_latest(row: &Row) -> Self {
        Self {
            timestamp: iso(row.get::<_, DateTime<Utc>>("timestamp")),
            players: row.get("players"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePopulation {
    pub game_id: i32,
    pub bucket_seconds: i32,
    pub rows: Vec<GameReading>,
    pub peak: Option<i32>,
    pub average: Option<f64>,
    pub latest: Option<GameReading>,
}

#[derive(Serialize)]
pub struct ServerReading {
    pub timestamp: String,
    pub online: i32,
}

impl From<&Row> for ServerReading {
    fn from(row: &Row) -> Self {
        Self {
            timestamp: iso(row.get::<_, DateTime<Utc>>("bucket")),
            online: row.get("online"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPopulation {
    pub bucket_seconds: i32,
    pub typical_days: i32,
    pub typical: Vec<Option<i64>>,
    pub rows: Vec<ServerReading>,
    pub peak: Option<i32>,
    pub average: Option<i32>,
}

#[derive(Serialize)]
pub struct ActiveHour {
    pub hour: i32,
    pub average: Option<i32>,
    pub peak: Option<i32>,
    pub samples: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHours {
    pub days: i32,
    pub time_zone: String,
    pub hours: Vec<ActiveHour>,
}
