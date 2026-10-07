function iso(value: unknown) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function getTopGainers(days = 30, gameId: number) {
  const res = await Bun.sql`
    WITH scores AS (
      SELECT
        lr.player,
        MAX(lr.score) - MIN(lr.score) AS score_gain
      FROM leaderboard_rows lr
      JOIN leaderboard_snapshots ls ON lr.snapshot_id = ls.id
      WHERE ls.timestamp >= NOW() - CAST(${days + " days"} AS INTERVAL)
        AND ls.game_id = ${gameId}
      GROUP BY lr.player
    ),
    player_igns AS (
        SELECT DISTINCT ON (player_uuid)
            player_uuid,
            player_ign
        FROM ign_history
        ORDER BY player_uuid, id DESC
    )
    SELECT
        s.player AS uuid,
        pi.player_ign AS ign,
        s.score_gain
    FROM scores s
    LEFT JOIN player_igns pi ON s.player = pi.player_uuid
    WHERE s.score_gain > 0
    ORDER BY s.score_gain DESC
  `;

  return (res || []).map((r: any) => ({
    player: r.uuid,
    ign: r.ign || "Unknown",
    score_gain: r.score_gain == null ? 0 : Number(r.score_gain),
  }));
}

/** Score series for an explicit player set, in `uuids` order; players with no data are omitted. */
export async function getPlayersHistory(uuids: string[], days = 30, gameId: number) {
  if (!uuids.length) return [];

  const res = await Bun.sql`
    WITH player_igns AS (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM ign_history
      ORDER BY player_uuid, id DESC
    )
    SELECT
      lr.player      AS uuid,
      pi.player_ign  AS ign,
      ls.timestamp,
      lr.score
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON lr.snapshot_id = ls.id
    LEFT JOIN player_igns pi ON pi.player_uuid = lr.player
    WHERE lr.player IN ${Bun.sql(uuids)}
      AND ls.game_id = ${gameId}
      AND ls.timestamp >= NOW() - CAST(${days + " days"} AS INTERVAL)
    ORDER BY ls.timestamp
  `;

  const seriesByUuid = new Map<string, { timestamp: string; score: number }[]>();
  const ignByUuid = new Map<string, string>();
  for (const r of (res || []) as any[]) {
    let series = seriesByUuid.get(r.uuid);
    if (!series) {
      series = [];
      seriesByUuid.set(r.uuid, series);
    }
    series.push({
      timestamp: iso(r.timestamp),
      score: r.score == null ? 0 : Number(r.score),
    });
    if (r.ign) ignByUuid.set(r.uuid, r.ign);
  }

  // Preserve the requested order so the chart's colour/legend assignment is stable.
  return uuids
    .filter((uuid) => seriesByUuid.has(uuid))
    .map((uuid) => ({
      player: uuid,
      ign: ignByUuid.get(uuid) || "Unknown",
      rows: seriesByUuid.get(uuid)!,
    }));
}

/** Default seed for the comparison chart: top-N gainers, then their histories via getPlayersHistory. */
export async function getTopGainersHistory(days = 30, gameId: number, limit = 10) {
  const gainers = await Bun.sql`
    SELECT lr.player AS uuid
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON lr.snapshot_id = ls.id
    WHERE ls.timestamp >= NOW() - CAST(${days + " days"} AS INTERVAL)
      AND ls.game_id = ${gameId}
    GROUP BY lr.player
    HAVING MAX(lr.score) - MIN(lr.score) > 0
    ORDER BY MAX(lr.score) - MIN(lr.score) DESC
    LIMIT ${limit}
  `;

  const uuids = (gainers || []).map((r: any) => r.uuid);
  return getPlayersHistory(uuids, days, gameId);
}

// How far before a month's start the carry snapshot may be; month coverage uses the same tolerance.
const CARRY_WINDOW = "3 days";

// CTEs `bounds` (the period's start and stop) and `carry` (the game's last snapshot within CARRY_WINDOW before the start).
// `period` is a month ("YYYY-MM") or a year ("YYYY").
function periodCtes(period: string, gameId: number) {
  const isYear = period.length === 4;
  const start = isYear ? `${period}-01-01` : `${period}-01`;
  const length = isYear ? "1 year" : "1 month";
  return Bun.sql`
    bounds AS (
      SELECT
        CAST(${start} AS timestamp)                                   AS start,
        CAST(${start} AS timestamp) + CAST(${length} AS INTERVAL)     AS stop
    ),
    carry AS (
      SELECT ls.id
      FROM leaderboard_snapshots ls
      CROSS JOIN bounds b
      WHERE ls.game_id = ${gameId}
        AND ls.timestamp < b.start
        AND ls.timestamp >= b.start - CAST(${CARRY_WINDOW} AS INTERVAL)
      ORDER BY ls.timestamp DESC
      LIMIT 1
    )
  `;
}

/** A player's readings in a month ("YYYY-MM") or year ("YYYY"), starting with their reading in the carry snapshot, plus their latest reading. */
export async function getPlayerPeriodScores(uuid: string, period: string, gameId: number) {
  const ign = await getIgnByUuid(uuid);
  if (!ign) return null;

  const scores = await Bun.sql`
    WITH ${periodCtes(period, gameId)}
    SELECT ls.timestamp, lr.score, lr.position, ls.id = (SELECT id FROM carry) AS is_carry
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON ls.id = lr.snapshot_id
    CROSS JOIN bounds b
    WHERE lr.player = ${uuid}
      AND ls.game_id = ${gameId}
      AND (
        (ls.timestamp >= b.start AND ls.timestamp < b.stop)
        OR ls.id = (SELECT id FROM carry)
      )
    ORDER BY ls.timestamp
  `;

  const [latest] = await Bun.sql`
    SELECT lr.score, lr.position
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON ls.id = lr.snapshot_id
    WHERE lr.player = ${uuid}
      AND ls.game_id = ${gameId}
    ORDER BY ls.timestamp DESC
    LIMIT 1
  `;

  // A carry reading without any readings in the month counts as no data.
  const hasMonthReadings = (scores as any[]).some((r) => !r.is_carry);

  const rows = hasMonthReadings
    ? (scores as any[]).map((r) => ({
        timestamp: iso(r.timestamp),
        score: Number(r.score),
        position: Number(r.position),
      }))
    : [];

  const gain = rows.length > 1 ? rows[rows.length - 1].score - rows[0].score : 0;

  return {
    player: uuid,
    ign,
    period,
    rows,
    gain,
    current: latest ? { score: Number(latest.score), position: Number(latest.position) } : null,
  };
}

/** Gainers over a month ("YYYY-MM") or year ("YYYY"), measured from the carry snapshot for players who are in it. */
export async function getTopGainersForPeriod(period: string, gameId: number) {
  const res = await Bun.sql`
    WITH ${periodCtes(period, gameId)},
    readings AS (
      SELECT
        lr.player,
        (array_agg(lr.score ORDER BY ls.timestamp))[1]      AS first_score,
        (array_agg(lr.score ORDER BY ls.timestamp DESC))[1] AS last_score
      FROM leaderboard_rows lr
      JOIN leaderboard_snapshots ls ON ls.id = lr.snapshot_id
      CROSS JOIN bounds b
      WHERE ls.game_id = ${gameId}
        AND ls.timestamp >= b.start
        AND ls.timestamp < b.stop
      GROUP BY lr.player
    ),
    -- Players missing from the carry snapshot count from their first reading in the period.
    gains AS (
      SELECT r.player, r.last_score - COALESCE(c.score, r.first_score) AS score_gain
      FROM readings r
      LEFT JOIN leaderboard_rows c ON c.snapshot_id = (SELECT id FROM carry) AND c.player = r.player
    ),
    player_igns AS (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM ign_history
      ORDER BY player_uuid, id DESC
    )
    SELECT g.player AS uuid, pi.player_ign AS ign, g.score_gain
    FROM gains g
    LEFT JOIN player_igns pi ON pi.player_uuid = g.player
    WHERE g.score_gain > 0
    ORDER BY g.score_gain DESC
  `;

  return (res || []).map((r: any) => ({
    player: r.uuid,
    ign: r.ign || "Unknown",
    score_gain: Number(r.score_gain),
  }));
}

/** Every month from the game's first snapshot to now, newest first, with how much of each month was tracked. */
export async function getTopGainerMonths(gameId: number) {
  const res = await Bun.sql`
    WITH snaps AS (
      SELECT
        timestamp,
        date_trunc('month', timestamp)            AS month,
        LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
      FROM leaderboard_snapshots
      WHERE game_id = ${gameId}
    ),
    tracked AS (
      SELECT DISTINCT ON (month)
        month,
        timestamp AS first_ts,
        MAX(timestamp) OVER (PARTITION BY month) AS last_ts,
        COALESCE(prev_ts >= month - CAST(${CARRY_WINDOW} AS INTERVAL), false) AS has_carry
      FROM snaps
      ORDER BY month, timestamp
    ),
    calendar AS (
      SELECT generate_series(
        (SELECT MIN(month) FROM tracked),
        date_trunc('month', NOW() AT TIME ZONE 'UTC'),
        INTERVAL '1 month'
      ) AS month
    )
    SELECT
      to_char(c.month, 'YYYY-MM') AS month,
      c.month = date_trunc('month', NOW() AT TIME ZONE 'UTC') AS in_progress,
      t.month IS NOT NULL AS tracked,
      (t.has_carry OR t.first_ts < c.month + CAST(${CARRY_WINDOW} AS INTERVAL)) AS covers_start,
      t.last_ts >= c.month + INTERVAL '1 month' - CAST(${CARRY_WINDOW} AS INTERVAL) AS covers_end,
      CASE WHEN t.has_carry THEN 1 ELSE EXTRACT(day FROM t.first_ts) END::int AS first_day,
      EXTRACT(day FROM t.last_ts)::int AS last_day
    FROM calendar c
    LEFT JOIN tracked t ON t.month = c.month
    ORDER BY c.month DESC
  `;

  return (res || []).map((r: any) => {
    const coversMonth = r.covers_start && (r.in_progress || r.covers_end);

    return {
      month: r.month,
      inProgress: r.in_progress,
      partial: r.tracked && !coversMonth,
      firstDay: r.first_day,
      lastDay: r.last_day,
    };
  });
}

/** Latest snapshot time per game; games without snapshots are absent. */
export async function getLastSnapshotTimes(): Promise<Map<number, string | null>> {
  const res = await Bun.sql`
    SELECT game_id, MAX(timestamp) AS last_snapshot
    FROM leaderboard_snapshots
    GROUP BY game_id
  `;
  return new Map((res || []).map((r: any) => [r.game_id, iso(r.last_snapshot)]));
}

export async function getLeaderboard(gameId: string, compareDays: number = 30) {
  const [latestSnapshot] = await Bun.sql`
    SELECT id, timestamp FROM leaderboard_snapshots
    WHERE game_id = ${gameId}
    ORDER BY timestamp DESC
    LIMIT 1
  `;

  if (!latestSnapshot) return { rows: [], departed: [], timestamp: null, compareTimestamp: null };

  const [pastSnapshot] = await Bun.sql`
    SELECT id, timestamp FROM leaderboard_snapshots
    WHERE game_id = ${gameId}
      AND timestamp <= ${latestSnapshot.timestamp}::timestamp - (${compareDays + " days"})::interval
    ORDER BY timestamp DESC
    LIMIT 1
  `;

  // Current + past scores and IGN in one shot; departed players sort last via NULLS LAST on cur.score.
  const allRows = await Bun.sql`
    SELECT
      COALESCE(cur.player, past.player) AS player,
      cur.score                         AS current_score,
      past.score                        AS past_score,
      past.rk                           AS past_rank,
      ih.player_ign                     AS ign
    FROM (
      SELECT player, score
      FROM leaderboard_rows
      WHERE snapshot_id = ${latestSnapshot.id}
    ) cur
    FULL OUTER JOIN (
      SELECT player, score,
             ROW_NUMBER() OVER (ORDER BY score DESC NULLS LAST) AS rk
      FROM leaderboard_rows
      WHERE snapshot_id = ${pastSnapshot?.id ?? null}
    ) past ON cur.player = past.player
           LEFT JOIN (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM ign_history
      ORDER BY player_uuid, id DESC
    ) ih ON ih.player_uuid = COALESCE(cur.player, past.player)
    ORDER BY cur.score DESC NULLS LAST
  `;

  const currentRows = (allRows as any[]).filter(r => r.current_score != null);
  const departedRows = (allRows as any[]).filter(r => r.current_score == null);

  const rows = currentRows.map((r, i) => {
    const currentRank = i + 1;
    const pastRank: number | null = r.past_rank ? Number(r.past_rank) : null;
    return {
      player: r.player,
      ign: r.ign,
      score: Number(r.current_score),
      rank: currentRank,
      prevRank: pastRank,
      rankChange: pastRank != null ? pastRank - currentRank : null,
      isNew: pastRank == null,
    };
  });

  const departed = departedRows.map(r => ({
    player: r.player,
    ign: r.ign,
    score: Number(r.past_score ?? 0),
    rank: Number(r.past_rank),
  }));

  return {
    rows,
    departed,
    timestamp: iso(latestSnapshot.timestamp),
    compareTimestamp: iso(pastSnapshot?.timestamp),
  };
}


async function getIgnByUuid(uuid: string): Promise<string | null> {
  const [row] = await Bun.sql`
    SELECT player_ign
    FROM ign_history
    WHERE player_uuid = ${uuid}
    ORDER BY id DESC
    LIMIT 1
  `;
  return row ? row.player_ign : null;
}

export async function getPlayerScores(uuid: string, days = 30, gameId: number) {
  const ign = await getIgnByUuid(uuid);
  if (!ign) return null;

  const scores = await Bun.sql`
    SELECT ls.timestamp, lr.score, lr.position
    FROM leaderboard_rows lr
    JOIN leaderboard_snapshots ls ON lr.snapshot_id = ls.id
    WHERE lr.player = ${uuid}
      AND ls.timestamp >= NOW() - CAST(${Math.max(days, 30) + " days"} AS INTERVAL)
      AND ls.game_id = ${gameId}
    ORDER BY ls.timestamp;
  `;

  if (!scores || scores.length === 0) return null;

  const rows = scores.map((r: any) => ({
    timestamp: iso(r.timestamp),
    score: r.score == null ? 0 : Number(r.score),
    position: r.position == null ? 0 : Number(r.position),
  }));

  // Rows within the requested days, used for the chart and the gain
  const now = Date.now();
  const filteredRows = days === 0 ? rows : rows.filter(r => (now - new Date(r.timestamp).getTime()) <= (days * 24 * 60 * 60 * 1000));

  const scoresInRange = filteredRows.map(r => r.score);
  const gain = scoresInRange.length > 1 ? Math.max(...scoresInRange) - Math.min(...scoresInRange) : 0;
  const latest = rows[rows.length - 1];

  return {
    player: uuid,
    ign,
    rows: filteredRows,
    gain,
    current: { score: latest.score, position: latest.position },
  };
}

/** Per-game readings bucketed to their LAST value — an average would invent counts never observed. */
export async function getGamePopulation(gameId: number, hours = 24, bucketSeconds = 300) {
  const buckets = await Bun.sql`
    WITH readings AS (
      SELECT
        to_timestamp(
          floor(extract(epoch FROM timestamp) / ${bucketSeconds}) * ${bucketSeconds}
        ) AS bucket,
        timestamp,
        players
      FROM game_player_counts
      WHERE game_id = ${gameId}
        AND timestamp >= NOW() - CAST(${hours + " hours"} AS INTERVAL)
    )
    SELECT DISTINCT ON (bucket)
      bucket,
      players,
      MAX(players) OVER ()           AS window_peak,
      (AVG(players) OVER ())::float8 AS window_average
    FROM readings
    ORDER BY bucket, timestamp DESC
  `;

  const [latest] = await Bun.sql`
    SELECT timestamp, players
    FROM game_player_counts
    WHERE game_id = ${gameId}
    ORDER BY timestamp DESC
    LIMIT 1
  `;

  const rows = (buckets || []).map((r: any) => ({
    timestamp: iso(r.bucket),
    players: Number(r.players),
  }));

  // Both window functions repeat the same value on every row.
  const [aggregate] = (buckets || []) as any[];

  return {
    gameId,
    bucketSeconds,
    rows,
    peak: aggregate ? Number(aggregate.window_peak) : null,
    average: aggregate ? Number(aggregate.window_average) : null,
    latest: latest
      ? {
          timestamp: iso(latest.timestamp),
          players: Number(latest.players),
        }
      : null,
  };
}

/** Bucket-averaged: a clocked one-ping-a-minute series, so an empty bucket is a failed poll, not a hold. */
export async function getServerPopulation(hours = 24, bucketSeconds = 300, timeZone = "UTC") {
  const window = Bun.sql`NOW() - CAST(${hours + " hours"} AS INTERVAL)`;

  const buckets = await Bun.sql`
    SELECT
      to_timestamp(
        floor(extract(epoch FROM timestamp) / ${bucketSeconds}) * ${bucketSeconds}
      ) AS bucket,
      ROUND(AVG(online))::int AS online
    FROM server_player_counts
    WHERE timestamp >= ${window}
    GROUP BY bucket
    ORDER BY bucket
  `;

  // Read off the raw rows, so the chosen bucket width never moves them.
  const [aggregate] = await Bun.sql`
    SELECT MAX(online)::int AS peak, ROUND(AVG(online))::int AS average
    FROM server_player_counts
    WHERE timestamp >= ${window}
  `;

  // Same bucket width, but keyed on local time of day across 30 days, so the chart can
  // draw what a given clock time usually looks like beside what it did this time.
  const typicalRows = await Bun.sql`
    SELECT
      FLOOR(
        EXTRACT(epoch FROM (timestamp AT TIME ZONE ${timeZone})::time) / ${bucketSeconds}
      )::int AS slot,
      AVG(online)::float8 AS average
    FROM server_player_counts
    WHERE timestamp >= NOW() - CAST('30 days' AS INTERVAL)
    GROUP BY slot
  `;

  const slots = Math.ceil(86400 / bucketSeconds);
  const bySlot = new Map((typicalRows || []).map((r: any) => [Number(r.slot), Number(r.average)]));

  // Roughly a quarter hour either side: enough to settle the 5-minute profile, a no-op hourly.
  const typical = smoothProfile(
    Array.from({ length: slots }, (_, i) => bySlot.get(i) ?? null),
    Math.round(900 / bucketSeconds)
  );

  return {
    bucketSeconds,
    typicalDays: 30,
    typical,
    rows: (buckets || []).map((r: any) => ({
      timestamp: iso(r.bucket),
      online: Number(r.online),
    })),
    peak: aggregate?.peak == null ? null : Number(aggregate.peak),
    average: aggregate?.average == null ? null : Number(aggregate.average),
  };
}

// A day of slots is a loop, so the window wraps midnight instead of tapering at both ends.
function smoothProfile(values: (number | null)[], radius: number) {
  if (radius < 1) return values.map((v) => (v == null ? null : Math.round(v)));

  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let d = -radius; d <= radius; d++) {
      const v = values[(i + d + values.length) % values.length];
      if (v != null) {
        sum += v;
        count++;
      }
    }
    return count ? Math.round(sum / count) : null;
  });
}

/** Newest reading plus the version range in force, for the live status card. */
export async function getServerStatus() {
  const [latest] = await Bun.sql`
    SELECT timestamp, online, max
    FROM server_player_counts
    ORDER BY timestamp DESC
    LIMIT 1
  `;

  const [version] = await Bun.sql`
    SELECT observed_at, minimum, maximum, raw
    FROM server_versions
    ORDER BY observed_at DESC
    LIMIT 1
  `;

  return {
    latest: latest
      ? {
          timestamp: iso(latest.timestamp),
          online: Number(latest.online),
          capacity: Number(latest.max),
        }
      : null,
    version: version
      ? {
          minimum: String(version.minimum),
          maximum: String(version.maximum),
          raw: String(version.raw),
          since: iso(version.observed_at),
        }
      : null,
  };
}

/** Average online per hour of day, bucketed in `timeZone` so DST and half-hour offsets hold. */
export async function getActiveHours(days = 30, timeZone = "UTC") {
  const rows = await Bun.sql`
    SELECT
      EXTRACT(hour FROM timestamp AT TIME ZONE ${timeZone})::int AS hour,
      ROUND(AVG(online))::int AS average,
      MAX(online)::int        AS peak,
      COUNT(*)::int           AS samples
    FROM server_player_counts
    WHERE timestamp >= NOW() - CAST(${days + " days"} AS INTERVAL)
    GROUP BY hour
    ORDER BY hour
  `;

  const byHour = new Map((rows || []).map((r: any) => [Number(r.hour), r]));

  // All 24 are emitted so a thin hour reads as a gap rather than shifting its neighbours along.
  return {
    days,
    timeZone,
    hours: Array.from({ length: 24 }, (_, hour) => {
      const r = byHour.get(hour);
      return {
        hour,
        average: r ? Number(r.average) : null,
        peak: r ? Number(r.peak) : null,
        samples: r ? Number(r.samples) : 0,
      };
    }),
  };
}

/** Batch IGN->UUID (case-insensitive, latest wins); map keyed by lowercased IGN, misses absent. */
export async function getUuidsByIgns(igns: string[]): Promise<Map<string, string>> {
  if (!igns.length) return new Map();
  const res = await Bun.sql`
    SELECT DISTINCT ON (LOWER(player_ign))
      LOWER(player_ign) AS ign,
      player_uuid
    FROM ign_history
    WHERE LOWER(player_ign) IN ${Bun.sql(igns.map((i) => i.toLowerCase()))}
    ORDER BY LOWER(player_ign), id DESC
  `;
  return new Map((res || []).map((r: any) => [r.ign, r.player_uuid]));
}

export async function getUuidByIgn(ign: string): Promise<string | null> {
  const res = await Bun.sql`
    SELECT player_uuid
    FROM ign_history
    WHERE player_ign ILIKE ${ign}
    ORDER BY id DESC
    LIMIT 1
  `;
  if (!res || res.length === 0) return null;
  return res[0].player_uuid;
}

export async function searchPlayers(query: string): Promise<{ uuid: string; ign: string }[]> {
  const contains = `%${query}%`;
  const starts = `${query}%`;
  const res = await Bun.sql`
    SELECT player_uuid, player_ign FROM (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM public.ign_history
      WHERE player_ign ILIKE ${contains}
      ORDER BY player_uuid, id DESC
    ) sub
    ORDER BY
      CASE WHEN player_ign ILIKE ${starts} THEN 0 ELSE 1 END,
      player_ign
    LIMIT 10
  `;
  return (res || []).map((r: any) => ({ uuid: r.player_uuid, ign: r.player_ign }));
}
