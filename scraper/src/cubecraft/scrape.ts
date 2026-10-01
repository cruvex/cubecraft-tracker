import { connect } from "./connection";
import { openGamesMenu, readGameCounts, scrapeLeaderboard, type ScrapedRow, type Window } from "./menus";

export type Game = {
  // As the Games menu shows it, minus decorations like " -UPDATE!".
  menuName: string;
  // Cubepanion's game id, which is what game_id holds in every table.
  id: number;
  leaderboard: boolean;
};

// The Games menu has no ids, so this maps its names onto the ones the database
// already uses. A game missing here still shows up, as an unmapped count.
export const games: Game[] = [
  { menuName: "EggWars", id: 11, leaderboard: true },
  { menuName: "Lucky Islands", id: 12, leaderboard: true },
  { menuName: "BedWars", id: 3, leaderboard: true },
  // Its Statistics screen has no Leaderboard entry.
  { menuName: "Skyblock", id: 7, leaderboard: false },
  { menuName: "Free For All", id: 1, leaderboard: true },
  { menuName: "SkyWars", id: 10, leaderboard: true },
  { menuName: "Pillars of Fortune", id: 8, leaderboard: true },
  { menuName: "Parkour", id: 2, leaderboard: true },
];

// Match on the start: CubeCraft decorates names ("BedWars -UPDATE!").
const matches = (game: Game) => (name: string) =>
  name.toLowerCase().startsWith(game.menuName.toLowerCase());

export type Board = { game: Game; readAt: Date } & (
  | { ok: true; rows: ScrapedRow[]; complete: boolean }
  | { ok: false; error: string }
);

export type ScrapeResult = {
  countsReadAt: Date;
  counts: { gameId: number; players: number }[];
  unmappedGames: string[];
  boards: Board[];
};

/**
 * One login: read every game's player count off the Games menu, then open each
 * game's leaderboard in turn. A board that fails is reported and the rest
 * carry on; only failing to log in or to open the Games menu throws.
 */
export async function scrapeCubeCraft(signal: AbortSignal): Promise<ScrapeResult> {
  const bot = await connect(signal);

  // Menu waits do not watch the signal, but they cannot outlive the connection.
  const onAbort = () => bot.quit();
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    const menu = await openGamesMenu(bot);
    const countsReadAt = new Date();

    const counts: ScrapeResult["counts"] = [];
    const unmappedGames: string[] = [];

    for (const { name, players } of readGameCounts(menu)) {
      const game = games.find((g) => matches(g)(name));
      if (game) counts.push({ gameId: game.id, players });
      else unmappedGames.push(name);
    }

    // Every board starts from the Games menu; the one read for the counts is
    // used for the first, the rest open it again.
    let openMenu: Window | null = menu;
    const gamesMenu = async () => {
      const current = openMenu ?? (await openGamesMenu(bot));
      openMenu = null;
      return current;
    };

    const boards: Board[] = [];

    for (const game of games.filter((g) => g.leaderboard)) {
      let board: Board | undefined;

      // One retry: a board that fails or stops early has so far always been a
      // one-off on the server's side.
      for (let attempt = 1; attempt <= 2; attempt++) {
        signal.throwIfAborted();
        try {
          const { rows, complete } = await scrapeLeaderboard(bot, await gamesMenu(), matches(game));
          board = { game, readAt: new Date(), ok: true, rows, complete };
          if (complete) break;
        } catch (err) {
          board = { game, readAt: new Date(), ok: false, error: describe(err) };
        }
        console.warn(`[cubecraft] ${game.menuName} attempt ${attempt} did not read cleanly`);
      }

      boards.push(board!);
    }

    return { countsReadAt, counts, unmappedGames, boards };
  } finally {
    signal.removeEventListener("abort", onAbort);
    bot.quit();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
