-- A period still on its game's latest read has no last_seen, so a read only writes the periods that changed.
-- games.last_read_at is when that latest read was.

ALTER TABLE games ADD COLUMN last_read_at timestamptz;

UPDATE games g
SET last_read_at = (SELECT MAX(last_seen) FROM player_scores p WHERE p.game_id = g.id);

ALTER TABLE player_scores ALTER COLUMN last_seen DROP NOT NULL;

UPDATE player_scores p
SET last_seen = NULL
FROM games g
WHERE p.game_id = g.id
  AND p.last_seen = g.last_read_at;
