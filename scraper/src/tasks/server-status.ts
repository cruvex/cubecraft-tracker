import { sql } from "../sql";
import { ping, stripFormatting } from "../minecraft";
import type { Task } from "../scheduler";

const host = process.env.CUBECRAFT_HOST || "play.cubecraft.net";
const port = Number(process.env.CUBECRAFT_PORT || 25565);

// Handshaking as a client too old to join swaps the brand name in the status
// response for the supported range: "§f§f§fWe support: 1.20-1.21". The player
// counts come back either way.
const unsupportedProtocol = -1;

const rangePattern = /(\d+(?:\.\d+)+)\s*-\s*(\d+(?:\.\d+)+)/;

let rangeUnreadable = false;

export const serverStatus: Task = {
  name: "server-status",
  schedule: process.env.SERVER_STATUS_CRON || "*/1 * * * *",
  timeoutMs: 30_000,

  async run({ firedAt, signal }) {
    const { players, version } = await ping(host, port, signal, unsupportedProtocol);

    await sql`
      INSERT INTO server_player_counts (timestamp, online, max)
      VALUES (${truncateToSecond(firedAt)}, ${players.online}, ${players.max})
      ON CONFLICT (timestamp) DO NOTHING
    `;

    console.log(`${players.online}/${players.max} players online`);

    await recordVersionRange(firedAt, version.name);
  },
};

// The range is parsed out of display copy the server can reword at will, so a
// miss is logged rather than thrown: it must not cost the player count that came
// back in the same response.
async function recordVersionRange(firedAt: Date, name: string): Promise<void> {
  const raw = stripFormatting(name);
  const match = rangePattern.exec(raw);

  if (!match) {
    // Once per outage, not once per poll.
    if (!rangeUnreadable) console.warn(`No version range in "${raw}"`);
    rangeUnreadable = true;
    return;
  }

  rangeUnreadable = false;
  const [, minimum, maximum] = match;

  // Only transitions earn a row; the range changes a few times a year.
  const inserted = await sql`
    INSERT INTO server_versions (observed_at, minimum, maximum, raw)
    SELECT ${firedAt}, ${minimum}, ${maximum}, ${raw}
    WHERE NOT EXISTS (
      SELECT 1 FROM (
        SELECT minimum, maximum FROM server_versions
        ORDER BY observed_at DESC LIMIT 1
      ) latest
      WHERE latest.minimum = ${minimum} AND latest.maximum = ${maximum}
    )
    RETURNING observed_at
  `;

  if (inserted.length > 0) {
    console.log(`Supported versions now ${minimum}-${maximum}`);
  }
}

function truncateToSecond(date: Date): Date {
  const second = new Date(date);
  second.setMilliseconds(0);
  return second;
}
