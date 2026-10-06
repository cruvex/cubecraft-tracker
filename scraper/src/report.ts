// Posts to the Discord webhook when the set of problems changes, and when Cubepanion's games change.
const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

const ownerId = "255361968037167105";
// Only a mention in the message body notifies; one in an embed is just a link.
const ping = { content: `<@${ownerId}>`, allowed_mentions: { users: [ownerId] } };

const green = 0x57f287;
const yellow = 0xfee75c;
const red = 0xed4245;
const blue = 0x5865f2;

// Discord allows 4096 in an embed description; this leaves room for the code fence.
const maxDescription = 3500;

export type BoardReport = { game: string } & (
  | { status: "saved"; changed: number }
  | { status: "unchanged" }
  | { status: "partial"; rows: number }
  // notFound goes to scrape_runs only: the Discord post does not name players.
  | { status: "unresolved"; resolved: number; total: number; notFound: string[] }
  | { status: "failed"; error: string }
  // The board was read but saving it threw.
  | { status: "crashed"; error: string }
);

type Problem = Exclude<BoardReport, { status: "saved" | "unchanged" }>;

export type RunReport =
  | { kind: "run"; boards: BoardReport[]; unmappedGames: string[] }
  | { kind: "failed"; error: unknown };

// What the last post said was wrong; in memory, so a restart with a problem ongoing posts it again.
let lastProblems = "";

export async function sendReport(report: RunReport) {
  const problems = problemKey(report);
  if (problems === lastProblems) return;

  lastProblems = problems;

  if (problems === "") return await post(recoveredEmbed);

  await post(report.kind === "failed" ? failedEmbed(report.error) : problemsEmbed(report), ping);
}

// Not part of the problem tracking: every change is news, and nobody is pinged.
export async function sendGamesChanged(changes: string[]) {
  if (changes.length === 0) return;

  await post({
    title: "Cubepanion's games changed",
    description: codeBlock(truncate(changes.join("\n"), maxDescription)),
    color: blue,
  });
}

async function post(embed: object, mention: object = {}) {
  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...mention, embeds: [{ ...embed, timestamp: new Date().toISOString() }] }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) console.error(`Webhook returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    // A scrape that worked is not a failed run just because Discord was down.
    console.error("Failed to post report:", err);
  }
}

// The problems without their details, so a board failing with a changing message does not post every run.
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

const recoveredEmbed = {
  title: "Back to normal",
  description: "Every leaderboard and player count is being read again.",
  color: green,
};

function failedEmbed(error: unknown) {
  return {
    title: "The CubeCraft scrape failed",
    description: `Nothing was read this run. It is retried every 5 minutes, and this is posted again only once it changes.\n${codeBlock(formatError(error))}`,
    color: red,
  };
}

function problemsEmbed(report: Extract<RunReport, { kind: "run" }>) {
  const problems = problemsOf(report.boards);
  const fine = report.boards.length - problems.length;

  const fields = problems.map((p) => ({ name: `⚠️ ${p.game}`, value: reason(p), inline: false }));

  if (report.unmappedGames.length > 0) {
    fields.push({
      name: "New in the Games menu",
      value: `${report.unmappedGames.join(", ")}: not tracked, as no game in Cubepanion's list has this name or alias`,
      inline: false,
    });
  }

  return {
    title:
      problems.length === 0
        ? "Untracked games in the Games menu"
        : `${problems.length} leaderboard${problems.length === 1 ? "" : "s"} not updating`,
    description: problems.length > 0 ? `The other ${fine} are fine. Skipped boards are tried again every 5 minutes.` : undefined,
    color: fine > 0 ? yellow : red,
    fields,
  };
}

function reason(p: Problem): string {
  switch (p.status) {
    case "partial":
      return `Skipped: the leaderboard stopped loading after ${count(p.rows)} players`;
    case "unresolved":
      return `Skipped: ${count(p.total - p.resolved)} of ${count(p.total)} names could not be matched to a Minecraft account`;
    case "failed":
      return `Skipped: ${p.error}`;
    case "crashed":
      return `Skipped: saving the board failed: ${p.error}`;
  }
}

const count = (n: number) => n.toLocaleString("en-US");

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return truncate(String(error), 1000);

  // Bun does not always prefix the stack with the message.
  const stack = error.stack ?? "";
  return truncate(stack.includes(error.message) ? stack : `${error.message}\n${stack}`.trim(), 1000);
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const codeBlock = (text: string) => `\`\`\`\n${text}\n\`\`\``;
