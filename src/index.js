import { Client, Events, GatewayIntentBits, REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { ProviderAdminUi } from './discord/provider-ui.js';
import { RoleModelAdminUi } from './discord/role-model-ui.js';
import { ProxyNetworkPolicy } from './providers/network-policy.js';
import { ProviderResolver } from './providers/resolver.js';
import { ProviderService } from './providers/service.js';
import { ProviderStore } from './providers/store.js';
import { SecretVault } from './providers/vault.js';

const config = loadConfig();
const store = new ProviderStore(config.databasePath);
const vault = new SecretVault({
  runtimeRoot: config.runtimeRoot,
  secretFileRoot: config.secretFileRoot,
  masterKey: process.env.PROVIDER_VAULT_MASTER_KEY,
});
const networkPolicy = new ProxyNetworkPolicy({
  allowedHosts: config.allowedProxyHosts,
  allowLoopback: config.allowLoopbackProxy,
  allowInsecureLoopback: config.allowInsecureLoopbackProxy,
});
const service = new ProviderService({
  store,
  vault,
  networkPolicy,
  timeoutMs: config.requestTimeoutMs,
});

export const providerResolver = new ProviderResolver({ store, vault });
export const providerService = service;

const providerUi = new ProviderAdminUi({ guildId: config.guildId, service, store });
const roleModelUi = new RoleModelAdminUi({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  service,
  store,
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});

client.once(Events.ClientReady, async (readyClient) => {
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  await rest.put(Routes.applicationGuildCommands(readyClient.user.id, config.guildId), {
    body: [providerUi.commandJson(), roleModelUi.commandJson()],
  });
  console.log(`Guild admin UIs registered as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (await providerUi.handle(interaction)) return;
  await roleModelUi.handle(interaction);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error instanceof Error ? error.message : String(error));
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  client.destroy();
  store.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(config.botToken);
