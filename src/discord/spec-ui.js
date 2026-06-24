import {
  AttachmentBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { EPHEMERAL, isServerAdministrator, replyError, restrictToAdministrators } from './common.js';
import { SPEC_STATUS } from '../specs/constants.js';

const WORKFLOW_CHOICES = [
  { name: 'Requirements First', value: 'requirements-first' },
  { name: 'Design First', value: 'design-first' },
  { name: 'Quick Plan', value: 'quick-plan' },
];

function guildOnly(builder) {
  return builder.setDMPermission(false);
}

function taskStatus(tasks) {
  if (!tasks.length) return '아직 task가 없습니다.';
  return tasks.slice(0, 20).map((task) => `\`${task.taskKey}\` · ${task.role} · wave ${task.wave} · **${task.status}**`).join('\n');
}

export class SpecCommandUi {
  constructor({ guildId, coordinator, store, repository }) {
    this.guildId = guildId;
    this.coordinator = coordinator;
    this.store = store;
    this.repository = repository;
  }

  commandJson() {
    const project = restrictToAdministrators(
      new SlashCommandBuilder()
        .setName('project')
        .setDescription('현재 forum thread의 프로젝트 폴더 관리')
        .addSubcommand((command) => command.setName('status').setDescription('현재 프로젝트 연결 확인'))
        .addSubcommand((command) => command.setName('create').setDescription('새 프로젝트 생성')
          .addStringOption((option) => option.setName('name').setDescription('프로젝트 이름').setRequired(true)))
        .addSubcommand((command) => command.setName('bind').setDescription('기존 Git 프로젝트 연결')
          .addStringOption((option) => option.setName('name').setDescription('프로젝트 이름').setRequired(true))
          .addStringOption((option) => option.setName('root').setDescription('서버의 절대 프로젝트 경로').setRequired(true)))
        .addSubcommand((command) => command.setName('delete').setDescription('프로젝트 연결 삭제')
          .addBooleanOption((option) => option.setName('remove_files').setDescription('프로젝트 파일도 제거'))),
    );

    const goal = guildOnly(new SlashCommandBuilder()
      .setName('goal')
      .setDescription('목표를 사양 기반 workflow로 시작')
      .addStringOption((option) => option.setName('objective').setDescription('구현 목표').setRequired(true).setMaxLength(2000))
      .addStringOption((option) => option.setName('type').setDescription('사양 유형').setRequired(true)
        .addChoices({ name: 'Feature', value: 'feature' }, { name: 'Bugfix', value: 'bugfix' }))
      .addStringOption((option) => option.setName('workflow').setDescription('미지정 시 /admin 오케스트레이션 정책 사용').addChoices(...WORKFLOW_CHOICES))
      .addBooleanOption((option) => option.setName('auto_run').setDescription('마지막 승인 후 자동 실행'))
      .addStringOption((option) => option.setName('project_name').setDescription('프로젝트 미생성 시 사용할 이름')));

    const spec = guildOnly(new SlashCommandBuilder()
      .setName('spec')
      .setDescription('현재 사양 승인·실행·상태 관리')
      .addSubcommand((command) => command.setName('status').setDescription('현재 사양 상태'))
      .addSubcommand((command) => command.setName('approve').setDescription('현재 사양 단계 승인'))
      .addSubcommand((command) => command.setName('run').setDescription('승인된 task manifest 실행'))
      .addSubcommand((command) => command.setName('sync').setDescription('task manifest 재생성'))
      .addSubcommand((command) => command.setName('files').setDescription('사양 문서 경로 확인'))
      .addSubcommand((command) => command.setName('cancel').setDescription('현재 사양 취소'))
      .addSubcommand((command) => command.setName('mediate').setDescription('자동 중재 실패 시 관리자 수동 override')
        .addStringOption((option) => option.setName('task').setDescription('task ID').setRequired(true))
        .addStringOption((option) => option.setName('decision').setDescription('구속력 있는 판정').setRequired(true)
          .addChoices({ name: 'Reviewer 지시 이행', value: 'reviewer' }, { name: 'Coder 이의 인정', value: 'coder' }))
        .addStringOption((option) => option.setName('comments').setDescription('사양·diff 근거').setRequired(true).setMaxLength(2000))));

    const resume = guildOnly(new SlashCommandBuilder().setName('resume').setDescription('중단된 planning/task/review/중재 세션 자동 재개'));
    return [project.toJSON(), goal.toJSON(), spec.toJSON(), resume.toJSON()];
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand?.()) return false;
    if (interaction.guildId !== this.guildId) return false;
    if (!['project', 'goal', 'spec', 'resume'].includes(interaction.commandName)) return false;
    try {
      if (interaction.commandName === 'project') await this.project(interaction);
      else if (interaction.commandName === 'goal') await this.goal(interaction);
      else if (interaction.commandName === 'spec') await this.spec(interaction);
      else await this.resume(interaction);
    } catch (error) {
      await replyError(interaction, error);
    }
    return true;
  }

  assertThread(interaction) {
    if (!interaction.channelId) throw new Error('Forum thread channel에서 실행해야 합니다.');
    return interaction.channelId;
  }

  current(interaction) {
    const threadId = this.assertThread(interaction);
    const current = this.store.currentSpecForThread(this.guildId, threadId);
    if (!current) throw new Error('현재 thread에 spec이 없습니다. `/goal`을 먼저 실행하세요.');
    return current;
  }

  canMutate(interaction, spec) {
    return interaction.user.id === spec.createdBy || isServerAdministrator(interaction, this.guildId);
  }

  async project(interaction) {
    if (!isServerAdministrator(interaction, this.guildId)) throw new Error('서버 Administrator 권한이 필요합니다.');
    const threadId = this.assertThread(interaction);
    const action = interaction.options.getSubcommand();
    if (action === 'status') {
      const selected = this.store.projectForThread(this.guildId, threadId);
      await interaction.reply({
        embeds: [new EmbedBuilder().setTitle('프로젝트 연결').setDescription(selected
          ? `**${selected.name}**\n\`${selected.rootDir}\`\nbranch: \`${selected.defaultBranch}\``
          : '연결된 프로젝트가 없습니다.')],
        flags: EPHEMERAL,
      });
      return;
    }
    if (action === 'create') {
      const selected = this.coordinator.ensureProject({
        guildId: this.guildId,
        threadId,
        name: interaction.options.getString('name', true),
        actorId: interaction.user.id,
      });
      await interaction.reply({ content: `프로젝트 생성 완료: \`${selected.rootDir}\``, flags: EPHEMERAL });
      return;
    }
    if (action === 'bind') {
      const selected = this.coordinator.bindProject({
        guildId: this.guildId,
        threadId,
        name: interaction.options.getString('name', true),
        rootDir: interaction.options.getString('root', true),
        actorId: interaction.user.id,
      });
      await interaction.reply({ content: `프로젝트 연결 완료: \`${selected.rootDir}\``, flags: EPHEMERAL });
      return;
    }
    const selected = this.coordinator.deleteProject({
      guildId: this.guildId,
      threadId,
      actorId: interaction.user.id,
      removeFiles: interaction.options.getBoolean('remove_files') || false,
    });
    await interaction.reply({ content: `프로젝트 연결 삭제 완료: **${selected.name}**`, flags: EPHEMERAL });
  }

  async goal(interaction) {
    const threadId = this.assertThread(interaction);
    await interaction.deferReply({ flags: EPHEMERAL });
    const created = await this.coordinator.createGoal({
      guildId: this.guildId,
      threadId,
      projectName: interaction.options.getString('project_name') || interaction.channel?.name || `project-${threadId}`,
      objective: interaction.options.getString('objective', true),
      kind: interaction.options.getString('type', true),
      workflow: interaction.options.getString('workflow') || undefined,
      autoRun: interaction.options.getBoolean('auto_run') ?? undefined,
      actorId: interaction.user.id,
    });
    await interaction.editReply(`Spec 생성 완료: \`${created.slug}\` · phase=\`${created.phase}\` · status=\`${created.status}\``);
  }

  async spec(interaction) {
    const current = this.current(interaction);
    const action = interaction.options.getSubcommand();
    if (action === 'status') {
      const status = this.coordinator.status(current.id);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`Spec · ${current.slug}`)
          .setDescription(current.objective)
          .addFields(
            { name: '상태', value: `phase=\`${current.phase}\`\nstatus=\`${current.status}\`\nrevision=${current.revision}`, inline: true },
            { name: 'Task', value: taskStatus(status.tasks) },
            { name: '최근 오류', value: current.lastError || '없음' },
          )],
        flags: EPHEMERAL,
      });
      return;
    }
    if (action === 'files') {
      const { project, spec } = this.coordinator.projectAndSpec(current.id);
      const files = this.coordinator.artifactPaths(project, spec);
      await interaction.reply({ content: files.map((file) => `\`${file}\``).join('\n') || '생성된 문서가 없습니다.', flags: EPHEMERAL });
      return;
    }
    if (!this.canMutate(interaction, current)) throw new Error('Spec 생성자 또는 서버 Administrator만 실행할 수 있습니다.');
    await interaction.deferReply({ flags: EPHEMERAL });
    let updated;
    if (action === 'approve') updated = await this.coordinator.approve(current.id, interaction.user.id);
    else if (action === 'run') updated = await this.coordinator.runSpec(current.id, interaction.user.id);
    else if (action === 'sync') updated = await this.coordinator.sync(current.id, interaction.user.id);
    else if (action === 'cancel') updated = this.coordinator.cancel(current.id, interaction.user.id);
    else if (action === 'mediate') {
      updated = await this.coordinator.mediateDispute(
        current.id,
        interaction.options.getString('task', true),
        interaction.options.getString('decision', true),
        interaction.options.getString('comments', true),
        interaction.user.id,
      );
    } else throw new Error(`Unknown spec action: ${action}`);
    await interaction.editReply(`처리 완료: phase=\`${updated.phase}\` · status=\`${updated.status}\``);
  }

  async resume(interaction) {
    const threadId = this.assertThread(interaction);
    await interaction.deferReply({ flags: EPHEMERAL });
    const updated = await this.coordinator.resume({ guildId: this.guildId, threadId, actorId: interaction.user.id });
    await interaction.editReply(`재개 완료: \`${updated.slug}\` · phase=\`${updated.phase}\` · status=\`${updated.status}\``);
  }
}

export const __test = { taskStatus, WORKFLOW_CHOICES };
