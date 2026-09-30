import type { Bot } from "mineflayer";

/*
 * CubeCraft's menus, as learned from packet logs:
 *
 * - Every click opens two windows: a "Loading" placeholder of gray panes, then
 *   the real menu right behind it, each sent whole. mineflayer also holds
 *   windowOpen back until a window's items are in, so the real menu is complete
 *   when its event fires. Page turns work the same way.
 * - Titles are unreadable (~156 U+FFFD characters), so screens are identified
 *   by their contents.
 * - Every navigation entry is a rabbit_foot whose meaning is its display name,
 *   and filler is exactly the items without one. Leaderboard rows are the only
 *   player heads.
 */

export type Window = NonNullable<Bot["currentWindow"]>;
type Item = NonNullable<Window["slots"][number]>;

export type Matcher = (name: string, lore: string[]) => boolean;

export type ScrapedRow = {
  position: number;
  player: string;
  score: number;
  texture: string;
};

const menuTimeoutMs = 10_000;

// An early answer to the Games item has been seen to take 1.3s.
const gamesMenuAttemptMs = 3_000;
const gamesMenuAttempts = 4;

// The boards are 100 deep over 5 pages; this only stops a runaway loop.
const maxPages = 25;

const isNext: Matcher = (name) => /^next$/i.test(name);

/** Chat components arrive in several shapes; flatten all of them to text. */
function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return node.map(flatten).join("");
  if (typeof node !== "object") return "";

  const n = node as Record<string, unknown>;
  if ("value" in n && !("text" in n) && !("extra" in n)) return flatten(n.value);

  let out = "";
  if (n.text != null) out += flatten(n.text);
  if (n.translate != null) out += `{${flatten(n.translate)}}`;
  if (n.extra) out += flatten(n.extra);
  return out;
}

const nameOf = (item: Item | null): string => (item ? flatten(item.customName).trim() : "");

function loreOf(item: Item): string[] {
  const raw: unknown = item.customLore;
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map(flatten);
}

/** Container slots only; the player inventory is never part of a menu. */
const containerSlots = (window: Window): (Item | null)[] =>
  window.slots.slice(0, window.inventoryStart ?? window.slots.length);

/** First container slot whose display name (and lore) matches, or -1. */
const findSlot = (window: Window, matches: Matcher): number =>
  containerSlots(window).findIndex((item) => item !== null && matches(nameOf(item), loreOf(item)));

const isRow = (item: Item | null): item is Item =>
  item?.name === "player_head" && nameOf(item) !== "";

export const hasEntry = (matches: Matcher) => (window: Window) => findSlot(window, matches) >= 0;
const hasRows = (window: Window) => containerSlots(window).some(isRow);

/** Every named entry, for errors that need to say what a menu did hold. */
const entries = (window: Window): string[] =>
  containerSlots(window).map(nameOf).filter((name) => name !== "");

/**
 * Run `trigger`, then wait for a newly opened menu that satisfies `ready`.
 *
 * The placeholder fails `ready` and the real menu passes, so a step costs one
 * server round trip. Slot updates are checked too, in case an entry lands after
 * its window.
 *
 * Resolves with the menu. On timeout, resolves with the last window that opened
 * so the caller can say what it holds, or null if none did.
 */
function waitForMenu(
  bot: Bot,
  trigger: () => void,
  ready: (window: Window) => boolean,
  maxMs = menuTimeoutMs,
): Promise<Window | null> {
  return new Promise((resolve) => {
    let window: Window | null = null;
    const deadline = setTimeout(settle, maxMs);

    function check() {
      if (window && ready(window)) settle();
    }
    function onOpen(opened: Window) {
      window?.removeListener("updateSlot", check);
      window = opened;
      window.on("updateSlot", check);
      check();
    }
    function settle() {
      clearTimeout(deadline);
      bot.removeListener("windowOpen", onOpen);
      window?.removeListener("updateSlot", check);
      resolve(window);
    }

    bot.on("windowOpen", onOpen);
    trigger();
  });
}

const click = (bot: Bot, slot: number) => () => {
  bot.clickWindow(slot, 0, 0).catch(() => {});
};

/**
 * Open the Games menu from the hotbar, closing whatever menu is open first.
 *
 * The lobby moves the selection to slot 4 while setting the player up, so slot
 * 0 is selected as part of every use. The retries cover a dropped click.
 */
export async function openGamesMenu(bot: Bot): Promise<Window> {
  if (bot.currentWindow) bot.closeWindow(bot.currentWindow);

  const useGames = () => {
    bot.setQuickBarSlot(0);
    bot.activateItem();
  };

  // Ready once it lists a game, which is any entry with a player count.
  const listsGames = (window: Window) => readGameCounts(window).length > 0;

  for (let attempt = 1; attempt <= gamesMenuAttempts; attempt++) {
    const window = await waitForMenu(bot, useGames, listsGames, gamesMenuAttemptMs);
    if (window && listsGames(window)) return window;
  }

  throw new Error("The Games menu did not open");
}

/** Every game in the Games menu with its live "Players: N" count. */
export function readGameCounts(window: Window): { name: string; players: number }[] {
  const counts: { name: string; players: number }[] = [];

  for (const item of containerSlots(window)) {
    if (!item) continue;
    const players = parseNumber(loreOf(item), /Players:\s*([\d,]+)/i);
    if (players !== null) counts.push({ name: nameOf(item), players });
  }

  return counts;
}

/**
 * Click the entry matching `matches`, then wait for the menu it opens to
 * satisfy `ready`. Throws, naming what the menu does hold, if either fails.
 */
export async function clickEntry(
  bot: Bot,
  window: Window,
  label: string,
  matches: Matcher,
  ready: (window: Window) => boolean,
): Promise<Window> {
  const slot = findSlot(window, matches);
  if (slot < 0) {
    throw new Error(`No "${label}" entry. The menu has: ${entries(window).join(", ")}`);
  }

  const next = await waitForMenu(bot, click(bot, slot), ready);
  if (!next || !ready(next)) {
    throw new Error(`"${label}" did not open the expected menu`);
  }

  return next;
}

/**
 * From the Games menu, open a game's leaderboard and read every page.
 *
 * `complete` is false when paging stopped anywhere but the last page, which is
 * the one without a Next button. Throws when a page does not carry on from the
 * one before: the server has been seen to answer a Next with a page of another
 * game's board, which would otherwise read as a short but complete board.
 */
export async function scrapeLeaderboard(
  bot: Bot,
  gamesMenu: Window,
  isGame: Matcher,
): Promise<{ rows: ScrapedRow[]; complete: boolean }> {
  // Usually "<Game> Statistics". Parkour's is a second entry named just
  // "Parkour" (the first one joins a game), told apart by its lore.
  const isStats: Matcher = (name, lore) =>
    /statistic/i.test(name) ||
    (isGame(name, lore) && lore.some((line) => /^click to view\.?$/i.test(line.trim())));
  const isLeaderboard: Matcher = (name) => /leaderboard/i.test(name);

  let window = await clickEntry(bot, gamesMenu, "game", isGame, hasEntry(isStats));
  window = await clickEntry(bot, window, "Statistics", isStats, hasEntry(isLeaderboard));
  window = await clickEntry(bot, window, "Leaderboard", isLeaderboard, hasRows);

  const rows: ScrapedRow[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const pageRows = readPage(window);
    if (pageRows.length === 0) return { rows, complete: false };

    const expected = (rows.at(-1)?.position ?? 0) + 1;
    pageRows.forEach((row, i) => {
      if (row.position !== expected + i) {
        throw new Error(`Page ${page} has #${row.position} where #${expected + i} belongs`);
      }
    });
    rows.push(...pageRows);

    const next = findSlot(window, isNext);
    if (next < 0) return { rows, complete: true };

    const turned = await waitForMenu(bot, click(bot, next), hasRows);
    if (!turned) return { rows, complete: false };
    window = turned;
  }

  return { rows, complete: false };
}

/** A row that is missing any field fails the whole page rather than guessing. */
function readPage(window: Window): ScrapedRow[] {
  return containerSlots(window)
    .filter(isRow)
    .map((item) => {
      const lore = loreOf(item);
      const position = parseNumber(lore, /Position:\s*(\d+)/i);
      const score = parseScore(lore);
      const texture = textureOf(item);

      if (position === null || score === null || texture === null) {
        throw new Error(`Unreadable leaderboard row for ${nameOf(item)}: ${lore.join(" | ")}`);
      }

      return { position, player: nameOf(item), score, texture };
    });
}

/** First capture of `pattern` in the lore as a number, commas dropped. */
function parseNumber(lore: string[], pattern: RegExp): number | null {
  for (const line of lore) {
    const m = line.match(pattern);
    if (m) return Number(m[1]!.replace(/,/g, ""));
  }
  return null;
}

/** The "<Stat>: <number>" line that is not the position, e.g. "Wins: 33,671". */
function parseScore(lore: string[]): number | null {
  for (const line of lore) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]*?):\s*([\d,]+)\s*$/);
    if (m && !/^position$/i.test(m[1]!.trim())) return Number(m[2]!.replace(/,/g, ""));
  }
  return null;
}

/*
 * The head's profile.uuid is not the player: CubeCraft builds each skull with a
 * freshly generated profile id, so the same player comes back with a different
 * uuid on every scrape. The username is the only identity a row carries; the
 * texture is only for rendering the head.
 */
function textureOf(item: Item): string | null {
  const profile = (item as any).componentMap?.get("profile")?.data;
  const properties: { name: string; value: string }[] = profile?.properties ?? [];
  return properties.find((p) => p.name === "textures")?.value ?? null;
}
