import { join } from "node:path";
import { z } from "zod";

const GAMES_FILE = join(import.meta.dir, "..", "games.json");

const gamesSchema = z.array(
  z.strictObject({
    id: z.number().int().positive(),
    name: z.string().min(1),
    displayName: z.string().min(1),
    scoreType: z.string(),
    // On the network, so the scraper expects its player count in the Games menu every run.
    active: z.boolean(),
    // Its Statistics screen has a leaderboard to scrape.
    hasLeaderboard: z.boolean(),
    // The name the Games menu shows, minus decorations; null for a game that is not on the network.
    menuName: z.string().min(1).nullable(),
  }),
);

function duplicates(values: unknown[]): unknown[] {
  return values.filter((value, i) => values.indexOf(value) !== i);
}

export function parseGames(json: unknown) {
  const games = gamesSchema.parse(json);

  const repeated = [
    ...duplicates(games.map((g) => g.id)),
    ...duplicates(games.map((g) => g.menuName).filter((name) => name !== null)),
  ];
  if (repeated.length > 0) throw new Error(`games.json repeats ${repeated.join(", ")}`);

  return games;
}

/**
 * Make the games table say what games.json says. A row the file does not have
 * stays, as scores refer to its id, but counts as off the network. Only the
 * definitions are written: games.last_read_at belongs to the scraper.
 */
export async function syncGames() {
  const games = parseGames(await Bun.file(GAMES_FILE).json());

  await Bun.sql.begin(async (tx) => {
    // Cleared first: a menu name moving between games would break the unique constraint halfway through the insert.
    await tx`UPDATE games SET menu_name = NULL, active = false`;

    await tx`
      INSERT INTO games ${tx(
        games.map((g) => ({
          id: g.id,
          name: g.name,
          display_name: g.displayName,
          score_type: g.scoreType,
          active: g.active,
          has_leaderboard: g.hasLeaderboard,
          menu_name: g.menuName,
        })),
      )}
      ON CONFLICT (id) DO UPDATE
        SET name            = EXCLUDED.name,
            display_name    = EXCLUDED.display_name,
            score_type      = EXCLUDED.score_type,
            active          = EXCLUDED.active,
            has_leaderboard = EXCLUDED.has_leaderboard,
            menu_name       = EXCLUDED.menu_name
    `;

    const unknown = await tx`SELECT id FROM games WHERE id NOT IN ${tx(games.map((g) => g.id))}`;
    if (unknown.length > 0) {
      console.warn(`games has rows that are not in games.json: ${unknown.map((r: any) => r.id).join(", ")}`);
    }
  });

  console.log(`Synced ${games.length} games`);
}
