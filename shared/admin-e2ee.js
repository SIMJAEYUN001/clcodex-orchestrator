const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cryptoApi() {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new Error('WebCrypto is required for the admin relay');
  }
  return value;
}

export function utf8(value) {
  return encoder.encode(String(value));
}

export function decodeUtf8(value) {
  return decoder.decode(value);
}

export function base64UrlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function canonicalPublicJwk(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
    throw new Error('Expected a P-256 public JWK');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true };
}

export function handshakeTranscript({
  sessionId,
  guildId,
  userId,
  channelId = '',
  clientPublicKey,
  devicePublicKey,
  expiresAt,
}) {
  const client = canonicalPublicJwk(clientPublicKey);
  const device = canonicalPublicJwk(devicePublicKey);
  return utf8([
    'clcodex-admin-relay-v1',
    sessionId,
    guildId,
    userId,
    channelId || '',
    client.x,
    client.y,
    device.x,
    device.y,
    String(expiresAt),
  ].join('\n'));
}

export async function sha256(value) {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return new Uint8Array(await cryptoApi().subtle.digest('SHA-256', bytes));
}

export async function publicKeyFingerprint(jwk) {
  const key = canonicalPublicJwk(jwk);
  return base64UrlEncode(await sha256(JSON.stringify(key)));
}

export async function generateEcdhKeyPair() {
  return cryptoApi().subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
}

export async function exportPublicJwk(key) {
  return canonicalPublicJwk(await cryptoApi().subtle.exportKey('jwk', key));
}

export async function deriveSessionKey({ privateKey, peerPublicJwk, transcript }) {
  const peer = await cryptoApi().subtle.importKey(
    'jwk',
    canonicalPublicJwk(peerPublicJwk),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const bits = await cryptoApi().subtle.deriveBits(
    { name: 'ECDH', public: peer },
    privateKey,
    256,
  );
  const material = await cryptoApi().subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = await sha256(transcript);
  return cryptoApi().subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: utf8('clcodex-admin-rpc-aes-gcm-v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptEnvelope({ key, sessionId, direction, sequence, value }) {
  const iv = cryptoApi().getRandomValues(new Uint8Array(12));
  const additionalData = utf8(`${sessionId}:${direction}:${sequence}`);
  const plaintext = utf8(JSON.stringify(value));
  const ciphertext = await cryptoApi().subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return {
    sequence,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
  };
}

export async function decryptEnvelope({ key, sessionId, direction, sequence, iv, ciphertext }) {
  const additionalData = utf8(`${sessionId}:${direction}:${sequence}`);
  const plaintext = await cryptoApi().subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlDecode(iv),
      additionalData,
      tagLength: 128,
    },
    key,
    base64UrlDecode(ciphertext),
  );
  return JSON.parse(decodeUtf8(new Uint8Array(plaintext)));
}

export async function signTranscript(privateKey, transcript) {
  const signature = await cryptoApi().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    transcript,
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyTranscript(publicJwk, transcript, signature) {
  const key = await cryptoApi().subtle.importKey(
    'jwk',
    canonicalPublicJwk(publicJwk),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return cryptoApi().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64UrlDecode(signature),
    transcript,
  );
}
