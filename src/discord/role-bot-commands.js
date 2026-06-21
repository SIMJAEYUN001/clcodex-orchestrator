import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { roleDefinition, roleLabel } from '../roles.js';
import {
  compact,
  isServerAdministrator,
  restrictToAdministrators,
} from './common.js';

const EPHEMERAL = MessageFlags.Ephemeral;

function threadIdFor(interaction, forumChannelId) {
  if (!interaction.channel?.isThread?.()) return null;
  if (forumChannelId && interaction.channel.parentId !== forumChannelId) return null;
  return interaction.channelId;
}

export function roleCommandJson(role) {
  const definition = roleDefinition(role);
  return [
    new SlashCommandBuilder()
      .setName(`${definition.commandPrefix}-model`)
      .setDescription(`${definition.label}에 현재 적용되는 공급자와 모델 확인`)
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(`${definition.commandPrefix}-history`)
      .setDescription(`${definition.label}의 현재 채널 작업 이력 확인`)
      .addIntegerOption((option) => option
        .setName('limit')
        .setDescription('표시할 최근 이력 수')
        .setMinValue(1)
        .setMaxValue(20))
      .setDMPermission(false)
      .toJSON(),
  ];
}

export function roleBotsStatusCommandJson() {
  return restrictToAdministrators(
    new SlashCommandBuilder()
      .setName('role-bots')
      .setDescription('역할별 Discord 봇 연결 상태 관리')
      .addSubcommand((command) => command
        .setName('status')
        .setDescription('네 역할 봇의 연결 상태 확인')),
  ).toJSON();
}

export class RoleBotCommandHandler {
  constructor({ role, guildId, forumChannelId, service, store, identities }) {
    this.role = role;
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.service = service;
    this.store = store;
    this.identities = identities;
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.guildId !== this.guildId) return false;
    const definition = roleDefinition(this.role);
    if (interaction.commandName === `${definition.commandPrefix}-model`) {
      const threadId = threadIdFor(interaction, this.forumChannelId);
      const binding = this.store.resolveBinding(this.guildId, threadId, this.role);
      if (!binding) {
        await interaction.reply({
          content: `${definition.label}에 적용된 모델이 없습니다. 서버 관리자가 /role-models panel에서 설정해야 합니다.`,
          flags: EPHEMERAL,
        });
        return true;
      }
      const provider = this.service.list(this.guildId).find((item) => item.id === binding.providerId);
      const identity = this.identities(this.role);
      const embed = new EmbedBuilder()
        .setColor(definition.color)
        .setTitle(`${definition.label} · 현재 모델`)
        .addFields(
          { name: 'Discord 봇', value: identity?.mention || identity?.tag || '연결되지 않음', inline: true },
          { name: '하네스', value: provider?.harness || '알 수 없음', inline: true },
          { name: '적용 범위', value: binding.scopeType === 'thread' ? '현재 포럼 스레드' : '서버 기본값', inline: true },
          { name: '공급자', value: compact(provider?.name || '삭제된 프로필', 100), inline: true },
          { name: '모델', value: `\`${compact(binding.modelKey, 100)}\``, inline: true },
        );
      await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
      return true;
    }

    if (interaction.commandName === `${definition.commandPrefix}-history`) {
      const limit = interaction.options.getInteger('limit') || 10;
      const entries = this.store.listWorkEvents({
        guildId: this.guildId,
        threadId: interaction.channelId,
        role: this.role,
        limit,
      });
      const description = entries.length
        ? entries.map((entry) => {
          const task = entry.taskId ? `\`${compact(entry.taskId, 30)}\`` : 'task 없음';
          const state = compact(entry.eventType, 24);
          const summary = compact(entry.summary || '', 120);
          return `• <t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R> · **${state}** · ${task}${summary ? ` · ${summary}` : ''}`;
        }).join('\n')
        : '현재 채널에 기록된 작업 이력이 없습니다.';
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(definition.color)
          .setTitle(`${definition.label} · 작업 이력`)
          .setDescription(description)],
        flags: EPHEMERAL,
      });
      return true;
    }
    return false;
  }
}

export async function handleRoleBotsStatus(interaction, { guildId, identities }) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'role-bots') return false;
  if (!isServerAdministrator(interaction, guildId)) {
    await interaction.reply({ content: '서버 Administrator 권한이 필요합니다.', flags: EPHEMERAL });
    return true;
  }
  const lines = Object.keys(identities()).map((role) => {
    const identity = identities(role);
    const status = identity?.ready ? '온라인' : '오프라인';
    return `**${roleLabel(role)}** — ${identity?.mention || identity?.tag || '미연결'} · ${status}`;
  });
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setTitle('역할별 Discord 봇 상태')
      .setDescription(lines.join('\n'))
      .setFooter({ text: '관리 UI는 오케스트레이터 봇에만 등록됩니다.' })],
    flags: EPHEMERAL,
  });
  return true;
}

export const __test = { threadIdFor };
