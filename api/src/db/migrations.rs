use deadpool_postgres::Pool;
use include_dir::{Dir, include_dir};
use std::collections::HashSet;
use std::error::Error;
use tracing::info;

// Embedded because the image is a single binary with no filesystem to read them from.
static MIGRATIONS: Dir = include_dir!("$CARGO_MANIFEST_DIR/migrations");

/// Applies un-run migrations in filename order, each in its own transaction.
/// Only the filename is tracked, so never edit an applied migration: add a new numbered file instead.
pub async fn run_migrations(db_pool: &Pool) -> Result<(), Box<dyn Error>> {
    let mut con = db_pool.get().await?;

    con.batch_execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
           name       text        PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )",
    )
    .await?;

    let applied: HashSet<String> = con
        .query("SELECT name FROM schema_migrations", &[])
        .await?
        .iter()
        .map(|row| row.get("name"))
        .collect();

    let mut files: Vec<_> = MIGRATIONS.files().collect();
    files.sort_by_key(|file| file.path());

    let pending: Vec<_> = files
        .into_iter()
        .filter(|file| {
            let name = file.path().to_string_lossy();
            name.ends_with(".sql") && !applied.contains(name.as_ref())
        })
        .collect();

    if pending.is_empty() {
        info!("Migrations up to date ({} applied)", applied.len());
        return Ok(());
    }

    for file in pending {
        let name = file.path().to_string_lossy();
        let sql = file
            .contents_utf8()
            .ok_or_else(|| format!("Migration {name} is not UTF-8"))?
            .trim();

        // Recording it as applied would swallow whatever is written into it later.
        if sql.is_empty() {
            return Err(format!("Migration {name} is empty").into());
        }

        let tx = con.transaction().await?;
        tx.batch_execute(sql).await?;
        tx.execute(
            "INSERT INTO schema_migrations (name) VALUES ($1::text)",
            &[&name.as_ref()],
        )
        .await?;
        tx.commit().await?;

        info!("Applied {name}");
    }

    Ok(())
}
