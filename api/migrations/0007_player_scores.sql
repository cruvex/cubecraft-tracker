-- One row per period a player held a score; a new period starts whenever the score changes.

CREATE TABLE player_scores (
    game_id    integer     NOT NULL,
    player     uuid        NOT NULL,
    score      integer     NOT NULL,
    first_seen timestamptz NOT NULL,
    last_seen  timestamptz NOT NULL,
    PRIMARY KEY (game_id, player, first_seen)
);

CREATE INDEX idx_player_scores_game_id_last_seen
    ON player_scores (game_id, last_seen);

INSERT INTO player_scores (game_id, player, score, first_seen, last_seen)
WITH readings AS (
    SELECT
        ls.game_id,
        lr.player,
        lr.score,
        ls.timestamp AT TIME ZONE 'UTC' AS read_at,
        LAG(lr.score) OVER (PARTITION BY ls.game_id, lr.player ORDER BY ls.timestamp) AS prev_score
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON ls.id = lr.snapshot_id
),
periods AS (
    SELECT
        *,
        COUNT(*) FILTER (WHERE score IS DISTINCT FROM prev_score)
            OVER (PARTITION BY game_id, player ORDER BY read_at) AS period
    FROM readings
)
SELECT game_id, player, score, MIN(read_at), MAX(read_at)
FROM periods
GROUP BY game_id, player, period, score;
