import { randomBytes } from 'node:crypto';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';

export const EPHEMERAL = MessageFlags.Ephemeral;

export function isServerAdministrator(interaction, guildId) {
  if (!interaction.guildId || interaction.guildId !== guildId) return false;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

export function restrictToAdministrators(command) {
  return command
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false);
}

export function compact(value, max = 100) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return compact(
    message
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]'),
    500,
  );
}

export class UiSessionStore {
  constructor(prefix, ttlMs = 15 * 60 * 1000) {
    this.prefix = prefix;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create(input) {
    this.sweep();
    const session = {
      id: randomBytes(9).toString('base64url'),
      ...input,
      expiresAt: Date.now() + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  require(id, interaction) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) throw new Error('관리 UI 세션이 만료되었습니다. 명령어를 다시 실행하세요.');
    if (session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
      throw new Error('이 관리 UI는 명령어를 실행한 서버 관리자만 사용할 수 있습니다.');
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return session;
  }

  id(session, action, argument = '') {
    const value = [this.prefix, session.id, action, argument].join('|');
    if (value.length > 100) throw new Error('Discord component ID is too long');
    return value;
  }

  parse(value) {
    const [prefix, sessionId, action, argument = ''] = String(value).split('|');
    if (prefix !== this.prefix || !sessionId || !action) return null;
    return { sessionId, action, argument };
  }

  sweep() {
    const current = Date.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= current) this.sessions.delete(id);
  }
}

export async function replyError(interaction, error) {
  const payload = { content: `오류: ${safeError(error)}`, flags: EPHEMERAL };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
  else await interaction.reply(payload).catch(() => {});
}
