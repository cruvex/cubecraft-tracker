import { z } from "zod";

// The api service's private domain on Railway.
const apiUrl = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

const GameSchema = z.object({
  id: z.number(),
  displayName: z.string(),
  active: z.boolean(),
  scoreType: z.string(),
});

export type Game = z.infer<typeof GameSchema>;

const LeaderboardSchema = z.object({
  rows: z.array(
    z.object({
      ign: z.string().nullable(),
      score: z.number(),
      rank: z.number(),
    }),
  ),
  timestamp: z.string().nullable(),
});

export type LeaderboardRow = z.infer<typeof LeaderboardSchema>["rows"][number];

const PlayerSchema = z.object({
  ign: z.string(),
  matchedIgn: z.string(),
  games: z.array(
    z.object({
      gameId: z.number(),
      score: z.number(),
      position: z.number(),
    }),
  ),
});

export type Player = z.infer<typeof PlayerSchema>;

const PlayerSearchSchema = z.array(z.object({ uuid: z.string(), ign: z.string() }));

/** The response body, or null on a 404. */
async function get(path: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(`${apiUrl}/api${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return res.json();
}

// Loaded once at startup, so it always matches the registered command choices.
let games: Game[] = [];

const loadAttempts = 5;

export async function loadGames() {
  for (let attempt = 1; ; attempt++) {
    try {
      const loaded = z.array(GameSchema).parse(await get("/games"));
      // The API answers [] when Cubepanion is down.
      if (!loaded.length) throw new Error("The API returned no games");
      games = loaded;
      return games;
    } catch (err) {
      if (attempt === loadAttempts) throw err;
      console.error(`Loading games failed (attempt ${attempt}/${loadAttempts}), retrying in 10s:`, err);
      await Bun.sleep(10_000);
    }
  }
}

export function getGame(id: number) {
  return games.find((game) => game.id === id);
}

export async function getLeaderboard(gameId: number) {
  return LeaderboardSchema.parse(await get(`/games/${gameId}/leaderboard`));
}

/** A name resolves to the last player who had it; null when nobody ever did. */
export async function getPlayer(name: string) {
  return PlayerSchema.nullable().parse(await get(`/player/${encodeURIComponent(name)}`));
}

// Short timeout: Discord drops autocomplete answers after 3 seconds.
export async function searchPlayers(query: string) {
  return PlayerSearchSchema.parse(await get(`/search/players?q=${encodeURIComponent(query)}`, 2_500));
}
