-- Seed file for the games table.

INSERT INTO games (id, name, display_name, score_type, active, has_leaderboard, menu_name) VALUES
    (1, 'free_for_all', 'Free For All', 'kills', true, true, 'Free For All'),
    (2, 'parkour', 'Parkour', 'medals', true, true, 'Parkour'),
    (3, 'bedwars', 'BedWars', 'wins', true, true, 'BedWars'),
    (4, 'ender', 'Ender', 'wins', false, true, NULL),
    (5, 'team_lucky_islands', 'Team Lucky Islands', 'wins', false, true, NULL),
    (6, 'snowman_survival', 'Snowman Survival', 'medals', false, true, NULL),
    (7, 'skyblock', 'Skyblock', '', true, false, 'Skyblock'),
    (8, 'pillars_of_fortune', 'Pillars of Fortune', 'wins', true, true, 'Pillars of Fortune'),
    (9, 'disasters', 'Disasters', 'wins', false, true, NULL),
    (10, 'solo_skywars', 'Solo SkyWars', 'wins', true, true, 'SkyWars'),
    (11, 'team_eggwars', 'Team EggWars', 'wins', true, true, 'EggWars'),
    (12, 'solo_lucky_islands', 'Lucky Islands', 'wins', true, true, 'Lucky Islands'),
    (13, 'main_lobby', 'Main Lobby', '', false, false, NULL),
    (14, 'lucky_pillars', 'Lucky Pillars', 'wins', false, true, NULL),
    (15, 'mob_who', 'Mob Hunt', 'wins', false, true, NULL),
    (16, 'skyblock_dungeons', 'Skyblock Dungeon', '', false, false, NULL)
ON CONFLICT (id) DO UPDATE
    SET name            = EXCLUDED.name,
        display_name    = EXCLUDED.display_name,
        score_type      = EXCLUDED.score_type,
        active          = EXCLUDED.active,
        has_leaderboard = EXCLUDED.has_leaderboard,
        menu_name       = EXCLUDED.menu_name;
