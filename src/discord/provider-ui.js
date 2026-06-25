import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  EPHEMERAL,
  UiSessionStore,
  compact,
  isServerAdministrator,
  replyError,
  restrictToAdministrators,
} from './common.js';

const PAGE_SIZE = 25;

function parseModels(value) {
  return String(value || '').split(/[\n,]+/g).map((item) => item.trim()).filter(Boolean);
}

function addText(modal, { id, label, value, placeholder, style = TextInputStyle.Short, required = true, maxLength = 4000 }) {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setRequired(required)
    .setMaxLength(maxLength);
  if (value) input.setValue(String(value).slice(0, maxLength));
  if (placeholder) input.setPlaceholder(placeholder);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
}

export class ProviderAdminUi {
  constructor({ guildId, service, store, activityLauncher = null, adminSetupServer = null }) {
    this.guildId = guildId;
    this.service = service;
    this.store = store;
    this.activityLauncher = activityLauncher;
    this.adminSetupServer = adminSetupServer;
    this.ui = new UiSessionStore('pui');
  }

  commandJson() {
    return restrictToAdministrators(
      new SlashCommandBuilder()
        .setName('providers')
        .setDescription('프록시 엔드포인트, API 키, 모델 목록 관리')
        .addSubcommand((command) => command.setName('panel').setDescription('공급자 관리 UI 열기'))
        .addSubcommand((command) => command.setName('audit').setDescription('최근 설정 변경 감사 로그 확인')),
    ).toJSON();
  }

  async handle(interaction) {
    try {
      if (interaction.isChatInputCommand() && interaction.commandName === 'providers') {
        if (!isServerAdministrator(interaction, this.guildId)) throw new Error('서버 Administrator 권한이 필요합니다.');
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === 'audit') {
          await interaction.reply({ ...this.auditView(), flags: EPHEMERAL });
          return true;
        }
        const session = this.ui.create({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          selectedProviderId: null,
          page: 0,
        });
        await interaction.reply({ ...this.panel(session), flags: EPHEMERAL });
        return true;
      }

      if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return false;
      const parsed = this.ui.parse(interaction.customId);
      if (!parsed) return false;
      if (!isServerAdministrator(interaction, this.guildId)) throw new Error('서버 Administrator 권한이 필요합니다.');
      const session = this.ui.require(parsed.sessionId, interaction);
      if (interaction.isButton()) await this.button(interaction, session, parsed.action, parsed.argument);
      else if (interaction.isStringSelectMenu()) await this.select(interaction, session, parsed.action);
      else await this.modal(interaction, session, parsed.action, parsed.argument);
      return true;
    } catch (error) {
      await replyError(interaction, error);
      return true;
    }
  }

  page(session) {
    const profiles = this.service.list(session.guildId);
    const maxPage = Math.max(0, Math.ceil(profiles.length / PAGE_SIZE) - 1);
    session.page = Math.min(Math.max(session.page, 0), maxPage);
    const items = profiles.slice(session.page * PAGE_SIZE, (session.page + 1) * PAGE_SIZE);
    if (!profiles.some((item) => item.id === session.selectedProviderId)) {
      session.selectedProviderId = items[0]?.id || profiles[0]?.id || null;
    }
    return { profiles, items, maxPage };
  }

  panel(session) {
    const { items, maxPage } = this.page(session);
    const selected = session.selectedProviderId ? this.service.describe(session.selectedProviderId) : null;
    const embed = new EmbedBuilder()
      .setTitle('공급자·API 키 관리')
      .setDescription('서버 관리자 전용 UI입니다. API 키 원문은 화면이나 감사 로그에 표시되지 않습니다.');
    if (selected) {
      embed.addFields(
        { name: '프로필', value: `**${compact(selected.name, 80)}** · ${selected.enabled ? '활성' : '비활성'} · rev ${selected.revision}` },
        { name: '하네스 / 인증', value: `${selected.harness} / ${selected.authType}${selected.authType === 'api-key' ? ` (${selected.authHeader})` : ''}`, inline: true },
        { name: '키', value: selected.secret.configured ? `${selected.secret.mode} · ${selected.secret.hint}` : '미설정', inline: true },
        { name: '엔드포인트', value: `\`${compact(selected.baseUrl, 240)}\`` },
        {
          name: `모델 ${selected.models.length}개`,
          value: selected.models.length
            ? selected.models.slice(0, 12).map((item) => `\`${compact(item.modelKey, 80)}\``).join('\n')
            : '등록된 모델 없음',
        },
      );
    } else {
      embed.addFields({ name: '프로필', value: '등록된 공급자 프로필이 없습니다.' });
    }

    const components = [];
    if (items.length) {
      components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(this.ui.id(session, 'select-provider'))
          .setPlaceholder('공급자 프로필 선택')
          .addOptions(items.map((item) => ({
            label: compact(item.name, 100),
            value: item.id,
            description: compact(`${item.harness} · ${item.baseUrl}`, 100),
            default: item.id === session.selectedProviderId,
          }))),
      ));
    }

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.ui.id(session, 'setup-link')).setLabel('통합 관리 UI').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'edit')).setLabel('엔드포인트 수정').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'secret-menu')).setLabel('API 키').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'models-edit')).setLabel('모델 편집').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
    ));

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.ui.id(session, 'models-sync')).setLabel('모델 동기화').setStyle(ButtonStyle.Secondary).setDisabled(!selected || !selected.secret.configured),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'test')).setLabel('연결 테스트').setStyle(ButtonStyle.Success).setDisabled(!selected || !selected.secret.configured),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'toggle')).setLabel(selected?.enabled ? '비활성화' : '활성화').setStyle(ButtonStyle.Secondary).setDisabled(!selected),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'delete-menu')).setLabel('삭제').setStyle(ButtonStyle.Danger).setDisabled(!selected),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'audit')).setLabel('감사 로그').setStyle(ButtonStyle.Secondary),
    ));

    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(this.ui.id(session, 'page-prev')).setLabel('이전').setStyle(ButtonStyle.Secondary).setDisabled(session.page <= 0),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'page-next')).setLabel('다음').setStyle(ButtonStyle.Secondary).setDisabled(session.page >= maxPage),
      new ButtonBuilder().setCustomId(this.ui.id(session, 'refresh')).setLabel('새로고침').setStyle(ButtonStyle.Secondary),
    ));

    return { embeds: [embed], components };
  }

  auditView() {
    const entries = this.store.listAudit(this.guildId, 15);
    const lines = entries.map((item) => `\`${item.createdAt.slice(0, 19)}\` <@${item.actorId}> **${item.action}** · ${item.targetId.slice(0, 8)}`);
    return { embeds: [new EmbedBuilder().setTitle('공급자 설정 감사 로그').setDescription(lines.join('\n') || '기록 없음')] };
  }

  async select(interaction, session, action) {
    if (action !== 'select-provider') return;
    session.selectedProviderId = interaction.values[0];
    await interaction.update(this.panel(session));
  }

  async button(interaction, session, action, argument) {
    if (action === 'refresh') return interaction.update(this.panel(session));
    if (action === 'page-prev' || action === 'page-next') {
      session.page += action === 'page-next' ? 1 : -1;
      return interaction.update(this.panel(session));
    }
    if (action === 'setup-link') {
      if (this.activityLauncher) {
        return this.activityLauncher.launch(interaction, {
          threadId: interaction.channel?.isThread?.() ? interaction.channelId : null,
        });
      }
      if (!this.adminSetupServer) throw new Error('Control Center가 연결되지 않았습니다.');
      const issued = this.adminSetupServer.issueSession({
        guildId: session.guildId,
        userId: interaction.user.id,
        threadId: interaction.channel?.isThread?.() ? interaction.channelId : null,
      });
      return interaction.reply({
        content: `레거시 loopback 관리 URL입니다.
${issued.url}`,
        flags: EPHEMERAL,
      });
    }
    const id = session.selectedProviderId;
    if (!id) throw new Error('먼저 공급자 프로필을 선택하세요.');
    if (action === 'edit') return interaction.showModal(this.editModal(session, this.service.describe(id)));
    if (action === 'models-edit') return interaction.showModal(this.modelsModal(session, this.service.describe(id)));
    if (action === 'secret-menu') {
      return interaction.reply({
        content: 'Discord native modal은 password 마스킹을 지원하지 않습니다. 직접 credential 입력은 `/admin` 또는 `통합 관리 UI`를 사용하고, 기존 프로필에는 ENV 또는 파일 참조를 사용하세요.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(this.ui.id(session, 'secret-env')).setLabel('ENV 참조').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(this.ui.id(session, 'secret-file')).setLabel('파일 참조').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(this.ui.id(session, 'secret-clear')).setLabel('키 제거').setStyle(ButtonStyle.Danger),
        )],
        flags: EPHEMERAL,
      });
    }
    if (['secret-env', 'secret-file'].includes(action)) return interaction.showModal(this.secretModal(session, action));
    if (action === 'secret-clear') {
      this.store.clearSecret(id, interaction.user.id);
      return interaction.update({ content: '키 연결을 제거했습니다.', components: [] });
    }
    if (action === 'models-sync') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const result = await this.service.sync(id, interaction.user.id);
      return interaction.editReply(`모델 ${result.models.length}개 동기화 완료 · HTTP ${result.status} · ${result.latencyMs}ms`);
    }
    if (action === 'test') {
      await interaction.deferReply({ flags: EPHEMERAL });
      const result = await this.service.test(id);
      return interaction.editReply(`연결 성공 · HTTP ${result.status} · ${result.latencyMs}ms · 모델 ${result.modelCount}개`);
    }
    if (action === 'toggle') {
      const current = this.store.requireProfile(id);
      await this.service.update(id, { enabled: !current.enabled }, interaction.user.id);
      return interaction.update(this.panel(session));
    }
    if (action === 'audit') return interaction.reply({ ...this.auditView(), flags: EPHEMERAL });
    if (action === 'delete-menu') {
      return interaction.reply({
        content: '프로필, 키, 모델, 해당 역할 바인딩을 모두 삭제합니다.',
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(this.ui.id(session, 'delete-confirm')).setLabel('영구 삭제').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(this.ui.id(session, 'delete-cancel')).setLabel('취소').setStyle(ButtonStyle.Secondary),
        )],
        flags: EPHEMERAL,
      });
    }
    if (action === 'delete-confirm') {
      this.store.deleteProfile(id, interaction.user.id);
      session.selectedProviderId = null;
      return interaction.update({ content: '프로필을 삭제했습니다.', components: [] });
    }
    if (action === 'delete-cancel') return interaction.update({ content: '삭제를 취소했습니다.', components: [] });
  }

  editModal(session, profile) {
    const modal = new ModalBuilder().setCustomId(this.ui.id(session, 'modal-edit')).setTitle('공급자 프로필 수정');
    addText(modal, { id: 'name', label: '프로필 이름', value: profile.name });
    addText(modal, { id: 'base_url', label: 'Base URL', value: profile.baseUrl });
    addText(modal, { id: 'models_path', label: '모델 목록 경로', value: profile.modelsPath });
    return modal;
  }

  modelsModal(session, profile) {
    const modal = new ModalBuilder().setCustomId(this.ui.id(session, 'modal-models')).setTitle('모델 목록 편집');
    addText(modal, {
      id: 'models', label: '모델 ID (한 줄에 하나)',
      value: profile.models.map((item) => item.modelKey).join('\n'),
      style: TextInputStyle.Paragraph,
    });
    return modal;
  }

  secretModal(session, action) {
    const env = action === 'secret-env';
    const modal = new ModalBuilder()
      .setCustomId(this.ui.id(session, `modal-${action}`))
      .setTitle(env ? '환경변수 참조' : '파일 참조');
    addText(modal, {
      id: 'secret',
      label: env ? '환경변수 이름' : 'secret root 기준 상대 경로',
      placeholder: env ? 'FRONTEND_PROXY_API_KEY' : 'frontend.key',
      maxLength: 512,
    });
    return modal;
  }

  async modal(interaction, session, action) {
    if (action === 'modal-edit') {
      await this.service.update(session.selectedProviderId, {
        name: interaction.fields.getTextInputValue('name'),
        baseUrl: interaction.fields.getTextInputValue('base_url'),
        modelsPath: interaction.fields.getTextInputValue('models_path'),
      }, interaction.user.id);
      return interaction.reply({ ...this.panel(session), flags: EPHEMERAL });
    }
    if (action === 'modal-models') {
      this.service.models(session.selectedProviderId, parseModels(interaction.fields.getTextInputValue('models')), interaction.user.id);
      return interaction.reply({ ...this.panel(session), flags: EPHEMERAL });
    }
    const value = interaction.fields.getTextInputValue('secret');
    if (action === 'modal-secret-env') this.service.envSecret(session.selectedProviderId, value, interaction.user.id);
    else if (action === 'modal-secret-file') this.service.fileSecret(session.selectedProviderId, value, interaction.user.id);
    else throw new Error('Unknown provider modal');
    return interaction.reply({ content: '키 참조를 저장했습니다. 원문 키는 표시하거나 감사 로그에 기록하지 않습니다.', flags: EPHEMERAL });
  }

}

export const __test = { parseModels };
