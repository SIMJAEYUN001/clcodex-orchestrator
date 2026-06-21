import assert from 'node:assert/strict';
import test from 'node:test';
import { ProxyNetworkPolicy, __test } from '../src/providers/network-policy.js';

test('network policy classifies sensitive address ranges', () => {
  assert.equal(__test.classify('127.0.0.1'), 'loopback');
  assert.equal(__test.classify('10.0.0.1'), 'private');
  assert.equal(__test.classify('169.254.169.254'), 'metadata');
  assert.equal(__test.classify('8.8.8.8'), 'public');
});

test('loopback HTTP is allowed only under the explicit loopback policy', async () => {
  const allowed = new ProxyNetworkPolicy({ allowLoopback: true, allowInsecureLoopback: true });
  assert.equal((await allowed.assertAllowed('http://127.0.0.1:8045')).hostname, '127.0.0.1');
  const denied = new ProxyNetworkPolicy({ allowLoopback: false, allowInsecureLoopback: false });
  await assert.rejects(() => denied.assertAllowed('http://127.0.0.1:8045'));
});

test('base URL validation blocks embedded credentials and absolute model paths', () => {
  const policy = new ProxyNetworkPolicy();
  assert.throws(() => policy.parseBaseUrl('https://user:pass@example.com'));
  assert.throws(() => policy.modelsPath('https://evil.example/models'));
});
