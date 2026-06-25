import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  base64UrlDecode,
  base64UrlEncode,
  decryptEnvelope,
  deriveSessionKey,
  encryptEnvelope,
  exportPublicJwk,
  generateEcdhKeyPair,
  handshakeTranscript,
  signTranscript,
  verifyTranscript,
} from '../shared/admin-e2ee.js';

test('Activity and device derive the same AES-GCM key and reject tampered ciphertext', async () => {
  const activity = await generateEcdhKeyPair();
  const device = await generateEcdhKeyPair();
  const clientPublicKey = await exportPublicJwk(activity.publicKey);
  const devicePublicKey = await exportPublicJwk(device.publicKey);
  const transcript = handshakeTranscript({
    sessionId: 'session-1', guildId: 'guild', channelId: 'thread', userId: 'admin',
    clientPublicKey, devicePublicKey, expiresAt: 123456789,
  });
  const activityKey = await deriveSessionKey({ privateKey: activity.privateKey, peerPublicJwk: devicePublicKey, transcript });
  const deviceKey = await deriveSessionKey({ privateKey: device.privateKey, peerPublicJwk: clientPublicKey, transcript });
  const encrypted = await encryptEnvelope({
    key: activityKey, sessionId: 'session-1', direction: 'activity-to-device', sequence: 1,
    value: { method: 'providers.create', params: { credential: 'must-not-be-visible-at-relay' } },
  });
  assert.doesNotMatch(JSON.stringify(encrypted), /must-not-be-visible-at-relay/);
  const decrypted = await decryptEnvelope({
    key: deviceKey, sessionId: 'session-1', direction: 'activity-to-device', ...encrypted,
  });
  assert.equal(decrypted.params.credential, 'must-not-be-visible-at-relay');
  const tamperedBytes = base64UrlDecode(encrypted.ciphertext);
  tamperedBytes[0] ^= 0x01;
  const damaged = { ...encrypted, ciphertext: base64UrlEncode(tamperedBytes) };
  await assert.rejects(() => decryptEnvelope({
    key: deviceKey, sessionId: 'session-1', direction: 'activity-to-device', ...damaged,
  }));
});

test('Activity verifies the pinned device signing key over the complete handshake transcript', async () => {
  const signer = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await webcrypto.subtle.exportKey('jwk', signer.publicKey);
  const activity = await generateEcdhKeyPair();
  const device = await generateEcdhKeyPair();
  const transcript = handshakeTranscript({
    sessionId: 'session-2', guildId: 'guild', channelId: 'thread', userId: 'admin',
    clientPublicKey: await exportPublicJwk(activity.publicKey),
    devicePublicKey: await exportPublicJwk(device.publicKey),
    expiresAt: 999,
  });
  const signature = await signTranscript(signer.privateKey, transcript);
  assert.equal(await verifyTranscript(publicJwk, transcript, signature), true);
  assert.equal(await verifyTranscript(publicJwk, new TextEncoder().encode('tampered'), signature), false);
});
