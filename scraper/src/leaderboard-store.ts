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

/**
 * Whether `rows` (players already resolved to uuids) are exactly the latest
 * saved snapshot of the game: same players at the same positions with the same
 * scores. Such a board is not saved again.
 */
export async function matchesLatestSnapshot(
  gameId: number,
  rows: BoardRow[],
  uuidMap: Map<string, string>,
): Promise<boolean> {
  const latest = await Bun.sql`
    SELECT position, player::text AS player, score
    FROM leaderboard_rows
    WHERE snapshot_id = (
      SELECT id FROM leaderboard_snapshots
      WHERE game_id = ${gameId}
      ORDER BY timestamp DESC
      LIMIT 1
    )
    ORDER BY position
  `;

  if (latest.length !== rows.length) return false;

  return rows.every((row, i) => {
    const saved = latest[i];
    return (
      saved.position === row.position &&
      saved.score === row.score &&
      normalizeUuid(saved.player) === normalizeUuid(uuidMap.get(row.player.toLowerCase())!)
    );
  });
}

export async function saveSnapshot(
  gameId: number,
  timestamp: Date,
  rows: BoardRow[],
  uuidMap: Map<string, string>,
) {
  const snapshotId = Bun.randomUUIDv7();

  await Bun.sql.begin(async (tx) => {
    await tx`
      INSERT INTO leaderboard_snapshots (id, game_id, timestamp)
      VALUES (${snapshotId}, ${gameId}, ${timestamp})
    `;

    const leaderboardRows = rows.map((row) => ({
      id: Bun.randomUUIDv7(),
      snapshot_id: snapshotId,
      position: row.position,
      player: uuidMap.get(row.player.toLowerCase())!,
      score: row.score,
    }));

    await tx`INSERT INTO leaderboard_rows ${tx(leaderboardRows)}`;
  });

  await savePlayerTextures(timestamp, rows, uuidMap);
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

type PlayerTextureRow = {
  player_uuid: string;
  texture: string;
  updated_at: Date;
};
