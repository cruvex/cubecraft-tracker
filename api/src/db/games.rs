use deadpool_postgres::Pool;
use serde::Deserialize;
use std::collections::HashSet;
use std::error::Error;
use tracing::{info, warn};

const GAMES_JSON: &str = include_str!("../../games.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GameDefinition {
    id: i32,
    name: String,
    display_name: String,
    score_type: String,
    // On the network, so the scraper expects its player count in the Games menu every run.
    active: bool,
    // Its Statistics screen has a leaderboard to scrape.
    has_leaderboard: bool,
    // The name the Games menu shows, minus decorations; null for a game that is not on the network.
    menu_name: Option<String>,
}

fn parse_games(json: &str) -> Result<Vec<GameDefinition>, Box<dyn Error>> {
    let games: Vec<GameDefinition> = serde_json::from_str(json)?;

    let mut ids = HashSet::new();
    let mut menu_names = HashSet::new();

    for game in &games {
        let blank_menu_name = game.menu_name.as_ref().is_some_and(String::is_empty);
        if game.id <= 0 || game.name.is_empty() || game.display_name.is_empty() || blank_menu_name {
            return Err(format!("games.json has an invalid entry for game {}", game.id).into());
        }
        if !ids.insert(game.id) {
            return Err(format!("games.json repeats {}", game.id).into());
        }
        if let Some(menu_name) = &game.menu_name
            && !menu_names.insert(menu_name)
        {
            return Err(format!("games.json repeats {menu_name}").into());
        }
    }

    Ok(games)
}

/// Make the games table say what games.json says. A row the file does not have
/// stays, as scores refer to its id, but counts as off the network. Only the
/// definitions are written: games.last_read_at belongs to the scraper.
pub async fn sync_games(db_pool: &Pool) -> Result<(), Box<dyn Error>> {
    let games = parse_games(GAMES_JSON)?;
    let ids: Vec<i32> = games.iter().map(|game| game.id).collect();

    let mut con = db_pool.get().await?;
    let tx = con.transaction().await?;

    // Cleared first: a menu name moving between games would break the unique constraint halfway through.
    tx.batch_execute("UPDATE games SET menu_name = NULL, active = false")
        .await?;

    let upsert = tx
        .prepare(
            "INSERT INTO games (id, name, display_name, score_type, active, has_leaderboard, menu_name)
             VALUES ($1::int, $2::text, $3::text, $4::text, $5::bool, $6::bool, $7::text)
             ON CONFLICT (id) DO UPDATE
               SET name            = EXCLUDED.name,
                   display_name    = EXCLUDED.display_name,
                   score_type      = EXCLUDED.score_type,
                   active          = EXCLUDED.active,
                   has_leaderboard = EXCLUDED.has_leaderboard,
                   menu_name       = EXCLUDED.menu_name",
        )
        .await?;

    for game in &games {
        tx.execute(
            &upsert,
            &[
                &game.id,
                &game.name,
                &game.display_name,
                &game.score_type,
                &game.active,
                &game.has_leaderboard,
                &game.menu_name,
            ],
        )
        .await?;
    }

    let unknown: Vec<i32> = tx
        .query("SELECT id FROM games WHERE id <> ALL($1::int[])", &[&ids])
        .await?
        .iter()
        .map(|row| row.get("id"))
        .collect();

    if !unknown.is_empty() {
        warn!("games has rows that are not in games.json: {unknown:?}");
    }

    tx.commit().await?;

    info!("Synced {} games", games.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i32, menu_name: &str) -> String {
        format!(
            r#"{{ "id": {id}, "name": "a", "displayName": "a", "scoreType": "", "active": true, "hasLeaderboard": true, "menuName": "{menu_name}" }}"#
        )
    }

    #[test]
    fn accepts_the_real_file() {
        assert_eq!(parse_games(GAMES_JSON).unwrap().len(), 16);
    }

    #[test]
    fn rejects_a_repeated_id() {
        let json = format!("[{}, {}]", entry(1, "A"), entry(1, "B"));
        assert!(parse_games(&json).is_err());
    }

    #[test]
    fn rejects_a_repeated_menu_name() {
        let json = format!("[{}, {}]", entry(1, "A"), entry(2, "A"));
        assert!(parse_games(&json).is_err());
    }

    #[test]
    fn rejects_an_unknown_field() {
        let json = format!("[{}]", entry(1, "A").replace("\"name\"", "\"nam\""));
        assert!(parse_games(&json).is_err());
    }
}
