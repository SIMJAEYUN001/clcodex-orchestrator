import assert from 'node:assert/strict';
import test from 'node:test';
import { cliOauthEnvironment, harnessExecutable, sanitizeCliOutput, __test } from '../src/providers/cli-oauth.js';

test('cli OAuth environment preserves login homes while blocking provider credentials', () => {
  const env = cliOauthEnvironment({
    PATH: '/bin', HOME: '/home/user', CODEX_HOME: '/home/user/.codex', XDG_CONFIG_HOME: '/home/user/.config',
    OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_API_KEY_HELPER: '/tmp/helper', CLCODEX_GATEWAY_TOKEN: 'secret',
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.CODEX_HOME, '/home/user/.codex');
  assert.equal(env.XDG_CONFIG_HOME, '/home/user/.config');
  for (const key of __test.BLOCKED_ENV_KEYS) assert.equal(env[key], undefined, `${key} should be blocked`);
});

test('CLI OAuth helpers use official harness login commands', () => {
  assert.deepEqual(__test.loginArgs('codex'), ['login', '--device-auth']);
  assert.deepEqual(__test.loginArgs('claude'), ['auth', 'login']);
  assert.deepEqual(__test.statusArgs('codex'), ['login', 'status']);
  assert.deepEqual(__test.statusArgs('claude'), ['auth', 'status']);
  assert.equal(harnessExecutable('codex', '/tmp/harness').endsWith(process.platform === 'win32' ? 'bin\\codex.cmd' : 'bin/codex'), true);
});

test('CLI OAuth output redacts credential-shaped values', () => {
  const output = sanitizeCliOutput('token=aaaabbbbccccddddeeeeffff.gggghhhhiiiijjjjkkkkllll.mmmmnnnnooooppppqqqqrrrr\napi key: sk-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(output.includes('sk-abcdefghijklmnopqrstuvwxyz0123456789'), false);
  assert.match(output, /\[redacted\]/);
});
