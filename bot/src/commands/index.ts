import { leaderboard } from "./leaderboard";
import type { Command } from "./types";

export const commands = new Map<string, Command>([leaderboard].map((command) => [command.name, command]));
