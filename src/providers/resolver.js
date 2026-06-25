import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateRoleSettings } from '../orchestration/policy-store.js';

const SAFE_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const OAUTH_PROVIDER_ENV_BLOCKLIST = new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_API_KEY',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_BASE_PATH', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'CLCODEX_GATEWAY_TOKEN', 'CLCODEX_PROVIDER_ID', 'CLCODEX_PROVIDER_REVISION',
]);

function jsonObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function cleanEnvironment(parent = process.env) {
  const env = {};
  for (const key of SAFE_ENV) if (parent[key]) env[key] = parent[key];
  return env;
}

function scrubOauthProviderEnvironment(env) {
  for (const key of OAUTH_PROVIDER_ENV_BLOCKLIST) delete env[key];
  return env;
}

function toml(value) { return JSON.stringify(String(value)); }
function codexProviderId(id) { return `clcodex_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`; }

export class ProviderResolver {
  constructor({ store, vault }) {
    this.store = store;
    this.vault = vault;
  }

  resolve({ guildId, threadId, role }) {
    const selected = this.store.resolveBinding(guildId, threadId, role);
    if (!selected) return null;
    const profile = this.store.requireProfile(selected.providerId);
    if (!profile.enabled || !this.store.hasModel(profile.id, selected.modelKey)) {
      throw new Error(`Role ${role} is bound to an unavailable provider or model`);
    }
    return {
      role,
      binding: selected,
      profile,
      model: selected.modelKey,
      credential: profile.authType === 'oauth' ? null : this.vault.resolve(profile.id, this.store.getSecret(profile.id)),
    };
  }
}

export function buildHarnessLaunch({ resolved, gatewayRoute, runtimeRoot, sessionId, cwd, parentEnv = process.env, runtimeSettings = null }) {
  const { profile, model } = resolved;
  const roleSettings = validateRoleSettings(resolved.role || 'backend', runtimeSettings || {});
  const oauthDirect = profile.authType === 'oauth';
  const baseUrl = gatewayRoute?.baseUrl || profile.baseUrl;
  const gatewayToken = gatewayRoute?.token || resolved.credential;
  if (!oauthDirect && !gatewayToken) throw new Error('Harness route token is missing');
  const stateRoot = path.join(path.resolve(runtimeRoot), 'harness-state', profile.harness, profile.id, sessionId);
  const home = path.join(stateRoot, 'home');
  const env = cleanEnvironment(parentEnv);
  for (const directory of [home, path.join(stateRoot, 'xdg-config'), path.join(stateRoot, 'xdg-cache'), path.join(stateRoot, 'xdg-data')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(stateRoot, 'xdg-config');
  env.XDG_CACHE_HOME = path.join(stateRoot, 'xdg-cache');
  env.XDG_DATA_HOME = path.join(stateRoot, 'xdg-data');
  env.CLCODEX_PROVIDER_ID = profile.id;
  env.CLCODEX_PROVIDER_REVISION = String(profile.revision);
  env.CLCODEX_SESSION_ID = sessionId;
  if (!oauthDirect) env.CLCODEX_GATEWAY_TOKEN = gatewayToken;

  if (profile.harness === 'claude') {
    const configDir = path.join(stateRoot, 'claude-config');
    const settingsFile = path.join(configDir, 'settings.json');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (oauthDirect) {
      if (parentEnv.HOME) env.HOME = parentEnv.HOME;
      if (parentEnv.USERPROFILE) env.USERPROFILE = parentEnv.USERPROFILE;
      if (parentEnv.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = parentEnv.XDG_CONFIG_HOME; else delete env.XDG_CONFIG_HOME;
      if (parentEnv.XDG_CACHE_HOME) env.XDG_CACHE_HOME = parentEnv.XDG_CACHE_HOME; else delete env.XDG_CACHE_HOME;
      if (parentEnv.XDG_DATA_HOME) env.XDG_DATA_HOME = parentEnv.XDG_DATA_HOME; else delete env.XDG_DATA_HOME;
      delete env.CLAUDE_CONFIG_DIR;
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_API_KEY_HELPER;
      delete env.CLAUDE_CODE_API_KEY;
      scrubOauthProviderEnvironment(env);
      const claude = roleSettings.claude;
      const args = ['--model', model, '--permission-mode', claude.permissionMode, '--effort', claude.effort];
      if (claude.fallbackModel) args.push('--fallback-model', claude.fallbackModel);
      if (claude.allowedTools.length) args.push('--allowedTools', ...claude.allowedTools);
      if (claude.disallowedTools.length) args.push('--disallowedTools', ...claude.disallowedTools);
      return { harness: 'claude', args, env, cwd, providerRevision: profile.revision, runtimeSettings: roleSettings, authType: profile.authType, blockedEnvKeys: [...OAUTH_PROVIDER_ENV_BLOCKLIST] };
    }
    const settings = jsonObject(settingsFile);
    const helper = path.join(configDir, 'gateway-key-helper.sh');
    writeFileSync(helper, '#!/usr/bin/env sh\nprintf %s "$CLCODEX_GATEWAY_TOKEN"\n', { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(helper, 0o700);
    settings.apiKeyHelper = helper;
    env.CLAUDE_CONFIG_DIR = configDir;
    env.ANTHROPIC_BASE_URL = baseUrl;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    const claude = roleSettings.claude;
    const args = ['--model', model, '--permission-mode', claude.permissionMode, '--effort', claude.effort];
    if (claude.fallbackModel) args.push('--fallback-model', claude.fallbackModel);
    if (claude.allowedTools.length) args.push('--allowedTools', ...claude.allowedTools);
    if (claude.disallowedTools.length) args.push('--disallowedTools', ...claude.disallowedTools);
    return { harness: 'claude', args, env, cwd, providerRevision: profile.revision, runtimeSettings: roleSettings };
  }

  const codexHome = path.join(stateRoot, 'codex-home');
  const codex = roleSettings.codex;
  if (oauthDirect) {
    if (parentEnv.HOME) env.HOME = parentEnv.HOME;
    if (parentEnv.USERPROFILE) env.USERPROFILE = parentEnv.USERPROFILE;
    if (parentEnv.CODEX_HOME) env.CODEX_HOME = parentEnv.CODEX_HOME; else if (parentEnv.HOME) env.CODEX_HOME = path.join(parentEnv.HOME, '.codex');
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    delete env.OPENAI_BASE_PATH;
    scrubOauthProviderEnvironment(env);
    return { harness: 'codex', args: ['--model', model], env, cwd, providerRevision: profile.revision, runtimeSettings: roleSettings, authType: profile.authType, blockedEnvKeys: [...OAUTH_PROVIDER_ENV_BLOCKLIST] };
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const providerKey = codexProviderId(profile.id);
  const config = [
    `model = ${toml(model)}`,
    `model_provider = ${toml(providerKey)}`,
    `approval_policy = ${toml(codex.approvalPolicy)}`,
    `sandbox_mode = ${toml(codex.sandboxMode)}`,
    `model_reasoning_effort = ${toml(codex.reasoningEffort)}`,
    `model_verbosity = ${toml(codex.verbosity)}`,
    `web_search = ${toml(codex.webSearch)}`,
    '',
    `[model_providers.${providerKey}]`,
    `name = ${toml(`${profile.name} gateway`)}`,
    `base_url = ${toml(baseUrl)}`,
    'env_key = "CLCODEX_GATEWAY_TOKEN"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
  writeFileSync(path.join(codexHome, 'config.toml'), config, { mode: 0o600 });
  env.CODEX_HOME = codexHome;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return { harness: 'codex', args: ['--model', model], env, cwd, providerRevision: profile.revision, runtimeSettings: roleSettings };
}

export const __test = { cleanEnvironment, codexProviderId, scrubOauthProviderEnvironment };
