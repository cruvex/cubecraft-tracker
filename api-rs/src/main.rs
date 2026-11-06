mod app;
mod db;
mod web;

use app::config::AppConfig;
use app::state::AppState;
use tokio::signal;
use tracing::info;

#[tokio::main]
async fn main() {
    app::tracing::init_tracing();

    let config = AppConfig::from_env();

    let db_pool = db::init_db(&config.database).expect("Failed to initialize database pool");

    let state = AppState::initialize(db_pool);

    let listener_url = format!("{}:{}", config.server.address, config.server.port);
    let listener = tokio::net::TcpListener::bind(&listener_url).await.expect("Failed to bind");

    info!("{:<12} - {:?}", "LISTENING", listener.local_addr());

    axum::serve(listener, web::app_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Failed to start server");
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
