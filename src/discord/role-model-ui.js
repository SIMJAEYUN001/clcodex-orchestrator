import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { ROLES, roleLabel } from '../roles.js';
import {
  EPHEMERAL,
  UiSessionStore,
  compact,
  isServerAdministrator,
  replyError,
  restrictToAdministrators,
} from './common.js';

const PAGE_SIZE = 25;


export class RoleModelAdminUi {
  constructor({ guildId, forumChannelId, service, store, roleBots = null }) {
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.service = service;
    this.store = store;
    this.roleBots = roleBots;
    this.ui = new UiSessionStore('rmui');
  }

  commandJson() {
    return restrictToAdministrators(
      new SlashCommandBuilder()
        .setName('role-models')
        .setDescription('역할군별 공급자와 모델 라우팅 관리')
        .addSubcommand((command) => command
          .setName('panel')
          .setDescription('역할별 모델 설정 UI 열기')
          .addStringOption((option) => option
            .setName('scope')
            .setDescription('설정 적용 범위')
            .setRequired(true)
            .addChoices(
              { name: '서버 전체 기본값', value: 'global' },
              { name: '현재 포럼 스레드', value: 'thread' },
            )))
        .addSubcommand((command) => command
          .setName('status')
          .setDescription('현재 채널에서 적용되는 역할별 모델 확인')),
    ).toJSON();
  }

  managedThread(interaction) {
    if (!interaction.channel?.isThread?.()) return null;
    if (this.forumChannelId && interaction.channel.parentId !== this.forumChannelId) return null;
    return interaction.channelId;
  }

  async handle(interaction) {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'role-models') {
        if (!isServerAdministrator(interaction, this.guildId)) throw new Error('서버 Administrator 권한이 필요합니다.');
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'status') {
          await interaction.reply({ ...this.statusView(this.managedThread(interaction)), flags: EPHEMERAL });
          return true;
        }
        const scopeType = interaction.options.getString('scope', true);
        const threadId = this.managedThread(interaction);
        if (scopeType === 'thread' && !threadId) {
          throw new Error('현재 채널은 설정된 Discord 포럼 채널의 스레드가 아닙니다.');
        }
        const session = this.ui.create({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          threadId,
          scopeType,
          scopeId: scopeType === 'thread' ? threadId : '*',
          selectedRole: 'orchestrator',
          selectedProviderId: null,
          selectedModel: null,
          providerPage: 0,
          modelPage: 0,
        });
        this.selectFromCurrentBinding(session);
        await interaction.reply({ ...this.panel(session), flags: EPHEMERAL });
        return true;
      }

      if (!(interaction.isButton() || interaction.isStringSelectMenu())) return false;
      const parsed = this.ui.parse(interaction.customId);
      if (!parsed) return false;
      if (!isServerAdministrator(interaction, this.guildId)) throw new Error('서버 Administrator 권한이 필요합니다.');
      const session = this.ui.require(parsed.sessionId, interaction);
      if (interaction.isButton()) await this.button(interaction, session, parsed.action);
      else await this.select(interaction, session, parsed.action);
      return true;
    } catch (error) {
      await replyError(interaction, error);
      return true;
    }
  }

  explicitBinding(session, role) {
    return this.store.getBinding(session.guildId, session.scopeType, session.scopeId, role);
  }

  effectiveBinding(session, role) {
    return session.scopeType === 'thread'
      ? this.store.resolveBinding(session.guildId, session.threadId, role)
      : this.store.getBinding(session.guildId, 'global', '*', role);
  }

  selectFromCurrentBinding(session) {
    const current = this.effectiveBinding(session, session.selectedRole);
    session.selectedProviderId = current?.providerId || null;
    session.selectedModel = current?.modelKey || null;
    session.providerPage = 0;
    session.modelPage = 0;
  }

  normalizeSelection(session) {
    const providers = this.service.list(session.guildId, true);
    if (!providers.some((item) => item.id === session.selectedProviderId)) {
      const current = this.effectiveBinding(session, session.selectedRole);
      session.selectedProviderId = providers.some((item) => item.id === current?.providerId)
        ? current.providerId
        : providers[0]?.id || null;
      session.selectedModel = null;
    }

    const providerIndex = Math.max(0, providers.findIndex((item) => item.id === session.selectedProviderId));
    const providerMaxPage = Math.max(0, Math.ceil(providers.length / PAGE_SIZE) - 1);
    session.providerPage = Math.min(Math.max(session.providerPage, 0), providerMaxPage);
    if (session.selectedProviderId && Math.floor(providerIndex / PAGE_SIZE) !== session.providerPage) {
      session.providerPage = Math.floor(providerIndex / PAGE_SIZE);
    }

    const provider = providers.find((item) => item.id === session.selectedProviderId) || null;
    const models = provider?.models || [];
    if (!models.some((item) => item.modelKey === session.selectedModel)) {
      const current = this.effectiveBinding(session, session.selectedRole);
      session.selectedModel = current?.providerId === provider?.id && models.some((item) => item.modelKey === current.modelKey)
        ? current.modelKey
        : models[0]?.modelKey || null;
    }
    const modelIndex = Math.max(0, models.findIndex((item) => item.modelKey === session.selectedModel));
    const modelMaxPage = Math.max(0, Math.ceil(models.length / PAGE_SIZE) - 1);
    session.modelPage = Math.min(Math.max(session.modelPage, 0), modelMaxPage);
    if (session.selectedModel && Math.floor(modelIndex / PAGE_SIZE) !== session.modelPage) {
      session.modelPage = Math.floor(modelIndex / PAGE_SIZE);
    }

    return { providers, provider, models, providerMaxPage, modelMaxPage };
  }

  assignmentLine(session, role, providers) {
    const explicit = this.explicitBinding(session, role);
    const effective = this.effectiveBinding(session, role);
    if (!effective) return `**${roleLabel(role)}** — 미지정`;
    const provider = providers.find((item) => item.id === effective.providerId);
    const inherited = session.scopeType === 'thread' && !explicit ? ' · 서버 기본값 상속' : '';
    const identity = this.roleBots?.identity(role);
    const bot = identity?.mention || identity?.tag || '봇 미연결';
    return `**${roleLabel(role)}** — ${bot} · ${compact(provider?.name || '삭제된 프로필', 60)} / \`${compact(effective.modelKey, 80)}\`${inherited}`;
  }

  panel(session) {
    const { providers, provider, models, providerMaxPage, modelMaxPage } = this.normalizeSelection(session);
    const providerItems = providers.slice(session.providerPage * PAGE_SIZE, (session.providerPage + 1) * PAGE_SIZE);
    const modelItems = models.slice(session.modelPage * PAGE_SIZE, (session.modelPage + 1) * PAGE_SIZE);
    const scopeName = session.scopeType === 'thread' ? '현재 포럼 스레드' : '서버 전체 기본값';
    const embed = new EmbedBuilder()
      .setTitle('역할별 모델 설정')
      .setDescription(`적용 범위: **${scopeName}**\n관리·설정 명령은 오케스트레이터 봇에만 등록됩니다. 실제 작업 메시지는 선택된 역할의 전용 봇이 작성합니다.\n이 명령과 UI는 서버 Administrator만 사용할 수 있습니다.`)
      .addFields(
        { name: '현재 라우팅', value: ROLES.map((role) => this.assignmentLine(session, role, providers)).join('\n') },
        {
          name: '편집 대상',
          value: `역할: **${roleLabel(session.selectedRole)}**\n공급자: **${compact(provider?.name || '미선택', 80)}**\n모델: \`${compact(session.selectedModel || '미선택', 90)}\``,
        },
      );

    const components = [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(this.ui.id(session, 'select-role'))
          .setPlaceholder('역할군 선택')
          .addOptions(ROLES.map((role) => ({ label: roleLabel(role), value: role, default: role === session.selectedRole }))),
      ),
    ];

    if (providerItems.length) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(this.ui.id(session, 'select-provider'))
          .setPlaceholder('공급자 선택')
          .addOptions(providerItems.map((item) => ({
            label: compact(item.name, 100),
            value: item.id,
            description: compact(`${item.harness} · ${item.baseUrl}`, 100),
            default: item.id === session.selectedProviderId,
          }))),
      ));
    }

    if (modelItems.length) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(this.ui.id(session, 'select-model'))
          .setPlaceholder('모델 선택')
          .addOptions(modelItems.map((item) => ({
            label: compact(item.displayName, 100),
            value: item.modelKey,
            description: compact(item.modelKey, 100),
            default: item.modelKey === session.selectedModel,
          }))),
      ));
    }

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.ui.id(session, 'save')).setLabel('역할 설정 저장').setStyle(ButtonStyle.Success).setDisabled(!provider || !session.selectedModel),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'preview')).setLabel('역할 봇 확인').setStyle(ButtonStyle.Primary).setDisabled(!provider || !session.selectedModel || !this.roleBots?.identity(session.selectedRole)?.ready),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'clear')).setLabel('현재 범위 설정 해제').setStyle(ButtonStyle.Danger).setDisabled(!this.explicitBinding(session, session.selectedRole)),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'refresh')).setLabel('새로고침').setStyle(ButtonStyle.Secondary),
    ));

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.ui.id(session, 'provider-prev')).setLabel('공급자 이전').setStyle(ButtonStyle.Secondary).setDisabled(session.providerPage <= 0),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'provider-next')).setLabel('공급자 다음').setStyle(ButtonStyle.Secondary).setDisabled(session.providerPage >= providerMaxPage),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'model-prev')).setLabel('모델 이전').setStyle(ButtonStyle.Secondary).setDisabled(session.modelPage <= 0),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'model-next')).setLabel('모델 다음').setStyle(ButtonStyle.Secondary).setDisabled(session.modelPage >= modelMaxPage),
    ));

    return { embeds: [embed], components };
  }

  statusView(threadId) {
    const providers = this.service.list(this.guildId);
    const lines = ROLES.map((role) => {
      const selected = this.store.resolveBinding(this.guildId, threadId, role);
      if (!selected) return `**${roleLabel(role)}** — 미지정`;
      const provider = providers.find((item) => item.id === selected.providerId);
      const identity = this.roleBots?.identity(role);
      const bot = identity?.mention || identity?.tag || '봇 미연결';
      return `**${roleLabel(role)}** — ${bot} · ${compact(provider?.name || '삭제된 프로필', 60)} / \`${compact(selected.modelKey, 80)}\` (${selected.scopeType})`;
    });
    return {
      embeds: [new EmbedBuilder()
        .setTitle('현재 적용 모델')
        .setDescription(lines.join('\n'))],
    };
  }

  async select(interaction, session, action) {
    if (action === 'select-role') {
      session.selectedRole = interaction.values[0];
      this.selectFromCurrentBinding(session);
    } else if (action === 'select-provider') {
      session.selectedProviderId = interaction.values[0];
      session.selectedModel = null;
      session.modelPage = 0;
    } else if (action === 'select-model') {
      session.selectedModel = interaction.values[0];
    }
    await interaction.update(this.panel(session));
  }

  async button(interaction, session, action) {
    if (action === 'refresh') return interaction.update(this.panel(session));
    if (action === 'preview') {
      if (!this.roleBots) throw new Error('역할 봇 supervisor가 연결되지 않았습니다.');
      const provider = this.service.list(session.guildId, true)
        .find((item) => item.id === session.selectedProviderId);
      if (!provider || !session.selectedModel) throw new Error('Provider와 model을 먼저 선택하세요.');
      await interaction.deferReply({ flags: EPHEMERAL });
      await this.roleBots.sendPreview({
        role: session.selectedRole,
        channelId: interaction.channelId,
        provider,
        model: session.selectedModel,
        scopeLabel: session.scopeType === 'thread' ? '현재 forum thread' : '서버 전체 기본값',
      });
      return interaction.editReply(`${roleLabel(session.selectedRole)} 봇이 현재 채널에 확인 메시지를 전송했습니다.`);
    }
    if (action === 'save') {
      this.service.bind({
        guildId: session.guildId,
        scopeType: session.scopeType,
        scopeId: session.scopeId,
        role: session.selectedRole,
        providerId: session.selectedProviderId,
        modelKey: session.selectedModel,
      }, interaction.user.id);
      return interaction.update(this.panel(session));
    }
    if (action === 'clear') {
      this.store.clearBinding({
        guildId: session.guildId,
        scopeType: session.scopeType,
        scopeId: session.scopeId,
        role: session.selectedRole,
      }, interaction.user.id);
      this.selectFromCurrentBinding(session);
      return interaction.update(this.panel(session));
    }
    if (action === 'provider-prev' || action === 'provider-next') {
      session.providerPage += action === 'provider-next' ? 1 : -1;
      const providers = this.service.list(session.guildId, true);
      const first = providers[session.providerPage * PAGE_SIZE];
      session.selectedProviderId = first?.id || null;
      session.selectedModel = null;
      session.modelPage = 0;
      return interaction.update(this.panel(session));
    }
    if (action === 'model-prev' || action === 'model-next') {
      session.modelPage += action === 'model-next' ? 1 : -1;
      const provider = this.service.list(session.guildId, true).find((item) => item.id === session.selectedProviderId);
      session.selectedModel = provider?.models[session.modelPage * PAGE_SIZE]?.modelKey || null;
      return interaction.update(this.panel(session));
    }
  }
}

export const __test = { roleLabel };
