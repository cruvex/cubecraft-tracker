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
    const boards: BoardRun[] = [];
    let failure: { error: unknown } | undefined;

    try {
      await scrapeAndSave(signal, boards);
    } catch (err) {
      failure = { error: err };
      throw err;
    } finally {
      // Also when the run failed or timed out, with whichever boards it got through.
      await saveRun(firedAt, performance.now() - started, boards, failure);
    }
  },
};

// What a run did with one board, as stored in scrape_runs.boards.
type BoardRun = { gameId: number; attempts: number } & BoardReport;

async function scrapeAndSave(signal: AbortSignal, boards: BoardRun[]) {
  let result: ScrapeResult;

  try {
    // The games task keeps this table up to date, so a run does not depend on Cubepanion being up.
    const games = await loadGames();
    if (games.length === 0) throw new Error("The games table is empty");

    result = await scrapeCubeCraft(signal, games);
  } catch (err) {
    await sendReport({ kind: "failed", error: err });
    throw err;
  }

  await saveCounts(result);

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

async function saveRun(
  startedAt: Date,
  durationMs: number,
  boards: BoardRun[],
  failure: { error: unknown } | undefined,
) {
  const skipped = boards.some((b) => b.status !== "saved" && b.status !== "unchanged");
  const status = failure ? "failed" : skipped ? "degraded" : "ok";

  try {
    // boards goes in as an array of objects: a JSON string would be stored as a jsonb string.
    // The game names are left out, as the games table has them.
    await Bun.sql`
      INSERT INTO scrape_runs ${Bun.sql({
        started_at: startedAt,
        duration_ms: Math.round(durationMs),
        status,
        error: failure ? errorMessage(failure.error) : null,
        boards: boards.map(({ game, ...board }) => board),
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
