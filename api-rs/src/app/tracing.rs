use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::format::JsonFields;

pub fn init_tracing() {
    let is_railway = std::env::var("RAILWAY_ENVIRONMENT_NAME").is_ok();
    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    if is_railway {
        tracing_subscriber::fmt()
            .with_env_filter(env_filter)
            .json()
            .fmt_fields(JsonFields::new())
            .flatten_event(true)
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(env_filter).with_target(false).with_file(false).init();
    }
}
