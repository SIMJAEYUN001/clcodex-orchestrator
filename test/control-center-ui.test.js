import assert from 'node:assert/strict';
import test from 'node:test';
import { APP, HTML } from '../src/admin/control-center-assets.js';

test('control center exposes provider, Codex, Claude Code and orchestration views', () => {
  assert.match(HTML, /data-tab="providers"/);
  assert.match(HTML, /data-tab="codex"/);
  assert.match(HTML, /data-tab="claude"/);
  assert.match(HTML, /data-tab="orchestration"/);
  assert.match(HTML, /전체 오케스트레이션 선택/);
});

test('provider form keeps authentication and credential separate and uses one initial model input', () => {
  assert.match(HTML, /<select id="auth_type"/);
  assert.match(HTML, /<option value="bearer">Bearer Token<\/option>/);
  assert.match(HTML, /<option value="api-key">API Key<\/option>/);
  assert.match(HTML, /<option value="basic">Basic Auth<\/option>/);
  assert.match(HTML, /<option value="oauth">CLI OAuth 로그인<\/option>/);
  assert.match(HTML, /id="credential"[^>]+type="password"/);
  assert.match(HTML, /id="endpoint_url"[^>]+type="url"/);
  assert.equal(/id="models_path"/.test(HTML), false);
  assert.equal(/id="base_url"/.test(HTML), false);
  assert.match(HTML, /id="initial_model"[^>]+type="text"[^>]+placeholder="예: gpt-4o"/);
  assert.equal(/textarea[^>]+id="initial_model"/.test(HTML), false);
});

test('client implements model discovery to role binding and searchable role model selection', () => {
  assert.match(APP, /\/api\/providers\/discover/);
  assert.match(APP, /\/api\/providers\/create/);
  assert.match(APP, /data-discovery-role/);
  assert.match(APP, /data-field=\"model-search\"/);
  assert.match(APP, /\/api\/bindings\/save/);
});

test('control center offers Open Codex-style runtime selectors', () => {
  for (const value of ['untrusted', 'on-request', 'never', 'read-only', 'workspace-write', 'danger-full-access', 'minimal', 'xhigh']) {
    assert.match(APP, new RegExp(value));
  }
  for (const value of ['acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'fallbackModel']) {
    assert.match(APP, new RegExp(value));
  }
});
