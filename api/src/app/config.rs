use config::{Case, Config, Environment};
use serde::Deserialize;

#[derive(Deserialize, Clone)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub mojang: MojangConfig,
}

#[derive(Deserialize, Clone)]
pub struct ServerConfig {
    pub address: String,
    pub port: u16,
}

#[derive(Deserialize, Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_pool_size: usize,
}

#[derive(Deserialize, Clone)]
pub struct MojangConfig {
    /// Overridable so a test can stand in for Mojang without a real account.
    pub has_joined_url: String,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Config::builder()
            .set_default("server.address", "::")
            .and_then(|b| b.set_default("server.port", 8080))
            .and_then(|b| b.set_default("database.max_pool_size", 10))
            .and_then(|b| {
                b.set_default(
                    "mojang.has_joined_url",
                    "https://sessionserver.mojang.com/session/minecraft/hasJoined",
                )
            })
            .expect("Failed to set config defaults")
            .add_source(
                Environment::default()
                    .separator("__")
                    .convert_case(Case::Snake)
                    .try_parsing(true),
            )
            .build()
            .expect("Failed to build config")
            .try_deserialize()
            .expect("Failed to deserialize config")
    }
}
