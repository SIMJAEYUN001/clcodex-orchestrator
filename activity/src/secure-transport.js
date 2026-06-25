import { DiscordSDK } from '@discord/embedded-app-sdk';
import {
  canonicalPublicJwk,
  decryptEnvelope,
  deriveSessionKey,
  encryptEnvelope,
  exportPublicJwk,
  generateEcdhKeyPair,
  handshakeTranscript,
  publicKeyFingerprint,
  verifyTranscript,
} from '../../shared/admin-e2ee.js';
import { ADMIN_PROTOCOL_VERSION, assertProtocolMessage } from '../../shared/admin-protocol.js';

function normalizeBase(value, protocol) {
  const url = new URL(String(value || ''));
  if (url.protocol !== protocol) throw new Error(`Expected ${protocol} URL`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Expected an exact ${protocol} origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

function assertConfig(config) {
  for (const name of ['discordClientId', 'installationId', 'relayHttpUrl', 'relayWebSocketUrl', 'deviceFingerprint']) {
    if (!config?.[name] || String(config[name]).includes('REPLACE_') || String(config[name]).includes('DISCORD_')) {
      throw new Error(`Activity config field is not provisioned: ${name}`);
    }
  }
  canonicalPublicJwk(config.deviceSigningPublicKey);
  return {
    ...config,
    relayHttpUrl: normalizeBase(config.relayHttpUrl, 'https:'),
    relayWebSocketUrl: normalizeBase(config.relayWebSocketUrl, 'wss:'),
  };
}

function applyDiscordProxyRelayOrigin(config) {
  if (!location.hostname.endsWith('.discordsays.com')) return config;
  return {
    ...config,
    relayHttpUrl: location.origin,
    relayWebSocketUrl: `wss://${location.host}`,
  };
}

async function loadConfig() {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Activity config.json is missing');
  return applyDiscordProxyRelayOrigin(assertConfig(await response.json()));
}

async function authorizeActivity(discordSdk, config) {
  return discordSdk.commands.authorize({
    client_id: config.discordClientId,
    response_type: 'code',
    state: crypto.randomUUID(),
    prompt: 'none',
    scope: ['identify'],
  });
}

async function oauth(config, discordSdk) {
  await discordSdk.ready();
  const authorization = await authorizeActivity(discordSdk, config);
  const response = await fetch(`${config.relayHttpUrl}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: authorization.code }),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `OAuth relay returned HTTP ${response.status}`);
  const authenticated = await discordSdk.commands.authenticate({ access_token: result.access_token });
  if (!authenticated?.user?.id || authenticated.user.id !== result.user?.id) {
    throw new Error('Discord Activity identity verification failed');
  }
  return {
    user: authenticated.user,
    relaySessionToken: result.relay_session_token,
  };
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay WebSocket connection timed out')), 12_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('Relay WebSocket connection failed'));
    }, { once: true });
  });
}

export class ActivitySecureTransport {
  constructor({ socket, sessionId, key, expiresAt }) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.key = key;
    this.expiresAt = expiresAt;
    this.sendSequence = 0;
    this.recvSequence = 0;
    this.pending = new Map();
    this.receiveQueue = Promise.resolve();
    this.sendQueue = Promise.resolve();
    socket.addEventListener('message', (event) => {
      this.receiveQueue = this.receiveQueue
        .then(() => this.onMessage(event.data))
        .catch((error) => {
          for (const { reject } of this.pending.values()) reject(error);
          this.pending.clear();
          if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1002, 'Invalid encrypted response');
        });
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Admin relay session was closed'));
      this.pending.clear();
    });
  }

  async onMessage(data) {
    const message = assertProtocolMessage(JSON.parse(String(data)));
    if (message.type !== 'rpc.response' || message.sessionId !== this.sessionId) return;
    const sequence = Number(message.sequence);
    if (!Number.isSafeInteger(sequence) || sequence !== this.recvSequence + 1) {
      throw new Error('Out-of-order or replayed admin response');
    }
    const response = await decryptEnvelope({
      key: this.key,
      sessionId: this.sessionId,
      direction: 'device-to-activity',
      sequence,
      iv: message.iv,
      ciphertext: message.ciphertext,
    });
    this.recvSequence = sequence;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || 'Admin RPC failed'));
  }

  request(method, params = {}) {
    if (Date.now() >= this.expiresAt) return Promise.reject(new Error('Admin Activity session expired'));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Admin relay is disconnected'));
    const requestId = crypto.randomUUID();
    let settle;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Admin RPC timed out'));
      }, 30_000);
      settle = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.pending.set(requestId, settle);
    });

    const send = async () => {
      if (Date.now() >= this.expiresAt) throw new Error('Admin Activity session expired');
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Admin relay is disconnected');
      const sequence = this.sendSequence + 1;
      const encrypted = await encryptEnvelope({
        key: this.key,
        sessionId: this.sessionId,
        direction: 'activity-to-device',
        sequence,
        value: { requestId, method, params },
      });
      this.sendSequence = sequence;
      this.socket.send(JSON.stringify({
        version: ADMIN_PROTOCOL_VERSION,
        type: 'rpc.request',
        sessionId: this.sessionId,
        ...encrypted,
      }));
    };

    this.sendQueue = this.sendQueue.then(send, send);
    this.sendQueue.catch((error) => {
      if (this.pending.delete(requestId)) settle.reject(error);
    });
    return result;
  }
}

export async function connectActivityTransport({ onStatus = () => {} } = {}) {
  onStatus('Activity 배포 설정을 확인하고 있습니다.');
  const config = await loadConfig();
  const discordSdk = new DiscordSDK(config.discordClientId);
  onStatus('Discord 사용자 인증을 진행하고 있습니다.');
  const authenticated = await oauth(config, discordSdk);
  const guildId = discordSdk.guildId;
  const channelId = discordSdk.channelId || null;
  if (!guildId) throw new Error('이 관리 Activity는 Discord 서버 안에서만 실행할 수 있습니다.');

  onStatus('오케스트레이터와 암호화 채널을 협상하고 있습니다.');
  const keyPair = await generateEcdhKeyPair();
  const clientPublicKey = await exportPublicJwk(keyPair.publicKey);
  const endpoint = new URL('/v1/activity', config.relayWebSocketUrl);
  endpoint.searchParams.set('installation_id', config.installationId);
  endpoint.searchParams.set('session', authenticated.relaySessionToken);
  const socket = new WebSocket(endpoint);
  await waitForOpen(socket);
  socket.send(JSON.stringify({
    version: ADMIN_PROTOCOL_VERSION,
    type: 'activity.hello',
    guildId,
    channelId,
    userId: authenticated.user.id,
    clientPublicKey,
  }));

  const accepted = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('오케스트레이터가 Activity를 승인하지 않았습니다.')), 15_000);
    const onMessage = (event) => {
      try {
        const message = assertProtocolMessage(JSON.parse(String(event.data)));
        if (!['activity.accept', 'activity.reject'].includes(message.type)) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        if (message.type === 'activity.reject') reject(new Error(message.error || 'Activity access was rejected'));
        else resolve(message);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      reject(new Error('Relay closed before the secure session was established'));
    }, { once: true });
  });

  const pinnedFingerprint = await publicKeyFingerprint(config.deviceSigningPublicKey);
  if (pinnedFingerprint !== config.deviceFingerprint || accepted.deviceFingerprint !== config.deviceFingerprint) {
    throw new Error('오케스트레이터 device key fingerprint가 배포 설정과 일치하지 않습니다.');
  }
  if (JSON.stringify(canonicalPublicJwk(accepted.deviceSigningPublicKey)) !== JSON.stringify(canonicalPublicJwk(config.deviceSigningPublicKey))) {
    throw new Error('오케스트레이터 device signing key가 pin과 일치하지 않습니다.');
  }
  const transcript = handshakeTranscript({
    sessionId: accepted.sessionId,
    guildId,
    channelId,
    userId: authenticated.user.id,
    clientPublicKey,
    devicePublicKey: accepted.devicePublicKey,
    expiresAt: accepted.expiresAt,
  });
  if (!await verifyTranscript(config.deviceSigningPublicKey, transcript, accepted.signature)) {
    throw new Error('오케스트레이터 E2EE 서명 검증에 실패했습니다.');
  }
  const key = await deriveSessionKey({
    privateKey: keyPair.privateKey,
    peerPublicJwk: accepted.devicePublicKey,
    transcript,
  });
  onStatus('E2EE 관리 채널이 연결되었습니다.');
  return {
    transport: new ActivitySecureTransport({
      socket,
      sessionId: accepted.sessionId,
      key,
      expiresAt: Number(accepted.expiresAt),
    }),
    discordSdk,
    authenticated,
    config,
  };
}
