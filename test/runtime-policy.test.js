import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildHarnessLaunch } from '../src/providers/resolver.js';

function resolved(harness, role = 'backend') {
  return {
    role,
    profile: {
      id: `provider-${harness}`,
      name: `${harness} proxy`,
      harness,
      baseUrl: 'http://127.0.0.1:8045',
      revision: 7,
    },
    model: harness === 'claude' ? 'claude-model' : 'codex-model',
    credential: 'session-token',
  };
}

test('Codex launch writes selected approval, sandbox, effort and verbosity to isolated config', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-runtime-'));
  const launch = buildHarnessLaunch({
    resolved: resolved('codex'), runtimeRoot: root, sessionId: 's1', cwd: root,
    runtimeSettings: { codex: {
      approvalPolicy: 'never', sandboxMode: 'read-only', reasoningEffort: 'xhigh', verbosity: 'high', webSearch: 'cached',
    } },
  });
  const config = readFileSync(path.join(launch.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.match(config, /approval_policy = "never"/);
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /model_reasoning_effort = "xhigh"/);
  assert.match(config, /model_verbosity = "high"/);
  assert.match(config, /web_search = "cached"/);
  assert.equal(config.includes('session-token'), false);
});

test('Claude launch translates runtime policy into official CLI arguments', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-runtime-'));
  const launch = buildHarnessLaunch({
    resolved: resolved('claude', 'frontend'), runtimeRoot: root, sessionId: 's2', cwd: root,
    runtimeSettings: { claude: {
      permissionMode: 'acceptEdits', effort: 'xhigh', allowedTools: ['Read', 'Grep'], disallowedTools: ['Write'], fallbackModel: 'fallback-model',
    } },
  });
  assert.deepEqual(launch.args.slice(0, 6), ['--model', 'claude-model', '--permission-mode', 'acceptEdits', '--effort', 'xhigh']);
  assert.equal(launch.args.includes('--allowedTools'), true);
  assert.equal(launch.args.includes('--disallowedTools'), true);
  assert.equal(launch.args.includes('--fallback-model'), true);
  assert.equal(readFileSync(path.join(launch.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8').includes('session-token'), false);
});
