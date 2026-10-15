import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  escapeMarkdown,
  time,
  TimestampStyles,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getGame, getLeaderboard, type Game, type LeaderboardRow } from "../api";
import { headerContainer, separator, slashCommand, text, v2Message } from "./shared";
import type { Command } from "./types";

const pageSize = 15;
const maxChoices = 25;

export const leaderboard: Command = {
  name: "leaderboard",

  build(games) {
    // Active first, so inactive games are the ones dropped past the limit.
    const choices = games
      .toSorted((a, b) => Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName))
      .map((game) => ({ name: game.active ? game.displayName : `${game.displayName} (inactive)`, value: game.id }));
    if (choices.length > maxChoices) {
      console.warn(`/leaderboard offers ${maxChoices} of ${choices.length} games; it needs autocomplete instead`);
    }

    return slashCommand(this.name, "Show a game's current leaderboard")
      .addIntegerOption((option) =>
        option.setName("game").setDescription("The game to show").setRequired(true).addChoices(choices.slice(0, maxChoices)),
      )
      .toJSON();
  },

  async execute(interaction) {
    await showPage(interaction, interaction.options.getInteger("game", true), 0);
  },

  // Paging state lives in the button ids, so buttons survive restarts.
  async button(interaction, [gameId, page]) {
    await showPage(interaction, Number(gameId), Number(page));
  },
};

async function showPage(interaction: ChatInputCommandInteraction | ButtonInteraction, gameId: number, page: number) {
  // Only misses for an old button whose game was dropped since.
  const game = getGame(gameId);
  if (!game) {
    await interaction.reply({ content: "That game is no longer tracked.", flags: MessageFlags.Ephemeral });
    return;
  }

  const message = await renderPage(game, page);
  if (interaction.isButton()) await interaction.update(message);
  else await interaction.reply(message);
}

async function renderPage(game: Game, requestedPage: number) {
  const board = await getLeaderboard(game.id);
  const title = `${game.displayName} leaderboard`;
  if (!board.rows.length) return v2Message(headerContainer(title, "No data yet"));

  const pageCount = Math.ceil(board.rows.length / pageSize);
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const rows = board.rows.slice(page * pageSize, (page + 1) * pageSize);
  const updated = board.timestamp ? ` · Updated ${time(new Date(board.timestamp), TimestampStyles.RelativeTime)}` : "";

  const container = headerContainer(title, `Ranked by ${game.scoreType}`)
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(rows.map(formatRow).join("\n")))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text(`-# Page ${page + 1}/${pageCount}${updated}`));

  if (pageCount > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        pageButton(game, page - 1, "◀️", page === 0),
        pageButton(game, page + 1, "▶️", page === pageCount - 1),
      ),
    );
  }

  return v2Message(container);
}

function pageButton(game: Game, page: number, emoji: string, disabled: boolean) {
  return new ButtonBuilder()
    .setCustomId(`leaderboard:${game.id}:${page}`)
    .setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function formatRow(row: LeaderboardRow) {
  const name = row.ign ? escapeMarkdown(row.ign) : "Unknown player";
  return `**${row.rank}.** ${name} · ${row.score.toLocaleString("en-US")}`;
}
