use crate::web::params::iso;
use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio_postgres::Row;

#[derive(Serialize)]
pub struct LatestReading {
    pub timestamp: String,
    pub online: i32,
    pub capacity: i32,
}

impl From<&Row> for LatestReading {
    fn from(row: &Row) -> Self {
        Self {
            timestamp: iso(row.get::<_, DateTime<Utc>>("timestamp")),
            online: row.get("online"),
            capacity: row.get("max"),
        }
    }
}

#[derive(Serialize)]
pub struct VersionRange {
    pub minimum: String,
    pub maximum: String,
    pub raw: String,
    pub since: String,
}

impl From<&Row> for VersionRange {
    fn from(row: &Row) -> Self {
        Self {
            minimum: row.get("minimum"),
            maximum: row.get("maximum"),
            raw: row.get("raw"),
            since: iso(row.get::<_, DateTime<Utc>>("observed_at")),
        }
    }
}

#[derive(Serialize)]
pub struct ServerStatus {
    pub latest: Option<LatestReading>,
    pub version: Option<VersionRange>,
}
