import { scrapeCubeCraft, type Board, type ScrapeResult } from "../cubecraft/scrape";
import { resolvePlayerUUIDs, savePlayerScores } from "../leaderboard-store";
import { sendReport, type BoardReport } from "../report";
import type { Task } from "../scheduler";

// Logs in to CubeCraft as a player and reads the numbers straight off its
// menus: every game's live player count, and every game's top-100 leaderboard.
export const cubecraft: Task = {
  name: "cubecraft",
  schedule: process.env.CUBECRAFT_CRON || "*/5 * * * *",
  // A run takes 10-30s; the rest is room for Mojang lookups and retries.
  timeoutMs: 4 * 60_000,

  async run({ signal }) {
    let result: ScrapeResult;

    try {
      result = await scrapeCubeCraft(signal);
    } catch (err) {
      await sendReport({ kind: "failed", error: err });
      throw err;
    }

    await saveCounts(result);

    const boards: BoardReport[] = [];
    for (const board of result.boards) {
      boards.push(await saveBoard(board, signal));
    }

    const saved = boards.filter((b) => b.status === "saved").length;
    console.log(`${result.counts.length} player counts, ${saved} of ${boards.length} boards changed`);

    await sendReport({ kind: "run", boards, unmappedGames: result.unmappedGames });
  },
};

async function saveCounts({ countsReadAt, counts }: ScrapeResult) {
  if (counts.length === 0) return;

  const timestamp = new Date(countsReadAt);
  timestamp.setMilliseconds(0);

  await Bun.sql`
    INSERT INTO game_player_counts ${Bun.sql(
      counts.map(({ gameId, players }) => ({ timestamp, game_id: gameId, players })),
    )}
    ON CONFLICT (game_id, timestamp) DO NOTHING
  `;
}

async function saveBoard(board: Board, signal: AbortSignal): Promise<BoardReport> {
  const game = board.game.menuName;

  if (!board.ok) return { game, status: "failed", error: board.error };

  // A short board would read as players dropping off it.
  if (!board.complete) return { game, status: "partial", rows: board.rows.length };

  const uuidMap = await resolvePlayerUUIDs(board.rows.map((row) => row.player), signal);

  // player_scores.player is a uuid column, so an unresolved player cannot be stored at all.
  const resolved = board.rows.filter((row) => uuidMap.has(row.player.toLowerCase())).length;
  if (resolved !== board.rows.length) {
    return { game, status: "unresolved", resolved, total: board.rows.length };
  }

  const changes = await savePlayerScores(board.game.id, board.readAt, board.rows, uuidMap);

  for (const { ign, from, to } of changes) {
    if (from !== null && to < from) console.warn(`[cubecraft] ${game}: ${ign} went down from ${from} to ${to}`);
  }

  return { game, status: changes.length > 0 ? "saved" : "unchanged" };
}
