/**
 * Posts to a Discord webhook when the set of problems changes: when something
 * starts failing, when what is failing changes, and once when everything is
 * back to normal. Runs every 5 minutes save boards almost every time, so a
 * post per saved board would be noise. Sends nothing when DISCORD_WEBHOOK_URL
 * is unset.
 */
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

/** Pinged whenever there is a new problem. */
const ownerId = "255361968037167105";

const green = 0x57f287;
const yellow = 0xfee75c;
const red = 0xed4245;

export type BoardReport = { game: string } & (
  | { status: "saved" }
  | { status: "unchanged" }
  | { status: "partial"; rows: number }
  | { status: "unresolved"; resolved: number; total: number }
  | { status: "failed"; error: string }
);

type Problem = Exclude<BoardReport, { status: "saved" | "unchanged" }>;

export type RunReport =
  | { kind: "run"; boards: BoardReport[]; unmappedGames: string[] }
  | { kind: "failed"; error: unknown };

// What the last post said was wrong; empty while everything is fine. Kept in
// memory, so a restart with a problem still ongoing posts it once more.
let lastProblems = "";

export async function sendReport(report: RunReport) {
  const problems = problemKey(report);
  if (problems === lastProblems) return;

  const recovered = problems === "";
  lastProblems = problems;

  if (!webhookUrl) return;

  const embed = recovered ? recoveredEmbed() : problemEmbed(report);

  // Only a mention in the message body notifies: one inside an embed renders as
  // a link and nothing else.
  const mention = recovered
    ? {}
    : { content: `<@${ownerId}>`, allowed_mentions: { users: [ownerId] } };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...mention, embeds: [embed] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`Webhook returned ${res.status}: ${await res.text()}`);
    }
  } catch (err) {
    // A scrape that worked is not a failed run just because Discord was down.
    console.error("Failed to post report:", err);
  }
}

/**
 * Identifies the problems without their details, so a board that keeps failing
 * with a slightly different message does not post every run.
 */
function problemKey(report: RunReport): string {
  if (report.kind === "failed") return "run failed";

  return [
    ...problemsOf(report.boards).map((b) => `${b.game}:${b.status}`),
    ...report.unmappedGames.map((name) => `unmapped:${name}`),
  ]
    .sort()
    .join(",");
}

function problemsOf(boards: BoardReport[]): Problem[] {
  return boards.filter((b): b is Problem => b.status !== "saved" && b.status !== "unchanged");
}

function recoveredEmbed() {
  return {
    title: "Back to normal",
    description: "Every leaderboard and player count is being read again.",
    color: green,
    timestamp: new Date().toISOString(),
  };
}

function problemEmbed(report: RunReport) {
  if (report.kind === "failed") {
    return {
      title: "The CubeCraft scrape failed",
      description: `Nothing was read this run. It is retried every 5 minutes, and this is posted again only once it changes.\n${codeBlock(formatError(report.error))}`,
      color: red,
      timestamp: new Date().toISOString(),
    };
  }

  const problems = problemsOf(report.boards);
  const fine = report.boards.length - problems.length;

  const fields = problems.map((p) => ({ name: `⚠️ ${p.game}`, value: value(p), inline: false }));

  if (report.unmappedGames.length > 0) {
    fields.push({
      name: "New in the Games menu",
      value: `${report.unmappedGames.join(", ")}: not tracked until added to \`games\` in scraper/src/cubecraft/scrape.ts`,
      inline: false,
    });
  }

  return {
    title:
      problems.length === 0
        ? "Untracked games in the Games menu"
        : `${problems.length} leaderboard${problems.length === 1 ? "" : "s"} not updating`,
    description:
      problems.length > 0
        ? `The other ${fine} are fine. Skipped boards are tried again every 5 minutes.`
        : undefined,
    color: fine > 0 ? yellow : red,
    fields,
    timestamp: new Date().toISOString(),
  };
}

function value(p: Problem): string {
  switch (p.status) {
    case "partial":
      return `Skipped: the leaderboard stopped loading after ${count(p.rows)} players`;
    case "unresolved":
      return `Skipped: ${count(p.total - p.resolved)} of ${count(p.total)} names could not be matched to a Minecraft account`;
    case "failed":
      return `Skipped: ${p.error}`;
  }
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function formatError(error: unknown): string {
  const text = error instanceof Error ? errorText(error) : String(error);
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

/** Bun does not always prefix the stack with the message. */
function errorText(error: Error): string {
  const stack = error.stack ?? "";
  return stack.includes(error.message)
    ? stack
    : `${error.message}\n${stack}`.trim();
}

function codeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}
