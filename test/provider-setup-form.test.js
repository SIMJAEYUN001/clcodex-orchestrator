import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/admin/setup-server.js';

test('provider setup form uses an authentication dropdown and a separate password credential field', () => {
  const html = __test.HTML;
  assert.match(html, /<select id="auth_type"/);
  assert.match(html, /<option value="bearer">Bearer Token<\/option>/);
  assert.match(html, /<option value="api-key">API Key<\/option>/);
  assert.match(html, /<option value="basic">Basic Auth<\/option>/);
  assert.match(html, /id="credential"[^>]+type="password"/);
  assert.match(html, /id="auth_header"/);
  assert.match(html, /id="auth_username"/);
});

test('initial model is a single-line text input with a concrete example', () => {
  const html = __test.HTML;
  assert.match(html, /id="initial_model"[^>]+type="text"[^>]+placeholder="예: gpt-4o"/);
  assert.equal(/<textarea[^>]+id="initial_model"/.test(html), false);
});

test('client script dynamically toggles API key and Basic Auth fields', () => {
  assert.match(__test.APP, /api-key-fields/);
  assert.match(__test.APP, /basic-fields/);
  assert.match(__test.APP, /auth\.addEventListener\('change',authUi\)/);
});
