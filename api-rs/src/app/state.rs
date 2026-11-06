use deadpool_postgres::Pool;

#[derive(Clone)]
pub struct AppState {
    pub db_pool: Pool,
}

impl AppState {
    pub fn initialize(db_pool: Pool) -> Self {
        Self { db_pool }
    }
}
