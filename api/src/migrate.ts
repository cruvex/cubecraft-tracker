import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { syncGames } from "./sync-games";

/**
 * Applies un-run migrations in filename order, each in its own transaction.
 * Only the filename is tracked, so never edit an applied migration -- add a
 * new numbered file instead.
 */

const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

export async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const rows = (await Bun.sql`SELECT name FROM schema_migrations`) as { name: string }[];
  const applied = new Set(rows.map((r) => r.name));

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`Up to date (${applied.size} applied)`);
    return;
  }

  for (const file of pending) {
    const sql = (await Bun.file(join(MIGRATIONS_DIR, file)).text()).trim();

    // Recording it as applied would swallow whatever is written into it later.
    if (!sql) throw new Error(`Migration ${file} is empty`);

    await Bun.sql.begin(async (tx) => {
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });

    console.log(`Applied ${file}`);
  }
}

if (import.meta.main) {
  await migrate();
  await syncGames();
  process.exit(0);
}
