use crate::service::{GameService, PlayerService, ServerService};
use axum::extract::FromRef;
use deadpool_postgres::Pool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub game: GameService,
    pub player: PlayerService,
    pub server: ServerService,
}

impl AppState {
    pub fn initialize(db_pool: Pool) -> Self {
        Self {
            game: GameService::new(db_pool.clone()),
            player: PlayerService::new(db_pool.clone()),
            server: ServerService::new(db_pool),
        }
    }
}
