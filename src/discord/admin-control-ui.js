import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import {
  EPHEMERAL,
  isServerAdministrator,
  replyError,
  restrictToAdministrators,
} from './common.js';

export class AdminControlUi {
  constructor({ guildId, forumChannelId = null, adminSetupServer }) {
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.adminSetupServer = adminSetupServer;
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
      const issued = this.adminSetupServer.issueSession({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        threadId: this.threadId(interaction),
      });
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle('clcodex Control Center')
        .setDescription([
          'Codex·Claude Code 런타임, proxy/provider, 역할별 모델과 사양 기반 오케스트레이션을 한 화면에서 관리합니다.',
          '',
          '링크는 명령을 실행한 관리자에게만 표시되며 제한 시간 후 만료됩니다.',
          '설정 변경은 실행 중 세션을 바꾸지 않고 새 세션부터 적용됩니다.',
        ].join('\n'))
        .addFields({
          name: '세션 만료',
          value: `<t:${Math.floor(new Date(issued.expiresAt).getTime() / 1000)}:R>`,
          inline: true,
        });
      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel('관리 UI 열기')
            .setURL(issued.url),
        )],
        flags: EPHEMERAL,
      });
      return true;
    } catch (error) {
      await replyError(interaction, error);
      return true;
    }
  }
}
