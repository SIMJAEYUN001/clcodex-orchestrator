import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../src/providers/service.js';

test('model normalization removes duplicates and rejects shell-like model IDs', () => {
  assert.deepEqual(__test.normalizeModels('glm-5.2\nmodel-b,glm-5.2').map((item) => item.modelKey), ['glm-5.2', 'model-b']);
  assert.throws(() => __test.modelId('model;rm'));
});

test('Claude and Codex authentication styles are validated by harness', () => {
  assert.equal(__test.authStyle('', 'claude'), 'api-key');
  assert.equal(__test.authStyle('', 'codex'), 'bearer');
  assert.equal(__test.authStyle('api-key-helper', 'codex'), 'api-key');
  assert.equal(__test.authType('basic'), 'basic');
  assert.equal(__test.authType('oauth'), 'oauth');
  assert.throws(() => __test.authType('digest'));
  assert.throws(() => __test.authHeader('Authorization'));
});

test('OpenAI-compatible model list shape is accepted', () => {
  assert.deepEqual(__test.extractModels({ data: [{ id: 'model-a' }, { id: 'model-b' }] }).map((item) => item.modelKey), ['model-a', 'model-b']);
});


test('full model endpoint URI is split into runtime base URL and model-list path', () => {
  const policy = { parseBaseUrl(raw) { return new URL(String(raw)); } };
  assert.deepEqual(
    __test.splitEndpointUrl('https://proxy.example.com/v1/models', policy),
    { baseUrl: 'https://proxy.example.com', modelsPath: '/v1/models', endpointUrl: 'https://proxy.example.com/v1/models' },
  );
  assert.deepEqual(
    __test.splitEndpointUrl('https://proxy.example.com/openai/v1/models', policy),
    { baseUrl: 'https://proxy.example.com/openai', modelsPath: '/v1/models', endpointUrl: 'https://proxy.example.com/openai/v1/models' },
  );
});
