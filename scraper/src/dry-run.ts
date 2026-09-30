/**
 * Run the CubeCraft scrape once and print what it read, without touching the
 * database. For checking the menus still work after CubeCraft changes them.
 *
 *   MC_USERNAME=... MC_AUTH_DIR=... bun src/dry-run.ts
 */
import { scrapeCubeCraft } from "./cubecraft/scrape";

const started = performance.now();
const result = await scrapeCubeCraft(AbortSignal.timeout(4 * 60_000));
const seconds = ((performance.now() - started) / 1000).toFixed(1);

console.log(`\nPlayer counts at ${result.countsReadAt.toISOString()}:`);
for (const { gameId, players } of result.counts) console.log(`  game ${gameId}: ${players}`);
if (result.unmappedGames.length > 0) console.log(`  unmapped: ${result.unmappedGames.join(", ")}`);

console.log("\nLeaderboards:");
for (const board of result.boards) {
  const name = `${board.game.menuName} (${board.game.id})`;

  if (!board.ok) {
    console.log(`  ${name}: FAILED ${board.error}`);
    continue;
  }

  const first = board.rows[0];
  const last = board.rows.at(-1);
  console.log(
    `  ${name}: ${board.rows.length} rows${board.complete ? "" : " (INCOMPLETE)"}` +
      (first && last ? `, #${first.position} ${first.player} ${first.score} .. #${last.position} ${last.player} ${last.score}` : ""),
  );
}

console.log(`\nDone in ${seconds}s`);
process.exit(0);
