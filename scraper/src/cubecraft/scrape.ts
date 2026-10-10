import { gameMatcher, type Game } from "../games";
import { connect } from "./connection";
import {
  openGamesMenu,
  readGameCounts,
  readGameEntries,
  scrapeLeaderboard,
  type GameEntry,
  type ScrapedRow,
  type Window,
} from "./menus";

export type Board = { game: Game; readAt: Date; attempts: number } & (
  | { ok: true; rows: ScrapedRow[]; complete: boolean }
  | { ok: false; error: string }
);

export type ScrapeResult = {
  countsReadAt: Date;
  counts: { gameId: number; players: number }[];
  // Active games the Games menu gave no count for.
  missingCounts: number[];
  unmappedGames: string[];
  boards: Board[];
};

// The whole Games menu is logged once per process, as what a healthy one looks like.
let menuLogged = false;

/**
 * One login: read every game's player count off the Games menu, then open the
 * leaderboard of each active game that has one in turn. A board that fails is
 * reported and the rest carry on; only failing to log in or to open the Games
 * menu throws.
 */
export async function scrapeCubeCraft(signal: AbortSignal, games: Game[]): Promise<ScrapeResult> {
  const gameOf = gameMatcher(games);
  const isGame = (game: Game) => (name: string) => gameOf(name)?.id === game.id;

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
      const game = gameOf(name);

      if (!game) {
        unmappedGames.push(name);
      } else if (counts.some((c) => c.gameId === game.id)) {
        console.warn(`[cubecraft] "${name}" is another entry for ${game.displayName}; keeping the first count`);
      } else {
        counts.push({ gameId: game.id, players });
      }
    }

    const entries = readGameEntries(menu);

    if (!menuLogged) {
      menuLogged = true;
      console.log(`[cubecraft] Games menu as first read: ${show(entries.map(({ raw, ...entry }) => entry), 8000)}`);
    }

    const missing = games.filter((g) => g.active && !counts.some((c) => c.gameId === g.id));
    for (const game of missing) console.warn(`[cubecraft] ${missingCountNote(game, entries, gameOf)}`);

    // Every board starts from the Games menu; the one read for the counts is
    // used for the first, the rest open it again.
    let openMenu: Window | null = menu;
    const gamesMenu = async () => {
      const current = openMenu ?? (await openGamesMenu(bot));
      openMenu = null;
      return current;
    };

    const boards: Board[] = [];

    for (const game of games.filter((g) => g.active && g.hasLeaderboard)) {
      let board: Board | undefined;

      // One retry: a board that fails or stops early has so far always been a
      // one-off on the server's side.
      for (let attempt = 1; attempt <= 2; attempt++) {
        signal.throwIfAborted();
        try {
          const { rows, complete } = await scrapeLeaderboard(bot, await gamesMenu(), isGame(game));
          board = { game, readAt: new Date(), attempts: attempt, ok: true, rows, complete };
          if (complete) break;
        } catch (err) {
          board = { game, readAt: new Date(), attempts: attempt, ok: false, error: describe(err) };
        }
        console.warn(`[cubecraft] ${game.displayName} attempt ${attempt} did not read cleanly`);
      }

      boards.push(board!);
    }

    return { countsReadAt, counts, missingCounts: missing.map((g) => g.id), unmappedGames, boards };
  } finally {
    signal.removeEventListener("abort", onAbort);
    bot.quit();
  }
}

// Says what the menu held for an active game that gave no count.
function missingCountNote(game: Game, entries: GameEntry[], gameOf: (name: string) => Game | undefined): string {
  const own = entries.filter((e) => gameOf(e.name)?.id === game.id);

  if (own.length === 0) {
    return `${game.displayName} is not in the Games menu, which lists ${entries.map((e) => e.name).join(", ")}`;
  }

  const counted = entries.find((e) => e.players !== null);
  return `no player count for ${game.displayName}; its entry reads ${show(own)}; a game with a count reads ${show(counted)}`;
}

// Capped so one odd item cannot flood the log.
function show(value: unknown, max = 2000): string {
  const text = JSON.stringify(value) ?? "nothing";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
