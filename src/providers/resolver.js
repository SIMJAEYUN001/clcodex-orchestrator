import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

function jsonObject(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function cleanEnvironment(parent = process.env) {
  const env = {};
  for (const key of SAFE_ENV) if (parent[key]) env[key] = parent[key];
  return env;
}

function toml(value) {
  return JSON.stringify(String(value));
}

function codexProviderId(id) {
  return `clcodex_${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`;
}

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
      credential: this.vault.resolve(profile.id, this.store.getSecret(profile.id)),
    };
  }
}

export function buildHarnessLaunch({ resolved, runtimeRoot, sessionId, cwd, parentEnv = process.env }) {
  const { profile, model, credential } = resolved;
  const stateRoot = path.join(path.resolve(runtimeRoot), 'harness-state', profile.harness, profile.id);
  const home = path.join(stateRoot, 'home');
  const env = cleanEnvironment(parentEnv);
  for (const directory of [
    home,
    path.join(stateRoot, 'xdg-config'),
    path.join(stateRoot, 'xdg-cache'),
    path.join(stateRoot, 'xdg-data'),
  ]) mkdirSync(directory, { recursive: true, mode: 0o700 });

  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(stateRoot, 'xdg-config');
  env.XDG_CACHE_HOME = path.join(stateRoot, 'xdg-cache');
  env.XDG_DATA_HOME = path.join(stateRoot, 'xdg-data');
  env.CLCODEX_PROVIDER_ID = profile.id;
  env.CLCODEX_PROVIDER_REVISION = String(profile.revision);
  env.CLCODEX_SESSION_ID = sessionId;

  if (profile.harness === 'claude') {
    const configDir = path.join(stateRoot, 'claude-config');
    const settingsFile = path.join(configDir, 'settings.json');
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const settings = jsonObject(settingsFile);
    env.CLAUDE_CONFIG_DIR = configDir;
    env.ANTHROPIC_BASE_URL = profile.baseUrl;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLCODEX_PROFILE_API_KEY;

    if (profile.authStyle === 'bearer') {
      delete settings.apiKeyHelper;
      env.ANTHROPIC_AUTH_TOKEN = credential;
    } else {
      const helper = path.join(configDir, 'provider-api-key-helper.sh');
      writeFileSync(helper, '#!/usr/bin/env sh\nprintf %s "$CLCODEX_PROFILE_API_KEY"\n', { mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(helper, 0o700);
      settings.apiKeyHelper = helper;
      env.CLCODEX_PROFILE_API_KEY = credential;
    }
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    return { harness: 'claude', args: ['--model', model], env, cwd, providerRevision: profile.revision };
  }

  const codexHome = path.join(stateRoot, 'codex-home');
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const providerKey = codexProviderId(profile.id);
  const authLine = profile.authStyle === 'x-api-key'
    ? 'env_http_headers = { "x-api-key" = "CLCODEX_PROFILE_API_KEY" }'
    : 'env_key = "CLCODEX_PROFILE_API_KEY"';
  const config = [
    `model = ${toml(model)}`,
    `model_provider = ${toml(providerKey)}`,
    '',
    `[model_providers.${providerKey}]`,
    `name = ${toml(profile.name)}`,
    `base_url = ${toml(profile.baseUrl)}`,
    authLine,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n');
  writeFileSync(path.join(codexHome, 'config.toml'), config, { mode: 0o600 });
  env.CODEX_HOME = codexHome;
  env.CLCODEX_PROFILE_API_KEY = credential;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return { harness: 'codex', args: ['--model', model], env, cwd, providerRevision: profile.revision };
}

export const __test = { cleanEnvironment, codexProviderId };
