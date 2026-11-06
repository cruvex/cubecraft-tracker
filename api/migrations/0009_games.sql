-- Cubepanion's games, which game_id refers to; filled by the scraper's games task, which never deletes a row.

CREATE TABLE games (
    id            integer     PRIMARY KEY,
    name          text        NOT NULL,
    display_name  text        NOT NULL,
    aliases       text[]      NOT NULL DEFAULT '{}',
    active        boolean     NOT NULL,
    score_type    text        NOT NULL DEFAULT '',
    should_track  boolean     NOT NULL,
    has_pre_lobby boolean     NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);
