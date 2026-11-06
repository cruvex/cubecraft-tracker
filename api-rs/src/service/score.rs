use crate::app::error::Result;
use crate::model::score::{
    CurrentScore, PlayerHistory, PlayerScores, Reading, TopGainer, TopGainerMonth,
};
use crate::web::params::{iso, number_text};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use std::collections::HashMap;
use tokio_postgres::Row;

// How far before a month's start a reading still counts as the month's starting score; month coverage uses the same tolerance.
const CARRY_WINDOW: &str = "3 days";

/// The CTE `bounds`, which always takes its one parameter as `$1`.
pub struct Bounds {
    cte: String,
    param: String,
}

impl Bounds {
    /// The last `days` days; only readings inside them count.
    pub fn last_days(days: f64) -> Self {
        Self {
            cte: "bounds AS (
                    SELECT start, start AS carry_start, CAST('infinity' AS timestamptz) AS stop
                    FROM (SELECT NOW() - CAST($1::text AS INTERVAL) AS start) s
                  )"
            .to_string(),
            param: format!("{} days", number_text(days)),
        }
    }

    /// A month ("YYYY-MM") or year ("YYYY") in UTC, starting from the last reading within CARRY_WINDOW before it.
    pub fn period(period: &str) -> Self {
        let is_year = period.len() == 4;
        let length = if is_year { "1 year" } else { "1 month" };

        Self {
            cte: format!(
                "bounds AS (
                   SELECT
                     start_utc AT TIME ZONE 'UTC'                             AS start,
                     (start_utc - INTERVAL '{CARRY_WINDOW}') AT TIME ZONE 'UTC' AS carry_start,
                     (start_utc + INTERVAL '{length}') AT TIME ZONE 'UTC'     AS stop
                   FROM (SELECT CAST($1::text AS timestamp) AS start_utc) s
                 )"
            ),
            param: if is_year {
                format!("{period}-01-01")
            } else {
                format!("{period}-01")
            },
        }
    }
}

// CTE `gains` (after `bounds`): each player's last score minus their last score from before the start, or else their first after it.
const GAINS_CTE: &str = "gains AS (
    SELECT
      p.player,
      (array_agg(p.score ORDER BY p.first_seen DESC))[1]
        - COALESCE(
            (array_agg(p.score ORDER BY p.first_seen DESC) FILTER (WHERE p.first_seen <= b.start))[1],
            (array_agg(p.score ORDER BY p.first_seen))[1]
          ) AS score_gain
    FROM player_scores p
    JOIN games ON games.id = p.game_id
    CROSS JOIN bounds b
    WHERE p.game_id = $2::int
      AND (p.last_seen >= b.carry_start OR (p.last_seen IS NULL AND games.last_read_at >= b.carry_start))
      AND p.first_seen < b.stop
    GROUP BY p.player
  )";

// Each period's first and last reading, so a chart shows how long a score held.
fn readings(periods: &[Row]) -> Vec<Reading> {
    periods
        .iter()
        .flat_map(|row| {
            let first_seen: DateTime<Utc> = row.get("first_seen");
            let last_seen: DateTime<Utc> = row.get("last_seen");
            let first = Reading {
                timestamp: iso(first_seen),
                score: row.get("score"),
                position: row.get("position"),
            };

            if first_seen.timestamp_millis() == last_seen.timestamp_millis() {
                vec![first]
            } else {
                let last = Reading {
                    timestamp: iso(last_seen),
                    ..first.clone()
                };
                vec![first, last]
            }
        })
        .collect()
}

#[derive(Clone)]
pub struct ScoreService {
    db_pool: Pool,
}

impl ScoreService {
    pub fn new(db_pool: Pool) -> Self {
        Self { db_pool }
    }

    pub async fn top_gainers(&self, bounds: Bounds, game_id: i32) -> Result<Vec<TopGainer>> {
        let con = self.db_pool.get().await?;

        let query = format!(
            "WITH {}, {GAINS_CTE},
             player_igns AS (
               SELECT DISTINCT ON (player_uuid)
                 player_uuid,
                 player_ign
               FROM ign_history
               ORDER BY player_uuid, id DESC
             )
             SELECT
               g.player::text AS uuid,
               pi.player_ign AS ign,
               g.score_gain
             FROM gains g
             LEFT JOIN player_igns pi ON g.player = pi.player_uuid
             WHERE g.score_gain > 0
             ORDER BY g.score_gain DESC",
            bounds.cte
        );
        let stmt = con.prepare_cached(&query).await?;

        Ok(con
            .query(&stmt, &[&bounds.param, &game_id])
            .await?
            .iter()
            .map(TopGainer::from)
            .collect())
    }

    /// Score series for an explicit player set, in `uuids` order; players with no data are omitted.
    pub async fn players_history(
        &self,
        uuids: &[String],
        days: f64,
        game_id: i32,
    ) -> Result<Vec<PlayerHistory>> {
        if uuids.is_empty() {
            return Ok(Vec::new());
        }

        let con = self.db_pool.get().await?;

        let bounds = Bounds::last_days(days);
        let query = format!(
            "WITH {},
             player_igns AS (
               SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
               FROM ign_history
               ORDER BY player_uuid, id DESC
             )
             SELECT
               p.player::text                  AS uuid,
               pi.player_ign                   AS ign,
               GREATEST(p.first_seen, b.start) AS first_seen,
               COALESCE(p.last_seen, games.last_read_at) AS last_seen,
               p.score,
               p.position
             FROM player_scores p
             JOIN games ON games.id = p.game_id
             CROSS JOIN bounds b
             LEFT JOIN player_igns pi ON pi.player_uuid = p.player
             WHERE p.player = ANY($3::text[]::uuid[])
               AND p.game_id = $2::int
               AND (p.last_seen >= b.start OR (p.last_seen IS NULL AND games.last_read_at >= b.start))
             ORDER BY p.first_seen",
            bounds.cte
        );
        let stmt = con.prepare_cached(&query).await?;

        let rows = con.query(&stmt, &[&bounds.param, &game_id, &uuids]).await?;

        let mut by_uuid: HashMap<String, Vec<Row>> = HashMap::new();
        for row in rows {
            by_uuid.entry(row.get("uuid")).or_default().push(row);
        }

        // Preserve the requested order so the chart's colour/legend assignment is stable.
        Ok(uuids
            .iter()
            .filter_map(|uuid| {
                let periods = by_uuid.get(uuid)?;
                let ign = periods
                    .iter()
                    .rev()
                    .find_map(|row| row.get::<_, Option<String>>("ign"))
                    .filter(|ign| !ign.is_empty())
                    .unwrap_or_else(|| "Unknown".to_string());

                Some(PlayerHistory {
                    player: uuid.clone(),
                    ign,
                    rows: readings(periods),
                })
            })
            .collect())
    }

    /// Default seed for the comparison chart: top-N gainers, then their histories.
    pub async fn top_gainers_history(
        &self,
        days: f64,
        game_id: i32,
        limit: f64,
    ) -> Result<Vec<PlayerHistory>> {
        let uuids = {
            let con = self.db_pool.get().await?;

            let bounds = Bounds::last_days(days);
            let query = format!(
                "WITH {}, {GAINS_CTE}
                 SELECT player::text AS uuid
                 FROM gains
                 WHERE score_gain > 0
                 ORDER BY score_gain DESC
                 LIMIT $3::float8::bigint",
                bounds.cte
            );
            let stmt = con.prepare_cached(&query).await?;

            con.query(&stmt, &[&bounds.param, &game_id, &limit])
                .await?
                .iter()
                .map(|row| row.get("uuid"))
                .collect::<Vec<String>>()
        };

        self.players_history(&uuids, days, game_id).await
    }

    /// Every month from the game's first read to now, newest first, with how much of each month was tracked.
    pub async fn top_gainer_months(&self, game_id: i32) -> Result<Vec<TopGainerMonth>> {
        let con = self.db_pool.get().await?;

        let query = format!(
            "WITH reads AS (
               SELECT first_seen AT TIME ZONE 'UTC' AS timestamp FROM player_scores WHERE game_id = $1::int
               UNION
               SELECT last_seen AT TIME ZONE 'UTC' FROM player_scores WHERE game_id = $1::int AND last_seen IS NOT NULL
               UNION
               SELECT last_read_at AT TIME ZONE 'UTC' FROM games WHERE id = $1::int AND last_read_at IS NOT NULL
             ),
             snaps AS (
               SELECT
                 timestamp,
                 date_trunc('month', timestamp)            AS month,
                 LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
               FROM reads
             ),
             tracked AS (
               SELECT DISTINCT ON (month)
                 month,
                 timestamp AS first_ts,
                 MAX(timestamp) OVER (PARTITION BY month) AS last_ts,
                 COALESCE(prev_ts >= month - INTERVAL '{CARRY_WINDOW}', false) AS has_carry
               FROM snaps
               ORDER BY month, timestamp
             ),
             calendar AS (
               SELECT generate_series(
                 (SELECT MIN(month) FROM tracked),
                 date_trunc('month', NOW() AT TIME ZONE 'UTC'),
                 INTERVAL '1 month'
               ) AS month
             )
             SELECT
               to_char(c.month, 'YYYY-MM') AS month,
               c.month = date_trunc('month', NOW() AT TIME ZONE 'UTC') AS in_progress,
               t.month IS NOT NULL AS tracked,
               (t.has_carry OR t.first_ts < c.month + INTERVAL '{CARRY_WINDOW}') AS covers_start,
               t.last_ts >= c.month + INTERVAL '1 month' - INTERVAL '{CARRY_WINDOW}' AS covers_end,
               CASE WHEN t.has_carry THEN 1 ELSE EXTRACT(day FROM t.first_ts) END::int AS first_day,
               EXTRACT(day FROM t.last_ts)::int AS last_day
             FROM calendar c
             LEFT JOIN tracked t ON t.month = c.month
             ORDER BY c.month DESC"
        );
        let stmt = con.prepare_cached(&query).await?;

        Ok(con
            .query(&stmt, &[&game_id])
            .await?
            .iter()
            .map(TopGainerMonth::from)
            .collect())
    }

    /// A player's readings in `bounds`, starting with the reading the start carries from, plus their latest reading.
    pub async fn player_scores(
        &self,
        uuid: &str,
        ign: String,
        bounds: Bounds,
        game_id: i32,
    ) -> Result<PlayerScores> {
        let con = self.db_pool.get().await?;

        // The periods in the bounds plus the one the start carries from, clamped so a score held into the bounds reads from the start.
        let query = format!(
            "WITH {},
             player_periods AS (
               SELECT p.first_seen, COALESCE(p.last_seen, games.last_read_at) AS last_seen, p.score, p.position
               FROM player_scores p
               JOIN games ON games.id = p.game_id
               WHERE p.game_id = $2::int AND p.player = $3::text::uuid
             )
             SELECT
               GREATEST(p.first_seen, LEAST(p.last_seen, b.start)) AS first_seen,
               LEAST(p.last_seen, b.stop)                          AS last_seen,
               p.score,
               p.position
             FROM player_periods p
             CROSS JOIN bounds b
             WHERE p.first_seen < b.stop
               AND (
                 p.last_seen >= b.start
                 OR p.first_seen = (
                   SELECT MAX(q.first_seen) FROM player_periods q
                   WHERE q.first_seen <= b.start
                     AND q.last_seen >= b.carry_start
                 )
               )
             ORDER BY p.first_seen",
            bounds.cte
        );
        let periods = con.prepare_cached(&query).await?;
        let latest = con
            .prepare_cached(
                "SELECT score, position
                 FROM player_scores
                 WHERE game_id = $1::int AND player = $2::text::uuid
                 ORDER BY first_seen DESC
                 LIMIT 1",
            )
            .await?;

        let periods = con
            .query(&periods, &[&bounds.param, &game_id, &uuid])
            .await?;
        let latest = con.query_opt(&latest, &[&game_id, &uuid]).await?;

        let rows = readings(&periods);
        let gain = match (rows.first(), rows.last()) {
            (Some(first), Some(last)) if rows.len() > 1 => last.score - first.score,
            _ => 0,
        };

        Ok(PlayerScores {
            player: uuid.to_string(),
            ign,
            rows,
            gain,
            current: latest.as_ref().map(CurrentScore::from),
            period: None,
        })
    }
}
