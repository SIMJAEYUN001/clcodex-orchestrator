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

test('Codex OAuth model discovery parses codex debug catalog from the configured harness install', async () => {
  const result = await __test.discoverCliOauthModels('codex', {
    harnessRoot: '/tmp/clcodex-harness',
    execFileImpl: async (command, args) => {
      assert.equal(command, '/tmp/clcodex-harness/bin/codex');
      assert.deepEqual(args, ['debug', 'models']);
      return { stdout: JSON.stringify({ models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
        { slug: 'hidden-model', visibility: 'hidden' },
      ] }) };
    },
  });
  assert.deepEqual(result.models.map((item) => item.modelKey), ['gpt-5.5']);
  assert.equal(result.source, 'codex-cli');
});

test('Claude OAuth model discovery returns Claude Code aliases without credentials', async () => {
  const result = await __test.discoverCliOauthModels('claude');
  assert.deepEqual(result.models.map((item) => item.modelKey), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(result.source, 'claude-code-cli');
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
