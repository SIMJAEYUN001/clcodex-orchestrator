import { createHash, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalPublicJwk, signTranscript } from '../../shared/admin-e2ee.js';


export class RelayDeviceIdentity {
  constructor({ privateKeyPath }) {
    this.privateKeyPath = path.resolve(privateKeyPath);
    this.privateKey = null;
    this.publicKey = null;
    this.publicJwk = null;
    this.fingerprint = null;
  }

  async initialize() {
    if (this.privateKey) return this;
    let privateJwk;
    if (existsSync(this.privateKeyPath)) {
      if (process.platform !== 'win32') {
        const { statSync } = await import('node:fs');
        if ((statSync(this.privateKeyPath).mode & 0o077) !== 0) {
          throw new Error(`Admin relay device key permissions are too broad: ${this.privateKeyPath}`);
        }
      }
      privateJwk = JSON.parse(readFileSync(this.privateKeyPath, 'utf8'));
    } else {
      mkdirSync(path.dirname(this.privateKeyPath), { recursive: true, mode: 0o700 });
      const generated = await webcrypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      privateJwk = await webcrypto.subtle.exportKey('jwk', generated.privateKey);
      writeFileSync(this.privateKeyPath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600, flag: 'wx' });
      if (process.platform !== 'win32') chmodSync(this.privateKeyPath, 0o600);
    }
    this.privateKey = await webcrypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const publicJwk = canonicalPublicJwk(privateJwk);
    this.publicJwk = publicJwk;
    this.publicKey = await webcrypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
    this.fingerprint = createHash('sha256').update(JSON.stringify(publicJwk)).digest('base64url');
    return this;
  }

  async sign(transcript) {
    if (!this.privateKey) await this.initialize();
    return signTranscript(this.privateKey, transcript);
  }

  metadata() {
    if (!this.publicJwk) throw new Error('Relay device identity is not initialized');
    return {
      publicKey: { ...this.publicJwk },
      fingerprint: this.fingerprint,
    };
  }
}
