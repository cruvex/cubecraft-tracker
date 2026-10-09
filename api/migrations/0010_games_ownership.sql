-- The games are kept here instead of synced from Cubepanion: active means the game is on the network, so its player count is expected every run.

ALTER TABLE games
    DROP COLUMN aliases,
    DROP COLUMN should_track,
    DROP COLUMN has_pre_lobby,
    DROP COLUMN updated_at,
    -- The name the Games menu shows, minus decorations like " -UPDATE!"; null for a game that is not on the network.
    ADD COLUMN menu_name text,
    -- Whether the game's Statistics screen has a leaderboard to scrape.
    ADD COLUMN has_leaderboard boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT uq_games_menu_name UNIQUE (menu_name);
