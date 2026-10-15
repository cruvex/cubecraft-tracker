import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from "discord.js";
import { loadGames } from "./api";
import { commands } from "./commands";
import { registerCommands } from "./register";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN is not set");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (ready) => {
  console.log(`Logged in as ${ready.user.tag}`);
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => reportError(interaction, err));
});

async function handleInteraction(interaction: Interaction) {
  if (interaction.isChatInputCommand()) {
    await commands.get(interaction.commandName)?.execute(interaction);
  } else if (interaction.isAutocomplete()) {
    await commands.get(interaction.commandName)?.autocomplete?.(interaction);
  } else if (interaction.isButton()) {
    const [name, ...args] = interaction.customId.split(":");
    await commands.get(name!)?.button?.(interaction, args);
  }
}

async function reportError(interaction: Interaction, err: unknown) {
  console.error(`Interaction ${interaction.id} failed:`, err);
  if (!interaction.isRepliable()) return;

  const content = "Something went wrong talking to the tracker. Try again in a bit.";
  try {
    if (interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (replyErr) {
    console.error("Reporting the failure to Discord failed too:", replyErr);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    await client.destroy();
    process.exit(0);
  });
}

// Fatal: without games there's nothing to register or show.
const games = await loadGames();
console.log(`Loaded ${games.length} games`);

// Not fatal: the previously registered commands keep working.
await registerCommands(token, games).catch((err) => console.error("Registering commands failed:", err));

await client.login(token);
