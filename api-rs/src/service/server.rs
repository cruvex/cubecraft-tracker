use crate::app::error::Result;
use crate::model::server::{LatestReading, ServerStatus, VersionRange};
use deadpool_postgres::Pool;

#[derive(Clone)]
pub struct ServerService {
    db_pool: Pool,
}

impl ServerService {
    pub fn new(db_pool: Pool) -> Self {
        Self { db_pool }
    }

    /// Newest reading plus the version range in force, for the live status card.
    pub async fn status(&self) -> Result<ServerStatus> {
        let con = self.db_pool.get().await?;

        let latest = con
            .prepare_cached(
                "SELECT timestamp, online, max
                 FROM server_player_counts
                 ORDER BY timestamp DESC
                 LIMIT 1",
            )
            .await?;
        let version = con
            .prepare_cached(
                "SELECT observed_at, minimum, maximum, raw
                 FROM server_versions
                 ORDER BY observed_at DESC
                 LIMIT 1",
            )
            .await?;

        Ok(ServerStatus {
            latest: con
                .query_opt(&latest, &[])
                .await?
                .as_ref()
                .map(LatestReading::from),
            version: con
                .query_opt(&version, &[])
                .await?
                .as_ref()
                .map(VersionRange::from),
        })
    }
}
