import { z } from "zod";

const cubepanionBaseUrl = "https://cubepanion.ameliah.art/api/v2";
const userAgent = "CubeCraftPlus-scraper";
const requestTimeoutMs = 10_000;

// Cubepanion's game, which is what game_id holds in every table.
export type Game = {
  id: number;
  name: string;
  displayName: string;
  aliases: string[];
  // Whether the game can take leaderboard submissions, so whether it has a leaderboard to read.
  active: boolean;
  scoreType: string;
  shouldTrack: boolean;
  hasPreLobby: boolean;
};

const GameSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  active: z.boolean(),
  scoreType: z.string().nullish().transform((s) => s ?? ""),
  shouldTrack: z.boolean(),
  hasPreLobby: z.boolean(),
});

/** Throws on anything but a usable list, so a bad answer never replaces the stored games. */
export async function fetchCubepanionGames(signal: AbortSignal): Promise<Game[]> {
  const res = await fetch(`${cubepanionBaseUrl}/Games`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });

  if (!res.ok) throw new Error(`Cubepanion's Games API answered ${res.status}`);

  const parsed = z.array(GameSchema).safeParse(await res.json());
  if (!parsed.success) throw new Error(`Invalid response from Cubepanion's Games API: ${parsed.error.message}`);
  if (parsed.data.length === 0) throw new Error("Cubepanion's Games API returned no games");

  return parsed.data;
}

// Never deletes: a game Cubepanion drops keeps its name for the data already stored.
export async function saveGames(games: Game[]) {
  if (games.length === 0) return;

  const updatedAt = new Date();

  await Bun.sql`
    INSERT INTO games ${Bun.sql(
      games.map((g) => ({
        id: g.id,
        name: g.name,
        display_name: g.displayName,
        // A plain array would be sent as comma-joined text, which Postgres rejects as an array.
        aliases: Bun.sql.array(g.aliases, "TEXT"),
        active: g.active,
        score_type: g.scoreType,
        should_track: g.shouldTrack,
        has_pre_lobby: g.hasPreLobby,
        updated_at: updatedAt,
      })),
    )}
    ON CONFLICT (id) DO UPDATE
      SET name          = EXCLUDED.name,
          display_name  = EXCLUDED.display_name,
          aliases       = EXCLUDED.aliases,
          active        = EXCLUDED.active,
          score_type    = EXCLUDED.score_type,
          should_track  = EXCLUDED.should_track,
          has_pre_lobby = EXCLUDED.has_pre_lobby,
          updated_at    = EXCLUDED.updated_at
  `;
}

const compared = ["name", "displayName", "aliases", "active", "scoreType", "shouldTrack", "hasPreLobby"] as const;

// Alias order carries no meaning, so a reshuffled list is not a change.
const comparable = (value: unknown) => (Array.isArray(value) ? JSON.stringify([...value].sort()) : value);
const show = (value: unknown) => (Array.isArray(value) ? `[${value.join(", ")}]` : JSON.stringify(value));

export type GamesDiff = {
  // New or differing games: what is worth writing.
  changed: Game[];
  // Stored games Cubepanion no longer lists. They are kept, so this is only worth saying.
  removed: Game[];
  // One line per changed game, saying what differs.
  lines: string[];
};

export function diffGames(stored: Game[], fetched: Game[]): GamesDiff {
  const storedById = new Map(stored.map((g) => [g.id, g]));
  const fetchedIds = new Set(fetched.map((g) => g.id));

  const changed: Game[] = [];
  const lines: string[] = [];

  for (const after of fetched) {
    const before = storedById.get(after.id);

    if (!before) {
      changed.push(after);
      lines.push(`new game ${after.displayName} (${after.id}, ${after.name}, ${after.active ? "active" : "inactive"})`);
      continue;
    }

    const differing = compared.filter((key) => comparable(before[key]) !== comparable(after[key]));
    if (differing.length === 0) continue;

    changed.push(after);
    lines.push(
      `${after.displayName} (${after.id}): ${differing.map((key) => `${key} ${show(before[key])} -> ${show(after[key])}`).join("; ")}`,
    );
  }

  return { changed, removed: stored.filter((g) => !fetchedIds.has(g.id)), lines };
}

export async function loadGames(): Promise<Game[]> {
  const rows = await Bun.sql`
    SELECT id, name, display_name, aliases, active, score_type, should_track, has_pre_lobby
    FROM games
    ORDER BY id
  `;

  return rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    aliases: r.aliases,
    active: r.active,
    scoreType: r.score_type,
    shouldTrack: r.should_track,
    hasPreLobby: r.has_pre_lobby,
  }));
}

// Case and spacing are ignored; otherwise the whole name has to match, as in Cubepanion's own mod.
const normalize = (name: string) => name.trim().replace(/\s+/g, "_").toLowerCase();

// CubeCraft decorates names in the Games menu ("BedWars -UPDATE!").
const undecorated = (name: string) => name.replace(/\s+-.*$/, "");

/**
 * Finds a game by a name from the menus: its name, display name or any alias.
 * A name two games claim matches neither, so it shows up as unmapped and a
 * board is never saved under the wrong game.
 */
export function gameMatcher(games: Game[]): (menuName: string) => Game | undefined {
  const byKey = new Map<string, Game | null>();

  for (const game of games) {
    for (const key of new Set([game.name, game.displayName, ...game.aliases].map(normalize))) {
      const claimed = byKey.get(key);

      if (claimed === undefined) {
        byKey.set(key, game);
      } else if (claimed !== null && claimed.id !== game.id) {
        console.warn(`[games] "${key}" belongs to both ${claimed.name} and ${game.name}; matching neither`);
        byKey.set(key, null);
      }
    }
  }

  const find = (name: string) => byKey.get(normalize(name)) ?? undefined;

  return (menuName) => find(menuName) ?? find(undecorated(menuName));
}
