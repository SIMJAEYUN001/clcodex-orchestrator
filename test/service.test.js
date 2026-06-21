import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/providers/service.js';

test('model normalization removes duplicates and rejects shell-like model IDs', () => {
  assert.deepEqual(__test.normalizeModels('glm-5.2\nmodel-b,glm-5.2').map((item) => item.modelKey), ['glm-5.2', 'model-b']);
  assert.throws(() => __test.modelId('model;rm'));
});

test('Claude and Codex authentication styles are validated by harness', () => {
  assert.equal(__test.authStyle('', 'claude'), 'api-key-helper');
  assert.equal(__test.authStyle('', 'codex'), 'bearer');
  assert.throws(() => __test.authStyle('api-key-helper', 'codex'));
});

test('OpenAI-compatible model list shape is accepted', () => {
  assert.deepEqual(__test.extractModels({ data: [{ id: 'model-a' }, { id: 'model-b' }] }).map((item) => item.modelKey), ['model-a', 'model-b']);
});
