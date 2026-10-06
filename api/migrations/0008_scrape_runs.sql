-- One row per scrape run, with what happened to each game's board.

CREATE TABLE scrape_runs (
    started_at  timestamptz PRIMARY KEY,
    duration_ms integer     NOT NULL,
    status      text        NOT NULL,
    -- Set when the run itself failed.
    error       text,
    -- One entry per game, e.g. {"gameId": 1, "status": "saved", "attempts": 1}.
    boards      jsonb       NOT NULL DEFAULT '[]',
    CONSTRAINT ck_scrape_runs_status CHECK (status IN ('ok', 'degraded', 'failed'))
);
