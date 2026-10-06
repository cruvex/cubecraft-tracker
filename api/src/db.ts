function iso(value: unknown) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// How far before a month's start a reading still counts as the month's starting score; month coverage uses the same tolerance.
const CARRY_WINDOW = "3 days";

// CTE `bounds`: the last `days` days; only readings inside them count.
function lastDays(days: number) {
  return Bun.sql`
    bounds AS (
      SELECT start, start AS carry_start, CAST('infinity' AS timestamptz) AS stop
      FROM (SELECT NOW() - CAST(${days + " days"} AS INTERVAL) AS start) s
    )
  `;
}

// CTE `bounds`: a month ("YYYY-MM") or year ("YYYY") in UTC, starting from the last reading within CARRY_WINDOW before it.
function periodBounds(period: string) {
  const isYear = period.length === 4;
  const start = isYear ? `${period}-01-01` : `${period}-01`;
  const length = isYear ? "1 year" : "1 month";
  return Bun.sql`
    bounds AS (
      SELECT
        start_utc AT TIME ZONE 'UTC'                                       AS start,
        (start_utc - CAST(${CARRY_WINDOW} AS INTERVAL)) AT TIME ZONE 'UTC' AS carry_start,
        (start_utc + CAST(${length} AS INTERVAL)) AT TIME ZONE 'UTC'       AS stop
      FROM (SELECT CAST(${start} AS timestamp) AS start_utc) s
    )
  `;
}

// CTE `gains` (after `bounds`): each player's last score minus their last score from before the start, or else their first after it.
function gainsCte(gameId: number) {
  return Bun.sql`
    gains AS (
      SELECT
        p.player,
        (array_agg(p.score ORDER BY p.first_seen DESC))[1]
          - COALESCE(
              (array_agg(p.score ORDER BY p.first_seen DESC) FILTER (WHERE p.first_seen <= b.start))[1],
              (array_agg(p.score ORDER BY p.first_seen))[1]
            ) AS score_gain
      FROM player_scores p
      CROSS JOIN bounds b
      WHERE p.game_id = ${gameId}
        AND p.last_seen >= b.carry_start
        AND p.first_seen < b.stop
      GROUP BY p.player
    )
  `;
}

type Period = { first_seen: Date; last_seen: Date; score: number; position: number };

// Each period's first and last reading, so a chart shows how long a score held.
function readings(periods: Period[]) {
  return periods.flatMap((p) => {
    const first = { timestamp: iso(p.first_seen), score: Number(p.score), position: Number(p.position) };
    if (p.first_seen.getTime() === p.last_seen.getTime()) return [first];
    return [first, { ...first, timestamp: iso(p.last_seen) }];
  });
}

export function getTopGainers(days = 30, gameId: number) {
  return topGainers(lastDays(days), gameId);
}

/** Gainers over a month ("YYYY-MM") or year ("YYYY"), measured from each player's score at its start. */
export function getTopGainersForPeriod(period: string, gameId: number) {
  return topGainers(periodBounds(period), gameId);
}

async function topGainers(bounds: ReturnType<typeof lastDays>, gameId: number) {
  const res = await Bun.sql`
    WITH ${bounds}, ${gainsCte(gameId)},
    player_igns AS (
        SELECT DISTINCT ON (player_uuid)
            player_uuid,
            player_ign
        FROM ign_history
        ORDER BY player_uuid, id DESC
    )
    SELECT
        g.player AS uuid,
        pi.player_ign AS ign,
        g.score_gain
    FROM gains g
    LEFT JOIN player_igns pi ON g.player = pi.player_uuid
    WHERE g.score_gain > 0
    ORDER BY g.score_gain DESC
  `;

  return (res || []).map((r: any) => ({
    player: r.uuid,
    ign: r.ign || "Unknown",
    score_gain: Number(r.score_gain),
  }));
}

/** Score series for an explicit player set, in `uuids` order; players with no data are omitted. */
export async function getPlayersHistory(uuids: string[], days = 30, gameId: number) {
  if (!uuids.length) return [];

  const res = await Bun.sql`
    WITH ${lastDays(days)},
    player_igns AS (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM ign_history
      ORDER BY player_uuid, id DESC
    )
    SELECT
      p.player                        AS uuid,
      pi.player_ign                   AS ign,
      GREATEST(p.first_seen, b.start) AS first_seen,
      p.last_seen,
      p.score,
      p.position
    FROM player_scores p
    CROSS JOIN bounds b
    LEFT JOIN player_igns pi ON pi.player_uuid = p.player
    WHERE p.player IN ${Bun.sql(uuids)}
      AND p.game_id = ${gameId}
      AND p.last_seen >= b.start
    ORDER BY p.first_seen
  `;

  const periodsByUuid = new Map<string, Period[]>();
  const ignByUuid = new Map<string, string>();
  for (const r of (res || []) as any[]) {
    let periods = periodsByUuid.get(r.uuid);
    if (!periods) {
      periods = [];
      periodsByUuid.set(r.uuid, periods);
    }
    periods.push(r);
    if (r.ign) ignByUuid.set(r.uuid, r.ign);
  }

  // Preserve the requested order so the chart's colour/legend assignment is stable.
  return uuids
    .filter((uuid) => periodsByUuid.has(uuid))
    .map((uuid) => ({
      player: uuid,
      ign: ignByUuid.get(uuid) || "Unknown",
      rows: readings(periodsByUuid.get(uuid)!),
    }));
}

/** Default seed for the comparison chart: top-N gainers, then their histories via getPlayersHistory. */
export async function getTopGainersHistory(days = 30, gameId: number, limit = 10) {
  const gainers = await Bun.sql`
    WITH ${lastDays(days)}, ${gainsCte(gameId)}
    SELECT player AS uuid
    FROM gains
    WHERE score_gain > 0
    ORDER BY score_gain DESC
    LIMIT ${limit}
  `;

  const uuids = (gainers || []).map((r: any) => r.uuid);
  return getPlayersHistory(uuids, days, gameId);
}

/** Every month from the game's first read to now, newest first, with how much of each month was tracked. */
export async function getTopGainerMonths(gameId: number) {
  const res = await Bun.sql`
    WITH reads AS (
      SELECT first_seen AT TIME ZONE 'UTC' AS timestamp FROM player_scores WHERE game_id = ${gameId}
      UNION
      SELECT last_seen AT TIME ZONE 'UTC' FROM player_scores WHERE game_id = ${gameId}
    ),
    snaps AS (
      SELECT
        timestamp,
        date_trunc('month', timestamp)            AS month,
        LAG(timestamp) OVER (ORDER BY timestamp) AS prev_ts
      FROM reads
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

/** Latest read time per game; games without reads are absent. */
// Cubepanion's games, as the scraper's games task last synced them. Ordered by name, as Cubepanion lists them.
export async function getGames() {
  const rows = await Bun.sql`
    SELECT id, name, display_name, aliases, active, score_type, should_track, has_pre_lobby
    FROM games
    ORDER BY name
  `;

  return rows.map((r: any) => ({
    id: r.id as number,
    name: r.name as string,
    displayName: r.display_name as string,
    aliases: r.aliases as string[],
    active: r.active as boolean,
    scoreType: r.score_type as string,
    shouldTrack: r.should_track as boolean,
    hasPreLobby: r.has_pre_lobby as boolean,
  }));
}

export async function getLastSnapshotTimes(gameIds: number[]): Promise<Map<number, string | null>> {
  // One lookup per game: each is an index probe, where a GROUP BY would scan the whole table.
  const times = await Promise.all(
    gameIds.map(async (gameId) => {
      const [row] = await Bun.sql`SELECT MAX(last_seen) AS at FROM player_scores WHERE game_id = ${gameId}`;
      return [gameId, iso(row?.at)] as const;
    }),
  );
  return new Map(times.filter(([, at]) => at != null));
}

export async function getLeaderboard(gameId: string, compareDays: number = 30) {
  // The comparison board is the latest one at least `compareDays` old: the board only changes when a period starts.
  const [times] = await Bun.sql`
    WITH latest AS (
      SELECT MAX(last_seen) AS at FROM player_scores WHERE game_id = ${gameId}
    )
    SELECT
      latest.at AS latest_at,
      (
        SELECT MAX(first_seen) FROM player_scores
        WHERE game_id = ${gameId}
          AND first_seen <= latest.at - CAST(${compareDays + " days"} AS INTERVAL)
      ) AS past_at
    FROM latest
  `;

  if (!times?.latest_at) return { rows: [], departed: [], timestamp: null, compareTimestamp: null };

  // Current + past boards and IGN in one shot; departed players sort last via NULLS LAST on cur.position.
  const allRows = await Bun.sql`
    WITH cur AS (
      SELECT player, score, position
      FROM player_scores
      WHERE game_id = ${gameId} AND last_seen = ${times.latest_at}
    ),
    past AS (
      SELECT player, score, position
      FROM player_scores
      WHERE game_id = ${gameId} AND first_seen <= ${times.past_at} AND last_seen >= ${times.past_at}
    )
    SELECT
      COALESCE(cur.player, past.player) AS player,
      cur.score                         AS current_score,
      cur.position                      AS current_position,
      past.score                        AS past_score,
      past.position                     AS past_position,
      ih.player_ign                     AS ign
    FROM cur
    FULL OUTER JOIN past ON cur.player = past.player
    LEFT JOIN (
      SELECT DISTINCT ON (player_uuid) player_uuid, player_ign
      FROM ign_history
      ORDER BY player_uuid, id DESC
    ) ih ON ih.player_uuid = COALESCE(cur.player, past.player)
    ORDER BY cur.position NULLS LAST, past.position
  `;

  const currentRows = (allRows as any[]).filter(r => r.current_score != null);
  const departedRows = (allRows as any[]).filter(r => r.current_score == null);

  const rows = currentRows.map((r) => {
    const currentRank = Number(r.current_position);
    const pastRank: number | null = r.past_position ? Number(r.past_position) : null;
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
    score: Number(r.past_score),
    rank: Number(r.past_position),
  }));

  return {
    rows,
    departed,
    timestamp: iso(times.latest_at),
    compareTimestamp: iso(times.past_at),
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

/** A player's readings over the last `days` days, plus their latest reading; null for a player never on this board. */
export async function getPlayerScores(uuid: string, days = 30, gameId: number) {
  const result = await playerScores(uuid, lastDays(days), gameId);
  return result?.current ? result : null;
}

/** A player's readings in a month ("YYYY-MM") or year ("YYYY"), starting with their last reading from before it, plus their latest reading. */
export async function getPlayerPeriodScores(uuid: string, period: string, gameId: number) {
  const result = await playerScores(uuid, periodBounds(period), gameId);
  return result ? { ...result, period } : null;
}

async function playerScores(uuid: string, bounds: ReturnType<typeof lastDays>, gameId: number) {
  const ign = await getIgnByUuid(uuid);
  if (!ign) return null;

  // The periods in the bounds plus the one the start carries from, clamped so a score held into the bounds reads from the start.
  const periods = await Bun.sql`
    WITH ${bounds}
    SELECT
      GREATEST(p.first_seen, LEAST(p.last_seen, b.start)) AS first_seen,
      LEAST(p.last_seen, b.stop)                          AS last_seen,
      p.score,
      p.position
    FROM player_scores p
    CROSS JOIN bounds b
    WHERE p.game_id = ${gameId}
      AND p.player = ${uuid}
      AND p.first_seen < b.stop
      AND (
        p.last_seen >= b.start
        OR p.first_seen = (
          SELECT MAX(q.first_seen) FROM player_scores q
          WHERE q.game_id = p.game_id
            AND q.player = p.player
            AND q.first_seen <= b.start
            AND q.last_seen >= b.carry_start
        )
      )
    ORDER BY p.first_seen
  `;

  const [latest] = await Bun.sql`
    SELECT score, position
    FROM player_scores
    WHERE game_id = ${gameId} AND player = ${uuid}
    ORDER BY first_seen DESC
    LIMIT 1
  `;

  const rows = readings(periods as Period[]);
  const gain = rows.length > 1 ? rows[rows.length - 1]!.score - rows[0]!.score : 0;

  return {
    player: uuid,
    ign,
    rows,
    gain,
    current: latest ? { score: Number(latest.score), position: Number(latest.position) } : null,
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
