import { escapeMarkdown } from "discord.js";
import { getGame, getPlayer, searchPlayers, type Player } from "../api";
import { headerContainer, separator, slashCommand, text, v2Message } from "./shared";
import type { Command } from "./types";

export const player: Command = {
  name: "player",

  build() {
    return slashCommand(this.name, "Show where a player stands on every leaderboard")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("Their Minecraft name, current or past")
          .setRequired(true)
          .setAutocomplete(true)
          .setMaxLength(16),
      )
      .toJSON();
  },

  async autocomplete(interaction) {
    const query = interaction.options.getFocused().trim();
    // The API only searches from two characters.
    const players = query.length < 2 ? [] : await searchPlayers(query);

    // A recycled name shows up once per owner, but it only ever resolves to the latest one.
    const names = [...new Map(players.map((p) => [p.ign.toLowerCase(), p.ign])).values()];
    await interaction.respond(names.map((name) => ({ name, value: name })));
  },

  async execute(interaction) {
    const name = interaction.options.getString("name", true).trim();
    const profile = await getPlayer(name);
    if (!profile) {
      const container = headerContainer(escapeMarkdown(name), "Never seen on a tracked leaderboard");
      await interaction.reply(v2Message(container, { ephemeral: true }));
      return;
    }

    await interaction.reply(renderProfile(profile));
  },
};

function renderProfile(profile: Player) {
  const title =
    profile.matchedIgn === profile.ign
      ? escapeMarkdown(profile.ign)
      : `${escapeMarkdown(profile.matchedIgn)} (${escapeMarkdown(profile.ign)})`;

  const entries = profile.games
    .flatMap((entry) => {
      const game = getGame(entry.gameId);
      return game ? [{ ...entry, game }] : [];
    })
    .sort((a, b) => Number(b.game.active) - Number(a.game.active) || a.position - b.position);

  if (!entries.length) return v2Message(headerContainer(title, "Not on any leaderboard right now"));

  const lines = entries.map(({ game, position, score }) => {
    const label = game.active ? `**${game.displayName}**` : `**${game.displayName}** (inactive)`;
    return `${label} · #${position} · ${score.toLocaleString("en-US")} ${game.scoreType}`;
  });

  const container = headerContainer(title, `On ${entries.length} leaderboard${entries.length === 1 ? "" : "s"}`)
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(lines.join("\n")));

  return v2Message(container);
}
