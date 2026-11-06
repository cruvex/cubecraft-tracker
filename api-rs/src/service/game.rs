use crate::app::error::Result;
use crate::model::game::Game;
use deadpool_postgres::Pool;

#[derive(Clone)]
pub struct GameService {
    db_pool: Pool,
}

impl GameService {
    pub fn new(db_pool: Pool) -> Self {
        Self { db_pool }
    }

    /// Games with at least one read, by name.
    pub async fn games(&self) -> Result<Vec<Game>> {
        let con = self.db_pool.get().await?;

        let stmt = con
            .prepare_cached(
                "SELECT id, name, display_name, active, score_type, last_read_at
                 FROM games
                 WHERE last_read_at IS NOT NULL
                 ORDER BY name",
            )
            .await?;

        Ok(con
            .query(&stmt, &[])
            .await?
            .iter()
            .map(Game::from)
            .collect())
    }
}
