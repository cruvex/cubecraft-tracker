use crate::app::error::AppError;
use deadpool_postgres::PoolError;
use tracing::error;

impl From<PoolError> for AppError {
    fn from(err: PoolError) -> Self {
        error!("failed to get a database connection: {err}");
        AppError::InternalServerError
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(err: tokio_postgres::Error) -> Self {
        error!("database query failed: {err:?}");
        AppError::InternalServerError
    }
}
