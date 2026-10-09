import { z } from "zod";
import { sendReport, type GameReport, type RunReport } from "../report";
import type { Task, TaskContext } from "../scheduler";

const cubepanionBaseUrl = "https://cubepanion.ameliah.art/api/v2";
const userAgent = "CubeCraftPlus-scraper";
const mojangBaseUrl = "https://api.mojang.com";

const requestTimeoutMs = 10_000;

export const leaderboards: Task = {
  name: "leaderboards",
  schedule: process.env.LEADERBOARDS_CRON || "*/1 * * * *",
  timeoutMs: 1 * 60_000,

  async run(ctx) {
    try {
      await sendReport(await scrapeLeaderboards(ctx));
    } catch (err) {
      await sendReport({ kind: "failed", error: err });
      throw err;
    }
  },
};

async function scrapeLeaderboards({ signal }: TaskContext): Promise<RunReport> {
  const start = Bun.nanoseconds();

  // Read per run: how deep the leaderboards go is a Cubepanion setting that changes.
  const config = await fetchLeaderboardConfig(signal);

  // Without the depth there is nothing to check a partial response against.
  if (!config) throw new Error("Leaderboard config not found");

  if (!config.enabled) {
    console.log("Leaderboards are currently disabled");
    return { kind: "disabled" };
  }

  console.log(`Leaderboards hold ${config.playerCount} players`);

  const games = (await fetchGames(signal)).filter((game) => game.active);

  // Reported as a run, an empty list passes every check in needsAttention.
  if (games.length === 0) throw new Error("No active games returned");

  const reports: GameReport[] = [];

  for (const game of games) {
    reports.push(await processGame(game, config.playerCount, signal));
  }

  const seconds = (Bun.nanoseconds() - start) / 1_000_000_000;
  console.log(`Checked ${games.length} games in ${seconds.toFixed(1)}s`);

  return { kind: "run", games: reports };
}

async function processGame(
  game: Game,
  playerCount: number,
  signal: AbortSignal,
): Promise<GameReport> {
  console.log(`Fetching leaderboard for ${game.displayName} (${game.id})`);
  const leaderboard = await fetchGameLeaderboard(game.name, signal);

  if (!leaderboard) {
    console.log(`Leaderboard not found for ${game.displayName}`);
    return { game: game.displayName, status: "missing" };
  }

  console.log(`Current leaderboard last updated: `, leaderboard.lastUpdated);

  const lastSavedSnapshot = await getLastGameSnapshotTimestamp(game.id);
  console.log(`Last saved snapshot: `, lastSavedSnapshot);

  const isNewSnapshot =
    !lastSavedSnapshot || new Date(leaderboard.lastUpdated) > lastSavedSnapshot;

  if (!isNewSnapshot) {
    console.log("Leaderboard not updated since last snapshot");
    return { game: game.displayName, status: "unchanged" };
  }

  // A short board is a partial response that would fabricate departures; deeper than expected is fine.
  if (leaderboard.rows.length < playerCount) {
    console.log(
      `Leaderboard returned ${leaderboard.rows.length} rows (expected at least ${playerCount})`,
    );

    return {
      game: game.displayName,
      status: "partial",
      rows: leaderboard.rows.length,
      expected: playerCount,
    };
  }

  const igns = leaderboard.rows.map((row: LeaderboardPosition) => row.player);

  const uuidMap = await resolvePlayerUUIDs(igns, signal);

  // leaderboard_rows.player is a uuid column, so an unresolved player cannot be stored at all.
  if (uuidMap.size != leaderboard.rows.length) {
    console.log(
      `Resolved ${uuidMap.size} of ${leaderboard.rows.length} players`,
    );

    return {
      game: game.displayName,
      status: "unresolved",
      resolved: uuidMap.size,
      total: leaderboard.rows.length,
    };
  }

  await saveGameLeaderboardSnapshot(leaderboard, uuidMap);
  console.log("Leaderboard snapshot saved");

  return {
    game: game.displayName,
    status: "saved",
    lastUpdated: leaderboard.lastUpdated,
  };
}

async function resolvePlayerUUIDs(
  igns: string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const cachedPlayers = await getCachedPlayers(igns);
  const cachedIgns = new Set(cachedPlayers.map((p) => p.ign.toLowerCase()));

  const uncachedIgns = igns.filter((ign) => !cachedIgns.has(ign.toLowerCase()));
  console.log(`${uncachedIgns.length} players not found in DB cache`);

  let unknownPlayers: PlayerProfile[] = [];

  if (uncachedIgns.length > 0) {
    console.log(`Fetching from Mojang: ${uncachedIgns.join(", ")}`);
    unknownPlayers = await fetchUnknownPlayers(uncachedIgns, signal);
    console.log(`Fetched ${unknownPlayers.length} from Mojang API`);

    if (unknownPlayers.length > 0) {
      await insertCachedPlayers(unknownPlayers);
    }

    // Logged only: the Discord post does not name players.
    const notFound = uncachedIgns.filter(
      (ign) => !unknownPlayers.some((p) => p.ign === ign),
    );

    if (notFound.length > 0) {
      console.log(`Not found: ${notFound.length}`);
      console.log(`Unsuccessful players: ${notFound.join(", ")}`);
    }
  }

  const uuidMap = new Map<string, string>();
  [...cachedPlayers, ...unknownPlayers].forEach((player) => {
    uuidMap.set(player.ign.toLowerCase(), player.uuid);
  });

  return uuidMap;
}

async function saveGameLeaderboardSnapshot(
  leaderboard: Leaderboard,
  uuidMap: Map<string, string>,
) {
  const row = await Bun.sql`
    INSERT INTO leaderboard_snapshots (id, game_id, timestamp)
    VALUES (${Bun.randomUUIDv7()}, ${leaderboard.gameId}, ${leaderboard.lastUpdated})
    RETURNING id, game_id, timestamp
  `;

  const parsed = LeaderboardSnapshotRowSchema.safeParse(row[0]);
  if (!parsed.success)
    throw new Error(
      "Failed to parse created leaderboard snapshot: " + parsed.error.message,
    );

  const snapshotId = parsed.data.id;

  const leaderboardRows = leaderboard.rows.map((row) => ({
    id: Bun.randomUUIDv7(),
    snapshot_id: snapshotId,
    position: row.position,
    player: uuidMap.get(row.player.toLowerCase()) || row.player,
    score: row.score,
  }));

  await Bun.sql`INSERT INTO leaderboard_rows ${Bun.sql(leaderboardRows)}`;

  await savePlayerTextures(leaderboard, uuidMap);
}

// The timestamp guard stops a re-run or out-of-order import overwriting a newer texture.
async function savePlayerTextures(
  leaderboard: Leaderboard,
  uuidMap: Map<string, string>,
) {
  // Two IGNs on one UUID would make ON CONFLICT hit the same row twice, which Postgres rejects.
  const textures = new Map<string, PlayerTextureRow>();

  for (const row of leaderboard.rows) {
    const player = uuidMap.get(row.player.toLowerCase()) || row.player;

    textures.set(player.replace(/-/g, "").toLowerCase(), {
      player_uuid: player,
      texture: row.texture,
      updated_at: leaderboard.lastUpdated,
    });
  }

  await Bun.sql`
    INSERT INTO player_textures ${Bun.sql([...textures.values()])}
    ON CONFLICT (player_uuid) DO UPDATE
      SET texture    = EXCLUDED.texture,
          updated_at = EXCLUDED.updated_at
    WHERE player_textures.updated_at < EXCLUDED.updated_at
  `;
}

async function getLastGameSnapshotTimestamp(
  gameId: number,
): Promise<Date | null> {
  const res = await Bun.sql`
    SELECT MAX(timestamp) AS last_updated
    FROM leaderboard_snapshots
    WHERE game_id = ${gameId}
  `;

  if (!res || !res[0].last_updated) return null;

  return new Date(res[0].last_updated);
}

async function getCachedPlayers(igns: string[]): Promise<PlayerProfile[]> {
  const res = await Bun.sql`
    SELECT DISTINCT ON (player_ign)
        id,
        player_ign AS ign,
        player_uuid AS uuid
    FROM ign_history
    WHERE player_ign IN ${Bun.sql(igns)}
    ORDER BY player_ign, id DESC
  `;

  const parsed = z.array(PlayerProfileShema).safeParse(res);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return [];
  }

  return parsed.data;
}

async function insertCachedPlayers(players: PlayerProfile[]): Promise<void> {
  const mappedPlayers = players.map((player) => ({
    id: Bun.randomUUIDv7(),
    player_ign: player.ign,
    player_uuid: player.uuid,
  }));

  await Bun.sql`
    INSERT INTO ign_history ${Bun.sql(mappedPlayers)}
  `;
}

// Aborts on whichever comes first: this request stalling, the task timing out, or shutdown.
function fetchJson(url: string, signal: AbortSignal, init?: RequestInit) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
}

async function fetchGameLeaderboard(
  game: string,
  signal: AbortSignal,
): Promise<Leaderboard | undefined> {
  const res = await fetchJson(
    `${cubepanionBaseUrl}/Leaderboard/game/${game}`,
    signal,
    { headers: { "User-Agent": userAgent } },
  );
  const json = await res.json();

  const parsed = LeaderboardSchema.safeParse(json);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return;
  }

  return parsed.data;
}

async function fetchLeaderboardConfig(
  signal: AbortSignal,
): Promise<LeaderboardConfig | undefined> {
  const res = await fetchJson(
    `${cubepanionBaseUrl}/Leaderboard/config`,
    signal,
    { headers: { "User-Agent": userAgent } },
  );
  const json = await res.json();

  const parsed = LeaderboardConfigSchema.safeParse(json);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return;
  }

  return parsed.data;
}

async function fetchGames(signal: AbortSignal): Promise<Game[]> {
  const res = await fetchJson(`${cubepanionBaseUrl}/Games`, signal, {
    headers: { "User-Agent": userAgent },
  });
  const json = await res.json();

  const parsed = GameResponse.safeParse(json);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return [];
  }

  return parsed.data;
}

async function fetchUnknownPlayers(
  igns: string[],
  signal: AbortSignal,
): Promise<PlayerProfile[]> {
  const results: PlayerProfile[] = [];

  const chunkSize = 10;
  for (let i = 0; i < igns.length; i += chunkSize) {
    const chunk = igns.slice(i, i + chunkSize);
    results.push(...(await fetchPlayerProfiles(chunk, signal)));
  }
  return results;
}

async function fetchPlayerProfiles(
  igns: string[],
  signal: AbortSignal,
): Promise<PlayerProfile[]> {
  const res = await fetchJson(`${mojangBaseUrl}/profiles/minecraft`, signal, {
    method: "POST",
    body: JSON.stringify(igns),
  });
  const json = await res.json();

  const mapped = json.map((profile: { name: string; id: string }) => ({
    ign: profile.name,
    uuid: profile.id,
  }));

  const parsed = z.array(PlayerProfileShema).safeParse(mapped);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return [];
  }

  return parsed.data;
}

const PlayerProfileShema = z.object({
  id: z.string().optional(),
  ign: z.string(),
  uuid: z.string(),
});

type PlayerProfile = z.infer<typeof PlayerProfileShema>;

const LeaderboardSnapshotRowSchema = z.object({
  id: z.uuidv7(),
  game_id: z.number(),
  timestamp: z.date(),
});

type PlayerTextureRow = {
  player_uuid: string;
  texture: string;
  updated_at: Date;
};

const LeaderboardPositionSchema = z.object({
  gameId: z.number(),
  position: z.number(),
  player: z.string(),
  score: z.number(),
  texture: z.string(),
});

type LeaderboardPosition = z.infer<typeof LeaderboardPositionSchema>;

const LeaderboardSchema = z.object({
  gameId: z.number(),
  lastUpdated: z.coerce.date(),
  rows: z.array(LeaderboardPositionSchema),
});

type Leaderboard = z.infer<typeof LeaderboardSchema>;

const LeaderboardConfigSchema = z.object({
  enabled: z.boolean(),
  playerCount: z.number(),
  pageCount: z.number(),
});

type LeaderboardConfig = z.infer<typeof LeaderboardConfigSchema>;

const GameSchema = z.object({
  id: z.number(),
  name: z.string(),
  displayName: z.string(),
  aliases: z.array(z.string()),
  active: z.boolean(),
  scoreType: z.string(),
  shouldTrack: z.boolean(),
  hasPreLobby: z.boolean(),
});

type Game = z.infer<typeof GameSchema>;

const GameResponse = z.array(GameSchema);
