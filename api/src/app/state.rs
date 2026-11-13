use crate::service::{
    AuthService, GameService, MojangSessionClient, PlayerService, ScoreService, ServerService,
};
use axum::extract::FromRef;
use deadpool_postgres::Pool;

#[derive(Clone, FromRef)]
pub struct AppState {
    pub auth: AuthService,
    pub game: GameService,
    pub player: PlayerService,
    pub score: ScoreService,
    pub server: ServerService,
}

impl AppState {
    pub fn initialize(db_pool: Pool, mojang: MojangSessionClient) -> Self {
        Self {
            auth: AuthService::new(db_pool.clone(), mojang),
            game: GameService::new(db_pool.clone()),
            player: PlayerService::new(db_pool.clone()),
            score: ScoreService::new(db_pool.clone()),
            server: ServerService::new(db_pool),
        }
    }
}
