import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function list(name) {
  return (process.env[name] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig() {
  const runtimeRoot = path.resolve(process.env.RUNTIME_ROOT || '.runtime');
  return {
    guildId: required('DISCORD_GUILD_ID'),
    forumChannelId: process.env.DISCORD_FORUM_CHANNEL_ID?.trim() || null,
    botToken: required('DISCORD_ORCHESTRATOR_BOT_TOKEN'),
    runtimeRoot,
    harnessRoot: path.resolve(process.env.HARNESS_ROOT || '.harness'),
    databasePath: path.resolve(process.env.DATABASE_PATH || path.join(runtimeRoot, 'state.sqlite')),
    secretFileRoot: path.resolve(process.env.PROVIDER_SECRET_FILE_ROOT || path.join(runtimeRoot, 'external-secrets')),
    allowedProxyHosts: list('PROXY_ALLOWED_HOSTS'),
    allowLoopbackProxy: bool('ALLOW_LOOPBACK_PROXY', true),
    allowInsecureLoopbackProxy: bool('ALLOW_INSECURE_LOOPBACK_PROXY', true),
    requestTimeoutMs: positiveInteger('PROVIDER_REQUEST_TIMEOUT_MS', 12_000),
  };
}
