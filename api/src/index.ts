import { getUuidByIgn, getUuidsByIgns, getTopGainers, getTopGainersForPeriod, getTopGainerMonths, getTopGainersHistory, getPlayersHistory, getPlayerScores, getPlayerPeriodScores, getLeaderboard, getLastSnapshotTimes, getGamePopulation, getServerPopulation, getServerStatus, getActiveHours, searchPlayers } from "./db";
import { fetchGames } from "./cubepanion";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PATTERN = /^\d{4}$/;

/** The `month` or `year` query param as one period string; null if neither, or an error response if invalid. */
function parsePeriod(url: URL): string | null | Response {
    const month = url.searchParams.get("month");
    const year = url.searchParams.get("year");
    if (month && !MONTH_PATTERN.test(month)) return jsonResponse({ error: "Invalid month" }, 400);
    if (year && !YEAR_PATTERN.test(year)) return jsonResponse({ error: "Invalid year" }, 400);
    return month || year || null;
}

// Utility helpers
function jsonResponse(obj: unknown, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

/** Resolve an ID which could be a UUID or an IGN to a UUID. */
async function resolvePlayerId(id: string): Promise<string | null> {
    const isUuid = id.length >= 32 && (id.includes("-") || id.length === 32);
    return isUuid ? id : await getUuidByIgn(id);
}

// Route Handlers

async function handleTopGainers(req: Request, params: { gameId: string }) {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") || 30);
    const period = parsePeriod(url);
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);
    if (period instanceof Response) return period;
    const result = period ? await getTopGainersForPeriod(period, gameId) : await getTopGainers(days, gameId);
    return jsonResponse(result);
}

async function handleTopGainersHistory(req: Request, params: { gameId: string }) {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") || 30);
    const limit = Number(url.searchParams.get("limit") || 10);
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);
    const result = await getTopGainersHistory(days, gameId, limit);
    return jsonResponse(result);
}

async function handleTopGainerMonths(req: Request, params: { gameId: string }) {
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);
    const result = await getTopGainerMonths(gameId);
    return jsonResponse(result);
}

// Generic batch history for an explicit player set (uuids or igns via ?ids=a,b,c).
async function handlePlayersHistory(req: Request, params: { gameId: string }) {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") || 30);
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);

    const ids = (url.searchParams.get("ids") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    // Accept either UUIDs or IGNs.
    const igns = ids.filter((id) => id.length < 32);
    const uuidByIgn = await getUuidsByIgns(igns);
    const uuids = ids
        .map((id) => (id.length >= 32 ? id : uuidByIgn.get(id.toLowerCase())))
        .filter((id): id is string => !!id); // unresolved IGNs are dropped

    const result = await getPlayersHistory(uuids, days, gameId);
    return jsonResponse(result);
}

async function handlePlayerScores(req: Request, params: { gameId: string, id: string }) {
    const id = await resolvePlayerId(params.id);
    if (!id) {
        return jsonResponse({ error: "Player not found" }, 404);
    }
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") || 30);
    const period = parsePeriod(url);
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);
    if (period instanceof Response) return period;
    const result = period ? await getPlayerPeriodScores(id, period, gameId) : await getPlayerScores(id, days, gameId);
    if (!result) {
        return jsonResponse({ error: "Player scores not found" }, 404);
    }
    return jsonResponse(result);
}

// Clamped, unlike other routes: this table grows by the minute and would scan the lot.
async function handleGamePopulation(req: Request, params: { gameId: string }) {
    const url = new URL(req.url);
    const gameId = Number(params.gameId);
    if (isNaN(gameId)) return jsonResponse({ error: "Invalid gameId" }, 400);

    const hours = clamp(Number(url.searchParams.get("hours") || 24), 1, 8760);
    const bucket = clamp(Number(url.searchParams.get("bucket") || 300), 60, 86400);

    const result = await getGamePopulation(gameId, hours, bucket);
    return jsonResponse(result);
}

async function handleServerPopulation(req: Request) {
    const url = new URL(req.url);
    const hours = clamp(Number(url.searchParams.get("hours") || 24), 1, 8760);
    const bucket = clamp(Number(url.searchParams.get("bucket") || 300), 60, 86400);

    const result = await getServerPopulation(hours, bucket, resolveTimeZone(url.searchParams.get("tz")));
    return jsonResponse(result);
}

async function handleServerStatus() {
    return jsonResponse(await getServerStatus());
}

// Bucketing happens in the viewer's zone, so an unknown one falls back instead of erroring the query.
function resolveTimeZone(tz: string | null) {
    if (!tz) return "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return tz;
    } catch {
        return "UTC";
    }
}

async function handleServerActiveHours(req: Request) {
    const url = new URL(req.url);
    const days = clamp(Number(url.searchParams.get("days") || 30), 1, 365);
    const timeZone = resolveTimeZone(url.searchParams.get("tz"));

    const result = await getActiveHours(days, timeZone);
    return jsonResponse(result);
}

function clamp(value: number, min: number, max: number) {
    if (isNaN(value)) return min;
    return Math.min(Math.max(Math.round(value), min), max);
}

async function handleGames() {
    const games = await fetchGames();
    const lastSnapshots = await getLastSnapshotTimes(games.map((g) => g.id));
    return jsonResponse(
        games
            .filter((g) => lastSnapshots.has(g.id))
            .map((g) => ({ ...g, lastSnapshot: lastSnapshots.get(g.id) })),
    );
}

async function handleSearchPlayers(req: Request) {
    const url = new URL(req.url);
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length < 2) return jsonResponse([]);
    const result = await searchPlayers(q);
    return jsonResponse(result);
}

async function handleLeaderboard (req: Request, params: { gameId: string })  {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") || 30);
    const result = await getLeaderboard(params.gameId, days);
    return jsonResponse(result);
}

// Main server
Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    routes: {
        "/api/games/:gameId/top-gainers": (req) => handleTopGainers(req, req.params as { gameId: string }),
        "/api/games/:gameId/top-gainers/history": (req) => handleTopGainersHistory(req, req.params as { gameId: string }),
        "/api/games/:gameId/top-gainers/months": (req) => handleTopGainerMonths(req, req.params as { gameId: string }),
        "/api/games/:gameId/players/history": (req) => handlePlayersHistory(req, req.params as { gameId: string }),
        "/api/games/:gameId/player/:id": (req) => handlePlayerScores(req, req.params as { gameId: string, id: string }),
        "/api/games": handleGames,
        "/api/games/:gameId/leaderboard": (req) => handleLeaderboard(req, req.params as { gameId: string }),
        "/api/games/:gameId/population": (req) => handleGamePopulation(req, req.params as { gameId: string }),
        "/api/server/population": handleServerPopulation,
        "/api/server/status": handleServerStatus,
        "/api/server/active-hours": handleServerActiveHours,
        "/api/search/players": handleSearchPlayers,
        "/api/healthz": () => new Response("OK", { status: 200 }),
    },
    async fetch(req: Request) {
        return new Response("Not found", { status: 404 });
    },
});

console.log(`Dashboard server running at http://0.0.0.0:${PORT}`);
