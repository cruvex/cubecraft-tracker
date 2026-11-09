use crate::app::error::Result;
use crate::model::population::{ActiveHour, ActiveHours, ServerPopulation, ServerReading};
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

    /// Bucket-averaged: a clocked one-ping-a-minute series, so an empty bucket is a failed poll, not a hold.
    pub async fn population(
        &self,
        hours: i32,
        bucket_seconds: i32,
        time_zone: &str,
    ) -> Result<ServerPopulation> {
        let con = self.db_pool.get().await?;

        let interval = format!("{hours} hours");

        let buckets = con
            .prepare_cached(
                "SELECT
                   to_timestamp(
                     floor(extract(epoch FROM timestamp) / $1::int) * $1::int
                   ) AS bucket,
                   ROUND(AVG(online))::int AS online
                 FROM server_player_counts
                 WHERE timestamp >= NOW() - CAST($2::text AS INTERVAL)
                 GROUP BY bucket
                 ORDER BY bucket",
            )
            .await?;
        // Read off the raw rows, so the chosen bucket width never moves them.
        let aggregate = con
            .prepare_cached(
                "SELECT MAX(online)::int AS peak, ROUND(AVG(online))::int AS average
                 FROM server_player_counts
                 WHERE timestamp >= NOW() - CAST($1::text AS INTERVAL)",
            )
            .await?;
        // Same bucket width, but keyed on local time of day across 30 days, so the chart can
        // draw what a given clock time usually looks like beside what it did this time.
        let typical = con
            .prepare_cached(
                "SELECT
                   FLOOR(
                     EXTRACT(epoch FROM (timestamp AT TIME ZONE $1::text)::time) / $2::int
                   )::int AS slot,
                   AVG(online)::float8 AS average
                 FROM server_player_counts
                 WHERE timestamp >= NOW() - CAST('30 days' AS INTERVAL)
                 GROUP BY slot",
            )
            .await?;

        let buckets = con.query(&buckets, &[&bucket_seconds, &interval]).await?;
        let aggregate = con.query_one(&aggregate, &[&interval]).await?;
        let typical = con.query(&typical, &[&time_zone, &bucket_seconds]).await?;

        let slots = (86400.0 / f64::from(bucket_seconds)).ceil() as usize;
        let mut by_slot = vec![None; slots];
        for row in &typical {
            let slot: i32 = row.get("slot");
            if let Some(value) = by_slot.get_mut(slot as usize) {
                *value = Some(row.get::<_, f64>("average"));
            }
        }

        // Roughly a quarter hour either side: enough to settle the 5-minute profile, a no-op hourly.
        let radius = round(900.0 / f64::from(bucket_seconds));

        Ok(ServerPopulation {
            bucket_seconds,
            typical_days: 30,
            typical: smooth_profile(&by_slot, radius),
            rows: buckets.iter().map(ServerReading::from).collect(),
            peak: aggregate.get("peak"),
            average: aggregate.get("average"),
        })
    }

    /// Average online per hour of day, bucketed in `time_zone` so DST and half-hour offsets hold.
    pub async fn active_hours(&self, days: i32, time_zone: String) -> Result<ActiveHours> {
        let con = self.db_pool.get().await?;

        let interval = format!("{days} days");

        let stmt = con
            .prepare_cached(
                "SELECT
                   EXTRACT(hour FROM timestamp AT TIME ZONE $1::text)::int AS hour,
                   ROUND(AVG(online))::int AS average,
                   MAX(online)::int        AS peak,
                   COUNT(*)::int           AS samples
                 FROM server_player_counts
                 WHERE timestamp >= NOW() - CAST($2::text AS INTERVAL)
                 GROUP BY hour
                 ORDER BY hour",
            )
            .await?;

        let rows = con.query(&stmt, &[&time_zone, &interval]).await?;

        // All 24 are emitted so a thin hour reads as a gap rather than shifting its neighbours along.
        let hours = (0..24)
            .map(|hour| {
                let row = rows.iter().find(|row| row.get::<_, i32>("hour") == hour);
                ActiveHour {
                    hour,
                    average: row.map(|row| row.get("average")),
                    peak: row.map(|row| row.get("peak")),
                    samples: row.map_or(0, |row| row.get("samples")),
                }
            })
            .collect();

        Ok(ActiveHours {
            days,
            time_zone,
            hours,
        })
    }
}

// Halves round up, unlike f64::round.
fn round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

// A day of slots is a loop, so the window wraps midnight instead of tapering at both ends.
fn smooth_profile(values: &[Option<f64>], radius: i64) -> Vec<Option<i64>> {
    if radius < 1 {
        return values.iter().map(|value| value.map(round)).collect();
    }

    let length = values.len() as i64;

    (0..length)
        .map(|i| {
            let window: Vec<f64> = (-radius..=radius)
                .filter_map(|d| values[(i + d).rem_euclid(length) as usize])
                .collect();

            (!window.is_empty()).then(|| round(window.iter().sum::<f64>() / window.len() as f64))
        })
        .collect()
}
