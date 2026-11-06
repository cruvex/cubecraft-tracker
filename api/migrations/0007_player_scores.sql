-- One row per stretch of consecutive reads in which a player kept the same score and position.

CREATE TABLE player_scores (
    game_id    integer     NOT NULL,
    player     uuid        NOT NULL,
    score      integer     NOT NULL,
    position   integer     NOT NULL,
    first_seen timestamptz NOT NULL,
    last_seen  timestamptz NOT NULL,
    PRIMARY KEY (game_id, player, first_seen)
);

CREATE INDEX idx_player_scores_game_id_last_seen
    ON player_scores (game_id, last_seen);

CREATE INDEX idx_player_scores_game_id_first_seen
    ON player_scores (game_id, first_seen);

-- Truncated to milliseconds so the values survive a round trip through a JS Date.
INSERT INTO player_scores (game_id, player, score, position, first_seen, last_seen)
WITH reads AS (
    SELECT
        id,
        game_id,
        date_trunc('milliseconds', timestamp) AT TIME ZONE 'UTC' AS read_at,
        ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY timestamp) AS read_number
    FROM leaderboard_snapshots
),
readings AS (
    SELECT
        r.game_id,
        lr.player,
        lr.score,
        lr.position,
        r.read_at,
        r.read_number,
        LAG(r.read_number) OVER w AS prev_read_number,
        LAG(lr.score)      OVER w AS prev_score,
        LAG(lr.position)   OVER w AS prev_position
    FROM leaderboard_rows lr
    JOIN reads r ON r.id = lr.snapshot_id
    WINDOW w AS (PARTITION BY r.game_id, lr.player ORDER BY r.read_number)
),
periods AS (
    SELECT
        *,
        COUNT(*) FILTER (
            WHERE prev_read_number IS DISTINCT FROM read_number - 1
               OR score <> prev_score
               OR position <> prev_position
        ) OVER (PARTITION BY game_id, player ORDER BY read_number) AS period
    FROM readings
)
SELECT game_id, player, score, position, MIN(read_at), MAX(read_at)
FROM periods
GROUP BY game_id, player, period, score, position;
