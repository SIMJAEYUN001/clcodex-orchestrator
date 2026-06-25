import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHarnessLaunch } from '../src/providers/resolver.js';

function selected(harness, authStyle) {
  return {
    profile: {
      id: `provider-${harness}`,
      name: `${harness} proxy`,
      harness,
      baseUrl: 'http://127.0.0.1:8045',
      authStyle,
      authType: authStyle,
      revision: 3,
    },
    model: harness === 'claude' ? 'glm-5.2' : 'gpt-model',
    credential: 'do-not-persist',
  };
}

test('Claude apiKeyHelper profile does not persist the API key or inherit global auth', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-launch-'));
  const launch = buildHarnessLaunch({
    resolved: selected('claude', 'api-key-helper'), runtimeRoot: root, sessionId: 's1', cwd: root,
    parentEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'global' },
  });
  const settings = readFileSync(path.join(launch.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8');
  assert.equal(settings.includes('apiKeyHelper'), true);
  assert.equal(settings.includes('do-not-persist'), false);
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
});

test('Codex custom provider config references a dedicated environment variable only', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-launch-'));
  const launch = buildHarnessLaunch({
    resolved: selected('codex', 'bearer'), runtimeRoot: root, sessionId: 's2', cwd: root,
    parentEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'global' },
  });
  const config = readFileSync(path.join(launch.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(config, /model_provider = "clcodex_provider_codex"/);
  assert.match(config, /env_key = "CLCODEX_GATEWAY_TOKEN"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.equal(config.includes('do-not-persist'), false);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
});


test('OAuth profiles launch the CLI directly without gateway token or proxy credentials', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-launch-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'clcodex-oauth-home-'));
  const launch = buildHarnessLaunch({
    resolved: { ...selected('codex', 'oauth'), credential: null },
    runtimeRoot: root,
    sessionId: 's3',
    cwd: root,
    parentEnv: {
      PATH: '/usr/bin', HOME: home, OPENAI_API_KEY: 'global', OPENAI_BASE_URL: 'https://proxy.invalid',
      CLCODEX_GATEWAY_TOKEN: 'gateway-token', CLCODEX_PROVIDER_ID: 'provider',
    },
  });
  assert.equal(launch.env.HOME, home);
  assert.equal(launch.env.CODEX_HOME, path.join(home, '.codex'));
  assert.equal(launch.env.CLCODEX_GATEWAY_TOKEN, undefined);
  assert.equal(launch.env.CLCODEX_PROVIDER_ID, undefined);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.OPENAI_BASE_URL, undefined);
  assert.equal(launch.blockedEnvKeys.includes('OPENAI_API_KEY'), true);
  assert.deepEqual(launch.args, ['--model', 'gpt-model']);
});

test('Claude OAuth profiles preserve subscription login homes but strip API/proxy overrides', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-launch-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'clcodex-claude-oauth-home-'));
  const launch = buildHarnessLaunch({
    resolved: { ...selected('claude', 'oauth'), credential: null },
    runtimeRoot: root,
    sessionId: 's4',
    cwd: root,
    parentEnv: {
      PATH: '/usr/bin', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
      ANTHROPIC_BASE_URL: 'https://openclawroot.com',
      ANTHROPIC_API_KEY: 'api-key',
      ANTHROPIC_AUTH_TOKEN: 'auth-token',
      CLAUDE_CODE_API_KEY_HELPER: '/tmp/helper',
      CLCODEX_GATEWAY_TOKEN: 'gateway-token',
    },
  });
  assert.equal(launch.env.HOME, home);
  assert.equal(launch.env.XDG_CONFIG_HOME, path.join(home, '.config'));
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(launch.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(launch.env.CLAUDE_CODE_API_KEY_HELPER, undefined);
  assert.equal(launch.env.CLCODEX_GATEWAY_TOKEN, undefined);
  assert.equal(launch.blockedEnvKeys.includes('ANTHROPIC_BASE_URL'), true);
  assert.deepEqual(launch.args.slice(0, 2), ['--model', 'glm-5.2']);
});

