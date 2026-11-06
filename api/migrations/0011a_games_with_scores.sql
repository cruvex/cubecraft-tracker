-- Rows for the games player_scores refers to, as 0012 needs one per game to find its latest read.
-- games.json fills them in right after the migrations; this only matters where games is still empty.

INSERT INTO games (id, name, display_name, active)
SELECT DISTINCT game_id, game_id::text, game_id::text, false
FROM player_scores
ON CONFLICT (id) DO NOTHING;
