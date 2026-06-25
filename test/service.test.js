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
  const expectedCommand = __test.harnessExecutable('codex', '/tmp/clcodex-harness');
  const result = await __test.discoverCliOauthModels('codex', {
    harnessRoot: '/tmp/clcodex-harness',
    parentEnv: {
      PATH: '/usr/bin', HOME: '/home/user', CODEX_HOME: '/home/user/.codex',
      OPENAI_API_KEY: 'must-not-leak', OPENAI_BASE_URL: 'https://proxy.invalid',
      CLCODEX_GATEWAY_TOKEN: 'must-not-leak',
    },
    execFileImpl: async (command, args, options) => {
      assert.equal(command, expectedCommand);
      assert.deepEqual(args, ['debug', 'models']);
      assert.equal(options.env.PATH, '/usr/bin');
      assert.equal(options.env.HOME, '/home/user');
      assert.equal(options.env.CODEX_HOME, '/home/user/.codex');
      assert.equal(options.env.OPENAI_API_KEY, undefined);
      assert.equal(options.env.OPENAI_BASE_URL, undefined);
      assert.equal(options.env.CLCODEX_GATEWAY_TOKEN, undefined);
      assert.equal(options.shell, process.platform === 'win32');
      return { stdout: JSON.stringify({ models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true },
        { slug: 'hide-model', visibility: 'hide' },
        { slug: 'none-model', visibility: 'none' },
        { slug: 'missing-visibility-model' },
      ] }) };
    },
  });
  assert.deepEqual(result.models.map((item) => item.modelKey), ['gpt-5.5']);
  assert.equal(result.source, 'codex-cli');
});

test('Codex debug catalog exposes only models with list visibility', () => {
  const models = __test.extractCodexDebugModels({ models: [
    { slug: 'visible', visibility: 'list' },
    { slug: 'hidden', visibility: 'hide' },
    { slug: 'none', visibility: 'none' },
    { slug: 'legacy-hidden', visibility: 'hidden' },
  ] });
  assert.deepEqual(models.map((item) => item.modelKey), ['visible']);
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
