import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
  escapeMarkdown,
  time,
  TimestampStyles,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from "discord.js";
import { getGame, getLeaderboard, type Game, type LeaderboardRow } from "../api";
import type { Command } from "./types";

const pageSize = 15;
const accentColor = 0x3aa9ff;

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

    return new SlashCommandBuilder()
      .setName(this.name)
      .setDescription("Show a game's current leaderboard")
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
      .addIntegerOption((option) =>
        option
          .setName("game")
          .setDescription("The game to show")
          .setRequired(true)
          .addChoices(choices.slice(0, maxChoices)),
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

  if (interaction.isButton()) await interaction.deferUpdate();
  else await interaction.deferReply();
  await interaction.editReply(await renderPage(game, page));
}

async function renderPage(game: Game, requestedPage: number): Promise<InteractionEditReplyOptions> {
  const board = await getLeaderboard(game.id);
  const container = new ContainerBuilder().setAccentColor(accentColor);

  if (!board.rows.length) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`No leaderboard data for **${game.displayName}** yet.`),
    );
    return v2Message(container);
  }

  const pageCount = Math.ceil(board.rows.length / pageSize);
  const page = Math.min(Math.max(Number.isInteger(requestedPage) ? requestedPage : 0, 0), pageCount - 1);
  const rows = board.rows.slice(page * pageSize, (page + 1) * pageSize);

  const heading = `## ${game.displayName} leaderboard\n-# Ranked by ${game.scoreType}`;
  const footer = [
    `Page ${page + 1}/${pageCount}`,
    board.timestamp && `Updated ${time(new Date(board.timestamp), TimestampStyles.RelativeTime)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  container
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
    .addSeparatorComponents((separator) => separator.setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(rows.map(formatRow).join("\n")),
    )
    .addSeparatorComponents((separator) => separator.setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));

  if (pageCount > 1) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`leaderboard:${game.id}:${page - 1}`)
          .setEmoji("◀️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`leaderboard:${game.id}:${page + 1}`)
          .setEmoji("▶️")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === pageCount - 1),
      ),
    );
  }

  return v2Message(container);
}

// A V2 message can't carry content or embeds.
function v2Message(container: ContainerBuilder): InteractionEditReplyOptions {
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function formatRow(row: LeaderboardRow) {
  const name = row.ign ? escapeMarkdown(row.ign) : "Unknown player";
  return `**${row.rank}.** ${name} · ${row.score.toLocaleString("en-US")}`;
}
