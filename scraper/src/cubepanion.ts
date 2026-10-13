import type { ScrapeResult } from "./cubecraft/scrape";

const baseUrl = "https://cubepanion.ameliah.art";
const submitterUuid = process.env.CUBEPANION_SUBMITTER_UUID;
const apiKey = process.env.CUBEPANION_API_KEY;

// UTC hour of each game's last board submission, e.g. "2026-10-13T12".
const submittedHour = new Map<number, string>();

// Counts as submitted, so boards start on the next hour after a deploy.
const startHour = new Date().toISOString().slice(0, 13);

// errors maps what failed ("player counts" or a game) to why.
export type CubepanionRun = { boards: number[]; errors?: Record<string, string> };

/** Counts every run, complete boards once per clock hour; undefined when submitting is off. */
export async function submitToCubepanion(result: ScrapeResult, signal: AbortSignal): Promise<CubepanionRun | undefined> {
  if (!submitterUuid || !apiKey) return undefined;

  const boards: number[] = [];
  const errors: Record<string, string> = {};

  const submit = async (what: string, path: string, body: unknown) => {
    try {
      await post(path, body, signal);
      return true;
    } catch (err) {
      signal.throwIfAborted();

      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cubepanion] submitting ${what} failed: ${message}`);
      errors[what] = message;
      return false;
    }
  };

  if (result.counts.length > 0) {
    const timeStamp = result.countsReadAt.toISOString();
    await submit(
      "player counts",
      "/api/Stats/submit-bot",
      result.counts.map(({ gameId, players }) => ({ gameId, playerCount: players, timeStamp })),
    );
  }

  for (const board of result.boards) {
    if (!board.ok || !board.complete) continue;

    const gameId = board.game.id;
    const hour = board.readAt.toISOString().slice(0, 13);
    if ((submittedHour.get(gameId) ?? startHour) === hour) continue;

    const entries = board.rows.map(({ position, player, score, texture }) => ({ gameId, position, score, player, texture }));

    if (await submit(board.game.displayName, "/api/v2/Leaderboard/submit-bot", { uuid: submitterUuid, gameId, entries })) {
      submittedHour.set(gameId, hour);
      boards.push(gameId);
    }
  }

  return { boards, ...(Object.keys(errors).length > 0 && { errors }) };
}

async function post(path: string, body: unknown, signal: AbortSignal): Promise<void> {
  const url = new URL(path, baseUrl);
  url.searchParams.set("api-key", apiKey!);

  // Errors name only the path, keeping the key out of logs.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "CubeCraftPlus-scraper" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });

  if (!res.ok) {
    const text = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(`Cubepanion ${path} returned ${res.status}${text ? `: ${text}` : ""}`);
  }
}
