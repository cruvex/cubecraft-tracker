import { diffGames, fetchCubepanionGames, loadGames, saveGames } from "../games";
import { sendGamesChanged } from "../report";
import type { Task } from "../scheduler";

// Games Cubepanion no longer lists, already said once. Kept in memory, so a restart says it again.
const reportedRemoved = new Set<number>();

// Keeps the games table in step with Cubepanion's list, writing only what changed, and says what did.
// A failed run leaves the table as it was, which is what the scrape then goes on using.
export const games: Task = {
  name: "games",
  schedule: process.env.GAMES_CRON || "*/5 * * * *",
  timeoutMs: 30_000,

  async run({ signal }) {
    const fetched = await fetchCubepanionGames(signal);
    const stored = await loadGames();

    // The first run fills an empty table, which is not news.
    if (stored.length === 0) {
      await saveGames(fetched);
      console.log(`[games] stored ${fetched.length} games`);
      return;
    }

    const { changed, removed, lines } = diffGames(stored, fetched);

    // Said once the change is stored, so a failed write is not announced twice.
    const news = [...lines];

    if (changed.length > 0) await saveGames(changed);

    for (const game of removed) {
      if (reportedRemoved.has(game.id)) continue;

      reportedRemoved.add(game.id);
      news.push(`${game.displayName} (${game.id}) is no longer in Cubepanion's list; keeping it`);
    }

    for (const line of news) console.log(`[games] ${line}`);
    await sendGamesChanged(news);
  },
};
