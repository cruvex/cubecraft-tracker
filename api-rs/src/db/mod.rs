pub mod error;

use crate::app::config::DatabaseConfig;
use deadpool_postgres::{BuildError, Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio_postgres::NoTls;

pub fn init_db(config: &DatabaseConfig) -> Result<Pool, BuildError> {
    let pg_config = config
        .url
        .parse::<tokio_postgres::Config>()
        .expect("Failed to parse DATABASE__URL");
    let manager_config = ManagerConfig {
        recycling_method: RecyclingMethod::Fast,
    };
    let manager = Manager::from_config(pg_config, NoTls, manager_config);

    Pool::builder(manager)
        .max_size(config.max_pool_size)
        .build()
}
