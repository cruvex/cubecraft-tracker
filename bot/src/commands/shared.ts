import {
  ApplicationIntegrationType,
  ContainerBuilder,
  InteractionContextType,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  SlashCommandBuilder,
  TextDisplayBuilder,
} from "discord.js";

const accentColor = 0x3aa9ff;

/** Installable on servers and user accounts, usable in servers and any DM. */
export function slashCommand(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel);
}

export function headerContainer(title: string, subtitle: string) {
  return new ContainerBuilder().setAccentColor(accentColor).addTextDisplayComponents(text(`## ${title}\n${subtitle}`));
}

export function text(content: string) {
  return new TextDisplayBuilder().setContent(content);
}

export function separator() {
  return new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small);
}

// A V2 message can't carry content or embeds.
export function v2Message(container: ContainerBuilder, { ephemeral = false } = {}) {
  return { components: [container], flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0) };
}
