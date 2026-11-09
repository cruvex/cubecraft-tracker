// Calls every route on the Bun API and the Rust API and compares the JSON.
//   bun api/tools/compare.ts http://localhost:4701 http://localhost:4702 [path regex]
const [oldUrl, newUrl, only] = Bun.argv.slice(2);
if (!oldUrl || !newUrl) throw new Error("Usage: compare.ts <old url> <new url> [filter]");

type Got = { status: number; type: string | null; body: unknown };

async function get(base: string, path: string): Promise<Got> {
  const res = await fetch(base + path);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  // A 500's body is the runtime's own error page, so only its status has to match.
  return { status: res.status, type: res.headers.get("content-type")?.split(";")[0] ?? null, body: res.status >= 500 ? null : body };
}

// Windows clamp to NOW(), which each API read a moment apart.
const isCloseTimestamp = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && /^\d{4}-\d\d-\d\dT/.test(a) && Math.abs(Date.parse(a) - Date.parse(b)) < 5000;

function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (a === b || isCloseTimestamp(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const diff = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const diff = firstDiff((a as any)[key], (b as any)[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 70)} vs ${JSON.stringify(b)?.slice(0, 70)}`;
}

const board = (await (await fetch(`${oldUrl}/api/games/1/leaderboard`)).json()) as any;
const top = board.rows[0];
const low = board.rows[Math.min(200, board.rows.length - 1)];
const nameWithUnderscore = board.rows.find((r: any) => r.ign?.includes("_"))?.ign ?? top.ign;
const games = [1, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 999];
const bad = ["abc", "1.5", "-1", "0"];

const paths: string[] = [
  "/api/healthz",
  "/api/nope",
  "/nope",
  "/api/games",
  "/api/server/status",
  `/api/search/players?q=${top.ign.slice(0, 3)}`,
  "/api/search/players?q=a",
  "/api/search/players?q=",
  "/api/search/players",
  "/api/search/players?q=%20xx%20",
  "/api/search/players?q=__",
  "/api/search/players?q=zzzzzzzz",
  `/api/player/${top.ign}`,
  `/api/player/${top.ign.toUpperCase()}`,
  `/api/player/${top.player}`,
  `/api/player/${top.player.replaceAll("-", "")}`,
  `/api/player/${top.player.toUpperCase()}`,
  `/api/player/${nameWithUnderscore}`,
  `/api/player/${nameWithUnderscore.replaceAll("_", "x")}`,
  "/api/player/nobody_at_all",
  "/api/player/11111111-1111-1111-1111-111111111111",
  "/api/player/not-a-uuid-but-very-long-string-of-text",
];

for (const g of games) {
  for (const d of ["", "?days=7", "?days=1", "?days=365", "?days=1.5", "?days=abc", "?days=0", "?days=-5"]) {
    paths.push(`/api/games/${g}/leaderboard${d}`, `/api/games/${g}/top-gainers${d}`, `/api/games/${g}/top-gainers/history${d}`);
  }
  for (const q of ["?month=2026-10", "?month=2026-11", "?year=2026", "?year=2025", "?month=2020-01", "?month=2026-13", "?year=26", "?month=", "?month=2026-10&year=2025"]) {
    paths.push(`/api/games/${g}/top-gainers${q}`, `/api/games/${g}/player/${top.player}${q}`);
  }
  paths.push(`/api/games/${g}/top-gainers/history?limit=3`, `/api/games/${g}/top-gainers/history?limit=0&days=7`, `/api/games/${g}/top-gainers/months`);
  paths.push(`/api/games/${g}/players/history?ids=${top.player},${low.ign},nobody_here`, `/api/games/${g}/players/history?ids=${low.ign}&days=7`, `/api/games/${g}/players/history`, `/api/games/${g}/players/history?ids=,%20,`);
  for (const id of [top.player, top.ign, low.player, "nobody_at_all", "not-a-uuid-but-very-long-string-of-text"]) {
    paths.push(`/api/games/${g}/player/${id}`, `/api/games/${g}/player/${id}?days=7`);
  }
  for (const q of ["", "?hours=1", "?hours=168&bucket=3600", "?hours=0&bucket=1", "?hours=abc", "?bucket=abc", "?hours=99999&bucket=999999", "?hours=2.5&bucket=90.5"]) {
    paths.push(`/api/games/${g}/population${q}`);
  }
}

for (const b of bad) {
  paths.push(
    `/api/games/${b}/top-gainers`,
    `/api/games/${b}/top-gainers/history`,
    `/api/games/${b}/top-gainers/months`,
    `/api/games/${b}/players/history`,
    `/api/games/${b}/player/${top.player}`,
    `/api/games/${b}/population`,
    `/api/games/${b}/leaderboard`,
  );
}

for (const q of ["", "?hours=1", "?hours=168&bucket=3600", "?hours=0&bucket=1", "?hours=abc", "?bucket=abc", "?hours=99999&bucket=999999", "?bucket=300&tz=Europe/Brussels", "?tz=Asia/Kolkata", "?tz=america/new_york", "?tz=Not/AZone", "?tz=UTC", "?tz=", "?bucket=7200", "?bucket=60"]) {
  paths.push(`/api/server/population${q}`);
}
for (const q of ["", "?days=7", "?days=0", "?days=9999", "?days=abc", "?days=2.5", "?tz=Europe/Brussels", "?tz=Asia/Kolkata", "?tz=america/new_york", "?tz=Not/AZone", "?tz="]) {
  paths.push(`/api/server/active-hours${q}`);
}

// A difference kept on purpose: 1.5 is not a game id, where Bun passed it on and answered with nothing.
const knownDifferences = [/^\/api\/games\/1\.5\//];

const selected = paths.filter((p) => !only || new RegExp(only).test(p));
let same = 0;
const failures: string[] = [];

for (let i = 0; i < selected.length; i += 8) {
  await Promise.all(
    selected.slice(i, i + 8).map(async (path) => {
      const [a, b] = await Promise.all([get(oldUrl, path), get(newUrl, path)]);
      const diff = a.status !== b.status ? `status ${a.status} vs ${b.status}` : a.status < 500 && a.type !== b.type ? `content-type ${a.type} vs ${b.type}` : firstDiff(a.body, b.body);
      if (diff && !knownDifferences.some((known) => known.test(path))) failures.push(`${path}\n    ${diff}`);
      else same++;
    }),
  );
}

for (const failure of failures.sort().slice(0, 40)) console.log(failure);
console.log(`\n${same}/${selected.length} identical, ${failures.length} different`);
process.exit(failures.length ? 1 : 0);
