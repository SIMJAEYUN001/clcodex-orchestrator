import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RelayDeviceIdentity } from '../src/admin/device-identity.js';

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}


function exactOrigin(value, protocol, label) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(`${label} must be a valid ${protocol} origin`); }
  if (url.protocol !== protocol || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must be an exact ${protocol} origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

const input = args(process.argv.slice(2));
const runtimeRoot = path.resolve(process.env.RUNTIME_ROOT || '.runtime');
const relayRoot = path.join(runtimeRoot, 'admin-relay');
const provisioningFile = path.join(relayRoot, 'provisioning.json');
const previous = await readJson(provisioningFile) || {};
const installationId = String(input['installation-id'] || previous.installationId || randomUUID());
const deviceToken = String(input['device-token'] || previous.deviceToken || randomBytes(32).toString('base64url'));
const discordClientId = String(input['discord-client-id'] || process.env.DISCORD_ACTIVITY_CLIENT_ID || '').trim();
const relayHttpUrl = exactOrigin(input['relay-http-url'] || process.env.ADMIN_RELAY_HTTP_URL, 'https:', '--relay-http-url');
const relayWebSocketUrl = exactOrigin(input['relay-ws-url'] || process.env.ADMIN_RELAY_WS_URL, 'wss:', '--relay-ws-url');
const activityOrigin = exactOrigin(input['activity-origin'] || process.env.DISCORD_ACTIVITY_ORIGIN, 'https:', '--activity-origin');
const oauthRedirectUri = exactOrigin(input['oauth-redirect-uri'] || process.env.RELAY_OAUTH_REDIRECT_URI || 'https://127.0.0.1', 'https:', '--oauth-redirect-uri');
if (!discordClientId || !/^\d+$/.test(discordClientId)) throw new Error('--discord-client-id is required');

await mkdir(relayRoot, { recursive: true, mode: 0o700 });
const privateKeyPath = path.resolve(process.env.ADMIN_RELAY_DEVICE_KEY_PATH || path.join(relayRoot, 'device-signing-private.jwk'));
const identity = await new RelayDeviceIdentity({ privateKeyPath }).initialize();
const metadata = identity.metadata();
const activityConfig = {
  discordClientId,
  installationId,
  relayHttpUrl,
  relayWebSocketUrl,
  oauthRedirectUri,
  deviceSigningPublicKey: metadata.publicKey,
  deviceFingerprint: metadata.fingerprint,
};
const provisioning = {
  installationId,
  deviceToken,
  privateKeyPath,
  activityConfig,
  generatedAt: new Date().toISOString(),
};
await writeFile(provisioningFile, `${JSON.stringify(provisioning, null, 2)}\n`, { mode: 0o600 });
await mkdir(path.resolve('activity/public'), { recursive: true });
await writeFile(path.resolve('activity/public/config.json'), `${JSON.stringify(activityConfig, null, 2)}\n`, { mode: 0o644 });

const orchestratorEnv = [
  'ADMIN_UI_MODE=activity-relay',
  `ADMIN_RELAY_WS_URL=${relayWebSocketUrl}`,
  `ADMIN_RELAY_INSTALLATION_ID=${installationId}`,
  `ADMIN_RELAY_DEVICE_TOKEN=${deviceToken}`,
  `ADMIN_RELAY_DEVICE_KEY_PATH=${privateKeyPath}`,
  '',
].join('\n');
const relayEnv = [
  'RELAY_HOST=127.0.0.1',
  'RELAY_PORT=8790',
  `RELAY_ACTIVITY_ORIGINS=${activityOrigin}`,
  `RELAY_DEVICES_JSON=${JSON.stringify({ [installationId]: deviceToken })}`,
  `RELAY_DISCORD_CLIENT_ID=${discordClientId}`,
  `RELAY_OAUTH_REDIRECT_URI=${oauthRedirectUri}`,
  'RELAY_DISCORD_CLIENT_SECRET=REPLACE_ME',
  '',
].join('\n');
const orchestratorEnvFile = path.join(relayRoot, 'orchestrator.env');
const relayEnvFile = path.join(relayRoot, 'relay.env');
await writeFile(orchestratorEnvFile, orchestratorEnv, { mode: 0o600 });
await writeFile(relayEnvFile, relayEnv, { mode: 0o600 });
if (process.platform !== 'win32') {
  await chmod(provisioningFile, 0o600);
  await chmod(orchestratorEnvFile, 0o600);
  await chmod(relayEnvFile, 0o600);
}

console.log(JSON.stringify({
  installationId,
  deviceFingerprint: metadata.fingerprint,
  activityConfig: path.resolve('activity/public/config.json'),
  orchestratorEnv: orchestratorEnvFile,
  relayEnv: relayEnvFile,
  oauthRedirectUri,
  note: 'relay.env still requires RELAY_DISCORD_CLIENT_SECRET and the public Activity origin. Register oauthRedirectUri in Discord Developer Portal OAuth2 Redirects.',
}, null, 2));
