import { leaderboard } from "./leaderboard";
import { player } from "./player";
import type { Command } from "./types";

export const commands = new Map<string, Command>([leaderboard, player].map((command) => [command.name, command]));
