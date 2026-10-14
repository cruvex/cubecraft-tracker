import { z } from "zod";

// The api service's private domain on Railway.
const apiUrl = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

const GameSchema = z.object({
  id: z.number(),
  name: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  active: z.boolean(),
  scoreType: z.string(),
});

export type Game = z.infer<typeof GameSchema>;

const LeaderboardSchema = z.object({
  rows: z.array(
    z.object({
      player: z.string(),
      ign: z.string().nullable(),
      score: z.number(),
      rank: z.number(),
    }),
  ),
  timestamp: z.string().nullable(),
});

export type Leaderboard = z.infer<typeof LeaderboardSchema>;
export type LeaderboardRow = Leaderboard["rows"][number];

async function get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(`${apiUrl}/api${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${path} returned ${res.status}`);
  return schema.parse(await res.json());
}

// Loaded once at startup, so it always matches the registered command choices.
let games: Game[] = [];

const loadAttempts = 5;

export async function loadGames(): Promise<Game[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const loaded = await get("/games", z.array(GameSchema));
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

export function getGame(id: number): Game | undefined {
  return games.find((game) => game.id === id);
}

export function getLeaderboard(gameId: number): Promise<Leaderboard> {
  return get(`/games/${gameId}/leaderboard`, LeaderboardSchema);
}
