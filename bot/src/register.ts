import { REST, Routes, type APIApplication } from "discord.js";
import type { Game } from "./api";
import { commands } from "./commands";

// Runs on every start since the choices come from the API; DISCORD_GUILD_ID limits it to one test server.
export async function registerCommands(token: string, games: Game[]) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const rest = new REST().setToken(token);

  // Derived from the token so there's no client id to configure.
  const application = (await rest.get(Routes.currentApplication())) as APIApplication;

  // Install and use contexts only exist on global commands.
  const body = [...commands.values()].map((command) => {
    const json = command.build(games);
    if (!guildId) return json;
    const { integration_types, contexts, ...guildJson } = json;
    return guildJson;
  });
  const route = guildId
    ? Routes.applicationGuildCommands(application.id, guildId)
    : Routes.applicationCommands(application.id);

  await rest.put(route, { body });

  console.log(`Registered ${body.length} command(s) for ${application.name} ${guildId ? `to guild ${guildId}` : "globally"}`);

  // A private app can't have Discord's own install link.
  const authorize = `https://discord.com/oauth2/authorize?client_id=${application.id}`;
  console.log(`Install to a server: ${authorize}&integration_type=0&scope=bot+applications.commands`);
  console.log(`Install to your account: ${authorize}&integration_type=1&scope=applications.commands`);
}
