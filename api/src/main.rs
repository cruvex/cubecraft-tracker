mod app;
mod db;
mod model;
mod service;
mod web;

use app::config::AppConfig;
use app::state::AppState;
use service::MojangSessionClient;
use std::time::Duration;
use tokio::signal;
use tracing::{info, warn};

#[tokio::main]
async fn main() {
    app::tracing::init_tracing();

    let config = AppConfig::from_env();

    let db_pool = db::init_db(&config.database).expect("Failed to initialize database pool");

    db::run_migrations(&db_pool)
        .await
        .expect("Failed to run database migrations");
    db::sync_games(&db_pool)
        .await
        .expect("Failed to sync games");

    let state = AppState::initialize(
        db_pool,
        MojangSessionClient::new(&config.mojang.has_joined_url),
    );

    spawn_auth_sweep(state.clone());

    let listener_url = format!("{}:{}", config.server.address, config.server.port);
    let listener = tokio::net::TcpListener::bind(&listener_url)
        .await
        .expect("Failed to bind");

    info!("{:<12} - {:?}", "LISTENING", listener.local_addr());

    axum::serve(listener, web::app_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Failed to start server");
}

/// Expired challenges and tokens are already refused by every query; this only keeps the tables small.
fn spawn_auth_sweep(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        loop {
            interval.tick().await;
            match state.auth.sweep().await {
                Ok((0, 0)) => {}
                Ok((challenges, tokens)) => {
                    info!(challenges, tokens, "swept expired auth rows")
                }
                Err(err) => warn!("auth sweep failed: {err:?}"),
            }
        }
    });
}

async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
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
