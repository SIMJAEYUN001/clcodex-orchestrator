import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

function decodeKey(value) {
  for (const encoding of ['base64', 'base64url', 'hex']) {
    try {
      const key = Buffer.from(String(value).trim(), encoding);
      if (key.length === 32) return key;
    } catch {
      // Try the next encoding.
    }
  }
  throw new Error('PROVIDER_VAULT_MASTER_KEY must decode to exactly 32 bytes');
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hint(value) {
  const secret = String(value || '');
  return secret ? `••••${secret.slice(-4)}` : '설정되지 않음';
}

export class SecretVault {
  constructor({ runtimeRoot, secretFileRoot, masterKey }) {
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.secretFileRoot = path.resolve(secretFileRoot || path.join(this.runtimeRoot, 'external-secrets'));
    mkdirSync(this.secretFileRoot, { recursive: true, mode: 0o700 });
    this.key = masterKey ? decodeKey(masterKey) : this.loadOrCreateKey();
  }

  loadOrCreateKey() {
    if (process.env.PROVIDER_VAULT_MASTER_KEY) return decodeKey(process.env.PROVIDER_VAULT_MASTER_KEY);
    const file = path.join(this.runtimeRoot, 'secrets', 'provider-master-key');
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(file, 0o600);
    }
    const key = readFileSync(file);
    if (key.length !== 32) throw new Error(`Invalid provider vault key: ${file}`);
    if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
      throw new Error(`Provider vault key permissions are too broad: ${file}`);
    }
    return key;
  }

  encrypted(providerId, plaintext) {
    const value = String(plaintext || '').trim();
    if (!value) throw new Error('API key cannot be empty');
    if (value.length > 16_384) throw new Error('API key is unexpectedly large');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`clcodex:${providerId}:v1`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return {
      mode: 'encrypted',
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      reference: null,
      hint: hint(value),
    };
  }

  envReference(name) {
    const value = String(name || '').trim();
    if (!ENV_NAME.test(value)) throw new Error('Environment reference must be an uppercase variable name');
    return { mode: 'env', ciphertext: null, nonce: null, tag: null, reference: value, hint: `ENV:${value}` };
  }

  fileReference(relativePath) {
    const value = String(relativePath || '').trim();
    if (!value) throw new Error('Secret file path cannot be empty');
    const candidate = path.resolve(this.secretFileRoot, value);
    if (!inside(candidate, this.secretFileRoot)) throw new Error(`Secret file must stay under ${this.secretFileRoot}`);
    return {
      mode: 'file', ciphertext: null, nonce: null, tag: null,
      reference: path.relative(this.secretFileRoot, candidate), hint: `FILE:${path.basename(candidate)}`,
    };
  }

  resolve(providerId, record) {
    if (!record) throw new Error('Provider has no credential configured');
    if (record.mode === 'encrypted') {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.nonce, 'base64'));
      decipher.setAAD(Buffer.from(`clcodex:${providerId}:v1`));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    }
    if (record.mode === 'env') {
      if (!ENV_NAME.test(record.reference || '')) throw new Error('Stored environment reference is invalid');
      const value = process.env[record.reference];
      if (!value) throw new Error(`Secret environment variable is not set: ${record.reference}`);
      return value;
    }
    if (record.mode === 'file') {
      const candidate = path.resolve(this.secretFileRoot, record.reference || '');
      if (!inside(candidate, this.secretFileRoot) || !existsSync(candidate)) throw new Error('Secret file is unavailable');
      const root = realpathSync(this.secretFileRoot);
      const file = realpathSync(candidate);
      if (!inside(file, root)) throw new Error('Secret file symlink escaped the configured root');
      const value = readFileSync(file, 'utf8').trim();
      if (!value) throw new Error('Secret file is empty');
      return value;
    }
    throw new Error(`Unsupported secret mode: ${record.mode}`);
  }
}

export const __test = { decodeKey, inside, hint };
