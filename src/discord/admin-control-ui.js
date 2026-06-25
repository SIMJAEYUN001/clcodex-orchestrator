import { SlashCommandBuilder } from 'discord.js';
import {
  isServerAdministrator,
  replyError,
  restrictToAdministrators,
} from './common.js';

export class AdminControlUi {
  constructor({
    guildId,
    forumChannelId = null,
    activityLauncher = null,
    adminSetupServer = null,
    mode = activityLauncher ? 'activity-relay' : 'legacy-loopback',
  }) {
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.activityLauncher = activityLauncher;
    this.adminSetupServer = adminSetupServer;
    this.mode = mode;
  }

  commandJson() {
    return restrictToAdministrators(
      new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Codex, Claude Code, 공급자와 전체 오케스트레이션 관리 UI 열기'),
    ).toJSON();
  }

  threadId(interaction) {
    const channel = interaction.channel;
    if (!channel?.isThread?.()) return null;
    if (this.forumChannelId && channel.parentId !== this.forumChannelId) return null;
    return channel.id;
  }

  async handle(interaction) {
    try {
      if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'admin') return false;
      if (!isServerAdministrator(interaction, this.guildId)) {
        throw new Error('서버 Administrator 권한이 필요합니다.');
      }
      if (this.mode === 'activity-relay') {
        if (!this.activityLauncher) throw new Error('Discord Activity launcher is unavailable');
        await this.activityLauncher.launch(interaction, { threadId: this.threadId(interaction) });
        return true;
      }
      if (this.mode === 'legacy-loopback') {
        if (!this.adminSetupServer) throw new Error('Legacy Control Center server is unavailable');
        const issued = this.adminSetupServer.issueSession({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          threadId: this.threadId(interaction),
        });
        await interaction.reply({
          content: `레거시 loopback 관리 URL입니다. 제한 시간 후 만료됩니다.\n${issued.url}`,
          ephemeral: true,
        });
        return true;
      }
      throw new Error('관리 UI가 비활성화되어 있습니다.');
    } catch (error) {
      await replyError(interaction, error);
      return true;
    }
  }
}
