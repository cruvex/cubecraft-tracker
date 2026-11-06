use crate::app::error::Result;
use crate::model::game::Game;
use crate::model::leaderboard::{DepartedPlayer, Leaderboard, LeaderboardRow};
use crate::model::population::{GamePopulation, GameReading};
use crate::web::params::{iso, number_text};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;

#[derive(Clone)]
pub struct GameService {
    db_pool: Pool,
}

impl GameService {
    pub fn new(db_pool: Pool) -> Self {
        Self { db_pool }
    }

    /// Games with at least one read, by name.
    pub async fn games(&self) -> Result<Vec<Game>> {
        let con = self.db_pool.get().await?;

        let stmt = con
            .prepare_cached(
                "SELECT id, name, display_name, active, score_type, last_read_at
                 FROM games
                 WHERE last_read_at IS NOT NULL
                 ORDER BY name",
            )
            .await?;

        Ok(con
            .query(&stmt, &[])
            .await?
            .iter()
            .map(Game::from)
            .collect())
    }

    pub async fn leaderboard(&self, game_id: i32, compare_days: f64) -> Result<Leaderboard> {
        let con = self.db_pool.get().await?;

        let interval = format!("{} days", number_text(compare_days));

        // The comparison board is the latest one at least `compare_days` old: the board only changes when a period starts.
        let times = con
            .prepare_cached(
                "SELECT
                   last_read_at AS latest_at,
                   (
                     SELECT MAX(first_seen) FROM player_scores
                     WHERE game_id = $1::int
                       AND first_seen <= last_read_at - CAST($2::text AS INTERVAL)
                   ) AS past_at
                 FROM games
                 WHERE id = $1::int",
            )
            .await?;

        let Some(times) = con.query_opt(&times, &[&game_id, &interval]).await? else {
            return Ok(Leaderboard::default());
        };

        let latest_at: Option<DateTime<Utc>> = times.get("latest_at");
        let past_at: Option<DateTime<Utc>> = times.get("past_at");

        let Some(latest_at) = latest_at else {
            return Ok(Leaderboard::default());
        };

        // Current + past boards and IGN in one shot; departed players sort last via NULLS LAST on cur.position.
        let stmt = con
            .prepare_cached(
                "WITH cur AS (
                   SELECT player, score, position
                   FROM player_scores
                   WHERE game_id = $1::int AND last_seen IS NULL
                 ),
                 past AS (
                   SELECT player, score, position
                   FROM player_scores
                   WHERE game_id = $1::int AND first_seen <= $2::timestamptz AND (last_seen IS NULL OR last_seen >= $2::timestamptz)
                 )
                 SELECT
                   COALESCE(cur.player, past.player)::text AS player,
                   cur.score                               AS current_score,
                   cur.position                            AS current_position,
                   past.score                              AS past_score,
                   past.position                           AS past_position,
                   ih.player_ign                           AS ign
                 FROM cur
                 FULL OUTER JOIN past ON cur.player = past.player
                 LEFT JOIN (
                   SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
                   FROM ign_history
                   ORDER BY player_uuid, id DESC
                 ) ih ON ih.player_uuid = COALESCE(cur.player, past.player)
                 ORDER BY cur.position NULLS LAST, past.position",
            )
            .await?;

        let rows = con.query(&stmt, &[&game_id, &past_at]).await?;
        let (current, departed): (Vec<_>, Vec<_>) = rows
            .iter()
            .partition(|row| row.get::<_, Option<i32>>("current_score").is_some());

        Ok(Leaderboard {
            rows: current.into_iter().map(LeaderboardRow::from).collect(),
            departed: departed.into_iter().map(DepartedPlayer::from).collect(),
            timestamp: Some(iso(latest_at)),
            compare_timestamp: past_at.map(iso),
        })
    }

    /// Per-game readings bucketed to their last value: an average would invent counts never observed.
    pub async fn population(
        &self,
        game_id: i32,
        hours: i32,
        bucket_seconds: i32,
    ) -> Result<GamePopulation> {
        let con = self.db_pool.get().await?;

        let interval = format!("{hours} hours");

        let buckets = con
            .prepare_cached(
                "WITH readings AS (
                   SELECT
                     to_timestamp(
                       floor(extract(epoch FROM timestamp) / $2::int) * $2::int
                     ) AS bucket,
                     timestamp,
                     players
                   FROM game_player_counts
                   WHERE game_id = $1::int
                     AND timestamp >= NOW() - CAST($3::text AS INTERVAL)
                 )
                 SELECT DISTINCT ON (bucket)
                   bucket,
                   players,
                   MAX(players) OVER ()           AS window_peak,
                   (AVG(players) OVER ())::float8 AS window_average
                 FROM readings
                 ORDER BY bucket, timestamp DESC",
            )
            .await?;
        let latest = con
            .prepare_cached(
                "SELECT timestamp, players
                 FROM game_player_counts
                 WHERE game_id = $1::int
                 ORDER BY timestamp DESC
                 LIMIT 1",
            )
            .await?;

        let buckets = con
            .query(&buckets, &[&game_id, &bucket_seconds, &interval])
            .await?;
        let latest = con.query_opt(&latest, &[&game_id]).await?;

        // Both window functions repeat the same value on every row.
        let aggregate = buckets.first();

        Ok(GamePopulation {
            game_id,
            bucket_seconds,
            peak: aggregate.map(|row| row.get("window_peak")),
            average: aggregate.map(|row| row.get("window_average")),
            rows: buckets.iter().map(GameReading::from_bucket).collect(),
            latest: latest.as_ref().map(GameReading::from_latest),
        })
    }
}
