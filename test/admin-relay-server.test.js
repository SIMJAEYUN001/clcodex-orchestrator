import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { generateEcdhKeyPair, exportPublicJwk } from '../shared/admin-e2ee.js';
import { ADMIN_PROTOCOL_VERSION } from '../shared/admin-protocol.js';
import { AdminRelayServer } from '../relay/server.js';

function open(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function next(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString('utf8'))));
    socket.once('error', reject);
  });
}

test('relay authenticates the outbound device and forwards only opaque Activity frames', async () => {
  const relay = new AdminRelayServer({
    host: '127.0.0.1', port: 0,
    activityOrigins: ['https://activity.example'],
    devices: new Map([['installation', 'x'.repeat(48)]]),
    discordClientId: 'client', discordClientSecret: 'secret', oauthRedirectUri: null,
    oauthSessionTtlMs: 120_000, activitySessionTtlMs: 300_000,
    maxPayloadBytes: 1_000_000, maxMessagesPerMinute: 180,
  }, { logger: { warn() {}, error() {} } });
  await relay.start();
  const address = relay.address();
  const base = `ws://127.0.0.1:${address.port}`;
  const device = await open(`${base}/v1/device?installation_id=installation`, {
    headers: { authorization: `Bearer ${'x'.repeat(48)}` },
  });
  device.send(JSON.stringify({
    version: ADMIN_PROTOCOL_VERSION, type: 'device.hello', installationId: 'installation', device: {},
  }));
  assert.equal((await next(device)).type, 'relay.ready');

  const oauth = relay.createOauthSession({ id: 'admin', username: 'admin' });
  const activity = await open(`${base}/v1/activity?installation_id=installation&session=${oauth.token}`, {
    origin: 'https://activity.example',
  });
  const pair = await generateEcdhKeyPair();
  activity.send(JSON.stringify({
    version: ADMIN_PROTOCOL_VERSION, type: 'activity.hello', guildId: 'guild', channelId: 'thread', userId: 'admin',
    clientPublicKey: await exportPublicJwk(pair.publicKey),
  }));
  const opened = await next(device);
  assert.equal(opened.type, 'activity.open');
  assert.equal(opened.userId, 'admin');
  assert.equal(opened.channelId, 'thread');

  device.send(JSON.stringify({
    version: ADMIN_PROTOCOL_VERSION, type: 'activity.accept', sessionId: opened.sessionId,
    guildId: 'guild', userId: 'admin', expiresAt: Date.now() + 60_000,
    devicePublicKey: opened.clientPublicKey, deviceSigningPublicKey: opened.clientPublicKey,
    deviceFingerprint: 'fingerprint', signature: 'signature',
  }));
  assert.equal((await next(activity)).type, 'activity.accept');

  const opaque = {
    version: ADMIN_PROTOCOL_VERSION, type: 'rpc.request', sessionId: opened.sessionId,
    sequence: 1, iv: 'opaque-iv', ciphertext: 'opaque-ciphertext',
  };
  activity.send(JSON.stringify(opaque));
  assert.deepEqual(await next(device), opaque);
  device.close();
  activity.close();
  await relay.close();
});
