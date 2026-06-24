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
