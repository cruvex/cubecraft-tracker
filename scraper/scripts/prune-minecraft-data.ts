/**
 * Delete every minecraft-data directory the given version does not read.
 *
 * minecraft-data ships protocol data for every Minecraft version, ~430MB, and
 * mineflayer only ever loads one. dataPaths.json names the directories each
 * version reads from (a version reuses older ones for whatever did not change),
 * so everything else can go.
 *
 *   bun scripts/prune-minecraft-data.ts 26.1
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version) throw new Error("Usage: bun prune-minecraft-data.ts <version>");

const root = "node_modules/minecraft-data/minecraft-data/data";
const dataPaths = JSON.parse(readFileSync(join(root, "dataPaths.json"), "utf8"));

const paths: Record<string, string> | undefined = dataPaths.pc[version];
if (!paths) throw new Error(`minecraft-data has no Java data for ${version}`);

// The common directories are read at load for every version: protocol version
// lists and feature tables, Bedrock's included.
const keep = new Set(["pc/common", "bedrock/common", ...Object.values(paths)]);

for (const edition of ["pc", "bedrock"]) {
  for (const dir of readdirSync(join(root, edition))) {
    if (!keep.has(`${edition}/${dir}`)) rmSync(join(root, edition, dir), { recursive: true });
  }
}

console.log(`Kept ${[...keep].sort().join(", ")}`);
