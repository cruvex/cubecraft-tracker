import { scrapeCubeCraft, type Board, type ScrapeResult } from "../cubecraft/scrape";
import { loadGames } from "../games";
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

  async run({ signal, firedAt }) {
    const started = performance.now();
    const details: RunDetails = {};

    try {
      await scrapeAndSave(signal, details);
    } catch (err) {
      details.error = errorMessage(err);
      throw err;
    } finally {
      // Also when the run failed or timed out, with whatever it got through.
      await saveRun(firedAt, performance.now() - started, details);
    }
  },
};

// What a board run is stored as: the game's id and attempts, and how it went.
type BoardRun = { gameId: number; attempts: number } & BoardReport;

// What scrape_runs.details holds; a key is there only when it applies.
type RunDetails = { boards?: BoardRun[]; missingCounts?: number[]; unmapped?: string[]; error?: string };

async function scrapeAndSave(signal: AbortSignal, details: RunDetails) {
  let result: ScrapeResult;

  try {
    const games = await loadGames();
    if (games.length === 0) throw new Error("The games table is empty");

    result = await scrapeCubeCraft(signal, games);
  } catch (err) {
    await sendReport({ kind: "failed", error: err });
    throw err;
  }

  if (result.missingCounts.length > 0) details.missingCounts = result.missingCounts;
  if (result.unmappedGames.length > 0) details.unmapped = result.unmappedGames;

  await saveCounts(result);

  const boards: BoardRun[] = (details.boards = []);

  for (const board of result.boards) {
    const report = await saveBoardSafely(board, signal);
    boards.push({ gameId: board.game.id, attempts: board.attempts, ...report });
  }

  const saved = boards.filter((b) => b.status === "saved").length;
  console.log(`${result.counts.length} player counts, ${saved} of ${boards.length} boards changed`);

  await sendReport({ kind: "run", boards, unmappedGames: result.unmappedGames });
}

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

async function saveRun(startedAt: Date, durationMs: number, { boards, ...rest }: RunDetails) {
  const skipped = boards?.some((b) => b.status !== "saved" && b.status !== "unchanged") || rest.unmapped !== undefined;
  const status = rest.error !== undefined ? "failed" : skipped ? "degraded" : "ok";

  try {
    // details goes in as an object: a JSON string would be stored as a jsonb string.
    // The game names are left out, as the games table has them.
    const details = { ...rest, ...(boards && { boards: boards.map(({ game, ...board }) => board) }) };

    await Bun.sql`
      INSERT INTO scrape_runs ${Bun.sql({
        started_at: startedAt,
        duration_ms: Math.round(durationMs),
        status,
        details,
      })}
      ON CONFLICT (started_at) DO NOTHING
    `;
  } catch (err) {
    // A run that did its job has not failed because the log of it did.
    console.error("[cubecraft] failed to record the run:", err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// One board failing to save must not skip the boards after it.
async function saveBoardSafely(board: Board, signal: AbortSignal): Promise<BoardReport> {
  try {
    return await saveBoard(board, signal);
  } catch (err) {
    // A timeout or shutdown is the whole run's failure, not this board's.
    signal.throwIfAborted();

    console.error(`[cubecraft] ${board.game.displayName}: saving the board failed`, err);
    return {
      game: board.game.displayName,
      status: "crashed",
      error: errorMessage(err),
    };
  }
}

async function saveBoard(board: Board, signal: AbortSignal): Promise<BoardReport> {
  const game = board.game.displayName;

  if (!board.ok) return { game, status: "failed", error: board.error };

  // A short board would read as players dropping off it.
  if (!board.complete) return { game, status: "partial", rows: board.rows.length };

  const uuidMap = await resolvePlayerUUIDs(board.rows.map((row) => row.player), signal);

  // player_scores.player is a uuid column, so an unresolved player cannot be stored at all.
  const notFound = board.rows.filter((row) => !uuidMap.has(row.player.toLowerCase())).map((row) => row.player);
  if (notFound.length > 0) {
    return { game, status: "unresolved", resolved: board.rows.length - notFound.length, total: board.rows.length, notFound };
  }

  const changes = await savePlayerScores(board.game.id, board.readAt, board.rows, uuidMap);

  for (const { ign, from, to } of changes) {
    if (from !== null && to < from) console.warn(`[cubecraft] ${game}: ${ign} went down from ${from} to ${to}`);
  }

  return changes.length > 0 ? { game, status: "saved", changed: changes.length } : { game, status: "unchanged" };
}
