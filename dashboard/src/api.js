// API client: a thin fetch wrapper plus explicit endpoint builders, so no URL substring sniffing.

const API_BASE = "/api";

/** Fetch JSON from an `endpoints.*` path or an absolute URL. Throws on non-2xx. */
export async function apiFetch(path) {
  const url = /^https?:\/\//.test(path) ? path : `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API Error: ${res.status}`);
  return res.json();
}

/** Build a query string from defined, non-empty params. */
function qs(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

export const endpoints = {
  games: () => `/games`,

  /** Sidebar top-gainers list for the last `days`, a `month` ("YYYY-MM") or a `year` ("YYYY"). */
  topGainers: (gameId, { days, month, year }) =>
    `/games/${gameId}/top-gainers${qs({ days, month, year })}`,

  /** Months for the sidebar's period dropdown. */
  topGainerMonths: (gameId) => `/games/${gameId}/top-gainers/months`,

  /** Default seed for the comparison chart: top-N gainers with their histories. */
  topGainersHistory: (gameId, days, limit) =>
    `/games/${gameId}/top-gainers/history${qs({ days, limit })}`,

  /** Comparison chart for an explicit player set (UUIDs or IGNs). */
  playersHistory: (gameId, ids, days) =>
    `/games/${gameId}/players/history${qs({ ids: ids.join(","), days })}`,

  /** One player's history for the last `days`, a `month` ("YYYY-MM") or a `year` ("YYYY"). */
  playerScores: (gameId, idOrIgn, { days, month, year }) =>
    `/games/${gameId}/player/${encodeURIComponent(idOrIgn)}${qs({ days, month, year })}`,

  leaderboard: (gameId, days) => `/games/${gameId}/leaderboard${qs({ days })}`,

  /** Concurrent-player readings for one game; `bucket` is in seconds. */
  gamePopulation: (gameId, hours, bucket) =>
    `/games/${gameId}/population${qs({ hours, bucket })}`,

  /** Total network population; a clocked 1-minute series, unlike the per-game one. */
  serverPopulation: (hours, bucket, tz) => `/server/population${qs({ hours, bucket, tz })}`,

  /** Newest reading + version range; polled for the live status card. */
  serverStatus: () => `/server/status`,

  /** Average players per hour of day; `tz` is an IANA zone name. */
  serverActiveHours: (days, tz) => `/server/active-hours${qs({ days, tz })}`,

  /** Autocomplete search; returns { uuid, ign } pairs. */
  searchPlayers: (q) => `/search/players${qs({ q })}`,
};
