import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdminActivityLauncher } from './admin/activity-launcher.js';
import { AdminControlPlane } from './admin/control-plane.js';
import { RelayDeviceIdentity } from './admin/device-identity.js';
import { AdminGrantStore } from './admin/grant-store.js';
import { AdminRelayClient } from './admin/relay-client.js';
import { AdminSetupServer } from './admin/setup-server.js';
import { AdminControlUi } from './discord/admin-control-ui.js';
import { loadConfig } from './config.js';
import { HelpUi } from './discord/help-ui.js';
import { ProviderAdminUi } from './discord/provider-ui.js';
import { RoleBotSupervisor } from './discord/role-bot-supervisor.js';
import { RoleModelAdminUi } from './discord/role-model-ui.js';
import { RoleOutputRouter } from './discord/role-output-router.js';
import { SpecCommandUi } from './discord/spec-ui.js';
import { ManagedHarnessRuntime } from './harness-runtime.js';
import { OrchestrationPolicyStore } from './orchestration/policy-store.js';
import { ProviderGateway } from './providers/gateway.js';
import { ProxyNetworkPolicy } from './providers/network-policy.js';
import { ProviderResolver } from './providers/resolver.js';
import { ProviderService } from './providers/service.js';
import { ProviderStore } from './providers/store.js';
import { SecretVault } from './providers/vault.js';
import { SpecCoordinator } from './specs/coordinator.js';
import { SpecRepository } from './specs/repository.js';
import { SpecStore } from './specs/store.js';
import { CommandToolServer } from './specs/tool-server.js';
import { GitWorkspaceManager } from './specs/workspace-manager.js';

const config = loadConfig();
const providerStore = new ProviderStore(config.databasePath);
const specStore = new SpecStore(config.databasePath);
const policyStore = new OrchestrationPolicyStore(config.databasePath);
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
const providerService = new ProviderService({
  store: providerStore,
  vault,
  networkPolicy,
  timeoutMs: config.requestTimeoutMs,
  harnessRoot: config.harnessRoot,
});
const providerResolver = new ProviderResolver({ store: providerStore, vault });
const providerGateway = new ProviderGateway({
  networkPolicy,
  host: config.providerGatewayHost,
  port: config.providerGatewayPort,
  routeTtlMs: config.providerGatewayRouteTtlMs,
});
const roleBots = new RoleBotSupervisor({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  tokens: config.tokens,
  service: providerService,
  store: providerStore,
});
const outputRouter = new RoleOutputRouter({
  roleBots,
  store: providerStore,
  flushIntervalMs: config.outputFlushIntervalMs,
});
const harnessRuntime = new ManagedHarnessRuntime({
  resolver: providerResolver,
  gateway: providerGateway,
  runtimeRoot: config.runtimeRoot,
  harnessRoot: config.harnessRoot,
  outputRouter,
  policyStore,
});

const controlPlane = new AdminControlPlane({
  service: providerService,
  store: providerStore,
  policyStore,
  specStore,
  harnessRuntime,
  sessionTtlMs: config.adminSessionTtlMs,
});

const adminSetupServer = config.adminUiMode === 'legacy-loopback'
  ? new AdminSetupServer({
      controlPlane,
      service: providerService,
      host: config.adminSetupHost,
      port: config.adminSetupPort,
      publicUrl: config.adminSetupPublicUrl,
      sessionTtlMs: config.adminSetupSessionTtlMs,
      frameAncestors: config.adminFrameAncestors,
    })
  : null;

const adminGrantStore = config.adminUiMode === 'activity-relay'
  ? new AdminGrantStore({ grantTtlMs: config.adminGrantTtlMs, sessionTtlMs: config.adminSessionTtlMs })
  : null;
const relayDeviceIdentity = config.adminUiMode === 'activity-relay'
  ? new RelayDeviceIdentity({ privateKeyPath: config.adminRelayDeviceKeyPath })
  : null;
const adminRelayClient = config.adminUiMode === 'activity-relay'
  ? new AdminRelayClient({
      url: config.adminRelayWsUrl,
      installationId: config.adminRelayInstallationId,
      deviceToken: config.adminRelayDeviceToken,
      identity: relayDeviceIdentity,
      grantStore: adminGrantStore,
      controlPlane,
      authorizeAdministrator: (identity) => roleBots.isAdministrator(identity),
      reconnectMinMs: config.adminRelayReconnectMinMs,
      reconnectMaxMs: config.adminRelayReconnectMaxMs,
      maxPayloadBytes: config.adminRelayMaxPayloadBytes,
    })
  : null;
const activityLauncher = adminRelayClient
  ? new AdminActivityLauncher({ grantStore: adminGrantStore, relayClient: adminRelayClient })
  : null;

const specRepository = new SpecRepository({ store: specStore });
const workspaceManager = new GitWorkspaceManager({
  projectsRoot: config.projectsRoot,
  runtimeRoot: path.join(config.runtimeRoot, 'spec-runtime'),
  verificationCommands: config.verificationCommands,
  allowedTaskCommandPrefixes: config.taskCommandPrefixes,
  autoPush: config.autoPush,
});
let specCoordinator;
const commandToolServer = new CommandToolServer({
  host: config.commandToolHost,
  port: config.commandToolPort,
  onCommand: (input) => specCoordinator.handleTool(input),
});
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
specCoordinator = new SpecCoordinator({
  store: specStore,
  repository: specRepository,
  workspaceManager,
  harnessRuntime,
  roleBots,
  toolServer: commandToolServer,
  toolScript: path.resolve(moduleDirectory, '..', 'scripts', 'clcodex-tool.mjs'),
  policyStore,
});

const adminControlUi = new AdminControlUi({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  activityLauncher,
  adminSetupServer,
  mode: config.adminUiMode,
});
const providerUi = new ProviderAdminUi({
  guildId: config.guildId,
  service: providerService,
  store: providerStore,
  activityLauncher,
  adminSetupServer,
});
const roleModelUi = new RoleModelAdminUi({
  guildId: config.guildId,
  forumChannelId: config.forumChannelId,
  service: providerService,
  store: providerStore,
  roleBots,
});
const helpUi = new HelpUi({ guildId: config.guildId, roleBots });
const specUi = new SpecCommandUi({
  guildId: config.guildId,
  coordinator: specCoordinator,
  store: specStore,
  repository: specRepository,
});
roleBots.setOrchestratorHandlers([helpUi, adminControlUi, providerUi, roleModelUi, specUi]);

export {
  adminRelayClient,
  adminSetupServer,
  commandToolServer,
  controlPlane as adminControlPlane,
  harnessRuntime as managedHarnessRuntime,
  providerGateway,
  providerResolver,
  policyStore as orchestrationPolicyStore,
  providerService,
  roleBots as roleBotSupervisor,
  outputRouter as roleOutputRouter,
  specCoordinator,
};

let closing = false;
async function shutdown(signal, exitCode = 0) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; shutting down role bots and control-plane services`);
  roleBots.destroy();
  await Promise.allSettled([
    specCoordinator.close(),
    adminRelayClient?.stop(),
    adminSetupServer?.close(),
    providerGateway.close(),
  ]);
  adminGrantStore?.clear();
  controlPlane.close();
  providerStore.close();
  specStore.close();
  policyStore.close();
  process.exit(exitCode);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

try {
  await providerGateway.start();
  if (adminSetupServer) await adminSetupServer.start();
  await specCoordinator.initialize();
  const identities = await roleBots.start();
  if (adminRelayClient) {
    await withTimeout(adminRelayClient.start(), config.adminRelayStartupTimeoutMs, 'Admin relay startup');
  }
  const connected = Object.values(identities).map((item) => `${item.role}:${item.tag}`).join(', ');
  console.log(`Role bot supervisor ready: ${connected}`);
  console.log(`Admin UI mode: ${config.adminUiMode}${adminRelayClient ? ` · device ${relayDeviceIdentity.metadata().fingerprint}` : ''}`);
} catch (error) {
  console.error('Startup failed:', error instanceof Error ? error.message : String(error));
  await shutdown('startup-error', 1);
}
