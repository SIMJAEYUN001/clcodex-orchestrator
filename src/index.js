import { loadConfig } from './config.js';
import { ProviderAdminUi } from './discord/provider-ui.js';
import { RoleBotSupervisor } from './discord/role-bot-supervisor.js';
import { RoleModelAdminUi } from './discord/role-model-ui.js';
import { RoleOutputRouter } from './discord/role-output-router.js';
import { ManagedHarnessRuntime } from './harness-runtime.js';
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
const resolver = new ProviderResolver({ store, vault });
const roleBots = new RoleBotSupervisor({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  tokens: config.tokens,
  service,
  store,
});
const providerUi = new ProviderAdminUi({ guildId: config.guildId, service, store });
const roleModelUi = new RoleModelAdminUi({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  service,
  store,
  roleBots,
});
roleBots.setAdminHandlers([providerUi, roleModelUi]);

const outputRouter = new RoleOutputRouter({
  roleBots,
  store,
  flushIntervalMs: config.outputFlushIntervalMs,
});
const harnessRuntime = new ManagedHarnessRuntime({
  resolver,
  runtimeRoot: config.runtimeRoot,
  harnessRoot: config.harnessRoot,
  outputRouter,
});

export const providerResolver = resolver;
export const providerService = service;
export const roleBotSupervisor = roleBots;
export const roleOutputRouter = outputRouter;
export const managedHarnessRuntime = harnessRuntime;

async function shutdown(signal, exitCode = 0) {
  console.log(`Received ${signal}; shutting down four role bots`);
  roleBots.destroy();
  store.close();
  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const identities = await roleBots.start();
  const connected = Object.values(identities).map((item) => `${item.role}:${item.tag}`).join(', ');
  console.log(`Role bot supervisor ready: ${connected}`);
} catch (error) {
  console.error('Role bot startup failed:', error instanceof Error ? error.message : String(error));
  await shutdown('startup-error', 1);
}
