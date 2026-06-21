import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SecretVault } from '../src/providers/vault.js';

function fixture() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'clcodex-vault-'));
  return { runtimeRoot, vault: new SecretVault({ runtimeRoot }) };
}

test('direct API key records are authenticated-encrypted and provider-bound', () => {
  const { vault } = fixture();
  const record = vault.encrypted('provider-a', 'secret-value');
  assert.equal(JSON.stringify(record).includes('secret-value'), false);
  assert.equal(vault.resolve('provider-a', record), 'secret-value');
  assert.throws(() => vault.resolve('provider-b', record));
});

test('environment and file references do not place secret contents in SQLite records', () => {
  const { runtimeRoot, vault } = fixture();
  process.env.TEST_PROVIDER_SECRET = 'env-value';
  assert.equal(vault.resolve('provider', vault.envReference('TEST_PROVIDER_SECRET')), 'env-value');
  const root = path.join(runtimeRoot, 'external-secrets');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'proxy.key'), 'file-value\n', { mode: 0o600 });
  const record = vault.fileReference('proxy.key');
  assert.equal(JSON.stringify(record).includes('file-value'), false);
  assert.equal(vault.resolve('provider', record), 'file-value');
  assert.throws(() => vault.fileReference('../escape.key'));
});
