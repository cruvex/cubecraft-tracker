import { z } from "zod";

const mojangBaseUrl = "https://api.mojang.com";
const requestTimeoutMs = 10_000;

export type BoardRow = {
  position: number;
  // The IGN as the board shows it; stored rows hold the resolved uuid.
  player: string;
  score: number;
  texture: string;
};

/**
 * IGN (lowercased) -> uuid, from the ign_history cache first and Mojang for the
 * rest. Names Mojang does not know are simply absent from the map.
 */
export async function resolvePlayerUUIDs(
  igns: string[],
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const cachedPlayers = await getCachedPlayers(igns);
  const cachedIgns = new Set(cachedPlayers.map((p) => p.ign.toLowerCase()));

  const uncachedIgns = igns.filter((ign) => !cachedIgns.has(ign.toLowerCase()));

  let unknownPlayers: PlayerProfile[] = [];

  if (uncachedIgns.length > 0) {
    console.log(`Fetching from Mojang: ${uncachedIgns.join(", ")}`);
    unknownPlayers = await fetchUnknownPlayers(uncachedIgns, signal);

    if (unknownPlayers.length > 0) {
      await insertCachedPlayers(unknownPlayers);
    }

    // Logged only: the Discord post does not name players.
    const notFound = uncachedIgns.filter(
      (ign) => !unknownPlayers.some((p) => p.ign.toLowerCase() === ign.toLowerCase()),
    );

    if (notFound.length > 0) {
      console.log(`Not found at Mojang: ${notFound.join(", ")}`);
    }
  }

  const uuidMap = new Map<string, string>();
  for (const player of [...cachedPlayers, ...unknownPlayers]) {
    uuidMap.set(player.ign.toLowerCase(), player.uuid);
  }

  return uuidMap;
}

export type ScoreChange = {
  ign: string;
  // Null for a player who was not on the previous read.
  from: number | null;
  to: number;
};

// Extends a player's period to `readAt` if they were on the previous read with the same score and position, else starts a new one.
export async function savePlayerScores(
  gameId: number,
  readAt: Date,
  rows: BoardRow[],
  uuidMap: Map<string, string>,
): Promise<ScoreChange[]> {
  // Two IGNs on one uuid would start two periods with the same key, so the higher-placed row wins.
  const board = new Map<string, BoardRow>();
  for (const row of rows) {
    const player = normalizeUuid(uuidMap.get(row.player.toLowerCase())!);
    if (board.has(player)) {
      console.warn(`${row.player} resolves to the same uuid as ${board.get(player)!.player}; keeping the higher-placed row`);
      continue;
    }
    board.set(player, row);
  }

  const changes = await Bun.sql.begin(async (tx) => {
    const previous: PreviousReading[] = await tx`
      SELECT player::text AS player, score, position, last_seen
      FROM player_scores
      WHERE game_id = ${gameId}
        AND last_seen = (SELECT MAX(last_seen) FROM player_scores WHERE game_id = ${gameId})
    `;

    // This read, or a newer one, is already recorded: a re-run or an out-of-order import.
    if (previous.length > 0 && previous[0]!.last_seen >= readAt) return [];

    const previousByPlayer = new Map(previous.map((p) => [normalizeUuid(p.player), p]));

    const extended: string[] = [];
    const started: PlayerScoreRow[] = [];
    const changes: ScoreChange[] = [];

    for (const [player, row] of board) {
      const prev = previousByPlayer.get(player);

      if (prev && prev.score === row.score && prev.position === row.position) {
        extended.push(player);
      } else {
        started.push({
          game_id: gameId,
          player,
          score: row.score,
          position: row.position,
          first_seen: readAt,
          last_seen: readAt,
        });
        changes.push({ ign: row.player, from: prev?.score ?? null, to: row.score });
      }
    }

    // The subquery runs before the update, so it still finds the previous read.
    if (extended.length > 0) {
      await tx`
        UPDATE player_scores
        SET last_seen = ${readAt}
        WHERE game_id = ${gameId}
          AND player IN ${tx(extended)}
          AND last_seen = (SELECT MAX(last_seen) FROM player_scores WHERE game_id = ${gameId})
      `;
    }

    if (started.length > 0) {
      await tx`INSERT INTO player_scores ${tx(started)}`;
    }

    return changes;
  });

  if (changes.length > 0) {
    await savePlayerTextures(readAt, [...board.values()], uuidMap);
  }

  return changes;
}

// The timestamp guard stops a re-run or out-of-order import overwriting a newer texture.
async function savePlayerTextures(
  timestamp: Date,
  rows: BoardRow[],
  uuidMap: Map<string, string>,
) {
  // Two IGNs on one UUID would make ON CONFLICT hit the same row twice, which Postgres rejects.
  const textures = new Map<string, PlayerTextureRow>();

  for (const row of rows) {
    const player = uuidMap.get(row.player.toLowerCase())!;
    textures.set(player, { player_uuid: player, texture: row.texture, updated_at: timestamp });
  }

  await Bun.sql`
    INSERT INTO player_textures ${Bun.sql([...textures.values()])}
    ON CONFLICT (player_uuid) DO UPDATE
      SET texture    = EXCLUDED.texture,
          updated_at = EXCLUDED.updated_at
    WHERE player_textures.updated_at < EXCLUDED.updated_at
  `;
}

// Mojang answers without dashes, Postgres with them.
function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

async function getCachedPlayers(igns: string[]): Promise<PlayerProfile[]> {
  const res = await Bun.sql`
    SELECT DISTINCT ON (player_uuid)
        id,
        player_ign AS ign,
        player_uuid AS uuid
    FROM ign_history
    WHERE player_ign IN ${Bun.sql(igns)}
    ORDER BY player_uuid, id
  `;

  const parsed = z.array(PlayerProfileSchema).safeParse(res);

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

async function fetchUnknownPlayers(
  igns: string[],
  signal: AbortSignal,
): Promise<PlayerProfile[]> {
  const results: PlayerProfile[] = [];

  // Mojang's bulk lookup takes at most 10 names per request.
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
  const res = await fetch(`${mojangBaseUrl}/profiles/minecraft`, {
    method: "POST",
    body: JSON.stringify(igns),
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
  const json = await res.json();

  const mapped = json.map((profile: { name: string; id: string }) => ({
    ign: profile.name,
    uuid: profile.id,
  }));

  const parsed = z.array(PlayerProfileSchema).safeParse(mapped);

  if (!parsed.success) {
    console.error("Invalid response:", parsed.error);
    return [];
  }

  return parsed.data;
}

const PlayerProfileSchema = z.object({
  id: z.string().optional(),
  ign: z.string(),
  uuid: z.string(),
});

type PlayerProfile = z.infer<typeof PlayerProfileSchema>;

type PlayerScoreRow = {
  game_id: number;
  player: string;
  score: number;
  position: number;
  first_seen: Date;
  last_seen: Date;
};

type PreviousReading = {
  player: string;
  score: number;
  position: number;
  last_seen: Date;
};

type PlayerTextureRow = {
  player_uuid: string;
  texture: string;
  updated_at: Date;
};
