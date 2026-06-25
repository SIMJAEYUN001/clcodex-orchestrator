import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {
  decryptEnvelope,
  deriveSessionKey,
  encryptEnvelope,
  exportPublicJwk,
  generateEcdhKeyPair,
  handshakeTranscript,
  verifyTranscript,
} from '../shared/admin-e2ee.js';
import { ADMIN_PROTOCOL_VERSION } from '../shared/admin-protocol.js';
import { AdminRelayServer } from '../relay/server.js';
import { RelayDeviceIdentity } from '../src/admin/device-identity.js';
import { AdminGrantStore } from '../src/admin/grant-store.js';
import { AdminRelayClient } from '../src/admin/relay-client.js';

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

test('outbound device performs authenticated E2EE RPC after local grant and Administrator verification', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'clcodex-relay-'));
  const deviceToken = 'd'.repeat(48);
  const relay = new AdminRelayServer({
    host: '127.0.0.1', port: 0, activityOrigins: ['https://activity.example'],
    devices: new Map([['installation', deviceToken]]),
    discordClientId: 'client', discordClientSecret: 'secret', oauthRedirectUri: null,
    oauthSessionTtlMs: 120_000, activitySessionTtlMs: 300_000,
    maxPayloadBytes: 1_000_000, maxMessagesPerMinute: 180,
  }, { logger: { warn() {}, error() {} } });
  const grantStore = new AdminGrantStore();
  const openedSessions = new Map();
  const controlPlane = {
    openSession(context) { const id = `control-${openedSessions.size + 1}`; openedSessions.set(id, context); return id; },
    async invoke(id, method, params) { return { ok: true, session: openedSessions.get(id), method, params }; },
    closeSession(id) { openedSessions.delete(id); },
  };
  let client;
  let authorizationChecks = 0;
  try {
    await relay.start();
    const address = relay.address();
    const base = `ws://127.0.0.1:${address.port}`;
    const identity = new RelayDeviceIdentity({ privateKeyPath: path.join(temporary, 'device.jwk') });
    client = new AdminRelayClient({
      url: base, installationId: 'installation', deviceToken,
      identity, grantStore, controlPlane,
      authorizeAdministrator: async ({ guildId, userId }) => {
        authorizationChecks += 1;
        return authorizationChecks <= 2 && guildId === 'guild' && userId === 'admin';
      },
      reconnectMinMs: 50, reconnectMaxMs: 100,
      logger: { error() {}, warn() {} },
    });
    await client.start();
    grantStore.issue({ guildId: 'guild', userId: 'admin', threadId: 'thread' });

    const oauth = relay.createOauthSession({ id: 'admin', username: 'admin' });
    const activity = await open(`${base}/v1/activity?installation_id=installation&session=${oauth.token}`, {
      origin: 'https://activity.example',
    });
    const pair = await generateEcdhKeyPair();
    const clientPublicKey = await exportPublicJwk(pair.publicKey);
    activity.send(JSON.stringify({
      version: ADMIN_PROTOCOL_VERSION, type: 'activity.hello', guildId: 'guild', channelId: 'thread', userId: 'admin', clientPublicKey,
    }));
    const accepted = await next(activity);
    assert.equal(accepted.type, 'activity.accept');
    const transcript = handshakeTranscript({
      sessionId: accepted.sessionId, guildId: 'guild', channelId: 'thread', userId: 'admin', clientPublicKey,
      devicePublicKey: accepted.devicePublicKey, expiresAt: accepted.expiresAt,
    });
    assert.equal(await verifyTranscript(accepted.deviceSigningPublicKey, transcript, accepted.signature), true);
    const key = await deriveSessionKey({ privateKey: pair.privateKey, peerPublicJwk: accepted.devicePublicKey, transcript });
    const request = await encryptEnvelope({
      key, sessionId: accepted.sessionId, direction: 'activity-to-device', sequence: 1,
      value: { requestId: 'request-1', method: 'admin.bootstrap', params: { marker: 'secret-value' } },
    });
    activity.send(JSON.stringify({
      version: ADMIN_PROTOCOL_VERSION, type: 'rpc.request', sessionId: accepted.sessionId, ...request,
    }));
    const encryptedResponse = await next(activity);
    const response = await decryptEnvelope({
      key, sessionId: accepted.sessionId, direction: 'device-to-activity', ...encryptedResponse,
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.method, 'admin.bootstrap');
    assert.equal(response.result.params.marker, 'secret-value');
    assert.equal(response.result.session.threadId, 'thread');

    const deniedRequest = await encryptEnvelope({
      key, sessionId: accepted.sessionId, direction: 'activity-to-device', sequence: 2,
      value: { requestId: 'request-2', method: 'admin.bootstrap', params: {} },
    });
    activity.send(JSON.stringify({
      version: ADMIN_PROTOCOL_VERSION, type: 'rpc.request', sessionId: accepted.sessionId, ...deniedRequest,
    }));
    const deniedEnvelope = await next(activity);
    const denied = await decryptEnvelope({
      key, sessionId: accepted.sessionId, direction: 'device-to-activity', ...deniedEnvelope,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Administrator/);
    assert.equal(authorizationChecks, 3, 'Administrator permission must be checked again for each RPC');
    activity.close();
  } finally {
    await client?.stop();
    await relay.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
