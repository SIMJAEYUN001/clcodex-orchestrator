import { once } from 'node:events';
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';
import { DISCORD_ROLES } from '../config.js';

export const ROLE_LABELS = {
  orchestrator: '오케스트레이터',
  backend: '백엔드 코더',
  frontend: '프론트엔드 코더',
  reviewer: '리뷰어',
};

export function assertDistinctBotUsers(roleUsers) {
  const seen = new Map();
  for (const role of DISCORD_ROLES) {
    const userId = roleUsers[role]?.id;
    if (!userId) throw new Error(`Discord role bot did not become ready: ${role}`);
    const previous = seen.get(userId);
    if (previous) throw new Error(`Discord role bots must be distinct: ${previous} and ${role} resolved to the same bot user`);
    seen.set(userId, role);
  }
}

function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });
}

function roleError(role, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[discord:${role}] ${message}`);
}

export class RoleBotFleet {
  constructor({ guildId, forumChannelId, adminLogChannelId, tokens, clientFactory = createClient }) {
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.adminLogChannelId = adminLogChannelId;
    this.tokens = tokens;
    this.clientFactory = clientFactory;
    this.clients = new Map();
    this.roleUsers = {};
    this.started = false;
  }

  async start({ commands = [], interactionHandler } = {}) {
    if (this.started) throw new Error('Discord role-bot fleet is already started');
    const results = await Promise.allSettled(
      DISCORD_ROLES.map((role) => this.startRole(role, role === 'orchestrator' ? interactionHandler : null)),
    );
    const failures = results
      .map((result, index) => ({ result, role: DISCORD_ROLES[index] }))
      .filter(({ result }) => result.status === 'rejected');
    if (failures.length) {
      await this.destroy();
      const summary = failures.map(({ role, result }) => `${role}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`).join('; ');
      throw new Error(`Unable to start all four Discord role bots: ${summary}`);
    }

    try {
      assertDistinctBotUsers(this.roleUsers);
      await this.synchronizeGuildCommands(commands);
      this.started = true;
      return this.identities();
    } catch (error) {
      await this.destroy();
      throw error;
    }
  }

  async startRole(role, interactionHandler) {
    const client = this.clientFactory(role);
    client.on(Events.Error, (error) => roleError(role, error));
    client.on(Events.Warn, (warning) => console.warn(`[discord:${role}] ${warning}`));
    if (interactionHandler) {
      client.on(Events.InteractionCreate, (interaction) => {
        Promise.resolve(interactionHandler(interaction)).catch((error) => roleError(role, error));
      });
    }

    const ready = once(client, Events.ClientReady);
    await client.login(this.tokens[role]);
    await ready;
    const guild = await client.guilds.fetch(this.guildId).catch(() => null);
    if (!guild) {
      client.destroy();
      throw new Error(`${ROLE_LABELS[role]} 봇이 대상 서버에 참여하지 않았습니다.`);
    }
    this.clients.set(role, client);
    this.roleUsers[role] = { id: client.user.id, tag: client.user.tag };
    console.log(`[discord:${role}] ready as ${client.user.tag}`);
  }

  async synchronizeGuildCommands(commands) {
    await Promise.all(DISCORD_ROLES.map(async (role) => {
      const client = this.requireClient(role);
      const rest = new REST({ version: '10' }).setToken(this.tokens[role]);
      const body = role === 'orchestrator' ? commands : [];
      await rest.put(Routes.applicationGuildCommands(client.user.id, this.guildId), { body });
      if (role === 'orchestrator') {
        console.log(`[discord:${role}] registered ${commands.length} guild commands`);
      } else {
        console.log(`[discord:${role}] cleared worker application commands`);
      }
    }));
  }

  identities() {
    return Object.fromEntries(
      DISCORD_ROLES.map((role) => [role, { ...this.roleUsers[role], label: ROLE_LABELS[role] }]),
    );
  }

  requireClient(role) {
    const client = this.clients.get(role);
    if (!client?.isReady?.()) throw new Error(`${ROLE_LABELS[role] || role} Discord bot is not ready`);
    return client;
  }

  async fetchTarget(role, channelId, { requireProjectThread = false } = {}) {
    if (!channelId) throw new Error(`No Discord destination configured for ${ROLE_LABELS[role] || role}`);
    const client = this.requireClient(role);
    const channel = await client.channels.fetch(channelId);
    if (!channel || typeof channel.send !== 'function') throw new Error(`Discord destination is not sendable: ${channelId}`);
    if (requireProjectThread) {
      if (!channel.isThread?.()) throw new Error('Role activity must be written to a Discord thread');
      if (this.forumChannelId && channel.parentId !== this.forumChannelId) {
        throw new Error('Role activity destination is outside the configured project forum');
      }
    }
    return channel;
  }

  async send(role, threadId, payload) {
    const channel = await this.fetchTarget(role, threadId, { requireProjectThread: true });
    return channel.send({ ...payload, allowedMentions: { parse: [] } });
  }

  async sendConfigurationNotice(role, threadId, payload) {
    const targetId = threadId || this.adminLogChannelId;
    if (!targetId) return null;
    const channel = await this.fetchTarget(role, targetId, { requireProjectThread: Boolean(threadId) });
    return channel.send({ ...payload, allowedMentions: { parse: [] } });
  }

  async destroy() {
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
    this.roleUsers = {};
    this.started = false;
  }
}
