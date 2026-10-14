import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { Game } from "../api";

export interface Command {
  name: string;
  build(games: Game[]): RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  /** Receives buttons with custom id `<command name>:<...args>`. */
  button?(interaction: ButtonInteraction, args: string[]): Promise<void>;
}
