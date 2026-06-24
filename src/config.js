import path from 'node:path';
import { ROLES, roleDefinition } from './roles.js';

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

function nonNegativeInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = nonNegativeInteger(name, fallback);
  if (value === 0) throw new Error(`${name} must be a positive integer`);
  return value;
}


function frameAncestors(value) {
  const raw = String(value || "'none'").trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "'none'";
  for (const token of tokens) {
    if (["'none'", "'self'"].includes(token)) continue;
    if (!/^https:\/\/[A-Za-z0-9*.-]+(?::\d{1,5})?$/.test(token)) {
      throw new Error('ADMIN_FRAME_ANCESTORS contains an invalid CSP source');
    }
  }
  if (tokens.includes("'none'") && tokens.length > 1) throw new Error("ADMIN_FRAME_ANCESTORS cannot combine 'none' with another source");
  return tokens.join(' ');
}

function jsonStringArray(name, fallback = []) {
  const raw = process.env[name]?.trim();
  if (!raw) return [...fallback];
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return value.map((item) => item.trim());
}

export function loadRoleBotTokens(environment = process.env) {
  const tokens = Object.fromEntries(ROLES.map((role) => {
    const variable = roleDefinition(role).tokenEnvironment;
    const value = environment[variable]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${variable}`);
    return [role, value];
  }));
  if (new Set(Object.values(tokens)).size !== ROLES.length) {
    throw new Error('Each role must use a distinct Discord bot token');
  }
  return tokens;
}

export function loadConfig() {
  const runtimeRoot = path.resolve(process.env.RUNTIME_ROOT || '.runtime');
  return {
    guildId: required('DISCORD_GUILD_ID'),
    forumChannelId: process.env.DISCORD_FORUM_CHANNEL_ID?.trim() || null,
    tokens: loadRoleBotTokens(),
    runtimeRoot,
    projectsRoot: path.resolve(process.env.PROJECTS_ROOT || path.join(runtimeRoot, 'projects')),
    harnessRoot: path.resolve(process.env.HARNESS_ROOT || '.harness'),
    databasePath: path.resolve(process.env.DATABASE_PATH || path.join(runtimeRoot, 'state.sqlite')),
    secretFileRoot: path.resolve(process.env.PROVIDER_SECRET_FILE_ROOT || path.join(runtimeRoot, 'external-secrets')),
    allowedProxyHosts: list('PROXY_ALLOWED_HOSTS'),
    allowLoopbackProxy: bool('ALLOW_LOOPBACK_PROXY', true),
    allowInsecureLoopbackProxy: bool('ALLOW_INSECURE_LOOPBACK_PROXY', true),
    requestTimeoutMs: positiveInteger('PROVIDER_REQUEST_TIMEOUT_MS', 12_000),
    outputFlushIntervalMs: positiveInteger('DISCORD_OUTPUT_FLUSH_INTERVAL_MS', 1_500),
    providerGatewayHost: process.env.PROVIDER_GATEWAY_HOST?.trim() || '127.0.0.1',
    providerGatewayPort: nonNegativeInteger('PROVIDER_GATEWAY_PORT', 0),
    providerGatewayRouteTtlMs: positiveInteger('PROVIDER_GATEWAY_ROUTE_TTL_MS', 86_400_000),
    adminSetupHost: process.env.ADMIN_SETUP_HOST?.trim() || '127.0.0.1',
    adminSetupPort: nonNegativeInteger('ADMIN_SETUP_PORT', 8_787),
    adminSetupPublicUrl: process.env.ADMIN_SETUP_PUBLIC_URL?.trim() || null,
    adminSetupSessionTtlMs: positiveInteger('ADMIN_SETUP_SESSION_TTL_MS', 600_000),
    adminFrameAncestors: frameAncestors(process.env.ADMIN_FRAME_ANCESTORS),
    commandToolHost: process.env.COMMAND_TOOL_HOST?.trim() || '127.0.0.1',
    commandToolPort: nonNegativeInteger('COMMAND_TOOL_PORT', 0),
    verificationCommands: jsonStringArray('SPEC_VERIFICATION_COMMANDS', []),
    taskCommandPrefixes: jsonStringArray('TASK_COMMAND_PREFIXES', []),
    autoPush: bool('SPEC_AUTO_PUSH', false),
  };
}

export const __test = { jsonStringArray, nonNegativeInteger, frameAncestors };
