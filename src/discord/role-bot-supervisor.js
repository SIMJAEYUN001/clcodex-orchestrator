import { once } from 'node:events';
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';
import { ROLES, roleDefinition } from '../roles.js';
import {
  RoleBotCommandHandler,
  handleRoleBotsStatus,
  roleBotsStatusCommandJson,
  roleCommandJson,
} from './role-bot-commands.js';

export class RoleBotSupervisor {
  constructor({ guildId, forumChannelId, tokens, service, store }) {
    this.guildId = guildId;
    this.forumChannelId = forumChannelId;
    this.tokens = tokens;
    this.service = service;
    this.store = store;
    this.clients = new Map();
    this.orchestratorHandlers = [];
    this.extraHandlers = new Map(ROLES.map((role) => [role, []]));
    this.validateTokens();
  }

  validateTokens() {
    const values = ROLES.map((role) => this.tokens[role]);
    if (values.some((value) => !value)) throw new Error('All four Discord role bot tokens are required');
    if (new Set(values).size !== values.length) {
      throw new Error('Each role must use a different Discord bot token');
    }
  }

  setOrchestratorHandlers(handlers) {
    this.orchestratorHandlers = [...handlers];
  }

  addInteractionHandler(role, handler) {
    this.extraHandlers.get(role).push(handler);
  }

  identity(role) {
    if (role == null) {
      return Object.fromEntries(ROLES.map((item) => [item, this.identity(item)]));
    }
    const client = this.clients.get(role);
    const user = client?.user;
    return {
      role,
      ready: Boolean(client?.isReady?.()),
      id: user?.id || null,
      tag: user?.tag || null,
      mention: user?.id ? `<@${user.id}>` : null,
    };
  }

  commandsFor(role) {
    const commands = [...roleCommandJson(role)];
    if (role === 'orchestrator') {
      commands.push(roleBotsStatusCommandJson());
      for (const handler of this.orchestratorHandlers) {
        const declared = handler.commandJson();
        if (Array.isArray(declared)) commands.push(...declared);
        else commands.push(declared);
      }
    }
    return commands;
  }

  async start() {
    const started = [];
    try {
      for (const role of ROLES) {
        const client = await this.startRole(role);
        started.push(client);
      }
      const ids = ROLES.map((role) => this.clients.get(role)?.user?.id);
      if (new Set(ids).size !== ROLES.length) {
        throw new Error('Role bot accounts must have four unique Discord user IDs');
      }
      return this.identity();
    } catch (error) {
      for (const client of started) client.destroy();
      this.clients.clear();
      throw error;
    }
  }

  async startRole(role) {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds],
      allowedMentions: { parse: [] },
    });
    client.on(Events.Error, (error) => {
      console.error(`[${role}] Discord client error:`, error instanceof Error ? error.message : String(error));
    });
    client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(role, interaction).catch((error) => {
        console.error(`[${role}] Interaction handler failed:`, error instanceof Error ? error.message : String(error));
      });
    });
    const ready = once(client, Events.ClientReady);
    this.clients.set(role, client);
    try {
      await client.login(this.tokens[role]);
      await ready;
      const rest = new REST({ version: '10' }).setToken(this.tokens[role]);
      const applicationId = client.application?.id || client.user.id;
      await rest.put(Routes.applicationGuildCommands(applicationId, this.guildId), {
        body: this.commandsFor(role),
      });
      console.log(`[${role}] connected as ${client.user.tag}`);
      return client;
    } catch (error) {
      client.destroy();
      this.clients.delete(role);
      throw error;
    }
  }

  async handleInteraction(role, interaction) {
    if (role === 'orchestrator') {
      if (await handleRoleBotsStatus(interaction, {
        guildId: this.guildId,
        identities: (selectedRole) => selectedRole ? this.identity(selectedRole) : this.identity(),
      })) return true;
      for (const handler of this.orchestratorHandlers) {
        if (await handler.handle(interaction)) return true;
      }
    }

    const roleHandler = new RoleBotCommandHandler({
      role,
      guildId: this.guildId,
      forumChannelId: this.forumChannelId,
      service: this.service,
      store: this.store,
      identities: (selectedRole) => this.identity(selectedRole),
    });
    if (await roleHandler.handle(interaction)) return true;
    for (const handler of this.extraHandlers.get(role)) {
      if (await handler(interaction, role)) return true;
    }
    return false;
  }

  async send(role, channelId, payload) {
    const client = this.clients.get(role);
    if (!client?.isReady?.()) throw new Error(`${roleDefinition(role).label} Discord 봇이 연결되지 않았습니다.`);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
      throw new Error(`Discord channel is not writable: ${channelId}`);
    }
    return channel.send({ allowedMentions: { parse: [] }, ...payload });
  }

  async sendPreview({ role, channelId, provider, model, scopeLabel }) {
    const definition = roleDefinition(role);
    return this.send(role, channelId, {
      embeds: [{
        color: definition.color,
        title: `${definition.label} · 봇 연결 확인`,
        description: '이 역할의 작업 시작·진행·완료 메시지는 이 봇 계정으로 기록됩니다.',
        fields: [
          { name: 'Provider', value: provider?.name || '미지정', inline: true },
          { name: '하네스', value: provider?.harness || '미지정', inline: true },
          { name: 'Model', value: model ? `\`${model}\`` : '미지정', inline: true },
          { name: '설정 범위', value: scopeLabel, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }

  destroy() {
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
  }
}
